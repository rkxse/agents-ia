// Comptes du panel (demande du propriétaire, 01/11 : « retirer la connexion par Telegram et permettre à d'autres
// utilisateurs de venir s'inscrire et se connecter »). Le routeur ne protège plus la route : chaque requête est vérifiée
// ici. Un utilisateur ne voit que ses projets ; seul l'administrateur (le propriétaire) a des projets sur ce serveur,
// ceux des autres tournent sur leurs propres appareils (nœuds), jamais ici.
//  - Mots de passe : scrypt (sel aléatoire), comparaison à temps constant.
//  - Sessions : jeton aléatoire dans un cookie HttpOnly / Secure / SameSite=Lax, seule son empreinte est gardée
//    (data/sessions.json), 30 jours.
//  - Essais limités par adresse IP (connexion, inscription) contre le forçage des mots de passe.
//  - Compte administrateur : réclamé une fois avec un code à usage unique (data/setup-code.json), jamais « premier
//    inscrit = administrateur » (n'importe qui pourrait s'inscrire avant le propriétaire).
// Fichiers : data/users.json, data/sessions.json (non suivis).
const crypto = require("crypto");
const path = require("path");
const store = require("./store");
const mfa = require("./mfa");

const DIR = process.env.AGENTS_AUTH_DIR || store.RUNTIME; // dossier à part pour les tests
const USERS = path.join(DIR, "users.json");
const SESSIONS = path.join(DIR, "sessions.json");
const SETUP = path.join(DIR, "setup-code.json");
const COOKIE = "ag_session";
const SESSION_MS = 30 * 86400e3;
const fail = (message, status) => Object.assign(new Error(message), { status: status || 400 });
const sha = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
const now = () => new Date().toISOString();

// users() : copie modifiable (à réenregistrer) ; peekUsers() : lecture seule, sans copie (recherches à chaque requête).
const users = () => store.readJson(USERS, []);
const peekUsers = () => store.peekJson(USERS, []);
const saveUsers = (list) => store.writeJson(USERS, list);
const publicUser = (u) => u && { id: u.id, email: u.email, name: u.name, role: u.role, status: u.status, createdAt: u.createdAt, lastLogin: u.lastLogin || null,
  mfa: !!(u.mfa && ((u.mfa.totp && u.mfa.totp.active) || (u.mfa.keys || []).length)) };
const byId = (id) => peekUsers().find((u) => u.id === id) || null;
const admin = () => peekUsers().find((u) => u.role === "admin" && u.status === "active") || null;

// ---------- mots de passe ----------
// scrypt asynchrone (calculé hors du fil principal) : en synchrone, chaque connexion figeait le panel ~80 ms pour tous
// les autres clients (test de charge du 01/11 : 87 % d'échecs à 200 clients).
const scrypt = require("util").promisify(crypto.scrypt);
async function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return "scrypt$" + salt.toString("hex") + "$" + (await scrypt(String(pw), salt, 64)).toString("hex");
}
async function checkPassword(pw, stored) {
  const [kind, salt, hash] = String(stored || "").split("$");
  if (kind !== "scrypt" || !salt || !hash) return false;
  const a = await scrypt(String(pw), Buffer.from(salt, "hex"), 64), b = Buffer.from(hash, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
// Empreinte factice : un compte inconnu coûte le même calcul qu'un vrai (pas de différence de temps à exploiter).
const DUMMY = "scrypt$" + "00".repeat(16) + "$" + crypto.scryptSync("x", Buffer.alloc(16), 64).toString("hex");
function cleanEmail(e) {
  const s = String(e || "").trim().toLowerCase();
  if (!/^[^\s@]{1,64}@[^\s@]{1,190}\.[a-z]{2,}$/.test(s)) throw fail("Adresse e-mail invalide.");
  return s;
}
function cleanPassword(pw) {
  const s = String(pw || "");
  if (s.length < 8) throw fail("Mot de passe trop court : 8 caractères au moins.");
  if (s.length > 200) throw fail("Mot de passe trop long.");
  return s;
}

// ---------- limite d'essais (mémoire du process) ----------
const tries = new Map(); // clé -> { n, until }
function limit(key, max, ms) {
  const t = Date.now();
  if (tries.size > 20000) for (const [k, v] of tries) if (v.until < t) tries.delete(k); // jamais de croissance sans fin
  const e = tries.get(key);
  if (!e || e.until < t) { tries.set(key, { n: 1, until: t + ms }); return; }
  if (++e.n > max) throw fail("Trop d'essais : réessaie dans " + Math.ceil((e.until - t) / 60000) + " min.", 429);
}

// ---------- sessions ----------
function newSession(u, ua) {
  const token = crypto.randomBytes(32).toString("base64url");
  const all = store.readJson(SESSIONS, {});
  const t = Date.now();
  for (const [k, s] of Object.entries(all)) if (s.expiresAt < t) delete all[k]; // ménage
  // 20 sessions au plus par compte (les plus anciennes fermées) : le fichier ne grossit pas à chaque connexion.
  const theirs = Object.entries(all).filter(([, s]) => s.uid === u.id).sort((x, y) => (x[1].createdAt < y[1].createdAt ? -1 : 1));
  for (const [k] of theirs.slice(0, Math.max(0, theirs.length - 19))) delete all[k];
  all[sha(token)] = { uid: u.id, createdAt: now(), expiresAt: t + SESSION_MS, ua: String(ua || "").slice(0, 160) };
  store.writeJson(SESSIONS, all);
  const list = users(), me = list.find((x) => x.id === u.id);
  if (me) { me.lastLogin = now(); saveUsers(list); }
  return token;
}
const cookieHeader = (token, maxAgeS) => COOKIE + "=" + token + "; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=" + maxAgeS;
const tokenOf = (req) => { const m = new RegExp("(?:^|;\\s*)" + COOKIE + "=([A-Za-z0-9_-]{20,100})").exec(req.headers.cookie || ""); return m ? m[1] : null; };
// Utilisateur de la requête (session valide, compte actif), sinon null.
function userOf(req) {
  const token = tokenOf(req);
  if (!token) return null;
  const s = store.peekJson(SESSIONS, {})[sha(token)];
  if (!s || s.expiresAt < Date.now()) return null;
  const u = byId(s.uid);
  return u && u.status === "active" ? u : null;
}
function logout(req) {
  const token = tokenOf(req);
  if (!token) return;
  const all = store.readJson(SESSIONS, {});
  delete all[sha(token)];
  store.writeJson(SESSIONS, all);
}
// Toutes les sessions d'un utilisateur (compte bloqué, mot de passe changé).
function dropSessions(uid) {
  const all = store.readJson(SESSIONS, {});
  for (const [k, s] of Object.entries(all)) if (s.uid === uid) delete all[k];
  store.writeJson(SESSIONS, all);
}

// ---------- inscription, connexion ----------
// Empreinte calculée d'abord (asynchrone), puis lecture, contrôle et écriture de la liste d'un seul tenant : deux
// inscriptions simultanées ne s'écrasent pas.
async function signup({ email, password, name }, ip, ua) {
  limit("signup:" + ip, 5, 3600e3);
  const e = cleanEmail(email), pw = cleanPassword(password);
  const n = String(name || "").trim().slice(0, 60) || e.split("@")[0];
  if (peekUsers().some((u) => u.email === e)) throw fail("Un compte existe déjà avec cette adresse : connecte-toi.");
  const passHash = await hashPassword(pw);
  const list = users();
  if (list.some((u) => u.email === e)) throw fail("Un compte existe déjà avec cette adresse : connecte-toi.");
  const u = { id: "u-" + crypto.randomBytes(6).toString("hex"), email: e, name: n, passHash, role: "user", status: "active", createdAt: now() };
  list.push(u);
  saveUsers(list);
  return { user: publicUser(u), token: newSession(u, ua) };
}
async function login({ email, password }, ip, ua) {
  limit("login:" + ip, 10, 15 * 60e3);
  const e = String(email || "").trim().toLowerCase();
  const found = peekUsers().find((x) => x.email === e);
  // Même réponse et même travail (scrypt) que le compte existe ou non.
  const ok = await checkPassword(password, found ? found.passHash : DUMMY);
  const u = found && byId(found.id); // relu après le calcul (bloqué ou modifié entre-temps)
  if (!u || !ok) throw fail("Adresse ou mot de passe incorrect.", 401);
  if (u.status !== "active") throw fail("Ce compte est suspendu.", 403);
  // Double authentification : pas de session avant le code ou la clé (ticket de 5 min, 5 essais).
  if (hasMfa(u)) {
    if (tickets.size > 500) for (const [k, v] of tickets) if (v.until < Date.now()) tickets.delete(k); // tickets expirés
    const ticket = crypto.randomBytes(24).toString("base64url");
    tickets.set(ticket, { uid: u.id, until: Date.now() + 5 * 60e3, tries: 0 });
    const m = u.mfa || {};
    return { mfa: { ticket, totp: !!(m.totp && m.totp.active), keys: (m.keys || []).length > 0, recovery: (m.recovery || []).length > 0 } };
  }
  return { user: publicUser(u), token: newSession(u, ua) };
}

// ---------- double authentification (lib/mfa.js) ----------
const hasMfa = (u) => !!(u && u.mfa && ((u.mfa.totp && u.mfa.totp.active) || (u.mfa.keys || []).length));
const tickets = new Map(); // ticket de connexion en attente du 2e facteur -> { uid, until, tries, challenge }
const keyChallenges = new Map(); // uid -> défi d'inscription d'une clé (2 min)
function ticketOf(t) {
  const e = tickets.get(String(t || ""));
  if (!e || e.until < Date.now()) throw fail("Connexion expirée : entre à nouveau ton mot de passe.", 401);
  return e;
}
function updateUser(uid, fn) {
  const list = users(), u = list.find((x) => x.id === uid);
  if (!u) throw fail("Utilisateur inconnu.", 404);
  u.mfa = u.mfa || {};
  const r = fn(u);
  saveUsers(list);
  return r;
}
// Options WebAuthn pour se connecter avec une clé (2e étape).
function loginKeyOptions({ ticket }) {
  const t = ticketOf(ticket), u = byId(t.uid);
  const keys = (u && u.mfa && u.mfa.keys) || [];
  if (!keys.length) throw fail("Aucune clé de sécurité sur ce compte.");
  const o = mfa.assertionOptions(keys);
  t.challenge = o.challenge;
  return { publicKey: o.publicKey };
}
// 2e étape : code de l'application, code de secours ou réponse de la clé.
function loginSecondFactor({ ticket, code, recovery, credential }, ip, ua) {
  limit("mfa:" + ip, 20, 15 * 60e3);
  const t = ticketOf(ticket);
  if (++t.tries > 5) { tickets.delete(ticket); throw fail("Trop d'essais : entre à nouveau ton mot de passe.", 429); }
  const ok = updateUser(t.uid, (u) => {
    const m = u.mfa;
    if (credential) {
      const k = (m.keys || []).find((x) => x.id === credential.id);
      if (!k) throw fail("Cette clé n'est pas enregistrée sur ce compte.", 401);
      k.signCount = mfa.verifyAssertion(credential, k, t.challenge);
      k.lastUsed = now();
      return true;
    }
    if (recovery) {
      const i = mfa.recoveryIndex(m.recovery, recovery);
      if (i < 0) return false;
      m.recovery.splice(i, 1); // usage unique
      return true;
    }
    if (m.totp && m.totp.active) {
      const step = mfa.totpCheck(m.totp.secret, code, m.totp.lastStep);
      if (step === null) return false;
      m.totp.lastStep = step; // le même code ne sert pas deux fois
      return true;
    }
    return false;
  });
  if (!ok) throw fail("Code incorrect.", 401);
  tickets.delete(ticket);
  const u = byId(t.uid);
  if (!u || u.status !== "active") throw fail("Ce compte est suspendu.", 403);
  return { user: publicUser(u), token: newSession(u, ua) };
}
// Réglages de sécurité de l'utilisateur connecté.
function security(u) {
  const m = (byId(u.id) || {}).mfa || {};
  return { totp: !!(m.totp && m.totp.active), recoveryLeft: (m.recovery || []).length, keys: (m.keys || []).map((k) => ({ id: k.id, name: k.name, createdAt: k.createdAt, lastUsed: k.lastUsed || null })) };
}
// Mot de passe redemandé avant une action sensible (revue du 02/11) : 10 essais par quart d'heure et par compte (une
// session volée ne permet pas de le deviner) ; 403 et non 401 (la session est valide : la page prendrait un 401 pour une
// session expirée et afficherait l'écran de connexion).
const needPassword = async (u, password) => {
  limit("pw:" + u.id, 10, 15 * 60e3);
  if (!(await checkPassword(password, (byId(u.id) || {}).passHash))) throw fail("Mot de passe incorrect.", 403);
};
// Codes de secours : créés au premier 2e facteur, montrés une seule fois.
function freshRecovery(u) { const r = mfa.newRecovery(); u.mfa.recovery = r.hashes; return r.codes; }
// Ajouter un 2e facteur demande aussi le mot de passe : sinon une session volée suffirait à poser son propre facteur et à
// fermer le compte à son propriétaire (revue du 02/11).
async function totpSetup(u, { password } = {}) { await needPassword(u, password); const t = mfa.newTotp(u.email); updateUser(u.id, (x) => { x.mfa.totpPending = t.secret; }); return t; }
function totpEnable(u, { code }) {
  return updateUser(u.id, (x) => {
    const secret = x.mfa.totpPending;
    if (!secret) throw fail("Recommence l'ajout de l'application.");
    const step = mfa.totpCheck(secret, code, 0);
    if (step === null) throw fail("Code incorrect : vérifie l'heure du téléphone et réessaie.");
    const first = !hasMfa(x);
    x.mfa.totp = { secret, active: true, lastStep: step, since: now() };
    delete x.mfa.totpPending;
    return { recovery: first || !(x.mfa.recovery || []).length ? freshRecovery(x) : null };
  });
}
async function totpDisable(u, { password }) { await needPassword(u, password); updateUser(u.id, (x) => { delete x.mfa.totp; if (!hasMfa(x)) delete x.mfa.recovery; }); return security(u); }
async function recoveryNew(u, { password }) {
  await needPassword(u, password);
  return { recovery: updateUser(u.id, (x) => { if (!hasMfa(x)) throw fail("Active d'abord une application ou une clé."); return freshRecovery(x); }) };
}
async function keyOptions(u, { password } = {}) {
  await needPassword(u, password);
  const me = byId(u.id), o = mfa.registrationOptions(me, (me.mfa && me.mfa.keys) || []);
  keyChallenges.set(u.id, { challenge: o.challenge, until: Date.now() + 2 * 60e3 });
  return { publicKey: o.publicKey };
}
function keyAdd(u, { name, credential }) {
  const c = keyChallenges.get(u.id);
  keyChallenges.delete(u.id);
  if (!c || c.until < Date.now()) throw fail("Délai dépassé : recommence l'ajout de la clé.");
  const k = mfa.verifyRegistration(credential, c.challenge);
  return updateUser(u.id, (x) => {
    x.mfa.keys = x.mfa.keys || [];
    if (x.mfa.keys.some((y) => y.id === k.id)) throw fail("Cette clé est déjà enregistrée.");
    const first = !hasMfa(x);
    x.mfa.keys.push({ ...k, name: String(name || "").trim().slice(0, 40) || "Clé de sécurité", createdAt: now() });
    return { recovery: first || !(x.mfa.recovery || []).length ? freshRecovery(x) : null };
  });
}
async function keyRemove(u, id, { password }) {
  await needPassword(u, password);
  updateUser(u.id, (x) => { x.mfa.keys = (x.mfa.keys || []).filter((k) => k.id !== id); if (!hasMfa(x)) delete x.mfa.recovery; });
  return security(u);
}
// Administrateur : un utilisateur qui a perdu son téléphone et ses codes de secours.
function resetMfa(adminUser, uid) {
  if (uid === adminUser.id) throw fail("Pas pour ton propre compte : passe par tes codes de secours.");
  updateUser(uid, (x) => { x.mfa = {}; });
  dropSessions(uid);
  return publicUser(byId(uid));
}
async function changePassword(u, { current, password }) {
  const pw = cleanPassword(password), cur = byId(u.id);
  limit("pw:" + u.id, 10, 15 * 60e3);
  if (!cur || !(await checkPassword(current, cur.passHash))) throw fail("Mot de passe actuel incorrect.", 403);
  const passHash = await hashPassword(pw);
  const list = users(), me = list.find((x) => x.id === u.id);
  if (!me) throw fail("Utilisateur inconnu.", 404);
  me.passHash = passHash;
  saveUsers(list);
  dropSessions(u.id);
}

// ---------- compte administrateur (une fois) ----------
// Code à usage unique, valable 24 h, créé sur le serveur (node -e "require('./lib/auth').setupCode()").
function setupCode() {
  const code = crypto.randomBytes(18).toString("base64url");
  store.writeJson(SETUP, { hash: sha(code), expiresAt: Date.now() + 24 * 3600e3 });
  return code;
}
async function claimAdmin({ code, email, password, name }, ip, ua) {
  limit("setup:" + ip, 10, 3600e3);
  const check = () => { const s = store.readJson(SETUP, null); if (!s || s.expiresAt < Date.now() || s.hash !== sha(code)) throw fail("Code invalide ou expiré.", 403); };
  check();
  const e = cleanEmail(email), pw = cleanPassword(password);
  const passHash = await hashPassword(pw);
  check(); // toujours valable (pas consommé entre-temps par une autre requête)
  require("fs").rmSync(SETUP, { force: true }); // usage unique
  const list = users();
  let u = list.find((x) => x.email === e);
  if (u) { u.passHash = passHash; u.role = "admin"; u.status = "active"; if (name) u.name = String(name).slice(0, 60); }
  else { u = { id: "u-" + crypto.randomBytes(6).toString("hex"), email: e, name: String(name || "").trim().slice(0, 60) || "Administrateur", passHash, role: "admin", status: "active", createdAt: now() }; list.push(u); }
  saveUsers(list);
  return { user: publicUser(u), token: newSession(u, ua) };
}

// ---------- administration ----------
function listUsers() { return users().map(publicUser); }
function setStatus(adminUser, uid, status) {
  if (uid === adminUser.id) throw fail("Tu ne peux pas te bloquer toi-même.");
  const list = users(), u = list.find((x) => x.id === uid);
  if (!u) throw fail("Utilisateur inconnu.", 404);
  u.status = status === "blocked" ? "blocked" : "active";
  saveUsers(list);
  if (u.status === "blocked") dropSessions(uid);
  return publicUser(u);
}

module.exports = { COOKIE, SESSION_MS, cookieHeader, userOf, publicUser, byId, admin, signup, login, logout, changePassword, setupCode, claimAdmin, listUsers, setStatus, hashPassword, checkPassword,
  loginKeyOptions, loginSecondFactor, security, totpSetup, totpEnable, totpDisable, recoveryNew, keyOptions, keyAdd, keyRemove, resetMfa, confirmPassword: needPassword };

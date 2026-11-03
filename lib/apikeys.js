// Clés d'API (02/11/2026) : un autre projet (bot, site, script, scanner) parle au panel au nom d'un utilisateur, sans
// session ni mot de passe, avec l'en-tête « Authorization: Bearer agk_… » (routes /api/v1 de server.js, docs/API.md).
// Une clé ne voit que les projets de son propriétaire (ou ceux choisis à sa création) et ne fait que ce que ses droits
// permettent :
//   lire     : projets, agents, passages, notifications, conversations avec le patron ;
//   notifier : envoyer une notification au panel (et sur le téléphone du propriétaire) ;
//   lancer   : lancer un agent ;
//   patron   : écrire à l'agent patron (qui peut modifier le code et écrire aux utilisateurs : le droit le plus fort).
// Gardée seulement en empreinte (sha256) : montrée une fois à la création ; perdue = en créer une autre. Compte bloqué :
// ses clés ne marchent plus. Dernière utilisation en mémoire, enregistrée toutes les 30 s (comme lib/nodes.js).
const crypto = require("crypto");
const path = require("path");
const store = require("./store");
const admin = require("./agents-admin");

const DIR = process.env.AGENTS_AUTH_DIR || store.RUNTIME; // avec les comptes (dossier à part pour les tests)
const FILE = path.join(DIR, "api-keys.json");
const SCOPES = ["lire", "notifier", "lancer", "patron"];
const MAX_KEYS = 20; // par utilisateur
const PER_MIN = 120; // requêtes par minute et par clé
const fail = admin.fail;
const sha = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
const now = () => new Date().toISOString();

const used = new Map(); // id -> { at, ip }
const view = (k) => ({ id: k.id, name: k.name, prefix: k.prefix, scopes: k.scopes, projects: k.projects || null, createdAt: k.createdAt,
  lastUsedAt: (used.get(k.id) || {}).at || k.lastUsedAt || null, lastIp: (used.get(k.id) || {}).ip || k.lastIp || null });
const list = (u) => store.peekJson(FILE, []).filter((k) => k.owner === u.id).map(view);

// projectIds : projets de l'utilisateur (les seuls qu'une clé peut viser). Renvoie { key, secret } : secret montré une fois.
function create(u, body, projectIds) {
  const all = store.readJson(FILE, []);
  if (all.filter((k) => k.owner === u.id).length >= MAX_KEYS) throw fail(MAX_KEYS + " clés au plus : retire celles qui ne servent plus.");
  const scopes = Array.isArray(body.scopes) ? [...new Set(body.scopes.filter((s) => SCOPES.includes(s)))] : ["lire", "notifier"];
  if (!scopes.length) throw fail("Choisis au moins un droit pour la clé.");
  let projects = null;
  if (Array.isArray(body.projects) && body.projects.length) {
    projects = [...new Set(body.projects.map(String))];
    const bad = projects.filter((id) => !projectIds.includes(id));
    if (bad.length) throw fail("Projet inconnu : " + bad[0], 404);
  }
  const secret = "agk_" + crypto.randomBytes(24).toString("base64url");
  const k = { id: "k-" + crypto.randomBytes(5).toString("hex"), owner: u.id, name: admin.str(body.name, 40) || "Clé API", prefix: secret.slice(0, 10), hash: sha(secret), scopes, projects, createdAt: now() };
  all.push(k);
  store.writeJson(FILE, all);
  return { key: view(k), secret };
}
function remove(u, id) {
  const all = store.readJson(FILE, []);
  if (!all.some((k) => k.id === id && k.owner === u.id)) throw fail("Clé inconnue.", 404);
  store.writeJson(FILE, all.filter((k) => !(k.id === id && k.owner === u.id)));
  used.delete(id);
}

// Projet supprimé (03/11) : retiré des clés limitées à certains projets ; une clé qui n'en vise plus aucun ne voit plus
// rien (un nouveau projet du même identifiant n'y aurait pas accès).
function forgetProject(pid) {
  const all = store.readJson(FILE, []);
  if (!all.some((k) => Array.isArray(k.projects) && k.projects.includes(pid))) return;
  for (const k of all) if (Array.isArray(k.projects)) k.projects = k.projects.filter((x) => x !== pid);
  store.writeJson(FILE, all);
}

// Requête d'un autre projet -> { key, user }. 401 sans clé valide ou compte bloqué ; 429 au-delà de PER_MIN par minute.
const hits = new Map(); // id -> { w, n }
function authenticate(req, ip) {
  const m = /^Bearer (agk_[A-Za-z0-9_-]{20,60})$/.exec(req.headers.authorization || "");
  if (!m) throw fail("Clé d'API manquante : en-tête « Authorization: Bearer agk_… » (clés : panel → API & connexions).", 401);
  const h = sha(m[1]), k = store.peekJson(FILE, []).find((x) => x.hash === h);
  const u = k && require("./auth").byId(k.owner);
  if (!k || !u || u.status !== "active") throw fail("Clé d'API invalide ou retirée.", 401);
  const w = Math.floor(Date.now() / 60e3), c = hits.get(k.id);
  if (!c || c.w !== w) hits.set(k.id, { w, n: 1 });
  else if (++c.n > PER_MIN) throw fail("Trop de requêtes avec cette clé : " + PER_MIN + " par minute au plus.", 429);
  used.set(k.id, { at: now(), ip: String(ip || "").slice(0, 60) });
  return { key: k, user: u };
}
function need(key, scope) {
  if (!key.scopes.includes(scope)) throw fail("Cette clé n'a pas le droit « " + scope + " » (à cocher en créant une clé dans le panel).", 403);
}
const allows = (key, projectId) => !key.projects || key.projects.includes(projectId);

// Limite propre à une action (notifications, messages au patron) : n par minute et par clé.
const quotas = new Map();
function quota(key, what, n) {
  const id = key.id + ":" + what, w = Math.floor(Date.now() / 60e3), c = quotas.get(id);
  if (!c || c.w !== w) return quotas.set(id, { w, n: 1 });
  if (++c.n > n) throw fail("Trop de " + what + " avec cette clé : " + n + " par minute au plus.", 429);
}

function flush() {
  if (!used.size) return;
  const all = store.readJson(FILE, []);
  let changed = false;
  for (const k of all) { const x = used.get(k.id); if (x && x.at !== k.lastUsedAt) { k.lastUsedAt = x.at; k.lastIp = x.ip; changed = true; } }
  if (changed) store.writeJson(FILE, all);
}
setInterval(() => { try { flush(); } catch (e) { /* prochain tour */ } }, 30e3).unref();

module.exports = { SCOPES, list, create, remove, forgetProject, authenticate, need, allows, quota, flush };

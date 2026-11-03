// Appareils (« nœuds ») : un utilisateur connecte un projet de son ordinateur au panel (demande du 01/11 : « pouvoir
// connecter un nouveau projet depuis un autre appareil »). Les agents de ce projet tournent sur l'appareil (node.js,
// avec le Claude de l'utilisateur), jamais sur ce serveur ; le panel les règle, les lance et montre leurs résultats.
//  - Connexion : code à usage unique (30 min) créé dans le panel, commande d'installation collée dans le dossier du
//    projet ; l'appareil reçoit un jeton secret (seule son empreinte est gardée ici).
//  - Synchronisation (toutes les 5 s, 1 s si une demande attend) : l'appareil envoie ses passages, notifications,
//    résultats des agents (copiés dans data/remote/<projet>/data, lus par le panel comme ceux d'un projet d'ici),
//    journaux git et réglages changés par son agent patron ; il reçoit les réglages des agents (gardés ici, avec leur
//    historique git), les lancements demandés et les demandes du panel (détail d'un commit).
// Fichiers : data/nodes.json, data/node-codes.json, data/remote/<projet>/ (copie, demandes).
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const store = require("./store");
const admin = require("./agents-admin");
const boss = require("./boss");

const NODES = path.join(store.RUNTIME, "nodes.json");
const CODES = path.join(store.RUNTIME, "node-codes.json");
const COMMANDS = path.join(store.RUNTIME, "commands");
const HISTORY = (id) => path.join(store.RUNTIME, "history", id + ".jsonl");
const ONLINE_MS = 60e3;
const fail = admin.fail;
const sha = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
const now = () => new Date().toISOString();
// État vivant des ordinateurs (dernier passage, agent en cours, problèmes) : en mémoire, enregistré toutes les 30 s.
// Avant (test de charge du 01/11), chaque synchronisation réécrivait nodes.json : 20 écritures par seconde à 100
// ordinateurs. nodes.json ne change plus que pour une connexion ou un retrait.
const live = new Map();
// Un ordinateur avec son état vivant ; seuls ceux cherchés sont copiés (à 500 ordinateurs, tout recopier à chaque page
// coûtait 15 % du temps).
const merged = (n) => ({ ...n, ...(live.get(n.id) || {}) });
const findNode = (pred) => { const n = store.peekJson(NODES, []).find(pred); return n ? merged(n) : null; };
const save = (list) => store.writeJson(NODES, list.map(({ status, problems, ...n }) => n));
function flushLive() {
  if (!live.size) return;
  const list = store.readJson(NODES, []);
  let changed = false;
  for (const n of list) { const l = live.get(n.id); if (l && l.lastSeen !== n.lastSeen) { n.lastSeen = l.lastSeen; n.info = l.info || n.info; changed = true; } }
  if (changed) store.writeJson(NODES, list);
}
setInterval(() => { try { flushLive(); } catch (e) { /* prochain tour */ } }, 30e3).unref();
const online = (n) => !!(n.lastSeen && Date.now() - Date.parse(n.lastSeen) < ONLINE_MS);
const projectsOf = (nodeId) => store.listProjects((p) => p.node === nodeId);
const view = (n) => ({ id: n.id, name: n.name, online: online(n), lastSeen: n.lastSeen || null, createdAt: n.createdAt, info: n.info || {}, current: online(n) ? (n.status && n.status.current) || null : null,
  projects: projectsOf(n.id).map((p) => ({ id: p.id, name: p.name, dir: p.dir, error: (n.problems || {})[p.id] || null })) });

// ---------- connexion d'un appareil ----------
function createCode(u) {
  const code = crypto.randomBytes(12).toString("base64url");
  const t = Date.now();
  const list = store.readJson(CODES, []).filter((c) => c.expiresAt > t);
  list.push({ hash: sha(code), owner: u.id, expiresAt: t + 30 * 60e3 });
  store.writeJson(CODES, list);
  return { code, expiresAt: new Date(t + 30 * 60e3).toISOString() };
}
// Code encore valable (sans le consommer) -> propriétaire.
function codeOwner(code) {
  const c = store.readJson(CODES, []).find((x) => x.hash === sha(code) && x.expiresAt > Date.now());
  return c ? c.owner : null;
}
function consumeCode(code) {
  const owner = codeOwner(code);
  if (!owner) throw fail("Code de connexion invalide ou expiré : crée-en un nouveau dans le panel.", 403);
  store.writeJson(CODES, store.readJson(CODES, []).filter((x) => x.hash !== sha(code)));
  return owner;
}

const slug = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 26);
// Projet d'un appareil : réglages et copie des agents gardés ici (patron et éclaireur, en pause au départ). Sur
// l'appareil, ses agents, leurs consignes et leurs résultats sont dans le dossier agents-ia du projet (03/11 : supprimer
// ce dossier retire tous les agents).
function createProject(ownerId, node, body) {
  const name = admin.str(body.name, 60), dir = admin.str(body.dir, 300).replace(/\\/g, "/");
  if (!name || !dir) throw fail("Nom et dossier du projet obligatoires.");
  if (projectsOf(node.id).some((p) => p.dir.toLowerCase() === dir.toLowerCase())) throw fail("Ce dossier est déjà connecté sur cet appareil.");
  let id = slug(name) || "projet";
  if (!store.ID_RE.test(id)) id = "projet-" + crypto.randomBytes(2).toString("hex");
  while (fs.existsSync(path.join(store.PROJECTS, id))) id = (id.slice(0, 24) + "-" + crypto.randomBytes(2).toString("hex"));
  const p = { id, name, owner: ownerId, node: node.id, description: admin.str(body.description, 200), dir, envFile: ".env", agentsDir: store.AGENTS_DIR, dataDir: store.AGENTS_DIR + "/data",
    testCmd: admin.str(body.testCmd, 120) || "", restartCmd: admin.str(body.restartCmd, 120) || null, pm2Process: null, allowed: "^(?!data/|" + store.AGENTS_DIR + "/|\\.env|node_modules/|\\.git/)", protected: null, createdAt: now() };
  // Projet supprimé puis reconnecté (même dossier ou même identifiant) avant que l'appareil ait effacé l'ancien dossier
  // des agents : plus effacé, le nouveau projet y écrit ses agents.
  const list = store.readJson(NODES, []), n = list.find((x) => x.id === node.id);
  if (n && n.dropped && n.dropped.some((d) => d.id === id || String(d.dir).toLowerCase() === dir.toLowerCase())) {
    n.dropped = n.dropped.filter((d) => d.id !== id && String(d.dir).toLowerCase() !== dir.toLowerCase());
    if (!n.dropped.length) delete n.dropped;
    save(list);
  }
  store.writeJson(path.join(store.PROJECTS, id, "project.json"), p);
  boss.starterAgents(id, name);
  admin.commitConfig("nouveau projet « " + name + " » sur l'appareil « " + node.name + " »", [path.join(store.PROJECTS, id)], "Panel");
  return store.project(id);
}

// L'appareil s'enregistre (code à usage unique) et peut connecter tout de suite le dossier où la commande a été lancée.
function enroll(body) {
  const owner = consumeCode(body.code);
  const token = crypto.randomBytes(32).toString("base64url");
  const node = { id: "n-" + crypto.randomBytes(5).toString("hex"), owner, name: admin.str(body.name, 60) || "Mon ordinateur", tokenHash: sha(token), createdAt: now(), lastSeen: now(), info: cleanInfo(body.info) };
  const list = store.readJson(NODES, []);
  list.push(node);
  save(list);
  let project = null;
  if (body.project && body.project.dir) project = createProject(owner, node, body.project);
  return { node: { id: node.id, name: node.name }, token, project: project && { id: project.id, name: project.name } };
}
const cleanInfo = (i) => ({ os: admin.str(i && i.os, 60), host: admin.str(i && i.host, 60), node: admin.str(i && i.node, 20), claude: admin.str(i && i.claude, 40), version: admin.str(i && i.version, 20) });
function byToken(req) {
  const m = /^Bearer ([A-Za-z0-9_-]{30,100})$/.exec(req.headers.authorization || "");
  if (!m) return null;
  const h = sha(m[1]);
  return findNode((x) => x.tokenHash === h);
}

// ---------- synchronisation ----------
// Chemin d'un fichier copié depuis l'appareil : relatif, sans « .. », 3 niveaux au plus.
const safeRel = (r) => /^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+){0,2}$/.test(r) && !r.split("/").includes("..");
// Projets avec une demande en attente (posées par ask() dans ce process) : les autres ne lisent pas leur dossier rpc.
const asking = new Set();
function pendingRpc(pid) {
  if (!asking.has(pid)) return [];
  let files = [];
  try { files = fs.readdirSync(path.join(store.remoteDir(pid), "rpc")).filter((f) => f.endsWith(".req.json")); } catch (e) { /* aucune */ }
  if (!files.length) asking.delete(pid);
  return files;
}

// Ce qu'un appareil envoie est plafonné et nettoyé (revue du 02/11 : n'importe qui peut s'inscrire et connecter un
// appareil ; sans plafond, des passages, notifications et fichiers sans fin auraient rempli le disque de ce serveur) :
// lignes d'historique réduites à leurs champs connus, 200 passages, 20 notifications et 100 fichiers par
// synchronisation, copie des résultats de 200 Mo au plus par projet.
const MIRROR_MAX = 200 * 1024 * 1024;
const mirror = new Map(); // projet -> { at, bytes } : taille de la copie, recomptée toutes les 10 min
function mirrorBytes(dir) {
  let t = 0;
  try { for (const e of fs.readdirSync(dir, { withFileTypes: true })) { const f = path.join(dir, e.name); t += e.isDirectory() ? mirrorBytes(f) : fs.statSync(f).size; } } catch (e) { /* absent */ }
  return t;
}
function mirrorRoom(pid, dir, adding) {
  let m = mirror.get(pid);
  if (!m || Date.now() - m.at > 10 * 60e3) mirror.set(pid, (m = { at: Date.now(), bytes: mirrorBytes(dir) }));
  if (m.bytes + adding > MIRROR_MAX) return false;
  m.bytes += adding;
  return true;
}
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
const cleanRun = (h) => ({ at: admin.str(h.at, 40), agent: admin.str(h.agent, 40), source: admin.str(h.source, 40) || undefined, status: admin.str(h.status, 20) || "ok",
  cost: num(h.cost), summary: h.summary ? admin.str(h.summary, 500) : null, commit: h.commit ? admin.str(h.commit, 40) : null, seconds: Math.max(0, num(h.seconds) || 0) });

const syncs = new Map(); // appareil -> { w, n } : 120 synchronisations par minute au plus (le programme en fait 12, 60 au plus)
function sync(node, body = {}) {
  const w = Math.floor(Date.now() / 60e3), c = syncs.get(node.id);
  if (!c || c.w !== w) syncs.set(node.id, { w, n: 1 });
  else if (++c.n > 120) throw fail("Trop de synchronisations : une par seconde au plus.", 429);
  const chat = require("./chat");
  const me = { lastSeen: now(), info: cleanInfo(body.info || node.info), problems: {},
    status: { current: body.status && body.status.current ? { project: admin.str(body.status.current.project, 40), agent: admin.str(body.status.current.agent, 40), name: admin.str(body.status.current.name, 60), since: body.status.current.since } : null } };
  live.set(node.id, me);
  const mine = projectsOf(node.id), ids = new Set(mine.map((p) => p.id));
  for (const [pid, d] of Object.entries(body.projects || {})) {
    if (!ids.has(pid) || !d || typeof d !== "object") continue; // seulement ses projets
    const p = store.project(pid), base = store.remoteDir(pid);
    if (d.problem) me.problems[pid] = admin.str(d.problem, 300);
    // Envoyé à chaque synchronisation : réécrit seulement s'il a changé.
    const runsFile = path.join(p.data, "agents-runs.json");
    if (d.runs && typeof d.runs === "object" && JSON.stringify(store.peekJson(runsFile, null)) !== JSON.stringify(d.runs)) store.writeJson(runsFile, d.runs);
    for (const [rel, content] of Object.entries(d.files && typeof d.files === "object" ? d.files : {}).slice(0, 100)) {
      if (!safeRel(rel) || typeof content !== "string" || content.length > 1024 * 1024) continue;
      if (!mirrorRoom(pid, p.data, Buffer.byteLength(content))) { me.problems[pid] = "Copie des résultats pleine (200 Mo) : les nouveaux résultats de cet appareil ne sont plus copiés."; break; }
      const f = path.join(p.data, rel);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, content);
    }
    for (const w of ["commits", "files"]) if (d.git && typeof d.git[w] === "string") { fs.mkdirSync(base, { recursive: true }); fs.writeFileSync(path.join(base, "git-" + w + ".txt"), d.git[w].slice(0, 4 * 1024 * 1024)); }
    for (const h of (Array.isArray(d.history) ? d.history : []).slice(0, 200)) if (h && typeof h.at === "string" && typeof h.agent === "string") store.append(HISTORY(pid), cleanRun(h));
    for (const n of (Array.isArray(d.notes) ? d.notes : []).slice(0, 20)) if (n && typeof n.text === "string") chat.note(p, n.text.slice(0, 4000));
    // Conversations avec le patron : réponse en cours ou terminée sur l'appareil (lib/chat.js remoteUpdate).
    for (const [cid, u] of Object.entries(d.chats && typeof d.chats === "object" ? d.chats : {}).slice(0, 20)) chat.remoteUpdate(p, cid, u);
    for (const r of (Array.isArray(d.rpc) ? d.rpc : []).slice(0, 20)) {
      if (!r || !/^[0-9a-z-]{8,40}$/.test(String(r.id))) continue;
      const req = path.join(base, "rpc", r.id + ".req.json");
      if (!fs.existsSync(req)) continue;
      store.writeJson(path.join(base, "rpc", r.id + ".res.json"), { result: r.result || null, error: r.error ? admin.str(r.error, 300) : null });
      fs.rmSync(req, { force: true });
    }
    // Réglages changés sur l'appareil (son agent patron règle les autres agents) : appliqués s'ils partent des réglages
    // actuels d'ici, sinon ceux d'ici l'emportent (ils repartent à l'appareil).
    // Dossier des agents supprimé sur l'appareil (03/11 : c'est ainsi qu'on retire tous les agents d'un projet) : retirés
    // ici aussi, au lieu de lui être renvoyés.
    if (d.removed === true) { if (store.peekAgents(pid).length) removeAgents(p, node); }
    else if (d.config && d.config.base === configHash(p) && Array.isArray(d.config.agents)) applyConfig(p, d.config, node);
  }
  // Lancements demandés dans le panel pour ses projets : remis à l'appareil.
  const commands = [];
  try {
    for (const f of store.listDir(COMMANDS).filter((x) => x.endsWith(".json"))) {
      const file = path.join(COMMANDS, f), c = store.readJson(file, null);
      if (c && ids.has(c.project)) { commands.push(c); fs.rmSync(file, { force: true }); }
    }
  } catch (e) { /* aucune demande */ }
  const rpc = mine.flatMap((p) => pendingRpc(p.id).map((f) => ({ ...store.readJson(path.join(store.remoteDir(p.id), "rpc", f), {}), project: p.id })));
  // Messages au patron qui attendent sa réponse sur cet appareil : synchronisation chaque seconde (réponse en direct).
  const chats = mine.flatMap((p) => chat.remoteJobs(p).map((j) => ({ ...j, project: p.id })));
  return { projects: mine.map(configOf), commands, rpc, chats, dropped: dropped(node, body.dropped), bundle: bundle().version, interval: rpc.length || chats.length ? 1 : 5 };
}
// Projets supprimés dans le panel (removeProject) : renvoyés à l'appareil jusqu'à ce qu'il confirme avoir effacé leur
// dossier des agents (acked : leurs identifiants, node.js applyProjects).
function dropped(node, acked) {
  const cur = (store.peekJson(NODES, []).find((x) => x.id === node.id) || {}).dropped || [];
  const done = Array.isArray(acked) ? acked.map(String) : [];
  if (!cur.some((d) => done.includes(d.id))) return cur;
  const list = store.readJson(NODES, []), n = list.find((x) => x.id === node.id);
  if (!n || !n.dropped) return [];
  n.dropped = n.dropped.filter((d) => !done.includes(d.id));
  if (!n.dropped.length) delete n.dropped;
  save(list);
  return n.dropped || [];
}

// Réglages d'un projet envoyés à l'appareil (son project.json local, les agents, leurs consignes, et ses connexions aux
// API d'autres projets avec leurs jetons : ses agents tournent là-bas, lib/connections.js).
function configOf(p) {
  const agents = store.peekAgents(p.id), prompts = {};
  for (const a of agents) prompts[a.prompt || "prompts/" + a.id + ".md"] = store.readPrompt(p.id, a);
  return { id: p.id, base: configHash(p), project: { name: p.name, description: p.description || "", dir: p.dir, envFile: p.envFile || ".env", agentsDir: p.agentsDir || null, dataDir: p.dataDir || "data/agents", testCmd: p.testCmd || "", restartCmd: p.restartCmd || null, allowed: p.allowed, protected: p.protected || null, locked: p.locked || null, rules: p.rules || null }, agents, prompts,
    connections: require("./connections").all(p.id) };
}
function configHash(p) {
  const agents = store.peekAgents(p.id);
  return sha(JSON.stringify(agents) + agents.map((a) => store.readPrompt(p.id, a)).join("\u0000"));
}
// Agents reçus d'un appareil : seulement les champs connus, types d'agents d'un appareil, consigne toujours
// prompts/<id>.md (revue du 02/11 : un chemin de consigne choisi par l'appareil réécrivait d'autres fichiers du projet).
const NODE_KINDS = new Set(["custom", "scout", "supervisor"]);
function cleanAgent(a) {
  const id = String(a.id);
  let schedule = { type: "on-demand" };
  try { schedule = admin.cleanSchedule(a.schedule); } catch (e) { /* horaire illisible : à la demande */ }
  const kind = NODE_KINDS.has(a.kind) ? a.kind : "custom", mode = a.mode === "code" ? "code" : "read";
  let allowed = null;
  if (typeof a.allowed === "string" && a.allowed.length <= 200) { try { new RegExp(a.allowed); allowed = a.allowed; } catch (e) { /* zone illisible : celle du projet */ } }
  return { id, name: admin.str(a.name, 60) || id, icon: admin.str(a.icon, 8) || "🤖", kind, enabled: a.enabled !== false, description: admin.str(a.description, 400),
    prompt: "prompts/" + id + ".md", schedule, budgetUsd: Math.min(20, Math.max(0.1, Number(a.budgetUsd) || 2)), mode,
    ...(mode === "code" || kind === "supervisor" ? { maxLines: Math.min(1000, Math.max(10, Math.round(Number(a.maxLines)) || 150)) } : {}),
    ...(a.web ? { web: true } : {}), ...(allowed ? { allowed } : {}), // options d'un agent personnalisé (lib/kinds.js)
    ...(Array.isArray(a.skipIfUnchanged) ? { skipIfUnchanged: a.skipIfUnchanged.filter((f) => typeof f === "string").slice(0, 10).map((f) => f.slice(0, 300)) } : {}),
    ...(Number(a.maxMinutes) > 0 ? { maxMinutes: Math.min(60, Math.max(2, Math.round(Number(a.maxMinutes)))) } : {}), ...(a.quiet ? { quiet: true } : {}) };
}
const applied = new Map(); // projet -> dernière application (au plus une par minute : pas un commit à chaque synchronisation)
function applyConfig(p, cfg, node) {
  if (Date.now() - (applied.get(p.id) || 0) < 60e3) return;
  applied.set(p.id, Date.now());
  const files = [store.agentsFile(p.id)];
  const seen = new Set();
  const agents = cfg.agents.filter((a) => a && store.ID_RE.test(String(a.id)) && !seen.has(String(a.id)) && seen.add(String(a.id))).slice(0, 30).map(cleanAgent);
  for (const a of agents) {
    const text = cfg.prompts && cfg.prompts[a.prompt];
    if (typeof text === "string" && text.length < 200000 && text !== store.readPrompt(p.id, a)) { store.writePrompt(p.id, a, text); files.push(store.promptPath(p.id, a)); }
  }
  store.writeAgents(p.id, agents);
  admin.commitConfig(p.name + " · réglages changés sur l'appareil « " + node.name + " »", files, "Agent patron");
}
function removeAgents(p, node) {
  const files = [store.agentsFile(p.id)];
  for (const a of store.listAgents(p.id)) { try { const f = store.promptPath(p.id, a); fs.rmSync(f, { force: true }); files.push(f); } catch (e) { /* consigne illisible */ } }
  store.writeAgents(p.id, []);
  admin.commitConfig(p.name + " · agents retirés sur l'appareil « " + node.name + " » (dossier " + (p.agentsDir || "des agents") + " supprimé)", files, "Panel");
}

// ---------- demandes du panel à l'appareil ----------
// Détail d'un commit, etc. : l'appareil répond à sa prochaine synchronisation (1 s quand une demande attend).
async function ask(p, req) {
  const n = findNode((x) => x.id === p.node);
  if (!n || !online(n)) throw fail("L'appareil « " + (n ? n.name : "?") + " » est hors ligne : réessaie quand il est allumé.", 503);
  const id = Date.now().toString(36) + "-" + crypto.randomBytes(4).toString("hex"), dir = path.join(store.remoteDir(p.id), "rpc");
  store.writeJson(path.join(dir, id + ".req.json"), { id, ...req, at: now() });
  asking.add(p.id);
  const res = path.join(dir, id + ".res.json");
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const r = store.readJson(res, null);
    if (r) { fs.rmSync(res, { force: true }); if (r.error) throw fail(r.error, 502); return r.result; }
  }
  fs.rmSync(path.join(dir, id + ".req.json"), { force: true });
  throw fail("L'appareil n'a pas répondu à temps.", 504);
}

// ---------- programme de l'appareil ----------
// Fichiers envoyés à l'appareil (aucun secret : le code des agents et du runner). Version = empreinte du contenu.
// Nouvelle version publiée seulement quand ses fichiers n'ont plus bougé depuis 30 s et que tous ses modules se chargent
// (03/11 : une version prise au milieu d'une mise à jour du code, « busyNote is not defined », a bloqué un ordinateur connecté :
// sa synchronisation plantait avant de pouvoir recevoir la suivante). Sinon, la dernière bonne version reste servie ;
// elle est gardée sur le disque (data/node-bundle.json) pour un panel qui redémarre sur un code cassé.
const SETTLE_MS = 30e3;
const GOOD = path.join(store.RUNTIME, "node-bundle.json");
// Chaque module du programme chargé dans un process à part, depuis une copie jetable -> message d'erreur, ou null.
const checkBundle = (files) => require("./loadcheck").checkCopy(files);
let cache = null, pending = null;
function bundle() {
  if (cache && Date.now() - cache.checked < 10e3) return cache; // fichiers vérifiés au plus toutes les 10 s
  const root = store.ROOT;
  // lib/*.md aussi : regles-communes.md (règles de tous les agents, lib/context.js withCommonRules) ; sans lui, les agents
  // des ordinateurs connectés ne les recevaient pas (02/11).
  const files = ["node.js", "runner.js", "package.json", ...fs.readdirSync(path.join(root, "lib")).filter((f) => (f.endsWith(".js") || f.endsWith(".md")) && !["auth.js", "mfa.js", "nodes.js", "boss-cases.js"].includes(f)).map((f) => "lib/" + f)];
  const stamp = files.map((f) => { try { return fs.statSync(path.join(root, f)).mtimeMs; } catch (e) { return 0; } }).join(",");
  if (cache && cache.stamp === stamp) { cache.checked = Date.now(); pending = null; return cache; }
  if (cache && (!pending || pending.stamp !== stamp || Date.now() - pending.since < SETTLE_MS)) {
    if (!pending || pending.stamp !== stamp) pending = { stamp, since: Date.now() }; // encore en train de changer
    cache.checked = Date.now();
    return cache;
  }
  const out = {};
  for (const f of files) out[f] = fs.readFileSync(path.join(root, f), "utf8");
  const version = sha(JSON.stringify(out)).slice(0, 16);
  const bad = cache && cache.version === version ? null : checkBundle(out);
  pending = null;
  if (bad) {
    const good = cache || store.readJson(GOOD, null);
    console.warn("[agents] version " + version + " du programme des appareils pas publiée : " + bad);
    if (good) { cache = { ...good, stamp, checked: Date.now(), refused: { version, error: bad } }; return cache; }
  }
  cache = { stamp, checked: Date.now(), version, files: out };
  if (!bad) { try { store.writeJson(GOOD, { version, files: out }); } catch (e) { /* gardée en mémoire */ } }
  return cache;
}

// ---------- panel ----------
const listFor = (u) => store.peekJson(NODES, []).filter((n) => n.owner === u.id).map((n) => view(merged(n)));
function nodeFor(u, id) {
  const n = findNode((x) => x.id === id && x.owner === u.id);
  if (!n) throw fail("Appareil inconnu.", 404);
  return n;
}
// Projet retiré du panel : réglages effacés (gardés dans l'historique git) ; passages, conversations, notifications et
// connexions aussi (un nouveau projet du même nom n'hérite de rien).
function forget(p, message) {
  fs.rmSync(path.join(store.PROJECTS, p.id), { recursive: true, force: true });
  fs.rmSync(store.remoteDir(p.id), { recursive: true, force: true });
  for (const f of [HISTORY(p.id), path.join(store.RUNTIME, "chat", p.id), path.join(store.RUNTIME, "chat", p.id + ".notes.jsonl"), require("./connections").file(p.id)]) fs.rmSync(f, { recursive: true, force: true });
  admin.commitConfig(message, [path.join(store.PROJECTS, p.id)], "Panel");
}
// Retirer un appareil : ses projets disparaissent du panel, son jeton ne marche plus.
function remove(u, id) {
  const n = nodeFor(u, id);
  for (const p of projectsOf(n.id)) forget(p, "projet « " + p.name + " » retiré avec l'appareil « " + n.name + " »");
  store.forgetProjects();
  live.delete(n.id);
  save(store.readJson(NODES, []).filter((x) => x.id !== n.id));
}
// Supprimer un projet depuis le panel (demande du 03/11) : il disparaît avec ses agents (dossier agents-ia : consignes et
// résultats), ses passages, conversations et connexions ; son code n'est pas touché. Projet d'ici : dossier des agents
// effacé tout de suite ; d'un appareil : à sa prochaine synchronisation (dropped). Lancements en attente retirés, clés
// d'API limitées à ce projet sans lui.
function removeProject(p) {
  try {
    for (const f of store.listDir(COMMANDS).filter((x) => x.endsWith(".json"))) {
      const c = store.readJson(path.join(COMMANDS, f), null);
      if (c && c.project === p.id) fs.rmSync(path.join(COMMANDS, f), { force: true });
    }
  } catch (e) { /* aucune demande */ }
  let where = "";
  if (p.node) {
    const list = store.readJson(NODES, []), n = list.find((x) => x.id === p.node);
    if (n) {
      n.dropped = [...(n.dropped || []).filter((d) => d.id !== p.id), { id: p.id, dir: p.dir, agentsDir: p.agentsDir || null, at: now() }].slice(-50);
      save(list);
      where = " (appareil « " + n.name + " »)";
    }
  } else {
    const home = store.agentsHome(p.id);
    if (home !== path.join(store.PROJECTS, p.id)) fs.rmSync(home, { recursive: true, force: true });
  }
  require("./apikeys").forgetProject(p.id);
  forget(p, "projet « " + p.name + " » supprimé" + where);
  store.forgetProjects();
}
const nodeOfProject = (p) => { const n = p.node && findNode((x) => x.id === p.node); return n ? { id: n.id, name: n.name, online: online(n), lastSeen: n.lastSeen || null, current: online(n) ? (n.status && n.status.current) || null : null, problem: (n.problems || {})[p.id] || null } : null; };

module.exports = { createCode, codeOwner, enroll, byToken, sync, ask, bundle, checkBundle, listFor, nodeFor, createProject, remove, removeProject, nodeOfProject, online, cleanAgent };

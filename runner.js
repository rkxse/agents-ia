// Runner des agents IA de tous les projets (process pm2 goldpilot-agents, lancé par le bot GOLD PILOT à son démarrage).
// Toutes les minutes, pour chaque projet de projects/ :
//  - rien si son process pm2 (project.pm2Process) est arrêté exprès : un agent ne le relance jamais ;
//  - un seul travail à la fois par projet (verrou <data>/lock, repris au bout de 45 min si le process a été tué) ;
//  - d'abord les demandes du panel (« Lancer maintenant », data/commands/), puis les agents actifs dont l'horaire est
//    venu (lib/schedule.js), dans l'ordre de agents.json.
// agents.json et les consignes sont relus à chaque passage : une modification faite dans le panel compte tout de suite.
// État du runner (pour le panel) : data/runner.json ; historique de chaque passage : data/history/<projet>.jsonl.
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const store = require("./lib/store");
const schedule = require("./lib/schedule");
const { makeContext } = require("./lib/context");
const generic = require("./lib/kinds");
const { revertCommit } = require("./lib/revert");
const team = require("./lib/team");

const TICK_MS = 60e3;
const LOCK_STALE_MS = 45 * 60e3;
const STATUS = path.join(store.RUNTIME, "runner.json");
const COMMANDS = path.join(store.RUNTIME, "commands");
const HISTORY = (id) => path.join(store.RUNTIME, "history", id + ".jsonl");
fs.mkdirSync(COMMANDS, { recursive: true });

// Un seul runner (pm2, ou node.js sur un appareil) : à son démarrage, un verrou restant vient d'un passage coupé par un
// redémarrage ; on le retire pour ne pas bloquer le projet 45 min (31/10 : deux redémarrages ont laissé le projet
// verrouillé). Seulement au démarrage du runner, jamais quand un autre outil charge ce fichier (revue du 02/11 : le
// verrou d'un agent en plein travail sautait, et un second passage pouvait partir en même temps).
function clearLocks() {
  for (const x of store.listProjects()) {
    try { fs.rmSync(path.join(store.project(typeof x === "string" ? x : x.id).data, "lock"), { force: true }); } catch (e) { /* projet illisible */ }
  }
}

const log = (...a) => console.log("[agents]", ...a);
const adminId = () => { try { return (require("./lib/auth").admin() || {}).id || null; } catch (e) { return null; } };
const status = { pid: process.pid, startedAt: new Date().toISOString(), beat: null, current: null };
const currentRuns = new Map(); // projet -> passage en cours (les projets tournent en parallèle)
const saveStatus = () => { status.beat = new Date().toISOString(); try { store.writeJson(STATUS, status); } catch (e) { /* jamais bloquant */ } };

// Process pm2 en ligne (une lecture de pm2 par passage), seulement si un projet en a un. 02/11 : sur un ordinateur
// d'utilisateur, le programme relancé après une mise à jour (sans console) restait bloqué pour toujours sur
// « pm2 jlist », hors ligne ; d'où aussi le délai maximum.
function pm2Online(projects) {
  if (!projects.some((p) => p.pm2Process)) return null;
  const r = spawnSync("pm2 jlist", { shell: true, encoding: "utf8", windowsHide: true, maxBuffer: 20 * 1024 * 1024, timeout: 30000 });
  try { return new Set(JSON.parse((r.stdout || "").trim().split(/\r?\n/).pop() || "[]").filter((p) => p.pm2_env && p.pm2_env.status === "online").map((p) => p.name)); } catch (e) { return null; }
}

function projectModule(p) {
  const f = path.join(p.home, "kinds.js");
  if (!fs.existsSync(f)) return { kinds: {} };
  delete require.cache[require.resolve(f)]; // relu à chaque passage (modifications sans redémarrer)
  return require(f);
}

async function withLock(p, fn) {
  const lock = path.join(p.data, "lock");
  try { if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) fs.rmSync(lock, { force: true }); } catch (e) { /* pas de verrou */ }
  try { fs.closeSync(fs.openSync(lock, "wx")); } catch (e) { return false; }
  try { await fn(); return true; } finally { fs.rmSync(lock, { force: true }); }
}

// Lance un agent (déjà sous verrou) et note le passage. source : "horaire", "panel" ou l'agent qui l'a déclenché.
async function runOne(p, ctx, mod, a, args, source) {
  const fn = (mod.kinds && mod.kinds[a.kind]) || generic[a.kind];
  if (!fn) { log(p.id + "/" + a.id + " : type inconnu « " + a.kind + " »"); return null; }
  const t0 = Date.now();
  store.setLastRun(p, a.id, { lastAt: new Date().toISOString() }); // noté avant : un plantage ne relance pas en boucle
  const cur = { project: p.id, agent: a.id, name: a.name, since: new Date().toISOString(), source };
  currentRuns.set(p.id, cur); status.current = cur;
  saveStatus();
  // Durée maximale d'un passage propre à l'agent (maxMinutes, ex. 5 min pour travailler par petits pas), sinon 25 min.
  ctx.timeoutMs = a.maxMinutes ? a.maxMinutes * 60e3 : undefined;
  ctx.passage = null; // chaque agent commence son propre passage (lib/context.js untrackedSet)
  // Fil des agents (lib/team.js) : messages reçus remis et équipe présentée (consigne système, lib/context.js claude) ;
  // à la fin, ses messages aux autres agents sont relevés et les destinataires actifs réveillés. Jamais bloquant.
  try { ctx.team = team.prepare(p, a); } catch (e) { ctx.team = ""; log(p.id + "/" + a.id + " : fil des agents illisible : " + e.message); }
  let r;
  try { r = (await fn(ctx, a, args || {})) || {}; } catch (e) { r = { status: "erreur", summary: e.message }; log(p.id + "/" + a.id + " : " + e.message); }
  ctx.team = "";
  ctx.timeoutMs = undefined;
  try { for (const m of team.collect(p, a, (args && args.depth) || 0)) log(p.id + "/" + a.id + " → " + m.to + " : " + m.wake); } catch (e) { log(p.id + "/" + a.id + " : messages pas relevés : " + e.message); }
  const entry = { at: new Date().toISOString(), agent: a.id, source, status: r.status || "ok", cost: r.cost == null ? null : Math.round(r.cost * 10000) / 10000,
    summary: r.summary ? String(r.summary).slice(0, 500) : null, commit: r.commit || null, seconds: Math.round((Date.now() - t0) / 1000), args: args && Object.keys(args).length ? args : undefined };
  store.setLastRun(p, a.id, { lastStatus: entry.status, lastCost: entry.cost, lastSummary: entry.summary, lastSeconds: entry.seconds });
  if (entry.status !== "rien" || source !== "horaire") store.append(HISTORY(p.id), entry); // pas de ligne pour un passage sans travail
  currentRuns.delete(p.id); status.current = [...currentRuns.values()].pop() || null;
  saveStatus();
  // Problème signalé (bilan « attention », ou redémarrage en échec après un commit) : le patron le traite tout de suite.
  // Même un problème répété (r.repeat) : un défaut qui revient après traitement doit remonter à sa cause (escalate).
  if (a.kind !== "supervisor" && (entry.status === "attention" || (entry.status === "erreur" && entry.commit))) {
    try { await escalate(p, ctx, mod, a, entry); } catch (e) { log(p.id + " : alerte au patron impossible : " + e.message); }
  }
  return r;
}

// Demande du propriétaire (02/11) : « dès que le patron détecte une erreur, il doit pouvoir la corriger », pour tous les
// projets. Le patron (s'il est actif) reçoit le problème qu'un agent vient de signaler (lib/kinds.js supervisor,
// args.alerte) : il corrige si la cause est dans le code (tests obligatoires, zones protégées respectées), sinon il dit
// quoi faire. Au plus une alerte par heure et par projet (pas de passages en rafale) ; une alerte écartée reste visible par
// le patron à son passage habituel (bilans des agents dans ses données).
// Règle commune « un défaut se corrige à sa cause » (lib/regles-communes.md, 02/11) : le même défaut (même agent, mêmes
// sujets) qui revient après une première alerte repart une seconde fois au patron, avec l'exigence d'une enquête sur la
// cause ; ensuite plus d'alerte (pas de boucle) : il reste dans les alertes de l'accueil pour le propriétaire. Avant,
// un défaut déjà signalé n'était plus jamais remonté, même s'il revenait après un « corrigé ».
const ALERT_GAP_MS = 60 * 60e3;
async function escalate(p, ctx, mod, a, entry) {
  const boss = store.listAgents(p.id).find((x) => x.kind === "supervisor" && x.enabled !== false);
  if (!boss) return;
  const res = ctx.readJson("agents/" + a.id + ".json", null); // bilan détaillé d'un agent personnalisé
  const pts = ((res && res.points) || []).filter((x) => x && x.gravite !== "basse").slice(0, 8);
  const text = ("Agent « " + a.name + " » (" + a.id + ") : " + (entry.summary || "") +
    pts.map((x) => "\n- [" + x.gravite + "] " + x.sujet + " : " + (x.detail || "") + (x.action ? " (action proposée : " + x.action + ")" : "")).join("")).slice(0, 3000);
  // Empreinte stable d'un défaut : l'agent et les sujets de ses points (sinon son résumé, chiffres retirés), pas le texte
  // entier qui change à chaque passage (heure, numéro de passage).
  const key = pts.length ? pts.map((x) => x.gravite + "|" + String(x.sujet || "").trim().toLowerCase()).sort().join("\n") : String(entry.summary || "").replace(/\d+/g, "#");
  const h = require("crypto").createHash("sha256").update(a.id + "\n" + key).digest("hex").slice(0, 16);
  const f = path.join(p.data, "boss-alertes.json"), st = store.readJson(f, { at: 0, seen: {} });
  const seen = Array.isArray(st.seen) ? Object.fromEntries(st.seen.map((x) => [x, 1])) : st.seen || {};
  const n = seen[h] || 0;
  if (n >= 2) return; // signalé puis revenu une fois : au propriétaire (alertes de l'accueil), plus de boucle
  if (Date.now() - st.at < ALERT_GAP_MS) { log(p.id + " : alerte de « " + a.name + " » gardée pour le passage habituel du patron (une alerte par heure)"); return; }
  seen[h] = n + 1;
  store.writeJson(f, { at: Date.now(), seen: Object.fromEntries(Object.entries(seen).slice(-50)) });
  const again = n === 1 ? "\n\n**Ce défaut revient : il t'a déjà été signalé, et ce qui a été fait ne l'a pas fait disparaître.** Un « corrigé » ne prouve rien si le symptôme revient. " +
    "Remonte à sa cause (source des données, vérification contre une référence indépendante, enquête avec le cas exact), jamais en changeant une consigne pour « faire avec ». " +
    "Si la cause est hors de ta portée, mets un point de gravité haute pour le propriétaire avec le fichier, la preuve chiffrée et la correction proposée." : "";
  log(p.id + " : « " + a.name + " » a signalé " + (n ? "de nouveau le même défaut" : "un problème") + ", le patron le traite");
  await runOne(p, ctx, mod, boss, { alerte: text + again, de: a.id, ...(n ? { revenu: true } : {}) }, (n ? "défaut revenu (« " : "alerte de « ") + a.name + " »" + (n ? ")" : ""));
}

function takeCommands(projectId) {
  const out = [];
  for (const f of fs.readdirSync(COMMANDS).filter((x) => x.endsWith(".json")).sort()) {
    const file = path.join(COMMANDS, f);
    const c = store.readJson(file, null);
    if (!c || c.project !== projectId) continue;
    fs.rmSync(file, { force: true });
    out.push(c);
  }
  return out;
}

// horaire = false (runner.js --once --sans-horaire, appareil qui sort de veille ou vient de démarrer, node.js) : seulement
// les lancements demandés.
async function tickProject(p, online, horaire = true) {
  if (p.node) return; // projet d'un autre appareil : ses agents tournent là-bas (node.js), jamais ici
  // Seuls les projets de l'administrateur tournent sur ce serveur : un projet d'un autre compte, même sans « node » (fichier
  // réécrit, erreur), n'y fait jamais rien (revue du 02/11). Sur un appareil, pas de comptes : ses projets n'ont pas d'owner.
  if (p.owner && p.owner !== adminId()) { log(p.id + " : projet d'un autre compte, ignoré ici"); return; }
  if (p.pm2Process && online && !online.has(p.pm2Process)) return; // projet arrêté exprès
  const agents = store.listAgents(p.id);
  if (!agents.length) return;
  const mod = projectModule(p);
  const ctx = makeContext(p, (...a) => log(p.id + " ·", ...a));
  // Premier passage : horaires repris de l'ancien état (seed) pour ne pas tout relancer d'un coup.
  const runs = store.lastRuns(p);
  if (mod.seed && !Object.keys(runs).length) for (const [id, at] of Object.entries(mod.seed(ctx) || {})) if (at) store.setLastRun(p, id, { lastAt: at });
  ctx.runAgent = (id, args) => { const a = store.listAgents(p.id).find((x) => x.id === id); return a && a.enabled !== false ? runOne(p, ctx, mod, a, args, "déclenché") : null; };
  await withLock(p, async () => {
    for (const c of takeCommands(p.id)) {
      if (c.revert) { await revertCommit(p, ctx, String(c.revert)); continue; }
      const a = store.listAgents(p.id).find((x) => x.id === c.agent);
      // Relance demandée par le patron, mais l'agent a déjà tourné depuis (son horaire est venu entre-temps) : inutile de
      // repasser (02/11 : la Revue passait deux fois de suite pour rien). Une question (enquête) passe toujours.
      const lastAt = a && (store.lastRuns(p)[a.id] || {}).lastAt;
      if (a && c.by === "boss" && !(c.args && c.args.question) && c.at && lastAt && lastAt > c.at) { log(p.id + "/" + a.id + " : déjà passé depuis la demande du patron"); continue; }
      // Réveil par un message d'un autre agent (lib/team.js) : inutile s'il l'a déjà lu à un passage entre-temps.
      if (a && c.args && c.args.message && !team.unread(p, a.id).length) { log(p.id + "/" + a.id + " : message déjà remis à un passage précédent"); continue; }
      const from = /^agent:/.test(String(c.by || "")) ? (store.listAgents(p.id).find((x) => "agent:" + x.id === c.by) || { name: String(c.by).slice(6) }).name : null;
      if (a) await runOne(p, ctx, mod, a, c.args, c.by === "boss" ? "agent patron" : c.by === "chat" ? "conversation" : from ? "message de « " + from + " »" : "panel");
    }
    if (!horaire) return;
    // Agents à heure fixe d'abord : derrière les autres, l'optimisation partait avec 2 h de retard (patron, 01/11).
    const list = store.listAgents(p.id);
    for (const a of [...list.filter((x) => (x.schedule || {}).type === "daily"), ...list.filter((x) => (x.schedule || {}).type !== "daily")]) {
      if (a.enabled === false) continue;
      const last = (store.lastRuns(p)[a.id] || {}).lastAt || null;
      let due = false;
      try { due = schedule.isDue(a.schedule, last, new Date(), mod.activity || (() => 0)); } catch (e) { log(p.id + "/" + a.id + " : horaire illisible (" + e.message + ")"); }
      if (due) await runOne(p, ctx, mod, a, {}, "horaire");
    }
  });
}

// Projets en parallèle, chacun avec un seul travail à la fois (verrou) : avant (02/11), un passage de chaque projet à la
// suite ; un projet dont les agents travaillent sans arrêt aurait retardé les autres (ex. la correction des messages de
// GOLD PILOT, toutes les 15 min). Un projet encore en cours n'est pas relancé ; tick() attend les projets qu'il a lancés.
const running = new Set();
async function tick({ horaire = true } = {}) {
  saveStatus();
  let projects = [], online = null;
  try { projects = store.listProjects(); online = pm2Online(projects); } catch (e) { log("projets illisibles : " + e.message); }
  await Promise.all(projects.filter((p) => !running.has(p.id)).map(async (p) => {
    running.add(p.id);
    try { await tickProject(p, online, horaire); } catch (e) { log(p.id + " : passage impossible : " + e.message); } finally { running.delete(p.id); saveStatus(); }
  }));
}

// Code des agents mis à jour (runner.js, lib/) : le runner se relance tout seul entre deux passages (pm2 le redémarre),
// et tous les agents de tous les projets passent avec les nouvelles règles (question du propriétaire, 03/11 : « comment
// faire pour que les agents se mettent à jour avec les nouvelles règles ? »). Consignes, règles communes
// (lib/regles-communes.md), agents.json et kinds.js d'un projet sont déjà relus à chaque passage ; un appareil relance
// son runner à chaque passage (node.js) ; le patron d'une conversation est un nouveau process à chaque message.
// Relance seulement quand les fichiers n'ont plus bougé depuis le tour précédent (pas au milieu d'une mise à jour), et
// que le nouveau code se charge (lib/loadcheck.js) : sinon l'ancien continue de tourner, et pm2 ne relance pas en boucle
// un runner qui plante.
const codeStamp = (dir = __dirname) => {
  let files = [];
  try { files = fs.readdirSync(path.join(dir, "lib")).filter((f) => f.endsWith(".js")).map((f) => path.join(dir, "lib", f)); } catch (e) { /* pas de lib */ }
  return [path.join(dir, "runner.js"), ...files].map((f) => { try { return f + ":" + fs.statSync(f).mtimeMs; } catch (e) { return f + ":0"; } }).join("|");
};
function codeWatcher(stamp = codeStamp) {
  const loaded = stamp();
  let seen = null;
  return () => {
    const s = stamp();
    if (s === loaded) { seen = null; return false; }
    if (s !== seen) { seen = s; return false; } // encore en train de changer : on attend le tour suivant
    return true;
  };
}

module.exports = { tick, runOne, clearLocks, codeWatcher };

if (require.main === module) {
  // --once : un seul passage puis fin. L'appareil (node.js) le lance chaque minute dans son propre process : les tests
  // et le redémarrage d'un projet (git-guard, en attente synchrone) ne figent plus sa synchronisation avec le panel.
  if (process.argv.includes("--once")) tick({ horaire: !process.argv.includes("--sans-horaire") }).catch((e) => log("passage impossible : " + e.message)).finally(() => process.exit(0));
  else {
    clearLocks();
    log("actif : " + store.listProjects().map((p) => p.name + " (" + store.listAgents(p.id).filter((a) => a.enabled !== false).length + " agents)").join(", "));
    saveStatus();
    const updated = codeWatcher();
    let refused = null;
    setTimeout(tick, 20e3);
    setInterval(() => {
      if (!running.size && updated()) {
        const stamp = codeStamp();
        const bad = stamp === (refused && refused.stamp) ? refused.error : require("./lib/loadcheck").check(require("./lib/loadcheck").programFiles(__dirname));
        if (!bad) { log("code des agents mis à jour : redémarrage pour prendre les nouvelles règles"); process.exit(0); }
        if (!refused || refused.stamp !== stamp) log("nouveau code des agents en erreur, l'ancien continue de tourner : " + bad);
        refused = { stamp, error: bad };
      }
      tick();
    }, TICK_MS);
    setInterval(saveStatus, 20e3);
  }
}

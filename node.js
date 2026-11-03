// Programme de l'appareil (« nœud ») : fait tourner les agents des projets de cet ordinateur et les relie au panel
// (lib/nodes.js côté panel). Installé par la commande donnée dans le panel (« Connecter un appareil »), dans
// %LOCALAPPDATA%\AgentsIA (Windows) ou ~/.agents-ia (macOS, Linux), et lancé au démarrage de la session.
//  - node node.js --enroll <panel> <code> <dossier du projet> [nom] : enregistre l'appareil et ce projet.
//  - node node.js : boucle. Toutes les 10 s (1 s si le panel attend une réponse), envoie au panel l'état, les passages,
//    les notifications, les résultats des agents, les journaux git et les réglages changés ici ; reçoit les réglages
//    des agents, les lancements demandés et les demandes du panel. Toutes les minutes, le runner (runner.js, le même
//    que sur le serveur) lance les agents dont l'horaire est venu, avec le Claude de cet ordinateur.
//  - Mise à jour : quand le panel a une nouvelle version, elle est téléchargée et le programme repart (jamais pendant
//    qu'un agent tourne).
process.env.AGENTS_NO_PUSH = "1"; // les notifications partent du panel, pas d'ici
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawn, spawnSync } = require("child_process");
const store = require("./lib/store");
const gitinfo = require("./lib/gitinfo");

const CONF = path.join(store.RUNTIME, "node.json");
const STATE = path.join(store.RUNTIME, "node-state.json");
const PID = path.join(store.RUNTIME, "node.pid");
const VERSION_FILE = path.join(__dirname, "version.txt");
const log = (...a) => console.log(new Date().toISOString().slice(0, 19).replace("T", " ") + " [nœud]", ...a);
const sha = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");

function info() {
  const claude = spawnSync(require("./lib/claude").CLAUDE, ["--version"], { encoding: "utf8", windowsHide: true, timeout: 20000 });
  return { os: os.type() + " " + os.release(), host: os.hostname(), node: process.version, claude: (claude.stdout || "").trim().slice(0, 40) || "introuvable", version: version() };
}
const version = () => { try { return fs.readFileSync(VERSION_FILE, "utf8").trim(); } catch (e) { return "?"; } };
async function api(conf, p, body, method = "POST") {
  const r = await fetch(conf.server + p, { method, headers: { "Content-Type": "application/json", Authorization: "Bearer " + conf.token }, body: method === "POST" ? JSON.stringify(body || {}) : undefined, signal: AbortSignal.timeout(60000) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(d.error || "panel : erreur " + r.status), { status: r.status });
  return d;
}

// ---------- enregistrement ----------
async function enroll(server, code, dir, name) {
  dir = path.resolve(dir);
  if (!fs.existsSync(path.join(dir, ".git"))) throw new Error("Ce dossier n'est pas un dépôt git : " + dir + " (lance « git init » puis un premier commit).");
  const testCmd = fs.existsSync(path.join(dir, "package.json")) && /"test"\s*:/.test(fs.readFileSync(path.join(dir, "package.json"), "utf8")) ? "npm test"
    : fs.existsSync(path.join(dir, "pytest.ini")) || fs.existsSync(path.join(dir, "pyproject.toml")) ? "python -m pytest" : "";
  const r = await fetch(server.replace(/\/+$/, "") + "/api/node/enroll", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code, name: os.hostname(), info: info(), project: { name: name || path.basename(dir), dir: dir.replace(/\\/g, "/"), testCmd } }) });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || "panel : erreur " + r.status);
  store.writeJson(CONF, { server: server.replace(/\/+$/, ""), id: d.node.id, name: d.node.name, token: d.token });
  ignoreData(dir);
  console.log("Appareil « " + d.node.name + " » connecté" + (d.project ? ", projet « " + d.project.name + " » ajouté" : "") + ".");
}
// Dossier des agents (agents-ia, 03/11) et anciens résultats (data/agents) du projet : ignorés par git sur cet
// ordinateur seulement (.git/info/exclude).
const ignoreData = (dir) => store.excludeLocal(dir, ["/data/agents/", "/" + store.AGENTS_DIR + "/"]);

// ---------- ce que l'appareil envoie ----------
const linesOf = (f) => { try { return fs.readFileSync(f, "utf8").split(/\r?\n/).filter(Boolean); } catch (e) { return []; } };
// Fichiers de résultats des agents (JSON, JSONL) dans le dossier de données du projet, changés depuis le dernier envoi.
function changedFiles(p, sent) {
  const out = {}, seen = {};
  const walk = (dir, rel, depth) => {
    let names = [];
    try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
    for (const d of names) {
      const r = rel ? rel + "/" + d.name : d.name, f = path.join(dir, d.name);
      if (d.isDirectory()) { if (depth < 2 && !/^(tmp|chat-files|chat-consignes|video|harness)$/.test(d.name)) walk(f, r, depth + 1); continue; }
      if (!/\.(json|jsonl)$/.test(d.name) || /^(agents-runs|chat-data|lock|commit-msg)/.test(d.name)) continue;
      const st = fs.statSync(f), key = st.size + ":" + st.mtimeMs;
      seen[r] = key;
      if (sent[r] === key) continue;
      if (d.name.endsWith(".jsonl")) out[r] = linesOf(f).slice(-300).join("\n") + "\n";
      else if (st.size < 900 * 1024) out[r] = fs.readFileSync(f, "utf8");
    }
  };
  walk(p.data, "", 0);
  return { out, seen };
}
function localConfigHash(p) {
  const agents = store.listAgents(p.id);
  return sha(JSON.stringify(agents) + agents.map((a) => store.readPrompt(p.id, a)).join("\u0000"));
}
function collect(state, results) {
  const projects = {}, marks = {};
  for (const p of store.listProjects()) {
    const s = (state.p[p.id] = state.p[p.id] || { history: 0, notes: 0, sent: {}, head: "", base: "" });
    const d = (projects[p.id] = {});
    if (!fs.existsSync(path.join(p.dir, ".git"))) d.problem = "Dossier introuvable ou sans git sur l'appareil : " + p.dir;
    d.runs = store.readJson(path.join(p.data, "agents-runs.json"), {});
    const h = linesOf(path.join(store.RUNTIME, "history", p.id + ".jsonl")), n = linesOf(path.join(store.RUNTIME, "chat", p.id + ".notes.jsonl"));
    // Journal élagué entre-temps (lib/store.js, au-delà de 5 Mo) : on repart de sa fin, sans rien renvoyer deux fois.
    if (s.history > h.length) s.history = h.length;
    if (s.notes > n.length) s.notes = n.length;
    d.history = h.slice(s.history, s.history + 1000).map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
    d.notes = n.slice(s.notes, s.notes + 100).map((l) => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
    const f = changedFiles(p, s.sent);
    d.files = f.out;
    // Journaux git : quand le dernier commit change.
    const head = d.problem ? "" : (spawnSync("git", ["rev-parse", "HEAD"], { cwd: p.dir, encoding: "utf8", windowsHide: true }).stdout || "").trim();
    if (head && head !== s.head) d.git = { commits: gitinfo.gitLog(p, "commits"), files: gitinfo.gitLog(p, "files") };
    // Dossier des agents supprimé sur cet ordinateur (03/11 : c'est ainsi qu'on retire tous les agents d'un projet) : le
    // panel les retire aussi, au lieu de les renvoyer. Seulement une fois les agents écrits à leur emplacement actuel
    // (applyProjects : s.where) : juste après la mise à jour du 03/11, le dossier agents-ia n'existe pas encore, et ses
    // agents « absents » auraient été effacés du panel.
    const file = store.agentsFile(p.id);
    if (s.where === file && s.count && !fs.existsSync(file)) d.removed = true;
    // Réglages changés ici (agent patron) depuis ceux reçus du panel.
    else if (s.base && s.where === file && localConfigHash(p) !== s.localHash) {
      const agents = store.listAgents(p.id), prompts = {};
      for (const a of agents) prompts[a.prompt || "prompts/" + a.id + ".md"] = store.readPrompt(p.id, a);
      d.config = { base: s.base, agents, prompts };
    }
    d.rpc = results.filter((r) => r.project === p.id);
    // Conversations avec le patron reçues du panel : réponse en cours ou terminée (lib/chat.js remoteStatus).
    const chats = require("./lib/chat").remoteStatus(p);
    if (Object.keys(chats).length) d.chats = chats;
    marks[p.id] = { history: s.history + d.history.length, notes: s.notes + d.notes.length, seen: f.seen, head: head || s.head,
      chatsDone: Object.keys(chats).filter((cid) => chats[cid].done) };
  }
  return { projects, marks };
}

// ---------- ce que l'appareil reçoit ----------
function applyProjects(list, state, dropped = []) {
  const keep = new Set(list.map((c) => c.id));
  // Projet supprimé dans le panel (03/11) : son dossier des agents (agents-ia : agents, consignes, résultats) est effacé
  // ici aussi, puis confirmé au panel (state.dropped, envoyé à la synchronisation suivante). Seulement un dossier d'agents
  // (LISEZMOI.md ou agents.json dedans), jamais le code du projet ; s'il ne s'efface pas (fichier ouvert), réessayé.
  for (const d of Array.isArray(dropped) ? dropped : []) {
    if (!d || !store.ID_RE.test(String(d.id))) continue;
    const local = store.readJson(path.join(store.PROJECTS, d.id, "project.json"), null) || d;
    const home = typeof local.dir === "string" && /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,39}$/.test(String(local.agentsDir)) ? path.join(local.dir, local.agentsDir) : null;
    try {
      if (!keep.has(d.id) && home && ["LISEZMOI.md", "agents.json"].some((f) => fs.existsSync(path.join(home, f)))) { fs.rmSync(home, { recursive: true, force: true }); log("projet « " + (local.name || d.id) + " » supprimé dans le panel : dossier " + home + " effacé"); }
      state.dropped = [...new Set([...(state.dropped || []), d.id])];
    } catch (e) { log("dossier des agents de « " + (local.name || d.id) + " » pas encore effacé : " + e.message); }
  }
  for (const c of list) {
    if (!store.ID_RE.test(c.id)) continue;
    const home = path.join(store.PROJECTS, c.id);
    store.writeJson(path.join(home, "project.json"), c.project);
    ignoreData(c.project.dir); // avant d'écrire dans le dossier des agents du projet
    const s = (state.p[c.id] = state.p[c.id] || { history: 0, notes: 0, sent: {}, head: "", base: "" });
    // Agents et consignes du panel : dans le dossier des agents du projet (agents-ia, 03/11), écrits seulement quand ils
    // changent ou changent d'emplacement (avant : à chaque synchronisation). Un dossier supprimé ici n'est donc pas recréé
    // avant que le panel l'ait su (collect : removed) ; aucun agent, aucun dossier créé. Une modification faite ici et pas
    // encore prise par le panel reste ici et repart à la synchronisation suivante.
    const file = store.agentsFile(c.id), dir = path.dirname(file);
    if (c.base !== s.base || s.where !== file) {
      if (c.agents.length || fs.existsSync(file)) {
        store.writeAgents(c.id, c.agents);
        for (const [rel, text] of Object.entries(c.prompts || {})) {
          const f = path.resolve(dir, rel);
          if (f.startsWith(dir + path.sep)) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); }
        }
      }
      // Ancien emplacement (réglages dans le dossier du programme, avant le 03/11) : retiré.
      if (dir !== home) { fs.rmSync(path.join(home, "agents.json"), { force: true }); fs.rmSync(path.join(home, "prompts"), { recursive: true, force: true }); }
      s.base = c.base; s.where = file; s.count = c.agents.length;
      s.localHash = localConfigHash(store.project(c.id));
    }
    // Connexions aux API d'autres projets (outil « appeler_api » des agents d'ici) : gardées hors des réglages du projet.
    if (Array.isArray(c.connections)) require("./lib/connections").write(c.id, c.connections);
  }
  // Projet retiré dans le panel : plus rien ne tourne ici (ses réglages locaux sont effacés).
  try {
    for (const id of fs.readdirSync(store.PROJECTS)) if (!keep.has(id)) {
      fs.rmSync(path.join(store.PROJECTS, id), { recursive: true, force: true });
      fs.rmSync(require("./lib/connections").file(id), { force: true }); // ses jetons ne restent pas ici
      delete state.p[id];
    }
  } catch (e) { /* aucun */ }
}
// Messages au patron envoyés depuis le panel : le patron répond sur cet ordinateur (lib/chat.js startRemote) ; arrêt
// demandé : transmis au process qui répond.
function applyChats(list, spawnFn) {
  const chat = require("./lib/chat");
  for (const j of Array.isArray(list) ? list : []) {
    let p;
    try { p = store.project(j.project); } catch (e) { continue; }
    if (j.conversation) chat.startRemote(p, j, spawnFn);
    if (j.stop) chat.remoteStop(p, j.cid);
  }
}
function applyCommands(list) {
  const dir = path.join(store.RUNTIME, "commands");
  fs.mkdirSync(dir, { recursive: true });
  for (const c of list) store.writeJson(path.join(dir, Date.now() + "-" + crypto.randomBytes(3).toString("hex") + ".json"), c);
}
async function answer(rpc) {
  return Promise.all(rpc.map(async (r) => {
    try {
      const p = store.project(r.project);
      if (r.type === "diff") return { id: r.id, project: r.project, result: gitinfo.commitDetail(p.dir, r.hash) };
      // Bouton « Tester » d'une connexion (lib/connections.js test) : essayée d'ici, où ses agents l'appellent.
      if (r.type === "connexion") return { id: r.id, project: r.project, result: await require("./lib/connections").test({ ...p, node: null }, String(r.conn)) };
      return { id: r.id, project: r.project, error: "demande inconnue : " + r.type };
    } catch (e) { return { id: r.id, project: r.project, error: e.message }; }
  }));
}

// ---------- mise à jour ----------
async function update(conf, wanted, fetched) {
  const b = fetched || await api(conf, "/api/node/bundle", null, "GET");
  // Journal du programme relancé, ouvert AVANT d'écrire quoi que ce soit : node.log comme au démarrage de la session
  // (AgentsIA.vbs, crontab) ; s'il est verrouillé (Windows : « cmd /c … >> node.log » le garde ouvert, 02/11 : EBUSY
  // ici laissait les nouveaux fichiers écrits et l'ancien code en marche), node-2.log ; sinon sans journal.
  let out = "ignore";
  for (const f of ["node.log", "node-2.log"]) { try { out = fs.openSync(path.join(__dirname, f), "a"); break; } catch (e) { /* suivant */ } }
  for (const [rel, text] of Object.entries(b.files)) {
    const f = path.resolve(__dirname, rel);
    if (!f.startsWith(__dirname + path.sep)) continue;
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, text);
  }
  fs.writeFileSync(VERSION_FILE, b.version || wanted);
  log("mis à jour (" + (b.version || wanted) + "), redémarrage");
  fs.rmSync(PID, { force: true });
  spawn(process.execPath, [__filename], { cwd: __dirname, detached: true, stdio: ["ignore", out, out], windowsHide: true }).unref();
  process.exit(0);
}

// Programme d'ici en erreur avant même la synchronisation (03/11 : une version publiée à moitié écrite, « busyNote is not
// defined », faisait planter collect() à chaque tour ; sans synchronisation, pas de mise à jour, et l'appareil restait
// bloqué jusqu'à une réparation à la main) : la version du panel est reprise si elle est différente, toutes les 5 min au
// plus, jamais pendant le passage d'un agent.
let repairedAt = 0;
async function repair(conf, err, busy) {
  if (busy || Date.now() - repairedAt < 5 * 60e3) return;
  repairedAt = Date.now();
  const b = await api(conf, "/api/node/bundle", null, "GET").catch(() => null);
  if (!b || !b.version || b.version === version()) return;
  log("programme en erreur ici (" + err.message + ") : version " + b.version + " du panel reprise");
  await update(conf, b.version, b);
}

// Retour de veille ou démarrage de l'ordinateur (02/11 : le PC de Scanner CVE est un portable, souvent fermé). Pendant
// 15 min, le réseau et les services du projet repartent (Scanner CVE laisse lui-même 15 min à ses serveurs après un
// réveil) : un agent lancé tout de suite relevait des pannes qui n'en étaient pas (synchro sans Internet, serveurs
// muets) et alertait le patron. Les agents à horaire attendent ; les lancements demandés (panel, conversation, patron)
// partent toujours tout de suite.
const WAKE_HOLD_MS = 15 * 60e3;
function holdSchedule(now, wakeAt, uptimeSec) {
  if (uptimeSec * 1000 < WAKE_HOLD_MS) return "démarrage de l'ordinateur";
  if (wakeAt && now - wakeAt < WAKE_HOLD_MS) return "retour de veille";
  return null;
}

// ---------- boucle ----------
async function run() {
  const conf = store.readJson(CONF, null);
  if (!conf) { console.error("Appareil pas encore connecté : colle la commande donnée par le panel (« Connecter un appareil »)."); process.exit(1); }
  // Une seule copie par ordinateur.
  try { const old = Number(fs.readFileSync(PID, "utf8")); if (old && old !== process.pid) { process.kill(old, 0); console.error("Déjà en marche (pid " + old + ")."); process.exit(0); } } catch (e) { /* pas d'autre copie */ }
  fs.writeFileSync(PID, String(process.pid));
  const runner = require("./runner");
  runner.clearLocks(); // seule copie du runner sur cet ordinateur : verrous d'un passage coupé retirés
  const state = store.readJson(STATE, { p: {} });
  const nfo = info();
  let results = [], ticking = false, lastTick = 0, fails = 0, beat = Date.now(), wakeAt = 0, held = null;
  // Veille : le programme est figé, l'horloge continue ; un battement en retard de plus de 3 min = réveil.
  setInterval(() => { const t = Date.now(); if (t - beat > 3 * 60e3) { wakeAt = t; log("retour de veille après " + Math.round((t - beat) / 60e3) + " min"); } beat = t; }, 20e3);
  log("en marche · appareil « " + conf.name + " » · panel " + conf.server);
  for (;;) {
    let wait = 10;
    try {
      let collected;
      try { collected = collect(state, results); } catch (e) { await repair(conf, e, ticking); throw Object.assign(e, { local: true }); }
      const { projects, marks } = collected;
      const status = store.readJson(path.join(store.RUNTIME, "runner.json"), {});
      const acked = state.dropped || [];
      const r = await api(conf, "/api/node/sync", { info: nfo, status: { current: status.current || null }, projects, dropped: acked });
      state.dropped = (state.dropped || []).filter((id) => !acked.includes(id));
      for (const [pid, m] of Object.entries(marks)) {
        const s = state.p[pid];
        if (s) { s.history = m.history; s.notes = m.notes; s.sent = m.seen; s.head = m.head; }
        if (m.chatsDone.length) try { require("./lib/chat").remoteSent(store.project(pid), m.chatsDone); } catch (e) { /* projet retiré */ } // réponses reçues par le panel
      }
      results = [];
      // Réponse du panel qui ne s'applique pas (programme d'ici en erreur) : la mise à jour plus bas part quand même.
      try {
        // Dossiers des projets supprimés : pas pendant le passage d'un agent (il écrirait dans un dossier effacé).
        applyProjects(r.projects || [], state, ticking ? [] : r.dropped);
        applyCommands(r.commands || []);
        applyChats(r.chats || []);
        results = await answer(r.rpc || []);
      } catch (e) { log("réponse du panel pas appliquée : " + e.message); }
      store.writeJson(STATE, state);
      if (fails) log("panel de nouveau joignable");
      fails = 0;
      wait = results.length ? 0.2 : r.interval || 10;
      if (r.bundle && r.bundle !== version() && !ticking) await update(conf, r.bundle).catch((e) => log("mise à jour impossible : " + e.message));
      if (r.commands && r.commands.length) lastTick = 0; // lancement demandé : tout de suite
    } catch (e) {
      if (e.status === 401) { log("jeton refusé : cet appareil a été retiré du panel"); process.exit(1); }
      if (fails++ % 30 === 0) log((e.local ? "programme en erreur ici : " : "panel injoignable : ") + e.message);
      wait = Math.min(60, 10 + fails * 5);
    }
    // Passage du runner dans son propre process (runner.js --once) : pendant les tests et le redémarrage d'un projet,
    // attendus de façon synchrone par git-guard, cette boucle continuait de bloquer et l'ordinateur paraissait hors
    // ligne (revue du 02/11). Un seul passage à la fois ; pas de mise à jour pendant un passage (ticking).
    if (!ticking && Date.now() - lastTick > 60e3) {
      ticking = true; lastTick = Date.now();
      const hold = holdSchedule(Date.now(), wakeAt, os.uptime());
      if (hold !== held && hold) log(hold + " : agents à horaire reportés de 15 min (lancements demandés : tout de suite)");
      held = hold;
      const child = spawn(process.execPath, [path.join(__dirname, "runner.js"), "--once", ...(hold ? ["--sans-horaire"] : [])], { cwd: __dirname, stdio: ["ignore", "inherit", "inherit"], windowsHide: true });
      child.on("error", (e) => { log("runner : " + e.message); ticking = false; });
      child.on("exit", () => { ticking = false; });
    }
    await new Promise((ok) => setTimeout(ok, wait * 1000));
  }
}

if (require.main === module) {
  const a = process.argv.slice(2);
  if (a[0] === "--enroll") enroll(a[1], a[2], a[3] || process.cwd(), a[4]).catch((e) => { console.error("Échec : " + e.message); process.exit(1); });
  else run().catch((e) => { log("arrêt : " + e.message); process.exit(1); });
}

module.exports = { collect, applyProjects, applyChats, answer, changedFiles, holdSchedule };

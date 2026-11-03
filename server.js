// Panel des agents IA (agent.rvkxse.com). Lancé par le routeur rvkxse.com (route « auth: telegram » : connexion
// Telegram sur admin.rvkxse.com, réservée au propriétaire) ; n'écoute qu'en local (127.0.0.1:PORT), donc jamais joignable
// sans passer par le routeur.
// Vue par projet : ses agents (état, horaire, dernier passage, coût), leurs résultats, les changements faits dans son
// code. On peut modifier un agent (consigne, horaire, budget, actif), en créer un (modèles), le lancer maintenant, et
// voir les pistes de l'éclaireur (projets similaires, skills). Chaque modification de réglage est commitée dans ce
// dépôt (historique et retour arrière possibles). Les agents eux-mêmes tournent dans runner.js (pm2 goldpilot-agents).
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const store = require("./lib/store");
const schedule = require("./lib/schedule");
const templates = require("./lib/templates");
const admin = require("./lib/agents-admin");
const boss = require("./lib/boss");
const chat = require("./lib/chat");
const push = require("./lib/push");
const auth = require("./lib/auth");
const gitinfo = require("./lib/gitinfo");
const nodes = require("./lib/nodes");
const apikeys = require("./lib/apikeys");
const connections = require("./lib/connections");
const agentsHistory = require("./lib/agents-history");
const { cleanSchedule, commitConfig, str } = admin;

const PORT = parseInt(process.env.PORT || "3017", 10);
const PAGE = path.join(__dirname, "public", "index.html");
const MAX_BODY = 512 * 1024;
const RUNNER_STATUS = path.join(store.RUNTIME, "runner.json");
const COMMANDS = path.join(store.RUNTIME, "commands");
const HISTORY = (id) => path.join(store.RUNTIME, "history", id + ".jsonl");
const KINDS_BUILTIN = new Set(["fix-messages", "review", "investigate", "optimize", "strategy", "scout", "supervisor", "video"]);

const fail = (message, status) => Object.assign(new Error(message), { status: status || 400 });
const git = (cwd, ...args) => spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
const round2 = (x) => Math.round((Number(x) || 0) * 100) / 100;

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(body), "Cache-Control": "no-store" });
  res.end(body);
}
function readBody(req, max = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (c) => { raw += c; if (raw.length > max) { reject(fail("Requête trop grosse.", 413)); req.destroy(); } });
    req.on("end", () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(fail("JSON invalide.")); } });
    req.on("error", reject);
  });
}

function runnerStatus() {
  const s = store.peekJson(RUNNER_STATUS, null);
  const online = !!(s && s.beat && Date.now() - Date.parse(s.beat) < 3 * 60e3);
  return { online, beat: s && s.beat, startedAt: s && s.startedAt, current: s && s.current };
}

// ---------- services (administrateur, 03/11 : redémarrer et lire le journal depuis le site) ----------
// Runner : process pm2 ; panel : ce process, relancé par le routeur rvkxse.com quand il s'arrête (en ~4 s).
const RUNNER_PM2 = process.env.AGENTS_RUNNER_PM2 || "goldpilot-agents";
const STARTED = new Date().toISOString();
// Une seule ligne de commande (arguments fixes, jamais venus d'une requête) : pm2 est un script .cmd sous Windows.
const pm2 = (...args) => spawnSync("pm2 " + args.join(" "), { shell: true, encoding: "utf8", windowsHide: true, timeout: 60e3, maxBuffer: 32 * 1024 * 1024 });
// État pm2 du runner (jamais son environnement, qui peut contenir des secrets).
function runnerProcess() {
  const r = pm2("jlist"), s = String(r.stdout || "");
  try {
    const x = JSON.parse(s.slice(s.indexOf("["))).find((y) => y.name === RUNNER_PM2);
    if (!x) return { error: "process pm2 « " + RUNNER_PM2 + " » introuvable" };
    const e = x.pm2_env || {};
    return { status: e.status, since: e.pm_uptime ? new Date(e.pm_uptime).toISOString() : null, restarts: e.restart_time || 0, memoryMb: x.monit ? Math.round(x.monit.memory / 1048576) : null, out: e.pm_out_log_path, err: e.pm_err_log_path };
  } catch (e) { return { error: "pm2 ne répond pas : " + String(r.stderr || r.error || e.message).slice(0, 200) }; }
}
// Fin d'un journal (64 Ko au plus), jetons masqués.
function tailFile(f, lines = 200) {
  try {
    const st = fs.statSync(f), n = Math.min(st.size, 64 * 1024), fd = fs.openSync(f, "r"), b = Buffer.alloc(n);
    fs.readSync(fd, b, 0, n, st.size - n); fs.closeSync(fd);
    return b.toString("utf8").split(/\r?\n/).slice(-lines).join("\n").replace(/(agk_|Bearer\s+|sk-ant-)[A-Za-z0-9._~+\/=-]{8,}/g, "$1[masqué]");
  } catch (e) { return ""; }
}
function services() {
  const head = git(__dirname, "log", "-1", "--format=%h%x09%s").stdout || "";
  const busyChats = store.listProjects().filter((p) => chat.busy(p)).map((p) => p.name);
  return { runner: { ...runnerStatus(), pm2: runnerProcess() }, panel: { pid: process.pid, since: STARTED, node: process.version, commit: head.split("\t")[0] || null, subject: (head.split("\t")[1] || "").trim(), busyChats } };
}
// what : « runner » ou « panel » ; force : même si un agent tourne (runner) ou si le patron répond (panel).
function restartService(what, force) {
  if (what === "runner") {
    const cur = runnerStatus().current;
    if (cur && !force) throw fail("« " + (cur.name || cur.agent) + " » tourne en ce moment : le redémarrage couperait son passage. Attends la fin, ou redémarre quand même.", 409);
    const lc = require("./lib/loadcheck"), bad = lc.check(lc.programFiles(__dirname));
    if (bad) throw fail("Le code des agents ne se charge pas : redémarrage refusé, le runner continue avec l'ancien (" + bad + ").", 409);
    const r = pm2("restart", RUNNER_PM2);
    if (r.status !== 0) throw fail("Redémarrage du runner impossible : " + String(r.stderr || r.stdout || (r.error && r.error.message) || "").trim().slice(0, 300), 500);
    return { ok: true };
  }
  if (what === "panel") {
    const busy = store.listProjects().filter((p) => chat.busy(p)).map((p) => p.name);
    if (busy.length && !force) throw fail("Le patron répond en ce moment (" + busy.join(", ") + ") : attends sa réponse, ou redémarre quand même.", 409);
    // Jamais sur un code qui ne se charge pas (lib/loadcheck.js) : le site ne reviendrait pas, et rien ne permettrait de
    // le réparer depuis le site.
    const lc = require("./lib/loadcheck"), bad = lc.check(lc.programFiles(__dirname), [path.join(__dirname, "server.js")]);
    if (bad) throw fail("Le nouveau code du panel ne se charge pas : redémarrage refusé, le site continue avec l'ancien (" + bad + ").", 409);
    apikeys.flush();
    // Après la réponse : le routeur relance le panel (il relance un panel arrêté, comme après un plantage).
    setTimeout(() => process.exit(1), 500).unref();
    return { ok: true, restarting: true };
  }
  throw fail("Service inconnu.");
}

const history = (id, n = 2000) => store.tail(HISTORY(id), n);
function costs(rows) {
  const d = Date.now();
  const sum = (ms) => round2(rows.filter((r) => d - Date.parse(r.at) < ms).reduce((s, r) => s + (Number(r.cost) || 0), 0));
  const within = (ms) => rows.filter((r) => d - Date.parse(r.at) < ms);
  const minutes = (ms) => Math.round(within(ms).reduce((s, r) => s + (Number(r.seconds) || 0), 0) / 60);
  return { day: sum(86400e3), week: sum(7 * 86400e3), month: sum(30 * 86400e3), runs24: within(86400e3).length, runs7: within(7 * 86400e3).length, minutes24: minutes(86400e3), minutes7: minutes(7 * 86400e3) };
}

// Commits des agents dans le code du projet (repérés par la ligne « Agent … (goldpilot-agents | scripts/auto-fix.js) »).
function agentCommits(p, n) {
  const out = gitinfo.gitLog(p, "commits");
  return out.split("\x1e").map((b) => b.trim()).filter(Boolean).map((b) => {
    const [hash, at, subject, body] = b.split("\t");
    const m = /(Agent[^\n]*?) \((?:goldpilot-agents|scripts\/auto-fix\.js)\)/.exec(body || "");
    return m && { hash, at, subject, by: m[1].replace(/ automatique$/, "") };
  }).filter(Boolean).slice(0, n);
}

function agentView(p, a, runs, all) {
  const last = runs[a.id] || {};
  const mine = all.filter((h) => h.agent === a.id);
  return {
    id: a.id, name: a.name, icon: a.icon || "🤖", kind: a.kind, builtin: KINDS_BUILTIN.has(a.kind), enabled: a.enabled !== false, description: a.description || "",
    mode: a.mode || (a.kind === "custom" ? "read" : null), schedule: a.schedule || { type: "on-demand" }, scheduleLabel: schedule.label(a.schedule),
    next: a.enabled === false ? null : schedule.nextRun(a.schedule, last.lastAt || null), budgetUsd: a.budgetUsd || null, maxLines: a.maxLines || null, maxMinutes: a.maxMinutes || null, maxRunsPerDay: a.maxRunsPerDay || null,
    last: last.lastAt ? { at: last.lastAt, status: last.lastStatus || null, cost: last.lastCost, summary: last.lastSummary || null, seconds: last.lastSeconds } : null,
    runs7: mine.filter((h) => Date.now() - Date.parse(h.at) < 7 * 86400e3).length, cost7: costs(mine).week,
  };
}

function projectSummary(p) {
  const agents = store.peekAgents(p.id), runs = store.peekRuns(p), all = history(p.id);
  return { id: p.id, name: p.name, description: p.description || "", dir: p.dir, agentsDir: p.agentsDir ? String(p.dir).replace(/[\\/]+$/, "") + "/" + p.agentsDir : null, node: nodes.nodeOfProject(p), agents: agents.length, active: agents.filter((a) => a.enabled !== false).length,
    costs: costs(all), lastAt: all.length ? all[all.length - 1].at : null, commits7: agentCommits(p, 50).filter((c) => Date.now() - Date.parse(c.at) < 7 * 86400e3).length,
    icons: agents.map((a) => a.icon || "🤖") };
}

// Résultats propres à certains agents (fichiers de travail dans le dossier du projet).
function kindDetails(p, a) {
  const J = (f, d) => store.readJson(path.join(p.data, f), d), T = (f, n) => store.tail(path.join(p.data, f), n).reverse();
  switch (a.kind) {
    case "fix-messages": return { runs: T("runs.jsonl", 20).map((r) => ({ at: r.at, suspects: r.suspects, commit: r.commit, cost: r.cost, testsFailed: !!r.testsFailed, error: r.agentError,
      verdicts: (r.verdicts || []).map((v) => ({ verdict: v.verdict, explication: v.explication, todo: v.a_faire_a_la_main })) })) };
    case "review": return { reviews: T("reviews.jsonl", 12).map((r) => ({ at: r.at, cost: r.cost, statut: r.review && r.review.statut, resume: r.review && r.review.resume, error: r.agentError,
      points: ((r.review && r.review.points) || []).map((x) => ({ gravite: x.gravite, sujet: x.sujet, detail: x.detail, action: x.action })) })) };
    case "investigate": return { investigations: T("investigations.jsonl", 12).map((r) => ({ at: r.at, cost: r.cost, commit: r.commit, question: String(r.question || "").split("\n")[0],
      resume: r.result && r.result.resume, cause: r.result && r.result.cause, action: r.result && r.result.action, error: r.agentError })) };
    case "optimize": return { history: J("optimize-history.json", []).slice(-15).reverse() };
    case "strategy": return { strategies: J("strategies.json", null) };
    case "scout": return { scout: J("scout.json", null) };
    case "custom": return { results: T("agents/" + a.id + ".jsonl", 15) };
    case "video": return { videos: T("video/videos.jsonl", 15).map((r) => ({ id: r.id || null, at: r.at, status: r.status, summary: r.summary, titre: r.titre, angle: r.angle, seconds: r.seconds, sent: r.sent, legende: r.legende, hashtags: r.hashtags, scenes: r.scenes })) };
    case "supervisor": return { boss: T("boss.jsonl", 12).map((r) => ({ at: r.at, cost: r.cost, commit: r.commit, testsFailed: !!r.testsFailed, error: r.agentError, changes: r.changes || [], launched: r.launched || [],
      statut: r.result && r.result.statut, resume: r.result && r.result.resume, bilan: (r.result && r.result.agents_bilan) || [], points: (r.result && r.result.points) || [], idees: (r.result && r.result.idees) || [] })) };
    default: return {};
  }
}

// Modification d'un agent : lib/agents-admin.js (même chemin que l'agent patron).
const updateAgent = (p, aid, body) => admin.updateAgent(p, aid, body).agent;

function createAgent(p, body) {
  const list = store.listAgents(p.id);
  const tpl = body.template ? templates.get(body.template) : null;
  const name = str(body.name || (tpl && tpl.name), 60);
  if (!name) throw fail("Donne un nom à l'agent.");
  let id = str(body.id, 30).toLowerCase() || name.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30);
  if (!store.ID_RE.test(id)) id = "agent-" + crypto.randomBytes(3).toString("hex");
  while (list.some((x) => x.id === id)) id = (id + "-2").slice(0, 30);
  const prompt = String(body.prompt || (tpl && tpl.prompt) || "");
  if (prompt.trim().length < 20) throw fail("Écris la consigne de l'agent (ce qu'il doit faire).");
  const a = { id, name, icon: str(body.icon || (tpl && tpl.icon), 8) || "🤖", kind: "custom", enabled: body.enabled !== false, description: str(body.description || (tpl && tpl.description), 400),
    prompt: "prompts/" + id + ".md", schedule: cleanSchedule(body.schedule || (tpl && tpl.schedule) || { type: "on-demand" }),
    budgetUsd: Math.min(20, Math.max(0.1, Number(body.budgetUsd || (tpl && tpl.budgetUsd) || 2))), mode: (body.mode || (tpl && tpl.mode)) === "code" ? "code" : "read" };
  if (a.mode === "code") a.maxLines = Math.min(1000, Math.max(10, Math.round(Number(body.maxLines || (tpl && tpl.maxLines) || 150))));
  if (Number(body.maxMinutes) > 0) a.maxMinutes = Math.min(60, Math.max(2, Math.round(Number(body.maxMinutes))));
  store.writePrompt(p.id, a, prompt);
  list.push(a);
  store.writeAgents(p.id, list);
  commitConfig(p.name + " · nouvel agent « " + a.name + " »", [store.agentsFile(p.id), store.promptPath(p.id, a)]);
  return a;
}

function deleteAgent(p, aid) {
  const list = store.listAgents(p.id);
  const a = list.find((x) => x.id === aid);
  if (!a) throw fail("Agent inconnu.", 404);
  if (KINDS_BUILTIN.has(a.kind)) throw fail("Un agent du projet ne se supprime pas : désactive-le.");
  store.writeAgents(p.id, list.filter((x) => x.id !== aid));
  const pp = store.promptPath(p.id, a);
  fs.rmSync(pp, { force: true });
  commitConfig(p.name + " · agent « " + a.name + " » supprimé", [store.agentsFile(p.id), pp]);
}

function runNow(p, aid, body) {
  const a = store.agent(p.id, aid);
  const args = {};
  if (a.kind === "investigate") {
    args.question = str(body.question, 2000);
    if (args.question.length < 10) throw fail("Décris le problème à éclaircir.");
  }
  fs.mkdirSync(COMMANDS, { recursive: true });
  store.writeJson(path.join(COMMANDS, Date.now() + "-" + crypto.randomBytes(3).toString("hex") + ".json"), { project: p.id, agent: a.id, args, at: new Date().toISOString() });
  return { queued: true };
}

function createProject(body, u) {
  // Un projet sur CE serveur fait tourner Claude ici : réservé à l'administrateur. Les autres connectent les leurs depuis
  // leurs appareils (nœuds).
  if (u.role !== "admin") throw fail("Un projet sur ce serveur est réservé à l'administrateur : connecte ton projet depuis ton appareil.", 403);
  const name = str(body.name, 60), dir = str(body.dir, 300).replace(/\\/g, "/");
  if (!name || !dir) throw fail("Nom et dossier du projet obligatoires.");
  if (!fs.existsSync(path.join(dir, ".git"))) throw fail("Ce dossier n'est pas un dépôt git (les agents qui codent en ont besoin).");
  let id = str(body.id, 30).toLowerCase() || name.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30);
  if (!store.ID_RE.test(id) || fs.existsSync(path.join(store.PROJECTS, id))) throw fail("Identifiant de projet invalide ou déjà pris.");
  // Agents, consignes et résultats dans le dossier agents-ia du projet (03/11 : le supprimer retire tous les agents).
  const p = { id, name, owner: u.id, description: str(body.description, 200), dir, envFile: ".env", agentsDir: store.AGENTS_DIR, dataDir: store.AGENTS_DIR + "/data", testCmd: str(body.testCmd, 120) || "npm test", restartCmd: str(body.restartCmd, 120) || null,
    pm2Process: str(body.pm2Process, 60) || null, allowed: str(body.allowed, 300) || "^src/|^test/|^lib/", protected: str(body.protected, 300) || null };
  store.writeJson(path.join(store.PROJECTS, id, "project.json"), p);
  // Chaque nouveau projet a son agent patron (en pause, mais on peut lui parler tout de suite) et son éclaireur
  // (désactivé : à lancer à la main au début).
  boss.starterAgents(id, name);
  commitConfig("nouveau projet « " + name + " »", [path.join(store.PROJECTS, id)]);
  return p;
}

// Détail d'un commit du projet (onglet Changements) : ici par git, ou demandé à l'appareil du projet (lib/nodes.js).
const commitDetail = async (p, hash) => (p.node ? nodes.ask(p, { type: "diff", hash }) : gitinfo.commitDetail(p.dir, hash));
// Annulation d'un commit : faite par le runner du projet, ici ou sur son appareil (verrou, tests, commit et redémarrage,
// ou rien).
async function revertCommit(p, hash) {
  const c = await commitDetail(p, hash);
  if (c.reverted) throw fail("Ce changement a déjà été annulé.");
  fs.mkdirSync(COMMANDS, { recursive: true });
  store.writeJson(path.join(COMMANDS, Date.now() + "-" + crypto.randomBytes(3).toString("hex") + ".json"), { project: p.id, agent: "annulation", revert: c.full, at: new Date().toISOString(), by: "panel" });
  return { queued: true };
}

// ---------- comptes : chaque utilisateur ne voit que ses projets ----------
// Propriétaire d'un projet : project.json « owner », sinon l'administrateur (projets d'avant les comptes, 01/11).
const ownerOf = (p) => p.owner || (auth.admin() || {}).id || null;
const mine = (u) => { const adminId = (auth.admin() || {}).id || null; return store.listProjects((p) => (p.owner || adminId) === u.id); };
function projectFor(u, id) {
  let p = null;
  try { p = store.project(id); } catch (e) { /* inconnu */ }
  if (!p || ownerOf(p) !== u.id) throw fail("Projet inconnu.", 404); // même réponse qu'un projet qui n'existe pas
  return p;
}
const clientIp = (req) => String(req.headers["x-real-ip"] || req.socket.remoteAddress || "?");

// Demandes « Lancer » pas encore prises par le runner, et agent en cours : suivi en direct dans le panel.
function queue(u) {
  const ids = new Set(mine(u).map((p) => p.id));
  let pending = [];
  try {
    pending = store.listDir(COMMANDS).filter((f) => f.endsWith(".json")).map((f) => store.peekJson(path.join(COMMANDS, f), null)).filter((c) => c && ids.has(c.project))
      .map((c) => ({ project: c.project, agent: c.agent, at: c.at }));
  } catch (e) { /* aucune demande */ }
  const r = runnerStatus();
  // Agents en cours : runner d'ici et appareils de l'utilisateur (plusieurs peuvent tourner en même temps).
  const running = [r.current, ...nodes.listFor(u).map((n) => n.current)].filter((c) => c && ids.has(c.project));
  return { runner: { ...r, current: r.current && ids.has(r.current.project) ? r.current : null }, running, pending };
}

// Versions de la consigne d'un agent (historique git du panel ; dossier agents-ia : sa copie d'historique,
// lib/store.js historyPath) ; content(hash) : le texte de cette version.
const promptRel = (p, a) => path.relative(__dirname, store.historyPath(p.id, store.promptPath(p.id, a))).split(path.sep).join("/");
function promptVersions(p, a) {
  const rel = promptRel(p, a);
  const out = git(__dirname, "log", "-n", "30", "--format=%h%x09%aI%x09%s", "--", rel).stdout || "";
  return out.trim().split(/\r?\n/).filter(Boolean).map((l) => { const [hash, at, subject] = l.split("\t"); return { hash, at, subject }; });
}
function promptAt(p, a, hash) {
  if (!/^[0-9a-f]{7,40}$/.test(hash)) throw fail("Version invalide.");
  const rel = promptRel(p, a);
  const r = git(__dirname, "show", hash + ":" + rel);
  if (r.status !== 0) throw fail("Version introuvable.", 404);
  return r.stdout;
}

// Points à surveiller sur l'accueil : runner arrêté, agents dont le dernier passage a échoué ou demande attention.
// Alertes marquées « Vu » par ce compte (projet/agent/heure du bilan) : cachées jusqu'au bilan suivant de l'agent.
const seenFile = (u) => path.join(store.RUNTIME, "alertes-vues", u.id + ".json");
function alerts(u) {
  const out = [];
  const r = runnerStatus(), seen = new Set(store.readJson(seenFile(u), []));
  if (!r.online && u.role === "admin") out.push({ level: "haute", text: "Le runner des agents ne tourne pas : aucun agent ne passe." });
  for (const p of mine(u)) {
    const runs = store.peekRuns(p), hist = history(p.id, 600);
    for (const a of store.peekAgents(p.id)) {
      const l0 = runs[a.id];
      if (a.enabled === false || !l0 || !l0.lastStatus) continue;
      // Heure du bilan affiché = fin du passage qui l'a écrit (lastAt change dès le début du passage suivant), et
      // « réévaluation en cours » si l'agent tourne en ce moment (01/11 : ancien bilan affiché avec l'heure du nouveau).
      const end = [...hist].reverse().find((h) => h.agent === a.id && h.status === l0.lastStatus && String(h.summary || "").slice(0, 200) === String(l0.lastSummary || "").slice(0, 200));
      const l = { ...l0, lastAt: end ? end.at : l0.lastAt };
      if (seen.has(p.id + "/" + a.id + "/" + l.lastAt)) continue;
      const busy = !!(r.current && r.current.project === p.id && r.current.agent === a.id);
      const before = out.length;
      // Texte entier (la page le replie sur deux lignes et le déplie au clic) et heure du passage : une alerte d'avant une
      // correction reste affichée jusqu'au passage suivant de l'agent (01/11 : textes coupés au milieu d'un mot).
      if (l.lastStatus === "erreur") out.push({ level: "haute", project: p.id, agent: a.id, at: l.lastAt, text: p.name + " · " + a.name + " : dernier passage en erreur" + (l.lastSummary ? " (" + String(l.lastSummary) + ")" : "") });
      else if (l.lastStatus === "attention") out.push({ level: "moyenne", project: p.id, agent: a.id, at: l.lastAt, text: p.name + " · " + a.name + " : " + String(l.lastSummary || "point à voir") });
      if (busy && out.length > before) out[out.length - 1].running = true;
    }
  }
  return out;
}

// ---------- carte du projet (graphe) ----------
// Nœuds : le projet, ses agents, les données qu'ils lisent (sources), les fichiers qu'ils produisent (sorties) et les
// fichiers de code qu'ils ont vraiment modifiés (commits des agents). Liens : lit, produit, modifie, déclenche.
// Liens déclarés dans projects/<id>/graph.json ; un agent personnalisé lit le code (et le modifie en mode « code »).
// Commit -> agent : d'après les journaux des agents (runs, enquêtes, optimisations, agents personnalisés), sinon d'après
// la ligne « Agent … (goldpilot-agents) » du message.
function commitOwners(p, agents) {
  const owners = new Map();
  const T = (f) => store.tail(path.join(p.data, f), 5000);
  const byKind = (kind) => (agents.find((a) => a.kind === kind) || {}).id;
  for (const r of T("runs.jsonl")) if (r.commit) owners.set(r.commit, byKind("fix-messages"));
  for (const r of T("investigations.jsonl")) if (r.commit) owners.set(r.commit, byKind("investigate"));
  for (const r of store.readJson(path.join(p.data, "optimize-history.json"), [])) if (r.commit) owners.set(r.commit, byKind("optimize"));
  for (const a of agents.filter((x) => x.kind === "custom")) for (const r of T("agents/" + a.id + ".jsonl")) if (r.commit) owners.set(r.commit, a.id);
  return owners;
}

function buildGraph(p) {
  const agents = store.peekAgents(p.id);
  const g = store.readJson(path.join(p.home, "graph.json"), { sources: {}, outputs: {}, agents: {} });
  const runs = store.peekRuns(p);
  const nodes = new Map(), edges = [];
  const node = (id, n) => { if (!nodes.has(id)) nodes.set(id, { id, ...n }); return nodes.get(id); };
  const edge = (from, to, type, label) => edges.push({ from, to, type, label });
  node("project", { type: "project", label: p.name, icon: "📦", detail: p.dir });
  const meta = (id) => g.sources[id] || g.outputs[id] || { label: id.replace(/^[a-z]+:/, ""), icon: "📄" };
  for (const a of agents) {
    const aid = "agent:" + a.id, m = g.agents[a.id] || (a.kind === "custom" ? { reads: ["code", "doc:carte"], writes: [], modifies: a.mode === "code" } : {});
    node(aid, { type: "agent", label: a.name, icon: a.icon || "🤖", detail: a.description || "", enabled: a.enabled !== false, agent: a.id, last: (runs[a.id] || {}).lastAt || null, status: (runs[a.id] || {}).lastStatus || null });
    edge("project", aid, "has", "agent du projet");
    for (const s of m.reads || []) { const isOut = s.startsWith("out:"); node(s, { type: isOut ? "output" : "source", ...meta(s) }); edge(s, aid, "reads", "lu par"); }
    for (const o of m.writes || []) { node(o, { type: "output", ...meta(o) }); edge(aid, o, "writes", "produit"); }
    for (const t of m.triggers || []) edge(aid, "agent:" + t, "triggers", "déclenche");
  }
  for (const a of agents) if ((g.agents[a.id] || {}).supervises || a.kind === "supervisor") for (const b of agents) if (b.id !== a.id) edge("agent:" + a.id, "agent:" + b.id, "supervises", "supervise");
  // Fichiers de code vraiment modifiés par les agents (100 derniers commits d'agents).
  const owners = commitOwners(p, agents);
  const log = gitinfo.gitLog(p, "files");
  const files = new Map(); // fichier -> { count, last, by: Map(agent -> n), commits: [] }
  let seen = 0;
  for (const block of log.split("@@").slice(1)) {
    const [head, names = ""] = block.split("\x1f");
    const [hash, at, subject, body] = head.split("\t");
    const trailer = /(Agent[^\n]*?) \((?:goldpilot-agents|scripts\/auto-fix\.js)\)/.exec(body || "");
    if (!trailer) continue;
    if (++seen > 100) break;
    let owner = owners.get(hash);
    if (!owner) owner = /patron/.test(trailer[1]) ? (agents.find((a) => a.kind === "supervisor") || {}).id : /optimisation/.test(trailer[1]) ? (agents.find((a) => a.kind === "optimize") || {}).id : /« (.+) »/.test(trailer[1]) ? (agents.find((a) => a.name === /« (.+) »/.exec(trailer[1])[1]) || {}).id : (agents.find((a) => a.kind === "fix-messages") || {}).id;
    for (const f of names.split(/\r?\n/).map((x) => x.trim()).filter(Boolean)) {
      const e = files.get(f) || { count: 0, last: at, by: new Map(), commits: [] };
      e.count++;
      if (at > e.last) e.last = at;
      if (owner) e.by.set(owner, (e.by.get(owner) || 0) + 1);
      if (e.commits.length < 6) e.commits.push({ hash, at, subject });
      files.set(f, e);
    }
  }
  for (const [f, e] of files) {
    const fid = "file:" + f;
    node(fid, { type: "code", label: f.split("/").pop(), icon: /test\//.test(f) ? "🧪" : /\.md$/.test(f) ? "📝" : "📄", detail: f, count: e.count, last: e.last, commits: e.commits });
    for (const [owner, n] of e.by) if (nodes.has("agent:" + owner)) edges.push({ from: "agent:" + owner, to: fid, type: "modifies", label: "a modifié (" + n + ")", weight: n });
  }
  return { nodes: [...nodes.values()], edges };
}

// ---------- routes ----------
// ---------- appareils (lib/nodes.js) : routes sans session, avec le code de connexion ou le jeton de l'appareil ----------
const PUBLIC_URL = (process.env.PANEL_ORIGINS || "https://agent.rvkxse.com").split(",")[0].trim();
// Script d'installation (collé dans le dossier du projet) : vérifie Node, git et Claude, télécharge le programme,
// connecte l'appareil et ce projet, et le lance au démarrage de la session.
function installScript(kind, code) {
  const ok = !!nodes.codeOwner(code);
  if (kind === "ps1") return !ok ? 'Write-Host "Code de connexion invalide ou expiré : crée-en un nouveau dans le panel." -ForegroundColor Red' : [
    "$ErrorActionPreference = 'Stop'",
    "$server = '" + PUBLIC_URL + "'; $code = '" + code + "'",
    "Write-Host 'Agents IA : connexion de cet ordinateur au panel' -ForegroundColor Cyan",
    "foreach ($c in 'node','git','claude') { if (-not (Get-Command $c -ErrorAction SilentlyContinue)) { Write-Host \"Il manque $c : installe-le (Node.js : nodejs.org, git : git-scm.com, Claude Code : claude.ai/code), connecte Claude (commande claude puis /login), puis relance cette commande.\" -ForegroundColor Red; return } }",
    // Claude connecté (sinon les agents échoueraient plus tard sans qu'on comprenne pourquoi). Ancien Claude Code sans
    // « auth status » : pas de blocage.
    "$st = ''; try { $st = (claude auth status 2>$null | Out-String) } catch { }",
    "if ($st -match '\"loggedIn\":\\s*false') { Write-Host \"Claude n'est pas connecté sur cet ordinateur : tape claude puis /login, puis relance cette commande.\" -ForegroundColor Red; return }",
    // Connecter un projet ne modifie AUCUN de ses fichiers (demande du propriétaire, 02/11 : la version précédente
    // complétait son .gitignore). Dossier pas encore suivi par git : dépôt local créé, secrets exclus par le réglage
    // local de git (.git/info/exclude, hors du code), état actuel enregistré tel quel ; les agents en ont besoin pour
    // annuler ce qu'ils changent. Rien n'est envoyé ailleurs.
    // Sous-dossier d'un dépôt existant : pas de dépôt imbriqué (il changerait l'état du dépôt parent) ; on indique le bon dossier.
    "$top = ''; if (-not (Test-Path .git)) { try { $top = (git rev-parse --show-toplevel 2>$null | Out-String).Trim() } catch { } }",
    "if ($top) { Write-Host \"Ce dossier fait partie du dépôt git $top : ouvre PowerShell dans ce dossier-là et relance la commande.\" -ForegroundColor Red; return }",
    "if (-not (Test-Path .git)) { Write-Host \"Ce dossier n'est pas encore suivi par git : je crée un dépôt git local pour les agents (aucun fichier de ton projet n'est modifié, rien n'est envoyé ailleurs).\" -ForegroundColor Yellow; git init -q }",
    "git rev-parse -q --verify HEAD *> $null",
    "if ($LASTEXITCODE -ne 0) {",
    "  $ig = '.env', '.env.local', '.env.*.local', '.env.production', '*.key', '*.pem', '*.p12', '*.pfx', 'id_rsa*', 'node_modules/', '.venv/', 'venv/', '__pycache__/', '*.db', '*.sqlite', '*.sqlite3', '/data/agents/', '/agents-ia/'",
    "  $ex = (git rev-parse --git-path info/exclude); New-Item -ItemType Directory -Force (Split-Path $ex) | Out-Null",
    "  $t = ''; if (Test-Path $ex) { $t = [IO.File]::ReadAllText($ex) }; if ($t -and -not $t.EndsWith(\"`n\")) { $t += \"`n\" }",
    "  $add = @($ig | Where-Object { ($t -split \"`r?`n\") -notcontains $_ }); [IO.File]::WriteAllText($ex, $t + (($add | ForEach-Object { $_ + \"`n\" }) -join ''))",
    "  git add -A",
    "  git -c user.name='Agents IA' -c user.email='agents@local' commit -q --allow-empty -m 'Départ : état du projet avant les agents IA'",
    "  if ($LASTEXITCODE -ne 0) { Write-Host 'Enregistrement git impossible : regarde le message de git ci-dessus.' -ForegroundColor Red; return }",
    "  Write-Host 'État actuel enregistré dans git sur cet ordinateur, sans rien modifier (les secrets comme .env en sont exclus).' -ForegroundColor Yellow",
    "}",
    "$dir = Join-Path $env:LOCALAPPDATA 'AgentsIA'; New-Item -ItemType Directory -Force $dir | Out-Null",
    "$b = Invoke-RestMethod \"$server/api/node/bundle?code=$code\"",
    "foreach ($f in $b.files.PSObject.Properties) { $p = Join-Path $dir $f.Name; New-Item -ItemType Directory -Force (Split-Path $p) | Out-Null; [IO.File]::WriteAllText($p, $f.Value, (New-Object Text.UTF8Encoding $false)) }",
    "[IO.File]::WriteAllText((Join-Path $dir 'version.txt'), $b.version)",
    "node (Join-Path $dir 'node.js') --enroll $server $code (Get-Location).Path",
    "if ($LASTEXITCODE -ne 0) { return }",
    "$vbs = Join-Path ([Environment]::GetFolderPath('Startup')) 'AgentsIA.vbs'",
    "Set-Content $vbs ('CreateObject(\"WScript.Shell\").Run \"cmd /c node \"\"' + (Join-Path $dir 'node.js') + '\"\" >> \"\"' + (Join-Path $dir 'node.log') + '\"\" 2>&1\", 0, False') -Encoding ASCII",
    // Lancé par l'explorateur Windows (comme un double-clic), pas par ce terminal : le programme continue quand la fenêtre
    // ou l'outil qui a lancé la commande se ferme (02/11 : lancé depuis Claude Code, il s'arrêtait avec la commande).
    "Start-Process explorer.exe -ArgumentList ('\"' + $vbs + '\"')",
    "Start-Sleep -Seconds 4",
    "if (-not (Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like ('*' + $dir + '*') })) { Start-Process wscript.exe $vbs }",
    "Write-Host \"C'est prêt : ce projet apparaît dans le panel ($server). Les agents tournent sur cet ordinateur, même après un redémarrage.\" -ForegroundColor Green",
    "Write-Host \"Ils sont rangés dans le dossier agents-ia de ce projet (ignoré par git) : supprimer ce dossier retire tous les agents, sans toucher à ton code.\"",
  ].join("\r\n");
  return !ok ? "echo 'Code de connexion invalide ou expiré : crée-en un nouveau dans le panel.'" : [
    "set -e", "server='" + PUBLIC_URL + "'; code='" + code + "'",
    "echo 'Agents IA : connexion de cet ordinateur au panel'",
    "for c in node git claude; do command -v $c >/dev/null || { echo \"Il manque $c : installe-le, connecte Claude (claude puis /login), puis relance.\"; exit 1; }; done",
    "st=$(claude auth status 2>/dev/null || true); case \"$st\" in *'\"loggedIn\": false'*) echo \"Claude n'est pas connecté sur cet ordinateur : tape claude puis /login, puis relance cette commande.\"; exit 1;; esac",
    "if [ ! -e .git ]; then top=$(git rev-parse --show-toplevel 2>/dev/null || true); [ -z \"$top\" ] || { echo \"Ce dossier fait partie du dépôt git $top : relance la commande dans ce dossier-là.\"; exit 1; }; fi",
    "[ -e .git ] || { echo \"Ce dossier n'est pas encore suivi par git : je crée un dépôt git local pour les agents (aucun fichier de ton projet n'est modifié, rien n'est envoyé ailleurs).\"; git init -q; }",
    "if ! git rev-parse -q --verify HEAD >/dev/null; then ex=$(git rev-parse --git-path info/exclude); mkdir -p \"$(dirname \"$ex\")\"; touch \"$ex\"; [ -s \"$ex\" ] && [ -n \"$(tail -c1 \"$ex\")\" ] && echo >> \"$ex\"; for p in .env .env.local '.env.*.local' .env.production '*.key' '*.pem' '*.p12' '*.pfx' 'id_rsa*' node_modules/ .venv/ venv/ __pycache__/ '*.db' '*.sqlite' '*.sqlite3' /data/agents/ /agents-ia/; do grep -qxF \"$p\" \"$ex\" || echo \"$p\" >> \"$ex\"; done; git add -A; git -c user.name='Agents IA' -c user.email=agents@local commit -q --allow-empty -m 'Départ : état du projet avant les agents IA'; echo 'État actuel enregistré dans git sur cet ordinateur, sans rien modifier (les secrets comme .env en sont exclus).'; fi",
    "dir=\"$HOME/.agents-ia\"; mkdir -p \"$dir\"",
    "curl -fsS \"$server/api/node/bundle?code=$code\" | node -e 'let s=\"\";process.stdin.on(\"data\",d=>s+=d).on(\"end\",()=>{const b=JSON.parse(s),fs=require(\"fs\"),p=require(\"path\");for(const[f,t]of Object.entries(b.files)){const x=p.join(process.argv[1],f);fs.mkdirSync(p.dirname(x),{recursive:true});fs.writeFileSync(x,t)}fs.writeFileSync(p.join(process.argv[1],\"version.txt\"),b.version)})' \"$dir\"",
    "node \"$dir/node.js\" --enroll \"$server\" \"$code\" \"$(pwd)\"",
    "( crontab -l 2>/dev/null | grep -v agents-ia; echo \"@reboot cd $dir && node node.js >> $dir/node.log 2>&1\" ) | crontab -",
    "( cd \"$dir\" && nohup node node.js >> node.log 2>&1 & )",
    "echo \"C'est prêt : ce projet apparaît dans le panel ($server).\"",
    "echo \"Ses agents sont rangés dans le dossier agents-ia de ce projet (ignoré par git) : supprimer ce dossier retire tous les agents, sans toucher à ton code.\"",
  ].join("\n");
}
// Réparation d'un ordinateur déjà connecté dont le programme ne se met plus à jour seul (03/11 : un ordinateur connecté bloqué sur
// une version cassée) : télécharge la version du panel avec le jeton de l'appareil, lu sur place (jamais affiché ni
// envoyé ailleurs que ce panel), remplace le programme et le relance. Ne touche ni aux projets ni à leurs agents.
function repairScript(kind) {
  if (kind === "ps1") return [
    "$ErrorActionPreference = 'Stop'",
    "$dir = Join-Path $env:LOCALAPPDATA 'AgentsIA'; $conf = Join-Path $dir 'data\\node.json'",
    "if (-not (Test-Path $conf)) { Write-Host \"Agents IA n'est pas installé sur cet ordinateur : connecte-le depuis le panel (Ajouter un projet).\" -ForegroundColor Red; return }",
    "$c = Get-Content $conf -Raw | ConvertFrom-Json",
    "Write-Host 'Agents IA : réparation du programme de cet ordinateur' -ForegroundColor Cyan",
    "$b = Invoke-RestMethod ($c.server + '/api/node/bundle') -Headers @{ Authorization = 'Bearer ' + $c.token }",
    "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like ('*' + $dir + '\\node.js*') } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }",
    "foreach ($f in $b.files.PSObject.Properties) { $p = Join-Path $dir $f.Name; New-Item -ItemType Directory -Force (Split-Path $p) | Out-Null; [IO.File]::WriteAllText($p, $f.Value, (New-Object Text.UTF8Encoding $false)) }",
    "[IO.File]::WriteAllText((Join-Path $dir 'version.txt'), $b.version)",
    "Remove-Item (Join-Path $dir 'data\\node.pid') -ErrorAction SilentlyContinue",
    "$vbs = Join-Path ([Environment]::GetFolderPath('Startup')) 'AgentsIA.vbs'",
    "if (-not (Test-Path $vbs)) { Set-Content $vbs ('CreateObject(\"WScript.Shell\").Run \"cmd /c node \"\"' + (Join-Path $dir 'node.js') + '\"\" >> \"\"' + (Join-Path $dir 'node.log') + '\"\" 2>&1\", 0, False') -Encoding ASCII }",
    "Start-Process explorer.exe -ArgumentList ('\"' + $vbs + '\"')",
    "Start-Sleep -Seconds 4",
    "if (-not (Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -like ('*' + $dir + '*') })) { Start-Process wscript.exe $vbs }",
    "Write-Host ('Réparé : version ' + $b.version + ' installée et relancée. Cet ordinateur repasse en ligne dans le panel sous une minute.') -ForegroundColor Green",
  ].join("\r\n");
  return [
    "set -e", "dir=\"$HOME/.agents-ia\"",
    "[ -f \"$dir/data/node.json\" ] || { echo \"Agents IA n'est pas installé sur cet ordinateur : connecte-le depuis le panel.\"; exit 1; }",
    "echo 'Agents IA : réparation du programme de cet ordinateur'",
    "node -e 'const fs=require(\"fs\"),p=require(\"path\"),d=process.argv[1],c=JSON.parse(fs.readFileSync(p.join(d,\"data/node.json\"),\"utf8\"));fetch(c.server+\"/api/node/bundle\",{headers:{Authorization:\"Bearer \"+c.token}}).then(r=>{if(!r.ok)throw new Error(\"panel : \"+r.status);return r.json()}).then(b=>{for(const[f,t]of Object.entries(b.files)){const x=p.join(d,f);fs.mkdirSync(p.dirname(x),{recursive:true});fs.writeFileSync(x,t)}fs.writeFileSync(p.join(d,\"version.txt\"),b.version);console.log(\"version \"+b.version+\" installée\")}).catch(e=>{console.error(e.message);process.exit(1)})' \"$dir\"",
    "pkill -f \"$dir/node.js\" || true; rm -f \"$dir/data/node.pid\"",
    "( cd \"$dir\" && nohup node node.js >> node.log 2>&1 & )",
    "echo 'Réparé et relancé : cet ordinateur repasse en ligne dans le panel sous une minute.'",
  ].join("\n");
}
async function nodeApi(req, res, url) {
  const rp = url.pathname.match(/^\/n\/repair\.(ps1|sh)$/);
  if (req.method === "GET" && rp) { res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" }); return res.end(repairScript(rp[1])); }
  const im = url.pathname.match(/^\/n\/install\.(ps1|sh)$/);
  if (req.method === "GET" && im) {
    const body = installScript(im[1], String(url.searchParams.get("code") || "").slice(0, 60));
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
    return res.end(body);
  }
  if (req.method === "GET" && url.pathname === "/api/node/bundle") {
    if (!nodes.byToken(req) && !nodes.codeOwner(String(url.searchParams.get("code") || ""))) throw fail("Code ou jeton invalide.", 401);
    const b = nodes.bundle();
    return sendJson(res, 200, { version: b.version, files: b.files });
  }
  if (req.method !== "POST" || !/^application\/json/.test(req.headers["content-type"] || "")) throw fail("Route inconnue.", 404);
  if (url.pathname === "/api/node/enroll") { nodeLimit(clientIp(req)); return sendJson(res, 200, nodes.enroll(await readBody(req))); }
  if (url.pathname === "/api/node/sync") {
    const n = nodes.byToken(req);
    if (!n) throw fail("Jeton d'appareil invalide.", 401);
    return sendJson(res, 200, nodes.sync(n, await readBody(req, 20 * 1024 * 1024)));
  }
  throw fail("Route inconnue.", 404);
}
const nodeTries = new Map();
function nodeLimit(ip) {
  const t = Date.now();
  if (nodeTries.size > 20000) for (const [k, v] of nodeTries) if (v.until < t) nodeTries.delete(k);
  const e = nodeTries.get(ip);
  if (!e || e.until < t) return nodeTries.set(ip, { n: 1, until: t + 3600e3 });
  if (++e.n > 20) throw fail("Trop d'essais : réessaie plus tard.", 429);
}

// Comptes : routes sans session (inscription, connexion, compte administrateur à réclamer).
async function authApi(req, res, url) {
  const ip = clientIp(req), ua = req.headers["user-agent"];
  // Double authentification : le mot de passe ne donne qu'un ticket, la session vient avec le code ou la clé.
  const open = (r) => { if (r.mfa) return { mfa: r.mfa }; res.setHeader("Set-Cookie", auth.cookieHeader(r.token, Math.floor(auth.SESSION_MS / 1000))); return { user: r.user }; };
  if (req.method === "POST" && url.pathname === "/api/auth/signup") return open(await auth.signup(await readBody(req), ip, ua));
  if (req.method === "POST" && url.pathname === "/api/auth/login") return open(await auth.login(await readBody(req), ip, ua));
  if (req.method === "POST" && url.pathname === "/api/auth/mfa") return open(auth.loginSecondFactor(await readBody(req), ip, ua));
  if (req.method === "POST" && url.pathname === "/api/auth/mfa/key") return auth.loginKeyOptions(await readBody(req));
  if (req.method === "POST" && url.pathname === "/api/auth/setup") return open(await auth.claimAdmin(await readBody(req), ip, ua));
  if (req.method === "POST" && url.pathname === "/api/auth/logout") { auth.logout(req); res.setHeader("Set-Cookie", auth.cookieHeader("x", 0)); return { ok: true }; }
  if (req.method === "GET" && url.pathname === "/api/auth/me") { const u = auth.userOf(req); if (!u) throw fail("Non connecté.", 401); return { user: auth.publicUser(u) }; }
  return null;
}

// ---------- API pour les autres projets (docs/API.md) ----------
// Clé d'API (lib/apikeys.js) dans « Authorization: Bearer agk_… » ; les cookies du panel n'ouvrent rien ici (une page d'un
// autre site ne peut donc rien faire au nom de l'utilisateur). Ni coût, ni dossier, ni réglage interne dans les réponses.
const LEVELS = { info: "🔌", attention: "⚠️", urgent: "🚨" };
const ROUTE_404 = "Route inconnue : voir la documentation (panel → API & connexions, ou docs/API.md).";
function apiProject(p) {
  const n = nodes.nodeOfProject(p), last = history(p.id, 1);
  return { id: p.id, name: p.name, description: p.description || "", device: n ? { name: n.name, online: n.online } : null, agents: store.peekAgents(p.id).length, lastRunAt: last.length ? last[0].at : null };
}
function apiAgents(p) {
  const runs = store.peekRuns(p);
  return store.peekAgents(p.id).map((a) => {
    const l = runs[a.id] || {};
    return { id: a.id, name: a.name, kind: a.kind, description: a.description || "", enabled: a.enabled !== false, schedule: schedule.label(a.schedule),
      next: a.enabled === false ? null : schedule.nextRun(a.schedule, l.lastAt || null), last: l.lastAt ? { at: l.lastAt, status: l.lastStatus || null, summary: l.lastSummary || null } : null };
  });
}
const apiMessage = (m) => ({ role: m.role, at: m.at, text: m.text || "", error: m.error || null, actions: (m.actions || []).map((x) => ({ ok: !!x.ok, text: x.text })), commit: m.commit || null });
async function apiV1(req, url) {
  const { key, user: u } = apikeys.authenticate(req, clientIp(req));
  if (req.method !== "GET" && !/^application\/json/.test(req.headers["content-type"] || "")) throw fail("Content-Type application/json requis.", 415);
  const need = (scope) => apikeys.need(key, scope);
  const GET = req.method === "GET", POST = req.method === "POST";
  const [r0, pid, r2, x3, x4, ...rest] = url.pathname.split("/").filter(Boolean).slice(2); // après /api/v1
  if (!r0 && GET) return { version: 1, user: { name: u.name, email: u.email }, key: { name: key.name, scopes: key.scopes, projects: key.projects || null } };
  if (r0 !== "projects" || rest.length) throw fail(ROUTE_404, 404);
  if (!pid && GET) { need("lire"); return { projects: mine(u).filter((p) => apikeys.allows(key, p.id)).map(apiProject) }; }
  if (!pid || !apikeys.allows(key, pid)) throw fail(pid ? "Projet inconnu." : ROUTE_404, 404);
  const p = projectFor(u, pid);
  if (!r2 && GET) { need("lire"); return { project: apiProject(p), agents: apiAgents(p) }; }
  if (r2 === "runs" && !x3 && GET) {
    need("lire");
    const since = url.searchParams.get("since") || "", agent = url.searchParams.get("agent") || "", limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit")) || 50));
    return { runs: history(p.id, 5000).filter((h) => (!since || h.at > since) && (!agent || h.agent === agent)).slice(-limit).reverse()
      .map((h) => ({ at: h.at, agent: h.agent, status: h.status, source: h.source || null, summary: h.summary || null, seconds: h.seconds || 0, commit: h.commit || null })) };
  }
  if (r2 === "agents" && x3 && x4 === "run" && POST) {
    need("lancer");
    try { store.agent(p.id, x3); } catch (e) { throw fail("Agent inconnu.", 404); }
    runNow(p, x3, await readBody(req));
    return { queued: true, agent: x3, at: new Date().toISOString() };
  }
  if (r2 === "notifications" && !x3 && GET) {
    need("lire");
    const since = url.searchParams.get("since") || "";
    return { notifications: chat.notes(p).filter((n) => !since || n.at > since).map((n) => ({ at: n.at, text: n.text, source: n.source || "agent" })) };
  }
  if (r2 === "notifications" && !x3 && POST) {
    need("notifier");
    apikeys.quota(key, "notifications", 30);
    const b = await readBody(req), text = str(b.text, 4000), title = str(b.title, 120), level = LEVELS[b.level] ? b.level : "info";
    if (!text && !title) throw fail("Notification vide : donne « text » (et « title » si tu veux).");
    chat.note(p, LEVELS[level] + " " + (title || key.name) + (text ? "\n" + text : ""), { source: "api", key: key.name, level });
    return { ok: true };
  }
  if (r2 === "boss" && GET && !x3) { need("lire"); return { conversations: chat.list(p) }; }
  if (r2 === "boss" && GET && x3 && !x4) { need("lire"); const v = chat.view(p, x3); return { id: v.id, title: v.title, pending: !!v.pending, messages: v.messages.slice(-50).map(apiMessage) }; }
  if (r2 === "boss" && POST && !x3) {
    need("patron");
    apikeys.quota(key, "messages au patron", 10);
    const b = await readBody(req, 40 * 1024 * 1024); // pièces jointes en base64, comme dans le panel
    if (!str(b.text, 8000) && !(Array.isArray(b.files) && b.files.length)) throw fail("Message vide : donne « text ».");
    if (!b.conversation && chat.list(p).some((c) => c.pending)) throw fail("Le patron répond déjà dans une autre conversation : réessaie quand il a fini.", 409);
    const v = chat.send(p, b.conversation ? String(b.conversation) : chat.create(p).id, { text: b.text, files: b.files });
    return { conversation: v.id, pending: !!v.pending };
  }
  throw fail(ROUTE_404, 404);
}

async function api(req, res, url, u) {
  const P = (id) => projectFor(u, id);
  const m = url.pathname.match(/^\/api\/projects\/([a-z0-9-]+)(?:\/agents(?:\/([a-z0-9-]+))?(?:\/(run|delete))?)?$/);
  if (req.method === "POST" && url.pathname === "/api/auth/password") { await auth.changePassword(u, await readBody(req)); res.setHeader("Set-Cookie", auth.cookieHeader("x", 0)); return { ok: true }; }
  // Sécurité du compte : application d'authentification, codes de secours, clés de sécurité (lib/auth.js, lib/mfa.js).
  if (url.pathname.startsWith("/api/me/")) {
    const B = () => readBody(req);
    if (req.method === "GET" && url.pathname === "/api/me/security") return auth.security(u);
    if (req.method === "POST" && url.pathname === "/api/me/totp/setup") return await auth.totpSetup(u, await B());
    if (req.method === "POST" && url.pathname === "/api/me/totp/enable") return auth.totpEnable(u, await B());
    if (req.method === "POST" && url.pathname === "/api/me/totp/disable") return await auth.totpDisable(u, await B());
    if (req.method === "POST" && url.pathname === "/api/me/recovery") return await auth.recoveryNew(u, await B());
    if (req.method === "POST" && url.pathname === "/api/me/keys/options") return await auth.keyOptions(u, await B());
    if (req.method === "POST" && url.pathname === "/api/me/keys") return auth.keyAdd(u, await B());
    const dk = url.pathname.match(/^\/api\/me\/keys\/([A-Za-z0-9_-]{8,400})\/delete$/);
    if (req.method === "POST" && dk) return await auth.keyRemove(u, dk[1], await B());
    // Clés d'API pour les autres projets (lib/apikeys.js) : la créer demande le mot de passe, elle n'est montrée qu'une fois.
    if (req.method === "GET" && url.pathname === "/api/me/api-keys") return { keys: apikeys.list(u), scopes: apikeys.SCOPES, projects: mine(u).map((p) => ({ id: p.id, name: p.name, remote: !!p.node })), base: PUBLIC_URL + "/api/v1" };
    if (req.method === "POST" && url.pathname === "/api/me/api-keys") { const b = await B(); await auth.confirmPassword(u, b.password); return apikeys.create(u, b, mine(u).map((p) => p.id)); }
    const ak = url.pathname.match(/^\/api\/me\/api-keys\/(k-[0-9a-f]+)\/delete$/);
    if (req.method === "POST" && ak) { apikeys.remove(u, ak[1]); return { ok: true }; }
  }
  // Administration des comptes (administrateur seulement).
  if (url.pathname.startsWith("/api/admin/")) {
    if (u.role !== "admin") throw fail("Réservé à l'administrateur.", 403);
    if (req.method === "GET" && url.pathname === "/api/admin/users") return { users: auth.listUsers().map((x) => ({ ...x, projects: store.listProjects().filter((p) => ownerOf(p) === x.id).length })) };
    const um = url.pathname.match(/^\/api\/admin\/users\/(u-[0-9a-f]+)\/status$/);
    if (req.method === "POST" && um) return { user: auth.setStatus(u, um[1], (await readBody(req)).status) };
    const rm = url.pathname.match(/^\/api\/admin\/users\/(u-[0-9a-f]+)\/mfa-reset$/);
    if (req.method === "POST" && rm) return { user: auth.resetMfa(u, rm[1]) };
    // Services : état, journal du runner, redémarrages.
    if (req.method === "GET" && url.pathname === "/api/admin/services") return services();
    if (req.method === "GET" && url.pathname === "/api/admin/logs") { const x = runnerProcess(); return { out: x.out ? tailFile(x.out) : "", err: x.err ? tailFile(x.err) : "", error: x.error || null }; }
    if (req.method === "POST" && url.pathname === "/api/admin/restart") { const b = await readBody(req); return restartService(String(b.what || ""), !!b.force); }
  }
  // « Vu » sur une alerte de l'accueil (02/11 : une alerte d'agent hebdomadaire restait une semaine) : cachée pour ce compte
  // jusqu'au bilan suivant de l'agent (autre heure). Seulement pour ses propres projets.
  if (req.method === "POST" && url.pathname === "/api/alerts/seen") {
    const b = await readBody(req), p = P(String(b.project || ""));
    const key = p.id + "/" + admin.str(b.agent, 40) + "/" + admin.str(b.at, 40);
    store.writeJson(seenFile(u), [...store.readJson(seenFile(u), []).filter((k) => k !== key), key].slice(-300));
    return { ok: true };
  }
  if (req.method === "GET" && url.pathname === "/api/overview") {
    const projects = mine(u);
    const recent = projects.flatMap((p) => history(p.id, 60).map((h) => ({ ...h, project: p.id, projectName: p.name }))).sort((x, y) => (x.at < y.at ? 1 : -1)).slice(0, 12);
    return { runner: queue(u).runner, projects: projects.map(projectSummary), alerts: alerts(u), recent, me: auth.publicUser(u) };
  }
  // Navigation (barre latérale, recherche Ctrl+K) : projets et agents avec leur état, en une requête légère.
  if (req.method === "GET" && url.pathname === "/api/nav") {
    const q = queue(u);
    return { me: auth.publicUser(u), runner: q.runner, running: q.running, queue: q.pending, projects: mine(u).map((p) => {
      const runs = store.peekRuns(p);
      return { id: p.id, name: p.name, lastNote: chat.lastNote(p), node: nodes.nodeOfProject(p), agents: store.peekAgents(p.id).map((a) => ({ id: a.id, name: a.name, icon: a.icon || "🤖", kind: a.kind, enabled: a.enabled !== false, status: (runs[a.id] || {}).lastStatus || null })) };
    }) };
  }
  if (req.method === "GET" && url.pathname === "/api/queue") return queue(u);
  // Appareils de l'utilisateur : connecter (code et commandes), ajouter un projet, retirer.
  if (req.method === "GET" && url.pathname === "/api/nodes") return { nodes: nodes.listFor(u) };
  if (req.method === "POST" && url.pathname === "/api/nodes/code") {
    const c = nodes.createCode(u);
    return { ...c, windows: "irm \"" + PUBLIC_URL + "/n/install.ps1?code=" + c.code + "\" | iex", unix: "curl -fsS \"" + PUBLIC_URL + "/n/install.sh?code=" + c.code + "\" | sh" };
  }
  const nm2 = url.pathname.match(/^\/api\/nodes\/(n-[0-9a-f]+)\/(projects|delete)$/);
  if (req.method === "POST" && nm2) {
    const n = nodes.nodeFor(u, nm2[1]);
    if (nm2[2] === "delete") { nodes.remove(u, n.id); return { ok: true }; }
    const p = nodes.createProject(u.id, n, await readBody(req));
    return { project: { id: p.id, name: p.name } };
  }
  // Notifications push sur les appareils de l'utilisateur.
  if (req.method === "GET" && url.pathname === "/api/push") return { publicKey: push.publicKey(), devices: push.count(u.id) };
  if (req.method === "POST" && url.pathname === "/api/push/subscribe") { const b = await readBody(req); push.subscribe(b.subscription, b.device, u.id); return { devices: push.count(u.id) }; }
  if (req.method === "POST" && url.pathname === "/api/push/unsubscribe") { push.unsubscribe(String((await readBody(req)).endpoint || ""), u.id); return { devices: push.count(u.id) }; }
  if (req.method === "POST" && url.pathname === "/api/push/test") return { sent: await push.send({ title: "Agents IA", body: "Les notifications des agents arrivent bien sur cet appareil.", url: "/", tag: "test", uid: u.id }) };
  const vm = url.pathname.match(/^\/api\/projects\/([a-z0-9-]+)\/agents\/([a-z0-9-]+)\/versions(?:\/([0-9a-f]+))?$/);
  if (req.method === "GET" && vm) {
    const p = P(vm[1]), a = store.agent(p.id, vm[2]);
    return vm[3] ? { content: promptAt(p, a, vm[3]) } : { versions: promptVersions(p, a) };
  }
  if (req.method === "GET" && url.pathname === "/api/templates") return { templates: templates.list() };
  if (req.method === "POST" && url.pathname === "/api/projects") return { project: createProject(await readBody(req), u) };
  // Supprimer un projet (lib/nodes.js removeProject) : nom du projet recopié ; jamais pendant qu'un de ses agents ou son
  // patron travaille (il écrirait dans un dossier effacé).
  const dm = url.pathname.match(/^\/api\/projects\/([a-z0-9-]+)\/delete$/);
  if (req.method === "POST" && dm) {
    const p = P(dm[1]), b = await readBody(req);
    if (String(b.name || "").trim().toLowerCase() !== p.name.trim().toLowerCase()) throw fail("Recopie le nom du projet pour le supprimer.");
    const cur = p.node ? (nodes.nodeOfProject(p) || {}).current : runnerStatus().current;
    if (cur && cur.project === p.id) throw fail("« " + (cur.name || cur.agent) + " » travaille en ce moment sur ce projet : attends la fin de son passage, puis réessaie.", 409);
    if (chat.busy(p)) throw fail("Le patron répond en ce moment dans une conversation de ce projet : attends sa réponse ou arrête-la, puis réessaie.", 409);
    nodes.removeProject(p);
    return { ok: true };
  }
  // Fil des agents (lib/team.js) : ce que les agents du projet se sont écrit.
  const fm2 = url.pathname.match(/^\/api\/projects\/([a-z0-9-]+)\/messages$/);
  if (req.method === "GET" && fm2) return { messages: require("./lib/team").all(P(fm2[1]), 300).slice(-150).reverse() };
  // Réglages du projet (lib/agents-admin.js updateProject).
  const sm = url.pathname.match(/^\/api\/projects\/([a-z0-9-]+)\/settings$/);
  if (req.method === "POST" && sm) return admin.updateProject(P(sm[1]), await readBody(req), { admin: u.role === "admin" });
  // Agents supprimés, retrouvés dans l'historique, et leur restauration (lib/agents-history.js).
  const rx = url.pathname.match(/^\/api\/projects\/([a-z0-9-]+)\/agents-removed(?:\/([a-z0-9-]+)\/restore)?$/);
  if (rx && req.method === "GET" && !rx[2]) return { agents: agentsHistory.removed(P(rx[1])).map(agentsHistory.view) };
  if (rx && req.method === "POST" && rx[2]) return { agent: agentsHistory.restore(P(rx[1]), rx[2]) };
  const gm = url.pathname.match(/^\/api\/projects\/([a-z0-9-]+)\/graph$/);
  if (req.method === "GET" && gm) return buildGraph(P(gm[1]));
  // Conversations avec l'agent patron du projet (lib/chat.js) : la réponse s'écrit en direct, la page interroge.
  const cm = url.pathname.match(/^\/api\/projects\/([a-z0-9-]+)\/chats(?:\/(c-[0-9a-z]+))?(?:\/(messages|stop|rename|delete|rewind))?$/);
  if (cm) {
    const p = P(cm[1]), [, , cid, act] = cm;
    if (req.method === "GET" && !cid) { const a = boss.bossOf(p); return { boss: a ? { id: a.id, name: a.name } : null, conversations: chat.list(p, url.searchParams.get("q")), lastNote: chat.lastNote(p) }; }
    if (req.method === "POST" && !cid) return chat.create(p);
    if (req.method === "GET" && !act) return chat.view(p, cid);
    if (req.method === "POST" && act === "messages") return chat.send(p, cid, await readBody(req, 40 * 1024 * 1024)); // pièces jointes en base64
    if (req.method === "POST" && act === "stop") return chat.stop(p, cid);
    if (req.method === "POST" && act === "rename") return chat.rename(p, cid, (await readBody(req)).title);
    if (req.method === "POST" && act === "delete") { chat.remove(p, cid); return { ok: true }; }
    if (req.method === "POST" && act === "rewind") { const b = await readBody(req); return chat.rewind(p, cid, Number(b.index), b.text); }
  }
  const km = url.pathname.match(/^\/api\/projects\/([a-z0-9-]+)\/commits\/([0-9a-f]{7,40})(\/revert)?$/);
  if (km && req.method === "GET" && !km[3]) return await commitDetail(P(km[1]), km[2]);
  if (km && req.method === "POST" && km[3]) return await revertCommit(P(km[1]), km[2]);
  // Chronologie : passages des agents sur 1 ou 7 jours (début = fin - durée), et celui en cours.
  const tm = url.pathname.match(/^\/api\/projects\/([a-z0-9-]+)\/timeline$/);
  if (req.method === "GET" && tm) {
    const p = P(tm[1]), days = Math.min(14, Math.max(1, Number(url.searchParams.get("days")) || 1)), from = Date.now() - days * 86400e3;
    const cur = runnerStatus().current;
    return { from: new Date(from).toISOString(), to: new Date().toISOString(), agents: store.peekAgents(p.id).map((a) => ({ id: a.id, name: a.name, kind: a.kind, enabled: a.enabled !== false })),
      runs: history(p.id, 20000).filter((h) => Date.parse(h.at) >= from).map((h) => ({ at: h.at, agent: h.agent, seconds: h.seconds || 0, status: h.status, source: h.source, summary: h.summary, commit: h.commit })),
      current: cur && cur.project === p.id ? cur : null };
  }
  const nm = url.pathname.match(/^\/api\/projects\/([a-z0-9-]+)\/notes$/);
  if (req.method === "GET" && nm) return { notes: chat.notes(P(nm[1])) };
  // Connexions des agents aux API d'autres projets (lib/connections.js) : les jetons ne reviennent jamais au navigateur.
  const xm = url.pathname.match(/^\/api\/projects\/([a-z0-9-]+)\/connections(?:\/(x-[0-9a-f]+)\/(delete|test|token|edit))?$/);
  if (xm) {
    const p = P(xm[1]);
    if (req.method === "GET" && !xm[2]) return { connections: connections.list(p), remote: !!p.node };
    if (req.method === "POST" && !xm[2]) return { connection: connections.add(p, await readBody(req)) };
    if (req.method === "POST" && xm[3] === "delete") { connections.remove(p, xm[2]); return { ok: true }; }
    if (req.method === "POST" && xm[3] === "token") return { connection: connections.setToken(p, xm[2], await readBody(req)) };
    if (req.method === "POST" && xm[3] === "edit") return { connection: connections.update(p, xm[2], await readBody(req)) };
    // Projet d'appareil : l'essai est fait par l'appareil, d'où ses agents appellent l'API (adresse locale comprise).
    if (req.method === "POST" && xm[3] === "test") {
      if (!p.node) return await connections.test(p, xm[2]);
      if (!connections.all(p.id).some((x) => x.id === xm[2])) throw fail("Connexion inconnue.", 404);
      return await nodes.ask(p, { type: "connexion", conn: xm[2] });
    }
  }
  if (!m) throw fail("Route inconnue.", 404);
  const p = P(m[1]);
  const [, , aid, action] = m;
  if (req.method === "GET" && !aid && !url.pathname.endsWith("/agents")) {
    const runs = store.peekRuns(p), all = history(p.id);
    // dataKept : résultats rangés hors du dossier des agents (projets d'avant le 03/11), laissés en place si on supprime le projet.
    const dd = p.dataDir || "data/agents";
    return { project: { ...projectSummary(p), testCmd: p.testCmd, restartCmd: p.restartCmd, pm2Process: p.pm2Process, allowed: p.allowed, protected: p.protected, locked: p.locked || "", rules: p.rules || "", dataDir: dd,
      dataKept: p.agentsDir && dd.startsWith(p.agentsDir + "/") ? null : dd },
      runner: runnerStatus(), agents: store.peekAgents(p.id).map((a) => agentView(p, a, runs, all)),
      activity: all.slice(-40).reverse(), commits: agentCommits(p, 20), scout: store.readJson(path.join(p.data, "scout.json"), null), strategies: store.readJson(path.join(p.data, "strategies.json"), null) };
  }
  if (req.method === "GET" && aid && !action) {
    const a = store.agent(p.id, aid);
    const all = history(p.id);
    return { project: { id: p.id, name: p.name }, runner: runnerStatus(), agent: { ...agentView(p, a, store.peekRuns(p), all), prompt: store.readPrompt(p.id, a) },
      history: all.filter((h) => h.agent === aid).slice(-40).reverse(), details: kindDetails(p, a) };
  }
  if (req.method === "POST" && url.pathname.endsWith("/agents") && !aid) return { agent: createAgent(p, await readBody(req)) };
  if (req.method === "POST" && aid && action === "run") return runNow(p, aid, await readBody(req));
  if (req.method === "POST" && aid && action === "delete") { deleteAgent(p, aid); return { ok: true }; }
  if (req.method === "POST" && aid && !action) return { agent: updateAgent(p, aid, await readBody(req)) };
  throw fail("Route inconnue.", 404);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  try {
    // Vidéos de l'agent vidéo (lecture et téléchargement depuis le panel), avec les requêtes partielles (Range) que les
    // lecteurs vidéo des téléphones demandent.
    // Pages et fichiers publics (l'app elle-même, son installation) ; tout le reste demande une session.
    // Fichiers d'un projet (vidéos, pièces jointes) : jamais publics, même sans point dans le nom (revue du 02/11).
    const isPublic = req.method === "GET" && !/^\/(media|chat-files)\//.test(url.pathname) && (url.pathname === "/" || url.pathname === "/sw.js" || url.pathname === "/manifest.webmanifest" || /^\/(icon-[\w-]+|apple-touch-icon)\.png$/.test(url.pathname) || !url.pathname.includes("."));
    if (url.pathname.startsWith("/api/node/") || url.pathname.startsWith("/n/")) return await nodeApi(req, res, url);
    // API pour les autres projets : clé d'API seulement, jamais la session du panel (docs/API.md).
    if (url.pathname === "/api/v1" || url.pathname.startsWith("/api/v1/")) return sendJson(res, 200, await apiV1(req, url));
    if (url.pathname.startsWith("/api/auth/") && url.pathname !== "/api/auth/password") {
      if (req.method !== "GET" && !/^application\/json/.test(req.headers["content-type"] || "")) throw fail("Content-Type application/json requis.", 415);
      const r = await authApi(req, res, url);
      if (r) return sendJson(res, 200, r);
    }
    const U = isPublic && !url.pathname.startsWith("/api/") ? null : auth.userOf(req);
    if (!U && !(isPublic && !url.pathname.startsWith("/api/"))) return sendJson(res, 401, { error: "Connecte-toi pour continuer." });
    const mm = url.pathname.match(/^\/media\/([a-z0-9-]+)\/video\/([0-9-]+)\/(gold-pilot\.mp4|apercu\.png)$/);
    if (req.method === "GET" && mm) {
      const file = path.join(projectFor(U, mm[1]).data, "video", mm[2], mm[3]);
      if (!fs.existsSync(file)) return sendJson(res, 404, { error: "Introuvable." });
      const size = fs.statSync(file).size, type = mm[3].endsWith(".mp4") ? "video/mp4" : "image/png";
      const head = { "Content-Type": type, "Accept-Ranges": "bytes", "Cache-Control": "private, max-age=86400" };
      if (url.searchParams.has("dl")) head["Content-Disposition"] = 'attachment; filename="gold-pilot-' + mm[2] + "." + (type === "video/mp4" ? "mp4" : "png") + '"';
      const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
      if (range) {
        const start = range[1] ? +range[1] : Math.max(0, size - +range[2]), end = range[1] && range[2] ? Math.min(+range[2], size - 1) : size - 1;
        if (start > end || start >= size) { res.writeHead(416, { "Content-Range": "bytes */" + size }); return res.end(); }
        res.writeHead(206, { ...head, "Content-Range": "bytes " + start + "-" + end + "/" + size, "Content-Length": end - start + 1 });
        return fs.createReadStream(file, { start, end }).pipe(res);
      }
      res.writeHead(200, { ...head, "Content-Length": size });
      return fs.createReadStream(file).pipe(res);
    }
    // App installable (manifeste, service worker, icônes) : notifications push des agents sur le téléphone (lib/push.js).
    if (req.method === "GET" && url.pathname === "/manifest.webmanifest") {
      const body = JSON.stringify({ name: "Agents IA", short_name: "Agents IA", description: "Console des agents IA", start_url: "/", scope: "/", display: "standalone", background_color: "#0d1117", theme_color: "#0d1117",
        icons: [{ src: "/icon-192.png", sizes: "192x192", type: "image/png" }, { src: "/icon-512.png", sizes: "512x512", type: "image/png" }, { src: "/icon-maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" }] });
      res.writeHead(200, { "Content-Type": "application/manifest+json; charset=utf-8", "Cache-Control": "no-store" });
      return res.end(body);
    }
    if (req.method === "GET" && url.pathname === "/sw.js") {
      res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-store", "Service-Worker-Allowed": "/" });
      return fs.createReadStream(path.join(__dirname, "public", "sw.js")).pipe(res);
    }
    const im = url.pathname.match(/^\/(?:icon-(192|512)|icon-maskable-(512)|apple-touch-icon)\.png$/);
    if (req.method === "GET" && im) {
      const png = require("./lib/icon").png(Number(im[1] || im[2] || 180), !!im[2]);
      res.writeHead(200, { "Content-Type": "image/png", "Content-Length": png.length, "Cache-Control": "public, max-age=86400" });
      return res.end(png);
    }
    // Pièces jointes des conversations avec le patron (images affichées, autres fichiers téléchargés).
    const fm = url.pathname.match(/^\/chat-files\/([a-z0-9-]+)\/(c-[0-9a-z]+)\/([\w.-]+)$/);
    if (req.method === "GET" && fm) {
      const f = chat.filePath(projectFor(U, fm[1]), fm[2], fm[3]);
      res.writeHead(200, { "Content-Type": f.type, "Content-Length": fs.statSync(f.file).size, "Cache-Control": "private, max-age=86400", "X-Content-Type-Options": "nosniff",
        ...(/^image\//.test(f.type) ? {} : { "Content-Disposition": "attachment; filename=\"" + fm[3].replace(/^[0-9a-z]+-\d+-/, "") + "\"" }) });
      return fs.createReadStream(f.file).pipe(res);
    }
    if (url.pathname.startsWith("/api/")) {
      // Écritures : JSON seulement (un formulaire d'un autre site ne peut pas en envoyer ; cookie SameSite=Lax).
      if (req.method !== "GET" && !/^application\/json/.test(req.headers["content-type"] || "")) throw fail("Content-Type application/json requis.", 415);
      return sendJson(res, 200, await api(req, res, url, U));
    }
    if (req.method === "GET" && (url.pathname === "/" || !url.pathname.includes("."))) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "X-Frame-Options": "DENY", "Referrer-Policy": "same-origin" });
      return fs.createReadStream(PAGE).pipe(res);
    }
    sendJson(res, 404, { error: "Introuvable." });
  } catch (e) {
    if (!e.status) console.error("[panel]", e);
    sendJson(res, e.status || 500, { error: e.status ? e.message : "Erreur interne." });
  }
});

// Connexions gardées 65 s (Node : 5 s par défaut) : un client qui revient toutes les 3 à 5 s (page, appareil qui se
// synchronise) réutilise la sienne au lieu d'en rouvrir une. File d'attente des nouvelles connexions agrandie. Test de
// charge du 01/11 à 1000 clients : toutes les erreurs étaient des connexions refusées, file pleine.
server.keepAliveTimeout = 65e3;
server.headersTimeout = 66e3;
if (require.main === module) server.listen(PORT, "127.0.0.1", 2048, () => console.log("[panel] agents sur http://127.0.0.1:" + PORT));
module.exports = { server, cleanSchedule, agentCommits };

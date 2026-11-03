// Agents rangés dans le projet lui-même (demande du propriétaire, 03/11) : <dossier>/agents-ia (agents.json, consignes,
// résultats), ignoré par git ; supprimer ce dossier retire tous les agents du projet, ici comme sur un appareil (le panel
// ne les renvoie pas). Dossiers jetables. Lancer : npm test
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gp-dossier-"));
process.env.AGENTS_RUNTIME = path.join(tmp, "data");
process.env.AGENTS_PROJECTS = path.join(tmp, "projects");
process.env.AGENTS_AUTH_DIR = path.join(tmp, "data");
process.env.AGENTS_NO_PUSH = "1";
const test = require("node:test");
const assert = require("node:assert/strict");
const store = require("../lib/store");
const nodes = require("../lib/nodes");
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

// L'appareil (node.js) dans son propre process, avec ses propres dossiers (comme sur un autre ordinateur) ; son état
// (node-state.json) gardé d'un appel à l'autre. fn(device, state, arg) -> résultat (JSON).
const DEV = path.join(tmp, "appareil");
function onDevice(fn, arg = null) {
  const sf = path.join(DEV, "state.json");
  const code = "const fs=require('fs'),d=require(" + JSON.stringify(path.join(__dirname, "..", "node.js")) + "),sf=" + JSON.stringify(sf) + ";" +
    "const state=fs.existsSync(sf)?JSON.parse(fs.readFileSync(sf,'utf8')):{p:{}};const out=(" + fn.toString() + ")(d,state,JSON.parse(process.argv[1]));" +
    "fs.writeFileSync(sf,JSON.stringify(state));console.log(JSON.stringify(out===undefined?null:out));";
  fs.mkdirSync(DEV, { recursive: true });
  const r = spawnSync(process.execPath, ["-e", code, JSON.stringify(arg)], { encoding: "utf8", timeout: 30000,
    env: { ...process.env, AGENTS_RUNTIME: path.join(DEV, "data"), AGENTS_PROJECTS: path.join(DEV, "projects"), AGENTS_AUTH_DIR: path.join(DEV, "data") } });
  if (r.status !== 0) throw new Error(r.stderr);
  return JSON.parse(r.stdout.trim().split(/\r?\n/).pop());
}

const repo = (name) => { const d = path.join(tmp, name); fs.mkdirSync(d, { recursive: true }); spawnSync("git", ["init", "-q"], { cwd: d }); return d; };
const project = (id, p) => store.writeJson(path.join(store.PROJECTS, id, "project.json"), p);

test("projet d'ici : agents, consignes et LISEZMOI dans <projet>/agents-ia, ignoré par git ; dossier supprimé = plus d'agents", () => {
  const dir = repo("site");
  project("site", { name: "Site", dir, agentsDir: "agents-ia", dataDir: "agents-ia/data" });
  const a = { id: "revue", name: "Revue", kind: "custom", prompt: "prompts/revue.md", schedule: { type: "on-demand" } };
  store.writePrompt("site", a, "Relis le code du site et note les problèmes.");
  store.writeAgents("site", [a]);
  const home = path.join(dir, "agents-ia");
  assert.ok(fs.existsSync(path.join(home, "agents.json")) && fs.existsSync(path.join(home, "prompts", "revue.md")) && fs.existsSync(path.join(home, "LISEZMOI.md")));
  assert.ok(!fs.existsSync(path.join(store.PROJECTS, "site", "agents.json")), "plus rien dans projects/<id>");
  assert.equal(store.project("site").data, path.join(dir, "agents-ia", "data"), "résultats dans le même dossier");
  assert.match(fs.readFileSync(path.join(dir, ".git", "info", "exclude"), "utf8"), /^\/agents-ia\/$/m);
  assert.equal(spawnSync("git", ["status", "--porcelain"], { cwd: dir, encoding: "utf8" }).stdout, "", "git ne voit rien : les agents qui codent ne sont pas bloqués");
  assert.deepEqual(store.listAgents("site").map((x) => x.id), ["revue"]);
  fs.rmSync(home, { recursive: true, force: true });
  assert.deepEqual(store.listAgents("site"), [], "dossier supprimé : plus aucun agent");
});

test("ancien projet (sans agentsDir) : toujours projects/<id>", () => {
  const dir = repo("ancien");
  project("ancien", { name: "Ancien", dir, dataDir: "data/agents" });
  store.writeAgents("ancien", [{ id: "x", name: "X", kind: "custom" }]);
  assert.ok(fs.existsSync(path.join(store.PROJECTS, "ancien", "agents.json")));
  assert.ok(!fs.existsSync(path.join(dir, "agents-ia")));
});

test("première connexion d'un appareil : projet créé avec son dossier agents-ia (patron et éclaireur)", () => {
  const { code } = nodes.createCode({ id: "u-essai" });
  const r = nodes.enroll({ code, name: "PC", info: {}, project: { name: "Mon appli", dir: "C:/x/mon-appli" } });
  const p = store.project(r.project.id);
  assert.deepEqual([p.agentsDir, p.dataDir], ["agents-ia", "agents-ia/data"]);
  assert.match(p.allowed, /agents-ia\//, "zone de code : jamais le dossier des agents");
  assert.deepEqual(store.listAgents(p.id).map((a) => a.id), ["boss", "scout"], "copie du panel");
  assert.match(store.readPrompt(p.id, { id: "scout" }), /Éclaireur Mon appli/);
  const cfg = nodes.sync({ id: r.node.id, name: "PC" }, {}).projects[0];
  assert.equal(cfg.project.agentsDir, "agents-ia", "envoyé à l'appareil");
});

test("appareil : agents écrits dans le projet ; dossier supprimé sur l'appareil = agents retirés du panel, pas renvoyés", () => {
  // Panel : un projet d'appareil avec deux agents.
  const { code } = nodes.createCode({ id: "u-dev" });
  const r = nodes.enroll({ code, name: "PC dev", info: {}, project: { name: "Appli dev", dir: "C:/y/appli" } });
  const node = { id: r.node.id, name: "PC dev" }, pid = r.project.id;
  const dir = repo("appli-appareil"), home = path.join(dir, "agents-ia");
  const toDevice = (c) => ({ ...c, project: { ...c.project, dir } }); // dossier du projet sur l'appareil
  const apply = (d, state, c) => d.applyProjects([c], state), collect = (d, state) => d.collect(state, []).projects;
  let c = nodes.sync(node, {}).projects.find((x) => x.id === pid);
  onDevice(apply, toDevice(c));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(home, "agents.json"), "utf8")).map((a) => a.id), ["boss", "scout"]);
  assert.ok(fs.existsSync(path.join(home, "prompts", "boss.md")) && fs.existsSync(path.join(home, "LISEZMOI.md")));
  assert.ok(!fs.existsSync(path.join(DEV, "projects", pid, "agents.json")), "plus dans le dossier du programme");
  assert.match(fs.readFileSync(path.join(dir, ".git", "info", "exclude"), "utf8"), /^\/agents-ia\/$/m);
  // Synchronisation suivante, rien de changé : rien de réécrit.
  const t = fs.statSync(path.join(home, "agents.json")).mtimeMs;
  onDevice(apply, toDevice(c));
  assert.equal(fs.statSync(path.join(home, "agents.json")).mtimeMs, t);
  // Le propriétaire supprime le dossier sur son ordinateur.
  fs.rmSync(home, { recursive: true, force: true });
  const sent = onDevice(collect)[pid];
  assert.equal(sent.removed, true);
  c = nodes.sync(node, { projects: { [pid]: sent } }).projects.find((x) => x.id === pid);
  assert.deepEqual(store.listAgents(pid), [], "retirés du panel aussi");
  assert.deepEqual(c.agents, []);
  onDevice(apply, toDevice(c));
  assert.ok(!fs.existsSync(home), "pas recréé sur l'appareil");
  assert.equal(onDevice(collect)[pid].removed, undefined, "signalé une seule fois");
});

// Supprimer un projet depuis le panel (03/11) : tout ce que le panel garde à son nom disparaît, son dossier agents-ia
// aussi ; le code du projet reste.
test("projet d'ici supprimé : réglages, agents-ia, passages, conversations, connexions, lancements et clés nettoyés ; code gardé", () => {
  const dir = repo("supprime");
  fs.writeFileSync(path.join(dir, "index.js"), "code du projet\n");
  project("supprime", { name: "À supprimer", dir, agentsDir: "agents-ia", dataDir: "agents-ia/data", owner: "u-sup" });
  project("autre", { name: "Autre", dir: repo("autre"), agentsDir: "agents-ia", dataDir: "agents-ia/data", owner: "u-sup" });
  const a = { id: "revue", name: "Revue", kind: "custom", prompt: "prompts/revue.md", schedule: { type: "on-demand" } };
  store.writePrompt("supprime", a, "Relis le code."); store.writeAgents("supprime", [a]);
  store.writeJson(path.join(store.project("supprime").data, "agents-runs.json"), { revue: { lastAt: "2026-11-03T10:00:00Z" } });
  const R = (...f) => path.join(store.RUNTIME, ...f);
  store.append(R("history", "supprime.jsonl"), { at: "2026-11-03T10:00:00Z", agent: "revue" });
  store.writeJson(R("chat", "supprime", "c-abcd.json"), { id: "c-abcd" });
  store.append(R("chat", "supprime.notes.jsonl"), { text: "note" });
  store.writeJson(R("connections", "supprime.json"), [{ id: "x-1" }]);
  store.writeJson(R("commands", "1-a.json"), { project: "supprime", agent: "revue" });
  store.writeJson(R("commands", "2-b.json"), { project: "autre", agent: "revue" });
  store.writeJson(R("api-keys.json"), [{ id: "k-1", owner: "u-sup", projects: ["supprime", "autre"] }, { id: "k-2", owner: "u-sup", projects: ["supprime"] }, { id: "k-3", owner: "u-sup", projects: null }]);
  nodes.removeProject(store.project("supprime"));
  assert.throws(() => store.project("supprime"), /inconnu/);
  assert.ok(!store.listProjects().some((p) => p.id === "supprime") && store.listProjects().some((p) => p.id === "autre"));
  assert.ok(!fs.existsSync(path.join(dir, "agents-ia")), "dossier des agents effacé");
  assert.equal(fs.readFileSync(path.join(dir, "index.js"), "utf8"), "code du projet\n", "code du projet gardé");
  for (const f of [R("history", "supprime.jsonl"), R("chat", "supprime"), R("chat", "supprime.notes.jsonl"), R("connections", "supprime.json"), R("commands", "1-a.json")]) assert.ok(!fs.existsSync(f), f);
  assert.ok(fs.existsSync(R("commands", "2-b.json")), "lancement d'un autre projet gardé");
  assert.deepEqual(store.readJson(R("api-keys.json"), []).map((k) => k.projects), [["autre"], [], null]);
});

test("projet d'appareil supprimé : l'appareil efface son dossier agents-ia, le confirme, et n'en entend plus parler", () => {
  const { code } = nodes.createCode({ id: "u-dev2" });
  const r = nodes.enroll({ code, name: "PC 2", info: {}, project: { name: "Appli 2", dir: "C:/z/appli2" } });
  const node = { id: r.node.id, name: "PC 2" }, pid = r.project.id;
  const dir = repo("appli-supprimee"), home = path.join(dir, "agents-ia");
  fs.writeFileSync(path.join(dir, "app.js"), "code\n");
  const toDevice = (c) => ({ ...c, project: { ...c.project, dir } });
  onDevice((d, state, c) => d.applyProjects([c], state), toDevice(nodes.sync(node, {}).projects.find((x) => x.id === pid)));
  assert.ok(fs.existsSync(path.join(home, "agents.json")));
  nodes.removeProject(store.project(pid));
  const res = nodes.sync(node, {});
  assert.ok(!res.projects.some((x) => x.id === pid), "plus envoyé à l'appareil");
  assert.deepEqual(res.dropped.map((x) => x.id), [pid]);
  // L'appareil le reçoit : dossier effacé (son project.json local donne le dossier), code gardé, confirmation en attente.
  const acked = onDevice((d, state, x) => { d.applyProjects([], state, x); return state.dropped; }, res.dropped);
  assert.deepEqual(acked, [pid]);
  assert.ok(!fs.existsSync(home), "dossier des agents effacé sur l'appareil");
  assert.equal(fs.readFileSync(path.join(dir, "app.js"), "utf8"), "code\n");
  assert.ok(!fs.existsSync(path.join(DEV, "projects", pid)), "réglages locaux retirés");
  assert.deepEqual(nodes.sync(node, { dropped: acked }).dropped, [], "confirmé : plus renvoyé");
});

test("projet d'appareil supprimé puis le même dossier reconnecté avant l'effacement : le nouveau dossier des agents reste", () => {
  const { code } = nodes.createCode({ id: "u-dev3" });
  const r = nodes.enroll({ code, name: "PC 3", info: {}, project: { name: "Appli 3", dir: "C:/w/appli3" } });
  const node = nodes.nodeFor({ id: "u-dev3" }, r.node.id);
  nodes.removeProject(store.project(r.project.id));
  assert.equal(nodes.sync(node, {}).dropped.length, 1);
  nodes.createProject("u-dev3", node, { name: "Appli 3 bis", dir: "C:/W/appli3" });
  assert.deepEqual(nodes.sync(node, {}).dropped, [], "plus d'effacement en attente pour ce dossier");
});

test("ancien appareil : ses réglages passent du dossier du programme au dossier du projet", () => {
  const dir = repo("migre"), id = "migre";
  const legacy = path.join(DEV, "projects", id);
  const a = { id: "a", name: "A", kind: "custom", prompt: "prompts/a.md", schedule: { type: "on-demand" } };
  const c = { id, base: "h1", project: { name: "Migré", dir, agentsDir: "agents-ia", dataDir: "data/agents" }, agents: [a], prompts: { "prompts/a.md": "consigne du panel" } };
  // Laissé par l'ancien programme : réglages dans son dossier (project.json déjà avec agentsDir), état sans emplacement.
  fs.mkdirSync(path.join(legacy, "prompts"), { recursive: true });
  fs.writeFileSync(path.join(legacy, "project.json"), JSON.stringify(c.project));
  fs.writeFileSync(path.join(legacy, "agents.json"), JSON.stringify([a]));
  fs.writeFileSync(path.join(legacy, "prompts", "a.md"), "ancienne consigne");
  // Premier envoi du nouveau programme, avant d'avoir écrit le dossier agents-ia : ni « supprimés » ni « liste vide ».
  const first = onDevice((d, state, s) => { state.p.migre = s; return d.collect(state, []).projects.migre; }, { history: 0, notes: 0, sent: {}, head: "", base: "h1", localHash: "x" });
  assert.equal(first.removed, undefined);
  assert.equal(first.config, undefined, "les agents du panel ne sont pas effacés");
  onDevice((d, state, x) => d.applyProjects([x], state), c);
  assert.equal(fs.readFileSync(path.join(dir, "agents-ia", "prompts", "a.md"), "utf8"), "consigne du panel");
  assert.ok(!fs.existsSync(path.join(legacy, "agents.json")) && !fs.existsSync(path.join(legacy, "prompts")), "ancien emplacement retiré");
  assert.ok(fs.existsSync(path.join(legacy, "project.json")));
});

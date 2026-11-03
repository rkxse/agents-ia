// Tout gérer depuis le site (03/11) : réglages du projet, agents supprimés restaurés depuis l'historique (copie
// d'historique d'un dossier agents-ia), connexion modifiée sans la retirer. Dépôt des réglages jetable
// (AGENTS_CONFIG_REPO), projets dedans comme dans le vrai panel. Lancer : npm test
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gp-gestion-"));
const repoGit = (cwd, ...a) => spawnSync("git", a, { cwd, encoding: "utf8" });
const CONF = path.join(tmp, "panel");
fs.mkdirSync(CONF, { recursive: true });
repoGit(CONF, "init", "-q"); repoGit(CONF, "config", "user.email", "test@example.invalid"); repoGit(CONF, "config", "user.name", "test"); repoGit(CONF, "config", "core.autocrlf", "false");
process.env.AGENTS_CONFIG_REPO = CONF;
process.env.AGENTS_PROJECTS = path.join(CONF, "projects");
process.env.AGENTS_RUNTIME = path.join(tmp, "data");
process.env.AGENTS_AUTH_DIR = path.join(tmp, "data");
process.env.AGENTS_NO_PUSH = "1";
const test = require("node:test");
const assert = require("node:assert/strict");
const store = require("../lib/store");
const admin = require("../lib/agents-admin");
const hist = require("../lib/agents-history");
const connections = require("../lib/connections");
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const codeDir = (name) => { const d = path.join(tmp, name); fs.mkdirSync(d, { recursive: true }); repoGit(d, "init", "-q"); return d; };
const project = (id, p) => { store.writeJson(path.join(store.PROJECTS, id, "project.json"), p); admin.commitConfig("projet " + id, [path.join(store.PROJECTS, id)]); };
const agent = (id, extra = {}) => ({ id, name: "Agent " + id, kind: "custom", enabled: true, prompt: "prompts/" + id + ".md", schedule: { type: "daily", hourUTC: 6, weekend: false }, ...extra });
const add = (pid, a, text) => { store.writePrompt(pid, a, text); store.writeAgents(pid, [...store.listAgents(pid), a]); admin.commitConfig("ajout " + a.id, [store.agentsFile(pid), store.promptPath(pid, a)]); };
const del = (pid, aid) => {
  const a = store.agent(pid, aid), pp = store.promptPath(pid, a);
  store.writeAgents(pid, store.listAgents(pid).filter((x) => x.id !== aid)); fs.rmSync(pp, { force: true });
  admin.commitConfig("retrait " + aid, [store.agentsFile(pid), pp]);
};

test("réglages du projet : champs changés et commités, zones vérifiées, commandes d'ici réservées à l'administrateur", () => {
  project("reg", { name: "Réglages", dir: codeDir("reg"), agentsDir: "agents-ia", dataDir: "agents-ia/data", testCmd: "npm test", allowed: "^src/" });
  const p = store.project("reg");
  const r = admin.updateProject(p, { name: "Réglages 2", rules: "- Ne lis jamais .env.\r\n- Tests d'abord.", allowed: "^src/|^lib/", testCmd: "npm test" }, { admin: false });
  assert.deepEqual(r.changed, ["nom", "zones permises", "règles du projet"], "commande inchangée : pas refusée");
  const saved = store.readJson(path.join(store.PROJECTS, "reg", "project.json"));
  assert.equal(saved.rules, "- Ne lis jamais .env.\n- Tests d'abord.");
  assert.match(repoGit(CONF, "log", "-1", "--format=%s").stdout, /Réglages 2 · réglages du projet \(nom, zones permises, règles du projet\)/);
  assert.throws(() => admin.updateProject(store.project("reg"), { allowed: "^src/(" }), /Expression invalide/);
  assert.throws(() => admin.updateProject(store.project("reg"), { allowed: "" }), /zones que les agents peuvent modifier/);
  assert.throws(() => admin.updateProject(store.project("reg"), { restartCmd: "pm2 restart x" }, { admin: false }), (e) => e.status === 403);
  admin.updateProject(store.project("reg"), { testCmd: "npm test\nrm -rf /" }, { admin: true });
  assert.equal(store.project("reg").testCmd, "npm test rm -rf /", "une seule ligne : pas de deuxième commande cachée");
  // Projet d'un appareil : ses commandes tournent sur son ordinateur, son propriétaire les change ; pas de pm2.
  project("dev", { name: "Appareil", node: "n-1", dir: "C:/x", agentsDir: "agents-ia", allowed: "^src/" });
  assert.deepEqual(admin.updateProject(store.project("dev"), { restartCmd: "scripts\\restart.bat", pm2Process: "x" }, { admin: false }).changed, ["commande de redémarrage"]);
});

test("dossier agents-ia : copie d'historique commitée, versions des consignes, agent supprimé restauré en pause", () => {
  const dir = codeDir("site");
  project("site", { name: "Site", dir, agentsDir: "agents-ia", dataDir: "agents-ia/data", allowed: "^src/" });
  add("site", agent("revue", { mode: "read" }), "Relis le code du site, version 1.");
  admin.updateAgent(store.project("site"), "revue", { prompt: "Relis le code du site, version 2 plus précise." });
  add("site", agent("tests"), "Écris les tests qui manquent au site.");
  fs.mkdirSync(path.join(dir, "agents-ia", "data"), { recursive: true });
  fs.writeFileSync(path.join(dir, "agents-ia", "data", "resultat.json"), "{}");
  const copy = path.join(store.PROJECTS, "site", store.HISTORY_DIR);
  assert.deepEqual(fs.readdirSync(path.join(copy, "prompts")).sort(), ["revue.md", "tests.md"]);
  admin.commitConfig("rien", [store.agentsFile("site")]);
  assert.ok(!fs.existsSync(path.join(copy, "data")), "résultats jamais copiés");
  assert.equal(repoGit(CONF, "status", "--porcelain").stdout, "", "copie commitée");
  const rel = path.relative(CONF, store.historyPath("site", store.promptPath("site", { id: "revue" }))).split(path.sep).join("/");
  assert.equal(repoGit(CONF, "log", "--format=%s", "--", rel).stdout.trim().split("\n").length, 2, "deux versions de la consigne");
  del("site", "revue");
  assert.ok(!fs.existsSync(path.join(copy, "prompts", "revue.md")), "retrait recopié");
  const gone = hist.removed(store.project("site"));
  assert.deepEqual(gone.map((x) => x.agent.id), ["revue"]);
  assert.ok(gone[0].removedAt, "date du retrait");
  const a = hist.restore(store.project("site"), "revue");
  assert.equal(a.enabled, false, "restauré en pause");
  assert.deepEqual(a.schedule, { type: "daily", hourUTC: 6, weekend: false });
  assert.equal(store.readPrompt("site", a), "Relis le code du site, version 2 plus précise.", "dernière consigne");
  assert.deepEqual(store.listAgents("site").map((x) => x.id), ["tests", "revue"]);
  assert.deepEqual(hist.removed(store.project("site")), [], "plus dans la liste des supprimés");
  assert.throws(() => hist.restore(store.project("site"), "revue"), (e) => e.status === 404);
});

test("projet d'un appareil (agents dans projects/<id>) : supprimés restaurables, un seul patron", () => {
  project("app", { name: "Appli", node: "n-2", dir: "C:/y", agentsDir: "agents-ia", allowed: "^src/" });
  add("app", agent("boss", { kind: "supervisor", mode: "code", maxLines: 150 }), "Tu es le patron de l'appli : vérifie les agents.");
  add("app", agent("veille", { kind: "custom", web: true, schedule: { type: "every", minutes: 240 } }), "Veille des failles pour l'appli, chaque matin.");
  // Consigne retouchée après le dernier changement de la liste (03/11, Scanner CVE : restaurée sans cette retouche).
  admin.updateAgent(store.project("app"), "veille", { prompt: "Veille des failles pour l'appli, chaque matin. Retouche : synchro de 05:00 pas rattrapée après une veille." });
  del("app", "boss"); del("app", "veille");
  add("app", agent("boss2", { kind: "supervisor", mode: "code" }), "Nouveau patron de l'appli : vérifie les agents.");
  assert.deepEqual(hist.removed(store.project("app")).map((x) => x.agent.id).sort(), ["boss", "veille"]);
  assert.throws(() => hist.restore(store.project("app"), "boss"), /déjà un agent patron/);
  const v = hist.restore(store.project("app"), "veille");
  assert.equal(v.web, true, "options de l'agent gardées (champs d'un agent d'appareil)");
  assert.equal(v.enabled, false);
  assert.match(store.readPrompt("app", v), /Retouche : synchro de 05:00/, "consigne d'avant le retrait, pas celle du dernier changement de la liste");
});

// 03/11 (GOLD PILOT) : agents retirés par le propriétaire, le patron a cru le panel en panne et ses lancements tombaient
// sur « Agent inconnu ». Il sait maintenant qu'il n'y a aucun agent, lesquels peuvent revenir, et les restaure lui-même.
test("patron d'un projet sans agent : il le sait, restaure l'agent supprimé et le lance dans le même bloc", async () => {
  project("vide", { name: "Vide", dir: codeDir("vide"), agentsDir: "agents-ia", dataDir: "agents-ia/data", allowed: "^src/" });
  add("vide", agent("enquetes", { kind: "custom", mode: "read" }), "Enquête sur le problème donné, cause et correction proposée.");
  del("vide", "enquetes");
  const boss = require("../lib/boss");
  const f = boss.framing(store.project("vide"), null, true, "");
  assert.match(f, /Agents du projet en ce moment : \*\*aucun\*\* : le propriétaire les a retirés, ce n'est pas une panne/);
  assert.match(f, /Agents supprimés, qui peuvent revenir : `enquetes` \(Agent enquetes\)/);
  assert.match(f, /fais le travail toi-même/);
  const out = await boss.applyActions(store.project("vide"), { env: {} }, [{ type: "lancer", agent: "absent" }, { type: "restaurer", agent: "enquetes" }, { type: "lancer", agent: "enquetes", question: "Relis le parseur des signaux." }]);
  assert.deepEqual(out.map((x) => [x.type, x.ok]), [["lancer", false], ["restaurer", true], ["lancer", true]]);
  assert.match(out[0].text, /aucun agent en ce moment/);
  assert.equal(store.agent("vide", "enquetes").enabled, false, "revenu en pause");
  const cmds = fs.readdirSync(path.join(store.RUNTIME, "commands")).map((x) => store.readJson(path.join(store.RUNTIME, "commands", x)));
  assert.ok(cmds.some((c) => c.project === "vide" && c.agent === "enquetes" && c.args.question === "Relis le parseur des signaux."));
});

test("connexion modifiée sans la retirer : jeton gardé ; nouvelle adresse sans jeton refusée", () => {
  project("cx", { name: "Cx", node: "n-3", dir: "C:/z", allowed: "^src/" });
  const p = store.project("cx");
  const c = connections.add(p, { name: "scanner-cve", baseUrl: "http://127.0.0.1:8000", prefix: "/api/v1/agent/", methods: ["GET", "POST"], token: "secret-jeton-1234", bearer: true });
  const v = connections.update(p, c.id, { description: "Scanner, lecture seule", methods: ["GET"] });
  assert.deepEqual(v.methods, ["GET"]);
  assert.equal(connections.all("cx")[0].token, "Bearer secret-jeton-1234", "jeton gardé");
  assert.throws(() => connections.update(p, c.id, { baseUrl: "https://ailleurs.example" }), /colle aussi le jeton/);
  assert.equal(connections.all("cx")[0].baseUrl, "http://127.0.0.1:8000");
  const w = connections.update(p, c.id, { baseUrl: "https://ailleurs.example", token: "autre-jeton-5678", bearer: true });
  assert.equal(w.baseUrl, "https://ailleurs.example");
  assert.equal(connections.all("cx")[0].token, "Bearer autre-jeton-5678");
});

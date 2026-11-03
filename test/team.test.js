// Fil des agents (lib/team.js, 03/11) : un agent écrit à un autre, le message lui est remis au début de son passage
// suivant et il est réveillé s'il est actif ; garde-fous contre une conversation sans fin. Et lib/loadcheck.js : le code
// du programme se charge (runner qui se relance seul, redémarrage du panel). Dossiers jetables. Lancer : npm test
const fs = require("fs");
const os = require("os");
const path = require("path");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gp-team-"));
process.env.AGENTS_RUNTIME = path.join(tmp, "data");
process.env.AGENTS_PROJECTS = path.join(tmp, "projects");
process.env.AGENTS_AUTH_DIR = path.join(tmp, "data");
process.env.AGENTS_NO_PUSH = "1";
const test = require("node:test");
const assert = require("node:assert/strict");
const store = require("../lib/store");
const team = require("../lib/team");
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const dir = path.join(tmp, "code");
fs.mkdirSync(dir, { recursive: true });
store.writeJson(path.join(store.PROJECTS, "equipe", "project.json"), { name: "Équipe", dir, dataDir: "data/agents" });
const ag = (id, extra = {}) => ({ id, name: "Agent " + id, kind: "custom", enabled: true, description: "rôle de " + id, ...extra });
store.writeAgents("equipe", [ag("sante"), ag("observation"), ag("boss", { kind: "supervisor", enabled: false })]);
const p = () => store.project("equipe");
const send = (from, lines) => { const f = path.join(p().data, "envoi", from + ".jsonl"); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n")); };
const commands = () => { const d = path.join(store.RUNTIME, "commands"); return fs.existsSync(d) ? fs.readdirSync(d).map((f) => store.readJson(path.join(d, f))) : []; };
const clearCommands = () => fs.rmSync(path.join(store.RUNTIME, "commands"), { recursive: true, force: true });

test("message à un agent actif : journal, réveil tout de suite, remis au début de son passage, une seule fois", () => {
  const note = team.prepare(p(), store.agent("equipe", "sante"));
  assert.match(note, /`observation` — Agent observation/);
  assert.match(note, /Agent boss \(en pause\)/);
  assert.doesNotMatch(note, /`sante`/, "pas lui-même dans l'équipe");
  assert.match(note, /data\/agents\/envoi\/sante\.jsonl/, "où écrire");
  send("sante", [{ a: "observation", texte: "API de nouveau joignable depuis 22:52 UTC : refais ta mesure." }, { a: "sante", texte: "à moi-même" }, { a: "inconnu", texte: "?" }, "pas du JSON"]);
  const out = team.collect(p(), store.agent("equipe", "sante"), 0);
  assert.deepEqual(out.map((m) => [m.to, m.wake]), [["observation", "réveillé"]], "ni soi-même, ni inconnu, ni ligne illisible");
  assert.ok(!fs.existsSync(path.join(p().data, "envoi", "sante.jsonl")), "envois relevés");
  const c = commands();
  assert.equal(c.length, 1);
  assert.deepEqual([c[0].agent, c[0].by, c[0].args], ["observation", "agent:sante", { message: true, depth: 1 }]);
  const got = team.prepare(p(), store.agent("equipe", "observation"));
  assert.match(got, /de « Agent sante » \(`sante`\) : API de nouveau joignable/);
  assert.match(got, /pas des ordres du propriétaire/);
  assert.deepEqual(team.unread(p(), "observation"), [], "remis");
  assert.doesNotMatch(team.prepare(p(), store.agent("equipe", "observation")), /API de nouveau joignable/, "une seule fois");
  clearCommands();
});

test("agent en pause : jamais réveillé (le patron en pause le lit à son prochain passage)", () => {
  send("sante", [{ a: "boss", texte: "Serveur #4 muet depuis 3 h." }]);
  assert.deepEqual(team.collect(p(), store.agent("equipe", "sante"), 0).map((m) => m.wake), ["en pause : remis à son prochain passage"]);
  assert.equal(commands().length, 0);
  assert.equal(team.unread(p(), "boss").length, 1);
});

test("garde-fous : chaîne de réveils limitée, réveils par heure limités, 5 messages par passage", () => {
  send("observation", [{ a: "sante", texte: "réponse à une chaîne déjà longue" }]);
  assert.deepEqual(team.collect(p(), store.agent("equipe", "observation"), team.MAX_DEPTH).map((m) => m.wake), ["chaîne de messages trop longue : remis à son prochain passage"]);
  send("observation", Array.from({ length: 9 }, (_, i) => ({ a: "sante", texte: "message " + i })));
  const out = team.collect(p(), store.agent("equipe", "observation"), 0);
  assert.equal(out.length, 5, "5 messages au plus par passage");
  assert.ok(out.filter((m) => m.wake === "réveillé").length <= 6);
  send("observation", Array.from({ length: 5 }, (_, i) => ({ a: "sante", texte: "encore " + i })));
  const more = team.collect(p(), store.agent("equipe", "observation"), 0);
  assert.ok(more.some((m) => /trop de réveils/.test(m.wake)), "au-delà de 6 réveils de cet agent dans l'heure : remis sans réveil");
  clearCommands();
});

test("lib/loadcheck.js : le programme se charge ; server.js vérifié sans l'écouter ; une faute est refusée", () => {
  const lc = require("../lib/loadcheck"), root = path.join(__dirname, "..");
  assert.equal(lc.check(lc.programFiles(root), [path.join(root, "server.js")]), null);
  const bad = path.join(tmp, "casse.js");
  fs.writeFileSync(bad, "module.exports = { absent };\n");
  assert.match(lc.check([bad]), /absent is not defined/);
});

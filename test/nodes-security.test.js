// Protections du panel face à un appareil connecté (revue du 02/11) : un appareil ne peut ni réécrire d'autres fichiers
// de son projet par une « consigne » (project.json, kinds.js), ni remplir le disque (historique, notifications, fichiers),
// ni se synchroniser sans fin ; le runner ne fait jamais tourner ici le projet d'un autre compte. Dossiers jetables.
// Lancer : npm test
const fs = require("fs");
const os = require("os");
const path = require("path");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gp-nodesec-"));
process.env.AGENTS_RUNTIME = path.join(tmp, "data");
process.env.AGENTS_PROJECTS = path.join(tmp, "projects");
process.env.AGENTS_AUTH_DIR = path.join(tmp, "data");
process.env.AGENTS_NO_PUSH = "1";
const test = require("node:test");
const assert = require("node:assert/strict");
const store = require("../lib/store");
const nodes = require("../lib/nodes");
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const HIST = path.join(store.RUNTIME, "history", "projet-malin.jsonl");
let node, pid = "projet-malin";
test("préparation : un appareil connecté avec son projet", () => {
  const { code } = nodes.createCode({ id: "u-autre" });
  const r = nodes.enroll({ code, name: "PC malin", info: { os: "Windows" }, project: { name: "Projet malin", dir: "C:/malin/projet" } });
  node = { id: r.node.id, name: r.node.name };
  assert.equal(r.project.id, pid);
});

test("une consigne est toujours prompts/<nom>.md : jamais project.json ni kinds.js", () => {
  assert.throws(() => store.promptPath(pid, { id: "a", prompt: "project.json" }), /invalide/);
  assert.throws(() => store.promptPath(pid, { id: "a", prompt: "prompts/../kinds.js" }), /invalide/);
  assert.throws(() => store.writePrompt(pid, { id: "a", prompt: "kinds.js" }, "require('child_process')"), /invalide/);
  assert.equal(store.readPrompt(pid, { id: "a", prompt: "project.json" }), "", "lecture refusée aussi");
  assert.ok(store.promptPath(pid, { id: "a" }).endsWith(path.join(pid, "prompts", "a.md")));
});

test("réglages envoyés par l'appareil : nettoyés, rien d'autre n'est écrit", () => {
  const before = fs.readFileSync(path.join(store.PROJECTS, pid, "project.json"), "utf8");
  const base = nodes.sync(node, {}).projects[0].base;
  nodes.sync(node, { projects: { [pid]: { config: { base, agents: [
    { id: "evil", name: "Mal", kind: "fix-messages", prompt: "project.json", mode: "code", schedule: { type: "every", minutes: 1 }, budgetUsd: 999, allowed: ".*", hack: true },
    { id: "evil", name: "doublon" },
  ], prompts: { "project.json": '{"name":"piraté","dir":"C:/Users/quelquun"}', "prompts/evil.md": "Consigne de l'agent envoyée par l'appareil." } } } } });
  assert.equal(fs.readFileSync(path.join(store.PROJECTS, pid, "project.json"), "utf8"), before, "project.json intact");
  assert.equal(store.project(pid).node, node.id, "toujours un projet d'appareil");
  const agents = store.listAgents(pid);
  assert.equal(agents.length, 1, "doublon retiré");
  const a = agents[0];
  // allowed : zone de code de l'agent sur l'appareil lui-même (sans effet ici) ; les champs inconnus partent.
  assert.deepEqual([a.kind, a.prompt, a.budgetUsd, a.schedule.minutes, a.hack, a.allowed], ["custom", "prompts/evil.md", 20, 5, undefined, ".*"]);
  assert.equal(store.readPrompt(pid, a), "Consigne de l'agent envoyée par l'appareil.");
  // Au plus une application par minute (pas un commit à chaque synchronisation).
  const base2 = nodes.sync(node, {}).projects[0].base;
  nodes.sync(node, { projects: { [pid]: { config: { base: base2, agents: [{ id: "autre", name: "Autre" }], prompts: {} } } } });
  assert.deepEqual(store.listAgents(pid).map((x) => x.id), ["evil"]);
});

test("historique et notifications : champs connus, textes coupés, nombre plafonné", () => {
  const rows = Array.from({ length: 1000 }, (_, i) => ({ at: "2026-11-02T08:" + String(i % 60).padStart(2, "0") + ":00Z", agent: "evil", summary: "x".repeat(10000), cost: 0.1, poison: "<script>" }));
  nodes.sync(node, { projects: { [pid]: { history: rows, notes: Array.from({ length: 100 }, (_, i) => ({ text: "n" + i + " " + "y".repeat(9000) })) } } });
  const h = store.tail(HIST, 5000);
  assert.equal(h.length, 200, "200 passages par synchronisation");
  assert.equal(h[0].summary.length, 500);
  assert.equal(h[0].poison, undefined);
  const notes = store.tail(path.join(store.RUNTIME, "chat", pid + ".notes.jsonl"), 500);
  assert.equal(notes.length, 20, "20 notifications par synchronisation");
  assert.ok(notes[0].text.length <= 4000);
});

test("synchronisations : 120 par minute au plus", () => {
  let err = null;
  for (let i = 0; i < 130 && !err; i++) { try { nodes.sync(node, {}); } catch (e) { err = e; } }
  assert.ok(err, "refusé au-delà");
  assert.equal(err.status, 429);
});

test("un journal ne grossit jamais sans fin : au-delà de 5 Mo, il garde sa moitié récente", () => {
  const f = path.join(store.RUNTIME, "gros.jsonl");
  fs.writeFileSync(f, Array.from({ length: 60000 }, (_, i) => JSON.stringify({ i, pad: "z".repeat(90) })).join("\n") + "\n");
  store.append(f, { i: "dernier" });
  const lines = fs.readFileSync(f, "utf8").trim().split("\n");
  assert.ok(fs.statSync(f).size < 5 * 1024 * 1024 && lines.length > 25000);
  assert.equal(JSON.parse(lines[lines.length - 1]).i, "dernier");
});

test("runner : le projet d'un autre compte ne tourne jamais ici, même sans « node »", async () => {
  const mk = (id, owner) => {
    const dir = path.join(tmp, "src-" + id);
    fs.mkdirSync(dir, { recursive: true });
    store.writeJson(path.join(store.PROJECTS, id, "project.json"), { name: id, dir, dataDir: "data/agents", ...(owner ? { owner } : {}) });
    store.writeAgents(id, [{ id: "m", name: "Marqueur", kind: "marqueur", enabled: true, schedule: { type: "every", minutes: 5 } }]);
    fs.writeFileSync(path.join(store.PROJECTS, id, "kinds.js"), "module.exports = { kinds: { marqueur: async () => { require('fs').writeFileSync(" + JSON.stringify(path.join(tmp, "marque-" + id)) + ", 'x'); return { status: 'ok' }; } } };");
  };
  mk("projet-admin", null); // projet d'avant les comptes : à l'administrateur
  mk("projet-etranger", "u-autre");
  await require("../runner").tick();
  assert.ok(fs.existsSync(path.join(tmp, "marque-projet-admin")), "le projet de l'administrateur tourne");
  assert.ok(!fs.existsSync(path.join(tmp, "marque-projet-etranger")), "celui d'un autre compte jamais");
});

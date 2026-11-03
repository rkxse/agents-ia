// Alerte au patron (runner.js escalate) : un agent qui signale un problème fait lancer le patron tout de suite, avec ce
// problème ; une alerte par heure et par projet au plus, jamais deux fois la même, rien si le patron est en pause.
// Faux types d'agents (kinds.js du projet), dossiers jetables. Lancer : npm test
const fs = require("fs");
const os = require("os");
const path = require("path");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gp-alerte-"));
process.env.AGENTS_RUNTIME = path.join(tmp, "data");
process.env.AGENTS_PROJECTS = path.join(tmp, "projects");
process.env.AGENTS_AUTH_DIR = path.join(tmp, "data");
process.env.AGENTS_NO_PUSH = "1";
const test = require("node:test");
const assert = require("node:assert/strict");
const store = require("../lib/store");
const runner = require("../runner");

const home = path.join(tmp, "projects", "esc");
const calls = path.join(tmp, "patron.jsonl");
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(path.join(tmp, "src"), { recursive: true });
fs.writeFileSync(path.join(home, "project.json"), JSON.stringify({ name: "esc", dir: path.join(tmp, "src"), dataDir: "data/agents" }));
fs.writeFileSync(path.join(home, "kinds.js"), `
const fs = require("fs");
module.exports = { kinds: {
  guet: async (ctx, a) => ({ status: "attention", summary: "service arrêté (" + a.id + ")" }),
  calme: async () => ({ status: "ok", summary: "rien à signaler" }),
  redite: async () => ({ status: "attention", summary: "toujours le même point", repeat: true }),
  supervisor: async (ctx, a, args) => { fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(args) + "\\n"); return { status: "ok", summary: "traité" }; },
} };`);
const agents = (bossOn) => store.writeAgents("esc", [
  { id: "boss", name: "Agent patron", kind: "supervisor", enabled: bossOn, schedule: { type: "on-demand" } },
  { id: "guet", name: "Guetteur", kind: "guet", enabled: true, schedule: { type: "every", minutes: 5 } },
  { id: "guet2", name: "Second guetteur", kind: "guet", enabled: true, schedule: { type: "every", minutes: 5 } },
  { id: "calme", name: "Calme", kind: "calme", enabled: true, schedule: { type: "every", minutes: 5 } },
]);
const read = () => (fs.existsSync(calls) ? fs.readFileSync(calls, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test("même défaut qui revient : alerte, puis une seconde qui exige la cause, puis plus rien (règle commune du 02/11)", async () => {
  store.writeAgents("esc", [
    { id: "boss", name: "Agent patron", kind: "supervisor", enabled: true, schedule: { type: "on-demand" } },
    { id: "redite", name: "Redite", kind: "redite", enabled: true, schedule: { type: "every", minutes: 5 } },
  ]);
  const p = store.project("esc"), alertes = path.join(p.data, "boss-alertes.json");
  const again = async () => { // une heure plus tard, l'agent repasse avec le même défaut
    const st = store.readJson(alertes, { at: 0, seen: {} });
    store.writeJson(alertes, { ...st, at: 0 });
    store.setLastRun(p, "redite", { lastAt: null });
    await runner.tick();
  };
  await runner.tick();
  assert.equal(read().length, 1, "première fois : alerte");
  assert.doesNotMatch(read()[0].alerte, /revient/);
  await again();
  assert.equal(read().length, 2, "le défaut revient : seconde alerte");
  assert.match(read()[1].alerte, /revient.*cause/s);
  assert.equal(read()[1].revenu, true);
  await again();
  assert.equal(read().length, 2, "ensuite : plus d'alerte au patron (pas de boucle)");
  fs.rmSync(calls, { force: true });
  fs.rmSync(alertes, { force: true });
});

test("relance demandée par le patron, mais l'agent est passé depuis : pas de second passage", async () => {
  store.writeAgents("esc", [{ id: "calme", name: "Calme", kind: "calme", enabled: true, schedule: { type: "on-demand" } }]);
  const p = store.project("esc");
  const cmds = path.join(store.RUNTIME, "commands");
  fs.mkdirSync(cmds, { recursive: true });
  store.setLastRun(p, "calme", { lastAt: "2026-11-02T03:08:10.000Z" });
  store.writeJson(path.join(cmds, "1-vieux.json"), { project: "esc", agent: "calme", args: {}, at: "2026-11-02T03:07:30.000Z", by: "boss" });
  await runner.tick();
  assert.equal((store.lastRuns(p).calme || {}).lastAt, "2026-11-02T03:08:10.000Z", "pas relancé");
  store.writeJson(path.join(cmds, "2-neuf.json"), { project: "esc", agent: "calme", args: {}, at: new Date().toISOString(), by: "boss" });
  await runner.tick();
  assert.ok((store.lastRuns(p).calme || {}).lastAt > "2026-11-02T03:08:10.000Z", "demande plus récente : relancé");
});

test("patron en pause : aucune alerte", async () => {
  agents(false);
  await runner.tick();
  assert.equal(read().length, 0);
});

test("problème signalé : patron lancé avec le problème, une seule fois par heure", async () => {
  agents(true);
  fs.rmSync(path.join(store.project("esc").data, "last-runs.json"), { force: true });
  for (const id of ["guet", "guet2", "calme"]) store.setLastRun(store.project("esc"), id, { lastAt: null });
  await runner.tick();
  const c = read();
  assert.equal(c.length, 1, "un seul passage du patron malgré deux agents en alerte (une alerte par heure)");
  assert.match(c[0].alerte, /Guetteur.*service arrêté/);
  assert.equal(c[0].de, "guet");
  const hist = fs.readFileSync(path.join(store.RUNTIME, "history", "esc.jsonl"), "utf8");
  assert.match(hist, /alerte de « Guetteur »/, "passage du patron noté avec sa source");
});

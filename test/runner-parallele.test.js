// Runner : projets en parallèle (un projet dont un agent travaille longtemps ne retarde pas les autres), un seul travail
// à la fois dans un projet, durée maximale propre à l'agent transmise au passage (maxMinutes). Faux types d'agents,
// dossiers jetables. Lancer : npm test
const fs = require("fs");
const os = require("os");
const path = require("path");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gp-par-"));
process.env.AGENTS_RUNTIME = path.join(tmp, "data");
process.env.AGENTS_PROJECTS = path.join(tmp, "projects");
process.env.AGENTS_AUTH_DIR = path.join(tmp, "data");
process.env.AGENTS_NO_PUSH = "1";
const test = require("node:test");
const assert = require("node:assert/strict");
const store = require("../lib/store");
const runner = require("../runner");
const log = path.join(tmp, "passages.jsonl");
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const projet = (id, kind) => {
  const home = path.join(tmp, "projects", id);
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.join(tmp, "src-" + id), { recursive: true });
  fs.writeFileSync(path.join(home, "project.json"), JSON.stringify({ name: id, dir: path.join(tmp, "src-" + id), dataDir: "data/agents" }));
  fs.writeFileSync(path.join(home, "kinds.js"), `
const fs = require("fs");
module.exports = { kinds: { ${kind}: async (ctx, a) => {
  const t0 = Date.now(); await new Promise((r) => setTimeout(r, a.id === "lent" ? 1500 : 50));
  fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ agent: a.id, debut: t0, fin: Date.now(), timeoutMs: ctx.timeoutMs || null }) + "\\n");
  return { status: "ok", summary: "fait" }; } } };`);
};
projet("lourd", "travail");
projet("leger", "travail");
store.writeAgents("lourd", [{ id: "lent", name: "Lent", kind: "travail", enabled: true, schedule: { type: "every", minutes: 5 }, maxMinutes: 5 }]);
store.writeAgents("leger", [{ id: "vif", name: "Vif", kind: "travail", enabled: true, schedule: { type: "every", minutes: 5 } }]);

test("un projet lent ne retarde pas les autres ; durée max de l'agent transmise", async () => {
  const t0 = Date.now();
  await runner.tick();
  const runs = fs.readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const lent = runs.find((r) => r.agent === "lent"), vif = runs.find((r) => r.agent === "vif");
  assert.ok(lent && vif, "les deux agents ont tourné");
  assert.ok(vif.fin < lent.fin, "l'agent rapide a fini avant l'agent lent de l'autre projet");
  assert.ok(vif.debut - t0 < 1000, "l'agent rapide n'a pas attendu la fin du projet lent");
  assert.equal(lent.timeoutMs, 5 * 60e3, "maxMinutes transmis au passage");
  assert.equal(vif.timeoutMs, null, "sans maxMinutes : durée par défaut");
});

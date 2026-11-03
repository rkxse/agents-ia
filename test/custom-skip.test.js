// Agent « custom » avec skipIfUnchanged (lib/kinds.js) : pas d'appel à Claude tant que les fichiers surveillés n'ont pas
// changé depuis le dernier passage réussi (surveillance des erreurs : ~0,70 $ toutes les 2 h pour un journal inchangé).
// Fichiers temporaires, Claude simulé. Lancer : npm test
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { custom } = require("../lib/kinds");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agents-skip-"));
test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
const log = path.join(dir, "error.log");
fs.writeFileSync(log, "ligne 1\n");

const files = {};
let calls = 0;
const ctx = {
  p: { dir, name: "Test" },
  readJson: (f, d) => (f in files ? files[f] : d), writeJson: (f, v) => { files[f] = v; }, rm: (f) => { delete files[f]; },
  log: () => {}, append: () => {}, notify: async () => {}, prompt: () => "consigne", rel: (x) => x, dirty: () => false,
  readOnly: async (fn) => ({ out: await fn(), touched: [] }),
  claude: async () => { calls++; files["agents/surv.json"] = { resume: "rien de neuf", points: [] }; return { cost: 0.5 }; },
};
const agent = { id: "surv", name: "Surveillance", mode: "read", skipIfUnchanged: ["error.log"] };

test("journal inchangé : aucun appel ; journal modifié : nouvel appel", async () => {
  assert.equal((await custom(ctx, agent)).status, "ok");
  assert.equal(calls, 1);
  assert.equal((await custom(ctx, agent)).status, "rien", "journal inchangé : sauté");
  assert.equal(calls, 1);
  fs.appendFileSync(log, "ligne 2\n");
  assert.equal((await custom(ctx, agent)).status, "ok");
  assert.equal(calls, 2);
});

test("sans skipIfUnchanged : toujours lancé, comme avant", async () => {
  const before = calls;
  await custom(ctx, { id: "autre", name: "Autre", mode: "read" });
  await custom(ctx, { id: "autre", name: "Autre", mode: "read" });
  assert.equal(calls, before + 2);
});

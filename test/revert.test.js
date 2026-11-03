// Annulation d'un changement depuis le panel (lib/revert.js) sur un dépôt jetable : annulé si les tests passent, rien ne
// change s'ils échouent ou si le code a bougé depuis. Lancer : npm test
process.env.AGENTS_NO_PUSH = "1"; // les notifications d'essai ne partent jamais sur le téléphone
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const store = require("../lib/store");
const { makeContext } = require("../lib/context");
const { revertCommit } = require("../lib/revert");

const ID = "zz-annulation";
const git = (dir, ...a) => spawnSync("git", a, { cwd: dir, encoding: "utf8" });
function repo(testCmd) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gp-revert-"));
  git(dir, "init", "-q"); git(dir, "config", "user.email", "t@t"); git(dir, "config", "user.name", "t");
  fs.writeFileSync(path.join(dir, ".gitignore"), "data/\n");
  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(path.join(dir, "src", "a.js"), "module.exports = 1;\n");
  git(dir, "add", "-A"); git(dir, "commit", "-q", "-m", "base");
  fs.writeFileSync(path.join(dir, "src", "a.js"), "module.exports = 2;\n");
  git(dir, "commit", "-qam", "agent : passe à 2");
  const hash = git(dir, "rev-parse", "HEAD").stdout.trim();
  const p = { id: ID, name: "Essai", dir, envFile: ".env", dataDir: "data/agents", data: path.join(dir, "data", "agents"), testCmd, restartCmd: null };
  return { dir, hash, p, ctx: makeContext(p, () => {}) };
}
const clean = () => { for (const f of [path.join(store.RUNTIME, "chat", ID + ".notes.jsonl"), path.join(store.RUNTIME, "history", ID + ".jsonl")]) fs.rmSync(f, { force: true }); };
test.after(clean);

test("annulé si les tests passent : nouveau commit qui revient en arrière", async () => {
  const { dir, hash, p, ctx } = repo('node -e "process.exit(0)"');
  const r = await revertCommit(p, ctx, hash);
  assert.equal(r.status, "ok", r.summary);
  assert.equal(fs.readFileSync(path.join(dir, "src", "a.js"), "utf8").replace(/\r/g, ""), "module.exports = 1;\n");
  assert.match(git(dir, "log", "-1", "--format=%s").stdout, /^Annulation de [0-9a-f]{7} : agent : passe à 2/);
  assert.equal(git(dir, "status", "--porcelain").stdout.trim(), "");
});

test("tests en échec : rien ne change", async () => {
  const { dir, hash, p, ctx } = repo('node -e "process.exit(1)"');
  const r = await revertCommit(p, ctx, hash);
  assert.equal(r.status, "erreur");
  assert.match(r.summary, /tests échouaient/);
  assert.equal(fs.readFileSync(path.join(dir, "src", "a.js"), "utf8").replace(/\r/g, ""), "module.exports = 2;\n");
  assert.equal(git(dir, "rev-parse", "HEAD").stdout.trim(), hash);
  assert.equal(git(dir, "status", "--porcelain").stdout.trim(), "");
});

test("code changé depuis : ne s'applique plus, rien ne change", async () => {
  const { dir, hash, p, ctx } = repo('node -e "process.exit(0)"');
  fs.writeFileSync(path.join(dir, "src", "a.js"), "module.exports = 3;\n");
  git(dir, "commit", "-qam", "autre changement");
  const r = await revertCommit(p, ctx, hash);
  assert.equal(r.status, "erreur");
  assert.match(r.summary, /ne s'applique plus/);
  assert.equal(fs.readFileSync(path.join(dir, "src", "a.js"), "utf8").replace(/\r/g, ""), "module.exports = 3;\n");
});

// Un passage d'agent ne garde ou n'annule que ce que l'agent a écrit avec ses outils (lib/git-guard.js passageChanges,
// lib/claude.js track). 02/11 : le patron de GOLD PILOT a commité une partie du travail en cours d'une autre session et
// remis un de ses fichiers à l'état du commit, en prenant tout ce qui avait changé dans le dépôt pour son travail.
// Dépôts jetables. Lancer : npm test
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const G = require("../lib/git-guard");
const { noteTools } = require("../lib/claude");

const OK = 'node -e "process.exit(0)"';
const KO = 'node -e "process.exit(1)"';
function repo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gp-passage-"));
  const git = (...a) => spawnSync("git", a, { cwd: root, encoding: "utf8" });
  git("init", "-q"); git("config", "user.email", "test@example.invalid"); git("config", "user.name", "test"); git("config", "core.autocrlf", "false");
  const write = (f, c) => { fs.mkdirSync(path.join(root, path.dirname(f)), { recursive: true }); fs.writeFileSync(path.join(root, f), c); };
  for (const [f, c] of Object.entries({ "src/a.js": "a\n", "src/autre.js": "autre\n", "test/x.test.js": "x\n", "scripts/s.js": "s\n" })) write(f, c);
  git("add", "-A"); git("commit", "-q", "-m", "départ");
  const read = (f) => (fs.existsSync(path.join(root, f)) ? fs.readFileSync(path.join(root, f), "utf8") : null);
  const run = (testCmd, before) => G.applyChanges({ root, before, title: "essai", bodyLines: [], testCmd, msgFile: path.join(root, ".git", "msg.txt") });
  const inCommit = () => git("show", "--name-only", "--format=", "HEAD").stdout.trim().split(/\r?\n/).filter(Boolean);
  return { root, git, write, read, run, inCommit, done: () => fs.rmSync(root, { recursive: true, force: true }) };
}
const passage = (r, ...files) => Object.assign(G.start(r.root), { track: { files: files.map((f) => path.join(r.root, f)), shell: false } });

test("autre session pendant le passage : ses fichiers ne sont ni commités ni annulés", () => {
  const r = repo();
  const before = passage(r, "src/a.js");
  r.write("src/a.js", "corrigé par l'agent\n");
  r.write("src/autre.js", "travail de l'autre session\n"); // dans la zone permise
  r.write("scripts/s.js", "travail hors zone de l'autre session\n"); // hors zone : avant, remis à l'état du commit
  r.write("src/nouveau.js", "nouveau fichier de l'autre session\n");
  const res = r.run(OK, before);
  assert.ok(res.commit);
  assert.deepEqual(r.inCommit(), ["src/a.js"], "seulement le fichier de l'agent");
  assert.deepEqual(res.others.sort(), ["scripts/s.js", "src/autre.js", "src/nouveau.js"]);
  assert.equal(r.read("src/autre.js"), "travail de l'autre session\n");
  assert.equal(r.read("scripts/s.js"), "travail hors zone de l'autre session\n", "jamais annulé");
  assert.equal(r.read("src/nouveau.js"), "nouveau fichier de l'autre session\n");
  r.done();
});

test("tests en échec : seul le changement de l'agent est annulé, le travail d'avant le passage reste", () => {
  const r = repo();
  r.write("src/autre.js", "travail en cours avant le passage\n");
  const before = passage(r, "src/a.js");
  r.write("src/a.js", "corrigé par l'agent\n");
  const res = r.run(KO, before);
  assert.ok(res.testsFailed);
  assert.equal(r.read("src/a.js"), "a\n", "changement de l'agent annulé");
  assert.equal(r.read("src/autre.js"), "travail en cours avant le passage\n", "travail d'avant gardé");
  r.done();
});

test("fichiers mis de côté (git add) par quelqu'un d'autre : pas dans le commit de l'agent, toujours prêts", () => {
  const r = repo();
  r.write("scripts/s.js", "prêt pour le commit de quelqu'un d'autre\n");
  r.git("add", "scripts/s.js");
  const before = passage(r, "src/a.js");
  r.write("src/a.js", "corrigé par l'agent\n");
  const res = r.run(OK, before);
  assert.ok(res.commit);
  assert.deepEqual(r.inCommit(), ["src/a.js"]);
  assert.equal(r.git("diff", "--cached", "--name-only").stdout.trim(), "scripts/s.js", "toujours dans l'index");
  r.done();
});

test("sans Claude (annulation depuis le panel) : tout ce qui a changé depuis le début du passage est à lui", () => {
  const r = repo();
  r.write("scripts/s.js", "modifié avant\n");
  const before = G.start(r.root); // track null
  r.write("src/a.js", "patch inverse\n");
  const res = r.run(OK, before);
  assert.deepEqual(r.inCommit(), ["src/a.js"], "le fichier modifié avant n'est pas pris");
  assert.equal(r.read("scripts/s.js"), "modifié avant\n");
  assert.deepEqual(res.others, []);
  r.done();
});

test("lib/claude.js track : fichiers écrits par Edit / Write notés, commandes repérées", () => {
  const track = { files: [], shell: false };
  for (const e of [
    { type: "assistant", message: { content: [{ type: "tool_use", name: "Edit", input: { file_path: "C:/p/src/a.js" } }, { type: "text", text: "…" }] } },
    { type: "assistant", message: { content: [{ type: "tool_use", name: "Write", input: { file_path: "src/b.js" } }, { type: "tool_use", name: "Read", input: { file_path: "src/c.js" } }] } },
    { type: "stream_event", event: { type: "content_block_delta" } },
    { type: "assistant", message: { content: [{ type: "tool_use", name: "PowerShell", input: { command: "npm test" } }] } },
    { type: "result", result: "fini" },
  ]) noteTools(track, e);
  assert.deepEqual(track.files, ["C:/p/src/a.js", "src/b.js"], "Read n'écrit rien");
  assert.equal(track.shell, true);
});

test("chemins notés par Claude (absolus, autre casse sous Windows) reconnus comme ceux de git", () => {
  const r = repo();
  const before = Object.assign(G.start(r.root), { track: { files: [path.join(r.root, "src", "a.js").toUpperCase()], shell: false } });
  r.write("src/a.js", "agent\n");
  const { mine } = G.passageChanges(r.root, before);
  assert.deepEqual(mine.map((c) => c.file), process.platform === "win32" ? ["src/a.js"] : []);
  r.done();
});

// 03/11 (« une correction globale, pas juste sur un ou deux agents ») : un agent qui code passe même pendant un travail en
// cours ; il n'efface ni ne commite jamais ce travail, même s'il touche au même fichier ou que ses tests échouent.
test("fichier déjà en cours de modification réécrit par l'agent : remis comme au début du passage, jamais commité", () => {
  const r = repo();
  r.write("src/autre.js", "travail en cours de quelqu'un\n");
  const before = passage(r, "src/a.js", "src/autre.js");
  r.write("src/a.js", "corrigé par l'agent\n");
  r.write("src/autre.js", "réécrit par l'agent\n");
  const res = r.run(OK, before);
  assert.deepEqual(res.conflicts, ["src/autre.js"]);
  assert.deepEqual(r.inCommit(), ["src/a.js"], "seulement son propre fichier");
  assert.equal(r.read("src/autre.js"), "travail en cours de quelqu'un\n", "travail en cours gardé tel qu'il était");
  r.done();
});

test("annulation (tests en échec, lecture seule, arrêt) : un fichier déjà modifié revient comme au début du passage, pas à l'état du commit", () => {
  const r = repo();
  r.write("src/autre.js", "travail en cours\n");
  const before = passage(r, "src/autre.js");
  r.write("src/autre.js", "agent par-dessus\n");
  for (const c of G.passageChanges(r.root, before).mine) G.revert(r.root, c, before);
  assert.equal(r.read("src/autre.js"), "travail en cours\n", "avant le 03/11 : remis à « autre », travail effacé");
  r.done();
});

test("contexte : fichiers en cours signalés à tout agent qui peut écrire (sans les données des agents)", () => {
  const r = repo();
  r.write("src/autre.js", "en cours\n");
  r.write("data/agents/x.json", "{}");
  r.git("add", "data/agents/x.json"); r.git("commit", "-q", "-m", "donnée");
  r.write("data/agents/x.json", "{\"a\":1}");
  const { makeContext, busyNote } = require("../lib/context");
  const ctx = makeContext({ id: "essai", dir: r.root, data: path.join(r.root, "data", "agents"), envFile: ".env" }, () => {});
  assert.deepEqual(ctx.busy(), ["src/autre.js"]);
  assert.deepEqual(ctx.busy(ctx.untrackedSet()), ["src/autre.js"]);
  assert.match(busyNote(ctx.busy()), /N'y touche pas/);
  assert.equal(busyNote([]), "");
  assert.equal(typeof ctx.dirty, "undefined", "plus aucun agent ne se reporte pour un travail en cours");
  r.done();
});

test("runner : relance quand le code des agents a changé et n'a plus bougé depuis le tour précédent", () => {
  let v = "a";
  const updated = require("../runner").codeWatcher(() => v);
  assert.equal(updated(), false);
  v = "b";
  assert.equal(updated(), false, "vient de changer : on attend");
  v = "c";
  assert.equal(updated(), false, "change encore");
  assert.equal(updated(), true, "stable : relance");
});

test("chemin abrégé de Windows (ADMINI~1) ou complet : même fichier", () => {
  const r = repo();
  const long = fs.realpathSync.native(r.root); // dossier temporaire : souvent noté en abrégé, ici en complet
  const before = Object.assign(G.start(r.root), { track: { files: [path.join(long, "src", "a.js")], shell: false } });
  r.write("src/a.js", "agent\n");
  assert.deepEqual(G.passageChanges(r.root, before).mine.map((c) => c.file), ["src/a.js"]);
  r.done();
});

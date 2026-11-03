// Garde-fous de l'agent de correction (lib/git-guard.js) sur un dépôt git jetable : fichiers gardés ou annulés,
// commit seulement si les tests passent, rien de l'agent ne reste en cas d'échec. Lancer : npm test
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const G = require("../lib/git-guard");

const CARTE = "carte/Règles métier.md"; // nom accentué : cas réel du 30/10 (agent bloqué 6 h)
const OK = 'node -e "process.exit(0)"';
const KO = 'node -e "process.exit(1)"';

function repo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "autofix-git-"));
  const git = (...a) => spawnSync("git", a, { cwd: root, encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "test@example.invalid");
  git("config", "user.name", "test");
  git("config", "core.autocrlf", "false");
  const files = { "src/a.js": "a\n", "test/x.test.js": "x\n", [CARTE]: "règles\n", "scripts/s.js": "s\n" };
  for (const [f, c] of Object.entries(files)) {
    fs.mkdirSync(path.join(root, path.dirname(f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), c);
  }
  git("add", "-A");
  git("commit", "-q", "-m", "départ");
  const write = (f, c) => { fs.mkdirSync(path.join(root, path.dirname(f)), { recursive: true }); fs.writeFileSync(path.join(root, f), c); };
  const read = (f) => (fs.existsSync(path.join(root, f)) ? fs.readFileSync(path.join(root, f), "utf8") : null);
  const run = (testCmd, before = new Set(), extra = {}) => G.applyChanges({ root, before, title: "essai", bodyLines: ["ligne"], testCmd, msgFile: path.join(root, ".git", "msg.txt"), ...extra });
  return { root, git, write, read, run, done: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("chemin accentué lu tel quel (pas « \\303\\250 » entre guillemets)", () => {
  const r = repo();
  r.write(CARTE, "règles\nnouvelle règle\n");
  assert.deepEqual(G.changedFiles(r.root).map((c) => c.file), [CARTE]);
  r.done();
});

test("tests OK : seuls src/, test/*.test.js et carte/ sont commités, le reste est annulé", () => {
  const r = repo();
  r.write("src/a.js", "a corrigé\n");
  r.write(CARTE, "règles\nnouvelle règle\n");
  r.write("test/nouveau.test.js", "n\n");
  r.write("test/_tmp_query.js", "brouillon\n"); // brouillon de l'agent : jamais commité
  r.write("scripts/s.js", "s modifié\n"); // hors zone
  const res = r.run(OK);
  assert.ok(res.commit, "commit fait");
  assert.deepEqual(res.refused.sort(), ["scripts/s.js", "test/_tmp_query.js"]);
  const inCommit = r.git("-c", "core.quotepath=false", "show", "--name-only", "--format=", "HEAD").stdout.trim().split("\n").sort();
  assert.deepEqual(inCommit, [CARTE, "src/a.js", "test/nouveau.test.js"].sort());
  assert.equal(r.read("scripts/s.js"), "s\n");
  assert.equal(r.read("test/_tmp_query.js"), null);
  assert.deepEqual(G.changedFiles(r.root), [], "rien ne reste en cours");
  r.done();
});

test("tests en échec : tout est annulé, aucun commit", () => {
  const r = repo();
  r.write("src/a.js", "a cassé\n");
  r.write(CARTE, "règles\nautre\n");
  r.write("test/nouveau.test.js", "n\n");
  const res = r.run(KO);
  assert.equal(res.commit, null);
  assert.equal(res.testsFailed, true);
  assert.equal(r.read("src/a.js"), "a\n");
  assert.equal(r.read(CARTE), "règles\n");
  assert.equal(r.read("test/nouveau.test.js"), null);
  assert.deepEqual(G.changedFiles(r.root), []);
  r.done();
});

test("commit refusé : les fichiers de l'agent reviennent à l'original (pas à la version ajoutée à git)", () => {
  const r = repo();
  fs.writeFileSync(path.join(r.root, ".git", "hooks", "pre-commit"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  r.write("src/a.js", "a de l'agent\n");
  const res = r.run(OK);
  assert.equal(res.commit, null);
  assert.equal(r.read("src/a.js"), "a\n");
  assert.deepEqual(G.changedFiles(r.root), []);
  r.done();
});

test("fichiers non suivis d'avant le passage : jamais supprimés", () => {
  const r = repo();
  r.write("notes-perso.txt", "à moi\n");
  r.write("test/vieux_brouillon.js", "à moi aussi\n");
  const before = G.untrackedSet(r.root);
  r.write("src/a.js", "a corrigé\n");
  const res = r.run(OK, before);
  assert.ok(res.commit);
  assert.equal(r.read("notes-perso.txt"), "à moi\n");
  assert.equal(r.read("test/vieux_brouillon.js"), "à moi aussi\n");
  r.done();
});

test("rien de modifié : pas de tests lancés, pas de commit", () => {
  const r = repo();
  const res = r.run(KO);
  assert.deepEqual(res, { commit: null, testsFailed: false, tooBig: false, refused: [], kept: [], others: [], conflicts: [] });
  r.done();
});

test("agent d'optimisation : la connexion MT5 (src/trading/, comptes, identifiants) est refusée", () => {
  const r = repo();
  r.write("src/a.js", "a optimisé\n");
  r.write("src/trading/trader.js", "touché\n");
  r.write("src/storage/runners.js", "touché\n");
  r.write("src/storage/users.js", "u optimisé\n");
  const res = r.run(OK, new Set(), { allowed: G.zone(G.ALLOWED, /^src\/trading\/|^src\/storage\/(?:provision|runners|secrets)\.js$/) });
  assert.ok(res.commit);
  assert.deepEqual(res.refused.sort(), ["src/storage/runners.js", "src/trading/trader.js"]);
  assert.deepEqual(res.kept.sort(), ["src/a.js", "src/storage/users.js"]);
  assert.equal(r.read("src/trading/trader.js"), null);
  r.done();
});

test("fichiers verrouillés du projet (locked) : annulés même pour le patron, dont la zone ignore « protected »", () => {
  const r = repo();
  r.write(".gitignore", "data/\n");
  r.write("CLAUDE.md", "règles\n");
  r.write(".claude/settings.json", '{"permissions":{"deny":["Read(/.env)"]}}\n');
  r.write("tests/conftest.py", "# garde-fou de la base\n");
  r.git("add", "-A");
  r.git("commit", "-q", "-m", "règles des agents");
  const p = { id: "essai", dir: r.root, data: path.join(r.root, "data", "agents"), testCmd: OK, restartCmd: null, allowed: "^(?!data/|\\.env)", protected: null,
    locked: "^(?:CLAUDE\\.md$|\\.claude/|(?:tests/)?conftest\\.py$)" };
  const ctx = require("../lib/context").makeContext(p, () => {});
  const before = G.untrackedSet(r.root);
  r.write("src/a.js", "a corrigé\n");
  r.write("CLAUDE.md", "plus de règles\n");
  r.write(".claude/settings.json", "{}\n");
  r.write("tests/conftest.py", "# garde-fou retiré\n");
  const res = ctx.applyChanges(before, "Correction", [], { allowed: G.zone("^(?!data/|\\.env|node_modules/|\\.git/)") });
  assert.ok(res.commit);
  assert.deepEqual(res.kept, ["src/a.js"]);
  assert.deepEqual(res.refused.sort(), [".claude/settings.json", "CLAUDE.md", "tests/conftest.py"]);
  assert.equal(r.read("CLAUDE.md"), "règles\n");
  assert.equal(r.read("tests/conftest.py"), "# garde-fou de la base\n");
  r.done();
});

test("redémarrage en échec après le commit : signalé (restartFailed), jamais « redémarré » en silence", () => {
  const r = repo();
  r.write("src/a.js", "a corrigé\n");
  const logs = [];
  const res = r.run(OK, new Set(), { restartCmd: 'node -e "console.log(\'API injoignable après la relance\');process.exit(1)"', log: (m) => logs.push(m) });
  assert.ok(res.commit, "le commit reste fait (tests passés)");
  assert.match(res.restartFailed, /API injoignable/);
  assert.match(logs.join(" "), /redémarrage en échec/);
  r.write("src/a.js", "encore\n");
  assert.equal(r.run(OK, new Set(), { restartCmd: OK }).restartFailed, undefined, "redémarrage réussi : rien de signalé");
  r.done();
});

test("changement trop gros (maxLines) : tout annulé, aucun commit", () => {
  const r = repo();
  r.write("src/a.js", Array.from({ length: 50 }, (_, i) => "ligne " + i).join("\n") + "\n");
  const res = r.run(OK, new Set(), { maxLines: 20 });
  assert.equal(res.commit, null);
  assert.equal(res.tooBig, true);
  assert.equal(r.read("src/a.js"), "a\n");
  assert.deepEqual(G.changedFiles(r.root), []);
  r.done();
});

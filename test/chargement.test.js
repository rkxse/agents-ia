// Programme des appareils : chaque module se charge (03/11 : lib/boss.js exportait busyNote, déplacé ailleurs ; « busyNote
// is not defined » au chargement a bloqué la synchronisation d'un ordinateur connecté). Une version qui ne se charge pas n'est
// jamais publiée : la dernière bonne reste servie. Lancer : npm test
const fs = require("fs");
const os = require("os");
const path = require("path");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gp-chargement-"));
process.env.AGENTS_RUNTIME = path.join(tmp, "data");
process.env.AGENTS_PROJECTS = path.join(tmp, "projects");
process.env.AGENTS_AUTH_DIR = path.join(tmp, "data");
process.env.AGENTS_NO_PUSH = "1";
const test = require("node:test");
const assert = require("node:assert/strict");
const nodes = require("../lib/nodes");
test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test("tous les modules du programme des appareils se chargent", () => {
  const b = nodes.bundle();
  assert.ok(Object.keys(b.files).includes("lib/boss.js") && Object.keys(b.files).includes("node.js"));
  assert.equal(b.refused, undefined);
  assert.equal(nodes.checkBundle(b.files), null);
  assert.ok(fs.existsSync(path.join(tmp, "data", "node-bundle.json")), "dernière bonne version gardée sur le disque");
});

test("version qui ne se charge pas (export d'un nom absent, faute de syntaxe) : refusée avec son erreur", () => {
  const files = nodes.bundle().files;
  assert.match(nodes.checkBundle({ ...files, "lib/boss.js": files["lib/boss.js"] + "\nmodule.exports.x = pasDefini;\n" }), /pasDefini is not defined/);
  assert.match(nodes.checkBundle({ ...files, "lib/chat.js": files["lib/chat.js"] + "\n}\n" }), /SyntaxError/);
});

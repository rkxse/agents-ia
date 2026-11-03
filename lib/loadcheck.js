// Le code se charge-t-il avant de le faire tourner ? (03/11 : une version à moitié écrite pendant une mise à jour,
// « busyNote is not defined », a bloqué la synchronisation d'un appareil ; demande du propriétaire : « fais en sorte que
// ça n'arrive plus jamais ».) Utilisé partout où du code nouveau prend la place de l'ancien : programme envoyé aux
// appareils (lib/nodes.js bundle), runner qui se relance seul (runner.js), redémarrage du panel depuis le site
// (server.js). Chaque module est chargé dans un process à part, avec des dossiers de données jetables : rien n'est écrit
// dans les vrais. Renvoie le message d'erreur, ou null si tout se charge.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

// files : chemins absolus des modules à charger ; syntax : fichiers seulement vérifiés (node --check), ex. server.js qui
// écoute un port dès qu'on le charge.
function check(files, syntax = []) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "agents-check-"));
  const env = { ...process.env, AGENTS_RUNTIME: path.join(tmp, "data"), AGENTS_PROJECTS: path.join(tmp, "projects"), AGENTS_AUTH_DIR: path.join(tmp, "data"), AGENTS_NO_PUSH: "1" };
  const opts = { cwd: tmp, encoding: "utf8", windowsHide: true, timeout: 60e3, env };
  const first = (r) => String(r.stderr || "").split(/\r?\n/).filter((l) => /Error/.test(l)).slice(0, 2).join(" ") || (r.error ? r.error.message : "code " + r.status);
  try {
    for (const f of syntax) { const r = spawnSync(process.execPath, ["--check", f], opts); if (r.status !== 0) return path.basename(f) + " : " + first(r).slice(0, 300); }
    if (!files.length) return null;
    const r = spawnSync(process.execPath, ["-e", "for (const f of process.argv.slice(1)) require(f); process.exit(0)", ...files], opts);
    return r.status === 0 ? null : first(r).slice(0, 300);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}
// Fichiers donnés par leur contenu ({ "lib/x.js": "…" }) : chargés depuis une copie jetable.
function checkCopy(map) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agents-bundle-"));
  try {
    for (const [f, t] of Object.entries(map)) { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), t); }
    const err = check(Object.keys(map).filter((f) => f.endsWith(".js")).map((f) => path.join(dir, f)));
    return err && err.split(dir).join("");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
// Modules du dossier du programme (root) : runner.js et lib/*.js.
const programFiles = (root) => [path.join(root, "runner.js"), ...fs.readdirSync(path.join(root, "lib")).filter((f) => f.endsWith(".js")).map((f) => path.join(root, "lib", f))];

module.exports = { check, checkCopy, programFiles };

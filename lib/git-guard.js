// Garde-fous git des agents qui modifient le code d'un projet, testés sur un dépôt jetable (test/git-guard.test.js) :
// fichiers modifiés par l'agent, annulation, tests puis commit et redémarrage. root : dossier du dépôt. Chemins tels que
// git les écrit, avec « / ».
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

// Zones par défaut (GOLD PILOT) : code, tests (*.test.js, jamais un brouillon comme test/_tmp_query.js, commité le
// 30/10), carte. Un projet donne les siennes dans project.json (allowed, protected).
const ALLOWED = /^src\/|^test\/[^/]+\.test\.js$|^carte\/|^PROJECT_MAP\.md$/;
// Zone d'un agent : permise (allowed) et pas protégée (protected, ex. la connexion MT5 pour l'agent d'optimisation,
// règle du propriétaire 30/10). Renvoie un objet { test(chemin) } comme une RegExp.
function zone(allowed, protectedRe) {
  const a = allowed instanceof RegExp ? allowed : new RegExp(allowed || ALLOWED.source);
  const p = protectedRe ? (protectedRe instanceof RegExp ? protectedRe : new RegExp(protectedRe)) : null;
  return { test: (f) => a.test(f) && !(p && p.test(f)) };
}

const git = (root, ...args) => spawnSync("git", args, { cwd: root, encoding: "utf8" });
const RESTART_MS = 15 * 60e3; // redémarrage du projet après un commit (Scanner CVE attend la fin d'une analyse en cours)

// Fichiers modifiés ou nouveaux. Sortie -z (séparée par des NUL) : chemins jamais entre guillemets ni échappés. Avant
// (30/10), « carte/Règles métier.md » arrivait en « "carte/R\303\250gles m\303\251tier.md" » : ni commité ni annulé,
// il est resté modifié et l'agent a sauté tous ses passages pendant 6 h.
function changedFiles(root) {
  const parts = (git(root, "status", "--porcelain=v1", "-z", "--untracked-files=all").stdout || "").split("\0");
  const out = [];
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (p.length < 4) continue;
    const code = p.slice(0, 2);
    out.push({ code, file: p.slice(3) });
    if (code[0] === "R" || code[0] === "C") i++; // renommage : le chemin d'origine suit, déjà couvert
  }
  return out;
}
const untrackedSet = (root) => new Set(changedFiles(root).filter((c) => c.code === "??").map((c) => c.file));
const dirtyTracked = (root) => changedFiles(root).filter((c) => c.code !== "??");

// Empreinte d'un fichier du dépôt (contenu ; taille et date au-delà de 20 Mo) ; « absent » s'il n'existe pas.
function stamp(root, f) {
  try {
    const st = fs.statSync(path.join(root, f));
    if (!st.isFile()) return "autre";
    if (st.size > 20 * 1024 * 1024) return st.size + ":" + st.mtimeMs;
    return crypto.createHash("sha1").update(fs.readFileSync(path.join(root, f))).digest("hex");
  } catch (e) { return "absent"; }
}
// Début d'un passage qui peut modifier le dépôt : fichiers déjà modifiés ou nouveaux, avec leur empreinte. S'utilise
// comme l'ancien « before » (has : fichier non suivi d'avant). track : fichiers écrits par les outils de l'agent
// (lib/claude.js, rempli par lib/context.js), null si aucun Claude n'a tourné (ex. annulation depuis le panel).
// content : contenu des fichiers suivis déjà modifiés (2 Mo au plus chacun), pour les remettre tels quels si l'agent y
// touche (applyChanges, conflicts).
const KEEP_MAX = 2 * 1024 * 1024;
function start(root) {
  const all = changedFiles(root), untracked = new Set(all.filter((c) => c.code === "??").map((c) => c.file));
  const content = new Map();
  for (const c of all) {
    if (c.code === "??") continue;
    try { const f = path.join(root, c.file), st = fs.statSync(f); if (st.isFile() && st.size <= KEEP_MAX) content.set(c.file, fs.readFileSync(f)); } catch (e) { /* supprimé */ }
  }
  return { has: (f) => untracked.has(f), untracked, snap: new Map(all.map((c) => [c.file, stamp(root, c.file)])), content, track: null };
}
// Changements d'un passage : fichiers changés depuis son début, séparés entre ceux que l'agent a écrits avec ses outils
// (mine) et les autres (others : une personne ou une session qui travaille dans le même dépôt pendant le passage, ou une
// commande lancée dans le terminal de l'agent), jamais commités ni annulés. 02/11 : le patron de GOLD PILOT, qui prenait
// tout ce qui avait changé dans le dépôt pour son travail, a commité une partie du travail en cours d'une autre session
// et remis un de ses fichiers (provision.js) à l'état du commit. before : start() (ou l'ancien Set : tout est à l'agent).
const caseKey = (f) => (process.platform === "win32" ? f.toLowerCase() : f);
// Chemin réel (Windows : « C:\Users\ADMINI~1\… » et « C:\Users\Administrateur\… » sont le même dossier ; Claude peut
// noter l'un quand le projet est déclaré avec l'autre).
const real = (f) => { try { return fs.realpathSync.native(f); } catch (e) { return f; } };
function passageChanges(root, before) {
  const all = changedFiles(root).filter((c) => !(c.code === "??" && before && before.has(c.file)));
  if (!before || !before.snap) return { mine: all, others: [] };
  const changed = all.filter((c) => !before.snap.has(c.file) || before.snap.get(c.file) !== stamp(root, c.file));
  if (!before.track) return { mine: changed, others: [] };
  const base = real(root);
  const own = new Set(before.track.files.map((f) => caseKey(path.relative(base, real(path.resolve(root, String(f)))).split(path.sep).join("/"))));
  return { mine: changed.filter((c) => own.has(caseKey(c.file))), others: changed.filter((c) => !own.has(caseKey(c.file))) };
}

// Annule une modification de l'agent : fichier suivi remis à l'état du commit, fichier nouveau supprimé (seulement ceux
// apparus pendant le passage : before = fichiers non suivis d'avant). Fichier déjà en cours de modification au début du
// passage (travail d'une personne ou d'une session) : remis comme il était à ce moment-là, jamais à l'état du commit
// (03/11, pour tous les agents : ce travail aurait été effacé) ; trop gros pour avoir été gardé : laissé tel quel.
function revert(root, c, before) {
  if (c.code === "??") { if (!before || !before.has(c.file)) fs.rmSync(path.join(root, c.file), { force: true, recursive: true }); return; }
  if (before && before.content && before.content.has(c.file)) return fs.writeFileSync(path.join(root, c.file), before.content.get(c.file));
  if (before && before.snap && before.snap.has(c.file)) return;
  git(root, "checkout", "--", c.file);
}

// Lignes ajoutées + retirées par rapport au dernier commit (fichiers suivis et nouveaux fichiers).
function changedLines(root, files) {
  let n = 0;
  for (const f of files) {
    const st = git(root, "diff", "--numstat", "HEAD", "--", f).stdout.trim();
    if (st) { const [a, d] = st.split(/\s+/); n += (Number(a) || 0) + (Number(d) || 0); }
    else if (fs.existsSync(path.join(root, f))) n += fs.readFileSync(path.join(root, f), "utf8").split("\n").length; // nouveau fichier
  }
  return n;
}

// Après un passage qui peut modifier le code : hors zones permises, annulé ; trop gros (maxLines), tout annulé ; puis
// tests, commit et redémarrage, ou tout annulé si un test échoue ou si le commit est refusé.
// Renvoie { commit, testsFailed, refused, kept, tooBig, others, conflicts } (+ restartFailed : message, si le redémarrage a
// échoué). others : fichiers changés pendant le passage, pas par les outils de l'agent : laissés tels quels
// (passageChanges). conflicts : fichiers déjà en cours de modification au début du passage, que l'agent a réécrits.
// opts : { root, before, title, bodyLines, testCmd, restartCmd, msgFile, log, allowed (RegExp ou zone()), maxLines, trailer }.
function applyChanges(opts) {
  const { root, before, log = () => {} } = opts;
  const allowed = opts.allowed || ALLOWED;
  const split = passageChanges(root, before);
  // Fichier que quelqu'un modifiait déjà (03/11 : les agents codent maintenant pendant un travail en cours, ces fichiers
  // leur sont signalés) et que l'agent a réécrit : remis comme au début du passage (revert). Jamais commité : le commit
  // aurait pris le travail en cours avec.
  const conflicts = before && before.track && before.snap ? split.mine.filter((c) => c.code !== "??" && before.snap.has(c.file)) : [];
  for (const c of conflicts) { revert(root, c, before); log("déjà en cours de modification par quelqu'un d'autre : " + c.file + ", changement de l'agent retiré, travail en cours gardé"); }
  const changes = split.mine.filter((c) => !conflicts.includes(c) && !c.file.startsWith("data/"));
  const others = split.others.filter((c) => !c.file.startsWith("data/")).map((c) => c.file);
  if (others.length) log("changés pendant le passage, pas par l'agent (autre session ou commande) : laissés tels quels : " + others.join(", ").slice(0, 300));
  const refused = changes.filter((c) => !allowed.test(c.file));
  refused.forEach((c) => revert(root, c, before));
  const kept = changes.filter((c) => allowed.test(c.file));
  const res = { commit: null, testsFailed: false, tooBig: false, refused: refused.map((c) => c.file), kept: kept.map((c) => c.file), others, conflicts: conflicts.map((c) => c.file) };
  if (!kept.length) return res;
  if (opts.maxLines && changedLines(root, res.kept) > opts.maxLines) {
    kept.forEach((x) => revert(root, x, before));
    log("changement trop gros (plus de " + opts.maxLines + " lignes) : annulé");
    return { ...res, tooBig: true };
  }
  const t = spawnSync(opts.testCmd, { cwd: root, shell: true, encoding: "utf8", timeout: 10 * 60 * 1000 });
  if (t.status !== 0) {
    kept.forEach((x) => revert(root, x, before));
    log("tests en échec : modifications de l'agent annulées");
    return { ...res, testsFailed: true };
  }
  git(root, "add", "-A", "--", ...kept.map((c) => c.file));
  const body = (opts.bodyLines || []).map((l) => "- " + String(l).replace(/\s+/g, " ").slice(0, 300)).join("\n");
  fs.writeFileSync(opts.msgFile, String(opts.title).replace(/\s+/g, " ").slice(0, 120) + "\n\n" + (body ? body + "\n\n" : "") +
    (opts.trailer || "Agent de correction automatique (goldpilot-agents).") + "\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\n");
  // Seulement ses fichiers (« -- chemins ») : ce que quelqu'un d'autre avait mis de côté pour son commit (git add) n'y
  // part pas.
  const c = git(root, "commit", "-q", "-F", opts.msgFile, "--", ...kept.map((x) => x.file));
  if (c.status !== 0) {
    git(root, "reset", "-q", "--", ...kept.map((x) => x.file));
    kept.forEach((x) => revert(root, x, before));
    log("commit impossible, modifications annulées : " + (c.stderr || c.stdout || "").slice(0, 300));
    return res;
  }
  res.commit = (git(root, "rev-parse", "--short", "HEAD").stdout || "").trim();
  if (opts.restartCmd) {
    // Redémarrage en échec (code non nul) : rendu dans restartFailed, jamais passé sous silence (02/11 : le script de Scanner
    // SHIELD renvoie 1 si l'API ne répond pas après la relance ; avant, « redémarré » était écrit quoi qu'il arrive).
    // Durée maximale (revue du 02/11) : un script qui ne rend jamais la main bloquait le runner pour toujours.
    const r = spawnSync(opts.restartCmd, { cwd: root, shell: true, encoding: "utf8", windowsHide: true, timeout: RESTART_MS });
    if (r.error && r.error.code === "ETIMEDOUT") res.restartFailed = "pas fini au bout de " + RESTART_MS / 60e3 + " min";
    else if (r.status !== 0) res.restartFailed = ((r.stderr || "") + "\n" + (r.stdout || "")).trim().split(/\r?\n/).slice(-3).join(" ").slice(0, 300) || "code " + r.status;
  }
  log("corrigé et commité (" + res.commit + ")" + (opts.restartCmd ? (res.restartFailed ? ", redémarrage en échec : " + res.restartFailed : ", redémarré") : ""));
  return res;
}

module.exports = { ALLOWED, zone, changedFiles, untrackedSet, dirtyTracked, start, passageChanges, revert, applyChanges };

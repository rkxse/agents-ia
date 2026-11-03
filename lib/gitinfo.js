// Lectures git d'un projet pour le panel, communes au serveur et aux appareils (node.js) : commits des agents, fichiers
// modifiés (carte), détail d'un commit (onglet Changements). Projet sur un autre appareil : les journaux viennent de la
// copie envoyée par l'appareil (data/remote/<id>/git-*.txt) ; le détail d'un commit lui est demandé (lib/nodes.js).
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const store = require("./store");

const LOGS = {
  commits: ["log", "-n", "300", "--format=%h%x09%aI%x09%s%x09%b%x1e"],
  files: ["log", "-n", "400", "--name-only", "--format=@@%h%x09%aI%x09%s%x09%b%x1f"],
};
const git = (dir, args, extra = {}) => spawnSync("git", ["-c", "core.quotepath=false", ...args], { cwd: dir, encoding: "utf8", windowsHide: true, maxBuffer: 30 * 1024 * 1024, ...extra });

// Sortie brute d'un des journaux (which : "commits" ou "files"). Gardée 20 s : avant (test de charge du 01/11), chaque
// affichage de l'accueil lançait un « git log » par projet.
const logs = new Map();
function gitLog(p, which) {
  if (p.node) return store.readText(path.join(store.remoteDir(p.id), "git-" + which + ".txt"), "");
  const key = p.id + ":" + which, c = logs.get(key);
  if (c && Date.now() - c.at < 20e3) return c.out;
  const out = git(p.dir, LOGS[which]).stdout || "";
  logs.set(key, { at: Date.now(), out });
  return out;
}

// Détail d'un commit dans le dépôt dir : message, et par fichier les lignes ajoutées / retirées.
function commitDetail(dir, hash) {
  if (!/^[0-9a-f]{7,40}$/.test(hash)) throw Object.assign(new Error("Commit invalide."), { status: 400 });
  const head = git(dir, ["show", "-s", "--format=%H%x1f%aI%x1f%an%x1f%s%x1f%b", hash]);
  if (head.status !== 0) throw Object.assign(new Error("Commit introuvable."), { status: 404 });
  const [full, at, author, subject, body] = head.stdout.split("\x1f");
  const out = git(dir, ["show", "--format=", "--no-color", "--patch", "-U3", hash]).stdout || "";
  const files = [];
  let cur = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("diff --git ")) { cur = { file: line.replace(/^diff --git a\/(.*) b\/.*$/, "$1"), add: 0, del: 0, lines: [], status: null }; files.push(cur); continue; }
    if (!cur) continue;
    if (/^(index |--- |\+\+\+ |similarity|rename |old mode|new mode)/.test(line)) continue;
    if (/^new file/.test(line)) { cur.status = "nouveau"; continue; }
    if (/^deleted file/.test(line)) { cur.status = "supprimé"; continue; }
    if (/^Binary/.test(line)) { cur.binary = true; continue; }
    if (line.startsWith("+")) cur.add++; else if (line.startsWith("-")) cur.del++;
    if (cur.lines.length < 2000) cur.lines.push(line); else cur.cut = true;
  }
  const reverted = (git(dir, ["log", "-n", "200", "--format=%s", "--grep=Annulation de " + full.slice(0, 7)]).stdout || "").trim().length > 0;
  return { hash: full.slice(0, 7), full, at, author, subject, body: (body || "").trim(), files, reverted };
}

module.exports = { LOGS, gitLog, commitDetail, git };

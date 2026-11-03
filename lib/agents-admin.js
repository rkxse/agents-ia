// Modification des réglages d'un agent, partagée par le panel (server.js) et l'agent patron (kinds.js, supervisor) :
// mêmes contrôles, même commit dans ce dépôt (« Panel : … » ou « Agent patron : … »), donc historique et retour arrière.
const path = require("path");
const { spawnSync } = require("child_process");
const store = require("./store");

// Dépôt des réglages (ce dépôt ; AGENTS_CONFIG_REPO : dépôt jetable pour les tests).
const ROOT = process.env.AGENTS_CONFIG_REPO || path.join(__dirname, "..");
const SCHEDULE_TYPES = new Set(["every", "daily", "weekly", "daily-activity", "on-demand"]);
const fail = (message, status) => Object.assign(new Error(message), { status: status || 400 });
const str = (v, max) => String(v == null ? "" : v).trim().slice(0, max);
const git = (...args) => spawnSync("git", args, { cwd: ROOT, encoding: "utf8", windowsHide: true });

function cleanSchedule(s) {
  if (!s || !SCHEDULE_TYPES.has(s.type)) throw fail("Horaire invalide.");
  const n = (v, lo, hi, d) => { const x = Math.round(Number(v)); return Number.isFinite(x) ? Math.min(hi, Math.max(lo, x)) : d; };
  // until : date de fin (ISO), ex. campagne d'observation de 7 jours ; après, l'agent ne tourne plus tout seul.
  const u = s.until && Number.isFinite(Date.parse(s.until)) ? { until: new Date(Date.parse(s.until)).toISOString() } : {};
  switch (s.type) {
    case "every": return { type: "every", minutes: n(s.minutes, 5, 7 * 24 * 60, 60), ...u };
    case "daily": return { type: "daily", hourUTC: n(s.hourUTC, 0, 23, 21), weekend: !!s.weekend, ...(s.maxLateMin ? { maxLateMin: n(s.maxLateMin, 5, 59, 30) } : {}), ...u };
    case "weekly": return { type: "weekly", weekdayUTC: n(s.weekdayUTC, 0, 6, 0), hourUTC: n(s.hourUTC, 0, 23, 10), ...u };
    case "daily-activity": return { type: "daily-activity", minTrades: n(s.minTrades, 1, 1000, 5), maxDays: n(s.maxDays, 1, 60, 7), ...u };
    default: return { type: "on-demand" };
  }
}

// Commit des fichiers de réglage modifiés (by : « Panel » ou « Agent patron »).
function commitConfig(message, files, by = "Panel") {
  // Seulement des fichiers de ce dépôt (copie isolée du panel : réglages ailleurs, rien à commiter ici). Fichier du
  // dossier agents-ia d'un projet d'ici (hors de ce dépôt) : sa copie d'historique, projects/<id>/historique (lib/store.js).
  const inRepo = (r) => r && !r.startsWith("..") && !path.isAbsolute(r);
  const out = new Set();
  for (const f of files) {
    const r = path.relative(ROOT, f);
    if (inRepo(r)) { out.add(r); continue; }
    const p = store.listProjects((x) => !x.node && x.agentsDir).find((x) => { const h = path.relative(store.agentsHome(x.id), f); return h && !h.startsWith("..") && !path.isAbsolute(h); });
    const d = p && store.syncHistory(p.id);
    if (d && inRepo(path.relative(ROOT, d))) out.add(path.relative(ROOT, d));
  }
  const mine = [...out];
  if (!mine.length) return;
  for (const r of mine) git("add", "-A", "--", r); // un par un : un chemin jamais suivi et absent n'empêche pas les autres
  const r = git("commit", "-q", "-m", by + " : " + message);
  if (r.status !== 0 && !/nothing to commit|rien à valider/i.test(r.stdout + r.stderr)) console.warn("[agents] commit impossible :", (r.stderr || r.stdout).slice(0, 200));
}

// body : { name, icon, description, enabled, schedule, budgetUsd, maxLines, mode, prompt } (champs facultatifs).
// Renvoie { agent, changed } ; l'agent patron ne peut ni se désactiver ni se modifier lui-même (opts.protect).
// opts.dryRun : mêmes contrôles, rien d'écrit ni de commité (banc d'essai du patron, boss-harness.js).
function updateAgent(p, aid, body, opts = {}) {
  const list = store.listAgents(p.id);
  const a = list.find((x) => x.id === aid);
  if (!a) throw fail("Agent inconnu.", 404);
  if (opts.protect && opts.protect(a)) throw fail("Cet agent ne peut pas être modifié ainsi.");
  const changed = [];
  if (body.name !== undefined) { a.name = str(body.name, 60) || a.name; changed.push("nom"); }
  if (body.icon !== undefined) { a.icon = str(body.icon, 8) || a.icon; changed.push("icône"); }
  if (body.description !== undefined) { a.description = str(body.description, 400); changed.push("description"); }
  if (body.enabled !== undefined) { a.enabled = !!body.enabled; changed.push(a.enabled ? "activé" : "désactivé"); }
  if (body.schedule !== undefined) { a.schedule = cleanSchedule(body.schedule); changed.push("horaire"); }
  if (body.budgetUsd !== undefined) { const b = Number(body.budgetUsd); if (!(b > 0 && b <= 20)) throw fail("Budget entre 0,1 et 20 $."); a.budgetUsd = Math.round(b * 100) / 100; changed.push("budget"); }
  if (body.maxLines !== undefined && (a.mode === "code" || a.kind === "optimize" || a.kind === "supervisor")) { a.maxLines = Math.min(1000, Math.max(10, Math.round(Number(body.maxLines)) || 150)); changed.push("taille max"); }
  if (body.mode !== undefined && a.kind === "custom") { a.mode = body.mode === "code" ? "code" : "read"; changed.push("mode"); }
  // Durée maximale d'un passage (minutes) ; vide ou 0 = celle par défaut (25 min).
  if (body.maxMinutes !== undefined) {
    const m = Math.round(Number(body.maxMinutes)), v = m > 0 ? Math.min(60, Math.max(2, m)) : undefined;
    if (v !== a.maxMinutes) { if (v) a.maxMinutes = v; else delete a.maxMinutes; changed.push("durée max"); }
  }
  const files = [store.agentsFile(p.id)];
  if (body.prompt !== undefined) {
    const t = String(body.prompt);
    if (t.trim().length < 20) throw fail("Consigne trop courte.");
    if (!opts.dryRun) store.writePrompt(p.id, a, t);
    files.push(store.promptPath(p.id, a));
    changed.push("consigne");
  }
  if (opts.dryRun) return { agent: a, changed };
  store.writeAgents(p.id, list);
  commitConfig(p.name + " · " + a.name + " (" + (changed.join(", ") || "rien") + ")" + (opts.reason ? " — " + String(opts.reason).slice(0, 140) : ""), files, opts.by || "Panel");
  return { agent: a, changed };
}

// Réglages d'un projet changés depuis le panel (03/11 : « tout gérer depuis le site » ; avant, project.json se changeait
// à la main). Champs connus seulement (le dossier, le propriétaire et l'appareil ne changent pas) ; zones vérifiées
// (expressions régulières lues par git-guard) ; commandes d'un projet de ce serveur réservées à l'administrateur (elles
// s'exécutent ici). Projet d'un appareil : ses réglages y partent à la synchronisation suivante (lib/nodes.js configOf).
const PROJECT_FIELDS = {
  name: ["nom", 60], description: ["description", 200], testCmd: ["commande de tests", 200], restartCmd: ["commande de redémarrage", 200],
  pm2Process: ["process pm2", 60], allowed: ["zones permises", 300], protected: ["zones interdites", 300], locked: ["fichiers verrouillés", 600], rules: ["règles du projet", 12000],
};
const COMMANDS = new Set(["testCmd", "restartCmd", "pm2Process"]);
function updateProject(p, body, opts = {}) {
  const file = path.join(store.PROJECTS, p.id, "project.json");
  const cur = store.readJson(file, null);
  if (!cur) throw fail("Projet inconnu.", 404);
  const changed = [];
  for (const [k, [label, max]] of Object.entries(PROJECT_FIELDS)) {
    if (body[k] === undefined || (k === "pm2Process" && p.node)) continue;
    // Règles : texte sur plusieurs lignes ; le reste sur une ligne (une commande ne cache pas une deuxième ligne).
    const v = k === "rules" ? String(body[k] == null ? "" : body[k]).replace(/\r\n/g, "\n").trim().slice(0, max) : str(String(body[k] == null ? "" : body[k]).replace(/[\r\n]+/g, " "), max);
    const old = cur[k] == null ? "" : String(cur[k]);
    if (v === old) continue;
    if (COMMANDS.has(k) && !p.node && !opts.admin) throw fail("Les commandes d'un projet de ce serveur s'exécutent ici : réservées à l'administrateur.", 403);
    if (k === "name" && !v) throw fail("Donne un nom au projet.");
    if (k === "allowed" && !v) throw fail("Indique les zones que les agents peuvent modifier (ex. ^src/|^test/).");
    if (["allowed", "protected", "locked"].includes(k) && v) { try { new RegExp(v); } catch (e) { throw fail("Expression invalide pour les " + label + " : " + e.message); } }
    cur[k] = v || (k === "description" || k === "testCmd" ? "" : null);
    changed.push(label);
  }
  if (!changed.length) return { project: cur, changed };
  store.writeJson(file, cur);
  commitConfig(cur.name + " · réglages du projet (" + changed.join(", ") + ")", [file]);
  return { project: cur, changed };
}

module.exports = { ROOT, cleanSchedule, commitConfig, updateAgent, updateProject, str, fail };

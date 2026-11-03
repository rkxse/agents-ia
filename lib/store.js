// Projets et agents : projects/<id>/project.json (dossier du projet, commandes, zones permises) et agents.json (un objet
// par agent : nom, type, horaire, budget, consigne, actif), rangé dans le dossier des agents du projet (agentsHome :
// <dossier du projet>/agents-ia depuis le 03/11). Lus à chaque passage du runner et par le panel, qui peut les modifier
// (writeAgents, writePrompt). Données de travail des agents : dans le dossier du projet (project.dataDir), là où l'agent
// a le droit d'écrire.
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
// Dossiers remplaçables (copie isolée du panel pour les tests de charge : k6/README.md).
const PROJECTS = process.env.AGENTS_PROJECTS || path.join(ROOT, "projects");
const RUNTIME = process.env.AGENTS_RUNTIME || path.join(ROOT, "data");
const ID_RE = /^[a-z0-9][a-z0-9-]{1,30}$/;

// Cache des fichiers lus très souvent (test de charge du 01/11 : chaque clic relisait des centaines de fichiers et le
// panel s'effondrait à 200 clients). Un fichier n'est relu et réanalysé que s'il a changé (date et taille ; un fichier
// absent est retenu absent). readJson rend une copie toujours à jour (lire-modifier-écrire) ; peekJson, readText et tail,
// pour l'affichage, rendent l'objet du cache (lecture seule) et ne revérifient le fichier qu'au plus une fois par seconde
// (à 1000 clients, ces vérifications prenaient 30 % du temps). Ce process voit ses propres écritures tout de suite
// (writeJson, writePrompt, append) ; celles des autres (runner, appareils) au plus 1 s plus tard.
const cache = new Map(), FRESH_MS = 1000;
function cached(f, parse, freshMs = 0) {
  const t = Date.now(), c = cache.get(f);
  if (c && t - c.at < freshMs) return c.value;
  const st = fs.statSync(f, { throwIfNoEntry: false });
  const key = st ? st.mtimeMs + ":" + st.size : "absent";
  if (c && c.key === key) { c.at = t; return c.value; }
  const value = st ? parse(fs.readFileSync(f, "utf8")) : undefined;
  // Plein : les plus anciennes entrées partent (tout vider d'un coup faisait tout relire, 500 projets ≈ 5000 fichiers).
  if (cache.size >= 20000) { let n = 2000; for (const k of cache.keys()) { cache.delete(k); if (--n === 0) break; } }
  cache.set(f, { key, value, at: t });
  return value;
}
// Contenu d'un dossier (noms triés), pour l'affichage : relu au plus une fois par seconde, tout de suite après une
// écriture de ce process dans ce dossier. Liste partagée : ne pas la modifier.
const dirs = new Map();
function listDir(dir) {
  const t = Date.now(), c = dirs.get(dir);
  if (c && t - c.at < FRESH_MS) return c.names;
  let names = [];
  try { names = fs.readdirSync(dir).sort(); } catch (e) { /* absent */ }
  dirs.set(dir, { at: t, names });
  return names;
}
const fromCache = (f, parse, freshMs, d) => { try { const v = cached(f, parse, freshMs); return v === undefined ? d : v; } catch (e) { return d; } };
const peekJson = (f, d) => fromCache(f, JSON.parse, FRESH_MS, d);
const readJson = (f, d) => { const v = fromCache(f, JSON.parse, 0, undefined); return v === undefined ? d : structuredClone(v); };
const readText = (f, d = "") => fromCache(f, (s) => s, FRESH_MS, d);
// Écriture sûre : fichier temporaire puis renommage (jamais un fichier à moitié écrit).
function writeJson(f, data) {
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f + ".tmp", JSON.stringify(data, null, 2) + "\n", "utf8");
  fs.renameSync(f + ".tmp", f);
  cache.delete(f);
  dirs.delete(path.dirname(f));
  if (path.basename(f) === "project.json" && f.startsWith(PROJECTS)) projectsCache = null;
}

// Liste des projets : gardée 1,5 s (un projet créé, modifié ou retiré par ce process l'efface tout de suite). Un dossier
// sans project.json lisible est sauté. pred : filtre appliqué avant la copie (seuls les projets gardés sont copiés).
let projectsCache = null;
function listProjects(pred) {
  if (!projectsCache || Date.now() - projectsCache.at >= 1500) {
    const list = [];
    for (const id of fs.existsSync(PROJECTS) ? fs.readdirSync(PROJECTS).filter((x) => ID_RE.test(x)) : []) { try { list.push(project(id)); } catch (e) { /* pas un projet */ } }
    projectsCache = { at: Date.now(), list };
  }
  return (pred ? projectsCache.list.filter(pred) : projectsCache.list).map((p) => ({ ...p }));
}
// Après des fichiers effacés directement (projet retiré) : tout le cache est oublié.
const forgetProjects = () => { projectsCache = null; cache.clear(); dirs.clear(); };

// Projet complet : réglages + chemins utiles (home : dossier de ses agents ici ; data : dossier de travail des agents).
// Projet sur un autre appareil (p.node, lib/nodes.js) : ses agents tournent là-bas ; data = copie de leurs résultats
// envoyée par l'appareil (data/remote/<id>/data), lue par le panel comme celle d'un projet d'ici.
const remoteDir = (id) => path.join(RUNTIME, "remote", id);
function project(id) {
  if (!ID_RE.test(String(id))) throw new Error("Projet inconnu.");
  const home = path.join(PROJECTS, id);
  const p = peekJson(path.join(home, "project.json"), null); // copié juste dessous
  if (!p) throw new Error("Projet inconnu.");
  return { ...p, id, home, data: p.node ? path.join(remoteDir(id), "data") : path.join(p.dir, p.dataDir || "data/agents") };
}

// Dossier des agents d'un projet (demande du propriétaire, 03/11) : dans le projet lui-même, <dossier>/agents-ia
// (agents.json, consignes prompts/, et résultats data/ pour un nouveau projet), ignoré par git sur cet ordinateur
// (.git/info/exclude) : supprimer ce dossier retire tous les agents du projet, sans toucher à son code. Projet sans
// agentsDir (d'avant) : projects/<id>. Projet d'un appareil, côté panel : la copie reste dans projects/<id>, l'original
// est dans le dossier du projet sur l'appareil (lib/nodes.js, node.js).
const AGENTS_DIR = "agents-ia";
function agentsHome(id) {
  let p = null;
  try { p = project(id); } catch (e) { /* projet pas encore créé */ }
  const d = p && !p.node && typeof p.agentsDir === "string" && /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,39}$/.test(p.agentsDir) ? p.agentsDir : null;
  return d ? path.join(p.dir, d) : path.join(PROJECTS, String(id));
}
// Lignes ajoutées au réglage local de git du dossier (.git/info/exclude : jamais commité, aucun fichier du projet modifié).
function excludeLocal(dir, entries) {
  try {
    const f = path.join(dir, ".git", "info", "exclude");
    const t = fs.existsSync(f) ? fs.readFileSync(f, "utf8") : "";
    const add = entries.filter((e) => !t.split(/\r?\n/).includes(e));
    if (!add.length) return;
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.appendFileSync(f, (t && !t.endsWith("\n") ? "\n" : "") + add.join("\n") + "\n");
  } catch (e) { /* pas un dépôt git ordinaire : pas bloquant */ }
}
const README = "# Agents IA de ce projet\n\nCe dossier contient les agents IA du projet (panel des agents) : leur liste (`agents.json`), leurs consignes\n(`prompts/`) et leurs résultats (`data/`, pour les projets connectés depuis le 03/11).\n\n" +
  "**Supprimer ce dossier retire tous les agents de ce projet.** Le code du projet n'est pas touché.\n\nIl est ignoré par git sur cet ordinateur (`.git/info/exclude`) : il n'est jamais commité avec le projet.\n";
// Dossier des agents dans le projet : ignoré par git avant d'y écrire (sinon les agents qui codent voyaient des
// modifications en cours), avec son LISEZMOI.
function prepareHome(id) {
  const home = agentsHome(id);
  if (home === path.join(PROJECTS, String(id))) return home;
  excludeLocal(path.dirname(home), ["/" + path.basename(home) + "/"]);
  const readme = path.join(home, "LISEZMOI.md");
  if (!fs.existsSync(readme)) { fs.mkdirSync(home, { recursive: true }); fs.writeFileSync(readme, README, "utf8"); }
  return home;
}
const agentsFile = (id) => path.join(agentsHome(id), "agents.json");
// Copie d'historique (03/11) : le dossier agents-ia d'un projet d'ici est hors du dépôt du panel ; sa liste d'agents et
// ses consignes sont recopiées dans projects/<id>/historique/ à chaque réglage commité (lib/agents-admin.js
// commitConfig), pour les versions des consignes et les agents supprimés à restaurer. Jamais lue pour faire tourner les
// agents ; leurs résultats (data/) ne sont pas copiés. Projet d'un appareil ou d'avant : ses agents sont déjà ici.
const HISTORY_DIR = "historique";
// Fichier du dossier des agents -> sa copie d'historique (le fichier lui-même s'il est déjà dans projects/<id>).
function historyPath(id, f) {
  const home = agentsHome(id), rel = path.relative(home, f);
  if (home === path.join(PROJECTS, String(id)) || !rel || rel.startsWith("..") || path.isAbsolute(rel)) return f;
  return path.join(PROJECTS, String(id), HISTORY_DIR, rel);
}
// Copie remise à l'état du dossier des agents (fichiers retirés compris) -> son dossier, ou null s'il n'y a pas de copie.
function syncHistory(id) {
  const home = agentsHome(id), dest = path.join(PROJECTS, String(id), HISTORY_DIR);
  if (home === path.join(PROJECTS, String(id))) return null;
  fs.rmSync(dest, { recursive: true, force: true });
  const copy = (rel) => { fs.mkdirSync(path.dirname(path.join(dest, rel)), { recursive: true }); fs.copyFileSync(path.join(home, rel), path.join(dest, rel)); };
  if (fs.existsSync(path.join(home, "agents.json"))) copy("agents.json");
  let prompts = [];
  try { prompts = fs.readdirSync(path.join(home, "prompts")); } catch (e) { /* aucune consigne */ } // pas listDir : liste gardée en cache
  for (const f of prompts) if (/^[A-Za-z0-9_-]{1,60}\.md$/.test(f)) copy(path.join("prompts", f));
  return dest;
}
const listAgents = (id) => readJson(agentsFile(id), []);
const peekAgents = (id) => peekJson(agentsFile(id), []); // affichage seulement (objets du cache)
const writeAgents = (id, list) => writeJson(path.join(prepareHome(id), "agents.json"), list);
function agent(projectId, agentId) {
  const a = listAgents(projectId).find((x) => x.id === agentId);
  if (!a) throw new Error("Agent inconnu.");
  return a;
}

// Consigne d'un agent (fichier prompts/<id>.md du projet ici). Toujours prompts/<nom>.md : une consigne ne remplace jamais
// un autre fichier du projet (revue du 02/11 : un appareil pouvait réécrire project.json ou kinds.js par une « consigne »,
// faire passer son projet pour un projet de ce serveur et y faire tourner son code).
function promptPath(projectId, a) {
  const rel = a.prompt || "prompts/" + a.id + ".md";
  if (!/^prompts\/[A-Za-z0-9_-]{1,60}\.md$/.test(rel) || !ID_RE.test(String(projectId))) throw new Error("Chemin de consigne invalide.");
  const home = agentsHome(projectId), p = path.resolve(home, rel);
  if (!p.startsWith(home + path.sep)) throw new Error("Chemin de consigne invalide.");
  return p;
}
const readPrompt = (projectId, a) => { try { return readText(promptPath(projectId, a), ""); } catch (e) { return ""; } };
function writePrompt(projectId, a, text) {
  prepareHome(projectId);
  const p = promptPath(projectId, a);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, String(text).replace(/\r\n/g, "\n"), "utf8");
  cache.delete(p);
}

// Journaux .jsonl : dernières lignes (lignes illisibles sautées) et lignes depuis une date ISO. Lignes analysées gardées
// en cache tant que le fichier ne change pas (objets partagés : ne pas les modifier).
const parseLines = (s) => { const out = []; for (const l of s.split(/\r?\n/)) if (l) { try { out.push(JSON.parse(l)); } catch (e) { /* ligne coupée */ } } return out; };
const tail = (file, n) => fromCache(file, parseLines, FRESH_MS, []).slice(-n);
const since = (file, iso) => tail(file, 5000).filter((r) => r.at >= iso);
// Au-delà de 5 Mo, un journal garde sa moitié la plus récente : il ne grossit jamais sans fin (revue du 02/11 : historique
// et notifications n'étaient jamais élagués, et un appareil pouvait en envoyer autant qu'il voulait).
const MAX_LOG = 5 * 1024 * 1024;
function append(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(obj) + "\n");
  cache.delete(file);
  try {
    if (fs.statSync(file).size <= MAX_LOG) return;
    const lines = fs.readFileSync(file, "utf8").split("\n").filter(Boolean);
    fs.writeFileSync(file + ".tmp", lines.slice(-Math.floor(lines.length / 2)).join("\n") + "\n");
    fs.renameSync(file + ".tmp", file);
  } catch (e) { /* élagage au prochain ajout */ }
}

// Dernier passage de chaque agent d'un projet (pour les horaires) : <data>/agents-runs.json.
const runsFile = (p) => path.join(p.data, "agents-runs.json");
const lastRuns = (p) => readJson(runsFile(p), {});
const peekRuns = (p) => peekJson(runsFile(p), {}); // affichage seulement
function setLastRun(p, agentId, patch) {
  const all = lastRuns(p);
  all[agentId] = { ...(all[agentId] || {}), ...patch };
  writeJson(runsFile(p), all);
}

module.exports = { ROOT, PROJECTS, RUNTIME, ID_RE, AGENTS_DIR, remoteDir, readJson, peekJson, readText, listDir, writeJson, listProjects, forgetProjects, project, agentsHome, agentsFile, HISTORY_DIR, historyPath, syncHistory, excludeLocal, listAgents, peekAgents, writeAgents, agent, promptPath, readPrompt, writePrompt, tail, since, append, lastRuns, peekRuns, setLastRun };

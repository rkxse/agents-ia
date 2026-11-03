// Connexions des agents aux API d'autres projets (02/11/2026) : le propriétaire d'un projet déclare une API (adresse,
// préfixe des chemins permis, en-tête et sa valeur) ; ses agents et son patron l'appellent avec l'outil « appeler_api »
// (lib/mcp-connexions.js, serveur MCP lancé par Claude Code). La valeur de l'en-tête (jeton) n'est jamais dans la
// conversation de l'IA : c'est le serveur MCP qui l'ajoute. Lecture seule (GET) par défaut.
// Gardées hors du dépôt du panel (data/connections/<projet>.json : les réglages commités ne contiennent jamais de
// jeton). Projet sur un autre appareil : envoyées à cet appareil, où ses agents tournent (lib/nodes.js configOf,
// node.js applyProjects).
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const store = require("./store");
const admin = require("./agents-admin");

const DIR = path.join(store.RUNTIME, "connections");
const file = (pid) => path.join(DIR, pid + ".json");
const TOOL = "mcp__connexions__appeler_api"; // nom de l'outil vu par Claude Code (serveur « connexions »)
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];
const MAX = 10; // par projet
const fail = admin.fail;

const all = (pid) => store.readJson(file(pid), []); // avec les jetons : jamais renvoyé au navigateur
const write = (pid, list) => store.writeJson(file(pid), list);
// Un mot de schéma seul (« Bearer ») n'est pas un jeton. 02/11 : « Bearer » tapé dans le champ masqué puis un collage
// raté avaient enregistré « Bearer » sans jeton ; l'API de Scanner CVE refusait tout (401) sans qu'on le voie ici.
const SCHEME = /^(bearer|basic|token|apikey|api-key)$/i;
const incomplete = (t) => SCHEME.test(String(t || "").trim());
const view = (c) => {
  const t = String(c.token || ""), scheme = /^\S+\s+\S/.test(t) ? t.split(/\s+/)[0] + " " : "";
  return { id: c.id, name: c.name, description: c.description, baseUrl: c.baseUrl, prefix: c.prefix, methods: c.methods, header: c.header,
    secret: t && !incomplete(t) ? scheme + "…" + t.slice(-4) : null, incomplete: incomplete(t), tokenAt: c.tokenAt || c.createdAt, createdAt: c.createdAt };
};
const list = (p) => all(p.id).map(view);
// Valeur de l'en-tête : le jeton collé tel quel ; body.bearer : « Bearer » ajouté devant un jeton seul (cas courant),
// pour l'en-tête Authorization seulement (une clé dans X-API-Key se passe telle quelle).
function tokenOf(body, header) {
  let t = String(body.token || "").trim();
  if (t.length > 4000 || /[\r\n]/.test(t)) throw fail("Valeur d'en-tête invalide.");
  if (incomplete(t)) throw fail("Il manque le jeton : « " + t + " » seul ne suffit pas. Colle le jeton en entier.");
  if (t && body.bearer && /^authorization$/i.test(header) && !/^\S+\s+\S/.test(t)) t = "Bearer " + t;
  return t;
}

function clean(body) {
  const name = admin.str(body.name, 30).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!name) throw fail("Donne un nom court à la connexion (ex. scanner-cve).");
  let u;
  try { u = new URL(String(body.baseUrl || "").trim()); } catch (e) { throw fail("Adresse de l'API invalide (ex. https://scanner.exemple.fr)."); }
  if (!/^https?:$/.test(u.protocol)) throw fail("Adresse en http:// ou https:// seulement.");
  if (u.username || u.password || u.search || u.hash) throw fail("Adresse sans identifiants ni paramètres : le jeton va dans le champ prévu.");
  const prefix = "/" + admin.str(body.prefix, 200).replace(/^\/+/, "");
  if (/\.\.|\\|\s/.test(prefix)) throw fail("Préfixe de chemin invalide.");
  const methods = Array.isArray(body.methods) ? [...new Set(body.methods.map((m) => String(m).toUpperCase()).filter((m) => METHODS.includes(m)))] : [];
  const header = admin.str(body.header, 60) || "Authorization";
  if (!/^[A-Za-z0-9-]+$/.test(header)) throw fail("Nom d'en-tête invalide.");
  const token = tokenOf(body, header);
  return { name, description: admin.str(body.description, 300), baseUrl: u.origin + u.pathname.replace(/\/+$/, ""), prefix, methods: methods.length ? methods : ["GET"], header, token };
}
function add(p, body) {
  const list = all(p.id);
  if (list.length >= MAX) throw fail(MAX + " connexions au plus par projet.");
  const c = clean(body);
  if (list.some((x) => x.name === c.name)) throw fail("Une connexion porte déjà ce nom.");
  const x = { id: "x-" + crypto.randomBytes(4).toString("hex"), ...c, createdAt: new Date().toISOString() };
  write(p.id, list.concat(x));
  return view(x);
}
function remove(p, id) {
  const list = all(p.id);
  if (!list.some((x) => x.id === id)) throw fail("Connexion inconnue.", 404);
  write(p.id, list.filter((x) => x.id !== id));
}
// Modifier une connexion sans la retirer (03/11) : description, adresse, chemins permis, écriture, en-tête. Nouvelle
// adresse ou nouvel en-tête : le jeton est à recoller (celui donné pour une adresse ne part jamais vers une autre).
function update(p, id, body) {
  const list = all(p.id), c = list.find((x) => x.id === id);
  if (!c) throw fail("Connexion inconnue.", 404);
  const pick = (k) => (body[k] !== undefined ? body[k] : c[k]);
  const next = clean({ name: c.name, description: pick("description"), baseUrl: pick("baseUrl"), prefix: pick("prefix"), methods: pick("methods"), header: pick("header"), token: body.token || "", bearer: body.bearer });
  if ((next.baseUrl !== c.baseUrl || next.header.toLowerCase() !== c.header.toLowerCase()) && !next.token && c.token) throw fail("Nouvelle adresse ou nouvel en-tête : colle aussi le jeton (l'ancien ne part jamais vers une autre adresse).");
  Object.assign(c, { description: next.description, baseUrl: next.baseUrl, prefix: next.prefix, methods: next.methods, header: next.header });
  if (next.token) { c.token = next.token; c.tokenAt = new Date().toISOString(); }
  write(p.id, list);
  return view(c);
}
// Nouveau jeton pour une connexion (jeton expiré, recréé, mal collé) sans la retirer. Projet d'appareil : il y part à
// la synchronisation suivante (lib/nodes.js configOf).
function setToken(p, id, body) {
  const list = all(p.id), c = list.find((x) => x.id === id);
  if (!c) throw fail("Connexion inconnue.", 404);
  const t = tokenOf(body, c.header);
  if (!t) throw fail("Colle le nouveau jeton.");
  c.token = t; c.tokenAt = new Date().toISOString();
  write(p.id, list);
  return view(c);
}
// Essai : premier chemin permis, en GET (sans la barre finale si l'API redirige ou ne connaît pas le chemin avec).
// Projet d'appareil : fait par l'appareil (le panel le lui demande, node.js answer) ; ce serveur n'a pas à joindre les
// adresses d'un autre utilisateur. Réponse coupée, jeton masqué.
async function test(p, id) {
  if (p.node) throw fail("Projet sur un autre appareil : la connexion est utilisée depuis cet appareil, pas testable d'ici.");
  const c = all(p.id).find((x) => x.id === id);
  if (!c) throw fail("Connexion inconnue.", 404);
  const t0 = Date.now(), paths = [...new Set([c.prefix, c.prefix.replace(/\/+$/, "") || "/"])];
  const hide = (s) => [c.token, c.token && c.token.split(/\s+/).pop()].filter((x) => x && x.length > 3).reduce((a, x) => a.split(x).join("[jeton masqué]"), s);
  try {
    let r;
    for (const [i, u] of paths.entries()) {
      r = await fetch(c.baseUrl + u, { headers: { Accept: "application/json", ...(c.token ? { [c.header]: c.token } : {}) }, redirect: "manual", signal: AbortSignal.timeout(10000) });
      if (i === paths.length - 1 || !(r.status === 404 || (r.status >= 300 && r.status < 400))) break;
      await r.arrayBuffer().catch(() => {}); // réponse lue avant l'essai suivant (connexion libérée)
    }
    const text = await r.text();
    return { status: r.status, ok: r.ok, ms: Date.now() - t0, sample: hide(text).slice(0, 300) };
  } catch (e) {
    return { status: 0, ok: false, ms: Date.now() - t0, error: e.name === "TimeoutError" ? "pas de réponse en 10 s" : String((e.cause && e.cause.code) || e.message) };
  }
}

// Options de runClaude pour un projet qui a des connexions : serveur MCP « connexions » et son outil ; {} sinon.
function mcpFor(p) {
  if (!all(p.id).length) return {};
  const config = path.join(DIR, p.id + ".mcp.json");
  fs.mkdirSync(DIR, { recursive: true });
  fs.writeFileSync(config, JSON.stringify({ mcpServers: { connexions: { type: "stdio", command: process.execPath, args: [path.join(__dirname, "mcp-connexions.js"), file(p.id)] } } }, null, 2));
  return { mcp: { config, tools: [TOOL] } };
}

module.exports = { TOOL, METHODS, all, write, list, add, remove, update, setToken, test, mcpFor, file };

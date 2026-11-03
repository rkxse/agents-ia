// Agents supprimés d'un projet, retrouvés dans l'historique git du panel, et leur restauration depuis le site (03/11 :
// « tout gérer depuis le site » ; avant, il fallait une session Claude pour remettre un agent retiré). Listes cherchées
// dans projects/<id>/agents.json (projet d'un appareil, ou d'avant le dossier agents-ia) et dans la copie d'historique
// d'un dossier agents-ia (projects/<id>/historique, lib/store.js). Un agent restauré revient en pause, avec la consigne
// de sa dernière version.
const path = require("path");
const { spawnSync } = require("child_process");
const store = require("./store");
const admin = require("./agents-admin");

const ROOT = admin.ROOT; // dépôt des réglages
const MAX_VERSIONS = 300;
const git = (args, input) => spawnSync("git", args, { cwd: ROOT, input, maxBuffer: 64 * 1024 * 1024, windowsHide: true });
const inRepo = (f) => { const r = path.relative(ROOT, f); return r && !r.startsWith("..") && !path.isAbsolute(r) ? r.split(path.sep).join("/") : null; };
const listPaths = (id) => [path.join(store.PROJECTS, id, "agents.json"), path.join(store.PROJECTS, id, store.HISTORY_DIR, "agents.json")].map(inRepo).filter(Boolean);

// Versions de la liste des agents, des plus récentes aux plus anciennes : [{ hash, at, path, agents }]. Contenus lus en
// un seul process git (cat-file --batch) : à 300 versions, un « git show » chacune prenait plusieurs secondes.
function versions(id) {
  const paths = listPaths(id);
  if (!paths.length) return [];
  const log = git(["log", "-n", String(MAX_VERSIONS), "--format=%H%x09%aI", "--", ...paths]);
  const commits = String(log.stdout || "").trim().split(/\r?\n/).filter(Boolean).map((l) => { const [hash, at] = l.split("\t"); return { hash, at }; });
  if (!commits.length) return [];
  const asks = commits.flatMap((c) => paths.map((p) => ({ c, p })));
  const out = git(["cat-file", "--batch"], asks.map((x) => x.c.hash + ":" + x.p).join("\n") + "\n").stdout || Buffer.alloc(0);
  const found = new Map();
  let pos = 0;
  for (const x of asks) {
    const nl = out.indexOf(10, pos);
    if (nl < 0) break;
    const head = out.slice(pos, nl).toString("utf8");
    pos = nl + 1;
    const m = /^[0-9a-f]+ blob (\d+)$/.exec(head);
    if (!m) continue; // « … missing » : pas de liste à cet endroit dans cette version
    const body = out.slice(pos, pos + Number(m[1])).toString("utf8");
    pos += Number(m[1]) + 1;
    if (found.has(x.c.hash)) continue;
    try { found.set(x.c.hash, { ...x.c, path: x.p, agents: JSON.parse(body) }); } catch (e) { /* version illisible */ }
  }
  return commits.map((c) => found.get(c.hash)).filter((v) => v && Array.isArray(v.agents));
}

// Agents d'avant qui ne sont plus dans le projet : leur dernière version et la date de leur retrait (null : retiré sans
// commit, par exemple dossier agents-ia effacé à la main).
function removed(p) {
  const now = new Set(store.listAgents(p.id).map((a) => a.id));
  const out = new Map();
  let newer = null;
  for (const v of versions(p.id)) {
    for (const a of v.agents) {
      if (!a || !store.ID_RE.test(String(a.id)) || now.has(a.id) || out.has(a.id)) continue;
      out.set(a.id, { agent: a, hash: v.hash, at: v.at, path: v.path, removedAt: newer ? newer.at : null, removedHash: newer ? newer.hash : null });
    }
    newer = v;
  }
  return [...out.values()];
}
const view = (r) => ({ id: r.agent.id, name: r.agent.name || r.agent.id, icon: r.agent.icon || "🤖", kind: r.agent.kind, mode: r.agent.mode || null, description: r.agent.description || "", lastVersionAt: r.at, removedAt: r.removedAt });

function restore(p, aid) {
  const r = removed(p).find((x) => x.agent.id === aid);
  if (!r) throw admin.fail("Cet agent n'est pas dans l'historique du projet (ou il y est déjà).", 404);
  const list = store.listAgents(p.id);
  if (r.agent.kind === "supervisor" && list.some((x) => x.kind === "supervisor")) throw admin.fail("Ce projet a déjà un agent patron : un seul à la fois.");
  // Consigne telle qu'elle était juste avant le retrait (toujours prompts/<id>.md, à côté de la liste) : une consigne
  // retouchée après le dernier changement de la liste n'est pas perdue (03/11 : les consignes de Scanner CVE revenaient
  // sans les retouches du 02/11, prises à la version de la liste). Retrait sans commit : la dernière version commitée.
  const rel = /^prompts\/[A-Za-z0-9_-]{1,60}\.md$/.test(String(r.agent.prompt || "")) ? r.agent.prompt : "prompts/" + aid + ".md";
  const file = path.posix.join(path.posix.dirname(r.path), rel);
  const text = [r.removedHash ? r.removedHash + "^" : "HEAD", r.hash].map((h) => String(git(["show", h + ":" + file]).stdout || "")).find((t) => t.trim().length >= 20) || "";
  if (text.trim().length < 20) throw admin.fail("La consigne de cet agent est introuvable dans l'historique : crée-le à nouveau.");
  let a = { ...r.agent, prompt: "prompts/" + aid + ".md" };
  if (p.node) a = require("./nodes").cleanAgent(a); // mêmes champs qu'un agent reçu d'un appareil
  else { try { a.schedule = admin.cleanSchedule(a.schedule); } catch (e) { a.schedule = { type: "on-demand" }; } }
  a.enabled = false; // en pause : on l'active quand on veut
  store.writePrompt(p.id, a, text);
  store.writeAgents(p.id, [...list, a]);
  admin.commitConfig(p.name + " · agent « " + a.name + " » restauré (version du " + r.at.slice(0, 10) + "), en pause", [store.agentsFile(p.id), store.promptPath(p.id, a)]);
  return a;
}

module.exports = { versions, removed, view, restore };

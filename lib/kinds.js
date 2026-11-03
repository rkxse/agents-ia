// Types d'agents valables pour tous les projets :
//  - scout  : l'éclaireur cherche sur le web projets similaires, skills Claude Code, serveurs MCP et bibliothèques utiles
//             (lecture seule + web) ; résultat <data>/scout.json, historique scout-history.json (pas de doublon).
//  - custom : agent créé depuis le panel. Sa consigne dit quoi faire ; mode "read" (analyse, aucun fichier modifié) ou
//             "code" (modifie le code dans les zones permises, puis tests, commit et redémarrage, sinon tout annulé).
//             Options : web (recherche et lecture de pages web), allowed (en mode code, sa propre zone permise, ex.
//             "^tests/", les zones protégées du projet comptant toujours), skipIfUnchanged (fichiers dont l'agent dépend,
//             ex. ["~/.pm2/logs/goldpilot-error.log"] : passage sauté, sans appel à Claude, s'ils n'ont pas changé).
//             Bilan <data>/agents/<id>.json, historique <data>/agents/<id>.jsonl.
// Chaque type : async (ctx, agent, args) -> { cost, status, summary }.
const { CODE_TOOLS, READ_TOOLS, WEB_TOOLS } = require("./claude");

const GRAV = { haute: "🔴", moyenne: "🟠", basse: "⚪" };

async function scout(ctx, a) {
  ctx.rm("scout.json");
  const { out: agent, touched } = await ctx.readOnly(() => ctx.claude({ prompt: ctx.prompt(a) + "\n\nBilan à écrire : " + ctx.rel("scout.json"), tools: WEB_TOOLS, budget: a.budgetUsd || 3 }));
  const res = ctx.readJson("scout.json", null);
  const hist = ctx.readJson("scout-history.json", []);
  if (res) {
    res.genere = new Date().toISOString();
    res.cout = agent.cost;
    ctx.writeJson("scout.json", res);
    for (const s of res.suggestions || []) hist.push({ at: res.genere, nom: s.nom, lien: s.lien, type: s.type });
    ctx.writeJson("scout-history.json", hist.slice(-300));
  }
  ctx.append("scout.jsonl", { at: new Date().toISOString(), cost: agent.cost, agentError: agent.error, reverted: touched, result: res });
  const top = ((res && res.suggestions) || []).slice(0, 4);
  await ctx.notify(res ? "🧭 Éclaireur · " + ctx.p.name + "\n\n" + (res.resume || "") + (top.length ? "\n\n" + top.map((s) => "• " + s.nom + " (" + s.type + ") : " + s.pourquoi + (s.lien ? "\n  " + s.lien : "")).join("\n") : "")
    : "🧭 Éclaireur · " + ctx.p.name + " : pas de bilan" + (agent.error ? " (" + agent.error.slice(0, 200) + ")" : "") + ".");
  return { cost: agent.cost, status: res ? "ok" : "erreur", summary: res ? res.resume : agent.error };
}

// Empreinte (taille + date) des fichiers d'un agent « skipIfUnchanged » (chemins absolus, « ~/ » ou relatifs au projet).
function filesSignature(list, dir) {
  const fs = require("fs");
  const path = require("path");
  const home = process.env.USERPROFILE || process.env.HOME || "";
  return list.map((f) => {
    const p = String(f).startsWith("~/") ? path.join(home, String(f).slice(2)) : path.resolve(dir, String(f));
    try { const s = fs.statSync(p); return s.size + ":" + Math.round(s.mtimeMs); } catch (e) { return "absent"; }
  }).join("|");
}

async function custom(ctx, a) {
  const file = "agents/" + a.id + ".json";
  // Agent qui code : il passe même pendant un travail en cours dans le dépôt (03/11, pour tous les agents ; avant, il se
  // reportait) ; les fichiers en cours lui sont signalés (lib/context.js claude) et restent intacts (git-guard).
  const code = a.mode === "code";
  // skipIfUnchanged : [fichiers] (ex. journal d'erreurs) ; aucun changement depuis le dernier passage : pas d'appel à
  // Claude (idée du patron, 01/11 : la surveillance des erreurs coûtait ~0,70 $ toutes les 2 h pour un journal inchangé).
  const sigFile = "agents/" + a.id + ".sig.json";
  const sig = Array.isArray(a.skipIfUnchanged) && a.skipIfUnchanged.length ? filesSignature(a.skipIfUnchanged, ctx.p.dir) : null;
  if (sig && ctx.readJson(sigFile, null) === sig) return { status: "rien", summary: "fichiers surveillés inchangés depuis le dernier passage" };
  ctx.rm(file);
  // Durée maximale du passage (maxMinutes) : dite à l'agent, pour qu'il fasse un petit pas complet et écrive son bilan à
  // temps (sinon il est coupé et son passage est perdu).
  // Heure de fin donnée (02/11 : avec 5 min, le Développeur finissait un élément en 1 à 2 min puis attendait le passage
  // suivant) : il enchaîne tant qu'il reste du temps. Limite de lignes dite aussi : en enchaînant, la dépasser sans le
  // savoir annulait tout le passage.
  const end = a.maxMinutes ? new Date(Date.now() + a.maxMinutes * 60e3).toISOString().slice(11, 19) : null;
  const time = end ? "\nTu as " + a.maxMinutes + " minutes : fin au plus tard à " + end + " UTC (regarde l'heure avec Get-Date). Fais un pas fini (code, tests), puis enchaîne le suivant tant qu'il reste plus de 2 minutes ; garde la dernière minute pour ton bilan, sinon le passage est coupé et perdu." : "";
  const lines = code ? " Au plus " + (a.maxLines || 150) + " lignes changées en tout dans ce passage, sinon tout est annulé : arrête-toi avant." : "";
  const prompt = ctx.prompt(a) + "\n\n## Cadre (obligatoire)\nTu travailles sans humain : ne pose aucune question." + time + " " +
    (code ? "Tu peux modifier le code, seulement dans les zones permises du projet ; `npm test` doit passer. Ne lance ni git (sauf log, diff, show) ni pm2 : le script commit et redémarre si les tests passent." + lines
      : "Tu es en lecture seule : ne modifie aucun fichier, sauf ton bilan.") +
    "\nÉcris ton bilan dans `" + ctx.rel(file) + "` (JSON valide) : { \"resume\": \"1 à 3 phrases\", \"points\": [ { \"gravite\": \"haute | moyenne | basse\", \"sujet\": \"…\", \"detail\": \"…\", \"action\": \"… ou null\" } ]" +
    (code ? ", \"commit\": \"titre court si tu as modifié le code, sinon null\"" : "") + " }. N'écris jamais de mot de passe, de token ou de clé.";
  let agent, touched = [], applied = {};
  const web = a.web ? ["WebSearch", "WebFetch"] : [];
  if (code) {
    const before = ctx.untrackedSet();
    agent = await ctx.claude({ prompt, tools: [...CODE_TOOLS, ...web], budget: a.budgetUsd || 3 });
    const res0 = ctx.readJson(file, null);
    // Titre du commit : celui de l'agent, sinon la première phrase de son bilan (avant : le nom de l'agent seul, « Produit »).
    const title = (res0 && res0.commit) || (res0 && String(res0.resume || "").split(/(?<=[.!?])\s/)[0].slice(0, 100)) || a.name;
    applied = ctx.applyChanges(before, title, res0 && res0.resume ? [res0.resume] : [],
      { allowed: a.allowed ? require("./git-guard").zone(a.allowed, ctx.p.protected) : ctx.zone(true), maxLines: a.maxLines || 150, trailer: "Agent « " + a.name + " » (goldpilot-agents)." });
  } else {
    ({ out: agent, touched } = await ctx.readOnly(() => ctx.claude({ prompt, tools: [...READ_TOOLS, ...web], budget: a.budgetUsd || 2 })));
  }
  const res = ctx.readJson(file, null);
  if (sig && res) ctx.writeJson(sigFile, sig); // empreinte gardée seulement après un passage réussi
  // Mêmes points (gravité et sujet) qu'au passage précédent, sans commit ni échec : pas de nouvelle notification ni
  // d'alerte au patron (02/11 : un agent hebdomadaire renvoyait chaque fois les mêmes constats). Bilan à jour dans le panel.
  const keyOf = (r) => ((r && r.points) || []).filter((x) => x && x.gravite !== "basse").map((x) => x.gravite + "|" + String(x.sujet || "").trim().toLowerCase()).sort().join("\n");
  let prev = null;
  try { const t = require("fs").readFileSync(ctx.D("agents/" + a.id + ".jsonl"), "utf8").trimEnd(); prev = JSON.parse(t.slice(t.lastIndexOf("\n") + 1)).result; } catch (e) { /* premier passage */ }
  const repeat = !!(res && prev && keyOf(res) && keyOf(res) === keyOf(prev) && !applied.commit && !applied.testsFailed && !applied.tooBig);
  ctx.append("agents/" + a.id + ".jsonl", { at: new Date().toISOString(), cost: agent.cost, agentError: agent.error, commit: applied.commit || null, testsFailed: !!applied.testsFailed,
    tooBig: !!applied.tooBig, refused: applied.refused || touched, result: res });
  const shown = ((res && res.points) || []).filter((x) => x.gravite !== "basse");
  // quiet : agent qui travaille en continu (ex. toutes les 5 min) : pas de notification pour un commit de routine,
  // seulement pour un problème (points, tests en échec, changement trop gros, pas de bilan).
  if (repeat) ctx.log(a.id + " : mêmes points qu'au passage précédent, pas de nouvelle notification");
  else if (!res || (applied.commit && !a.quiet) || applied.testsFailed || applied.tooBig || applied.restartFailed || shown.length) {
    await ctx.notify((a.icon || "🤖") + " " + a.name + " · " + ctx.p.name + (applied.commit ? " · " + applied.commit : "") + "\n\n" +
      (res ? (res.resume || "") + (shown.length ? "\n\n" + shown.map((x) => (GRAV[x.gravite] || "•") + " " + x.sujet + "\n" + (x.detail || "") + (x.action ? "\n👉 " + x.action : "")).join("\n\n") : "") : "❌ Pas de bilan" + (agent.error ? " : " + agent.error.slice(0, 200) : "")) +
      (applied.testsFailed ? "\n\n❌ Annulé : des tests échouaient." : "") + (applied.tooBig ? "\n\n❌ Annulé : changement trop gros." : "") +
      (applied.restartFailed ? "\n\n⚠️ Redémarrage en échec après le commit : " + applied.restartFailed : "") +
      ((applied.others || []).length ? "\n\nℹ️ Laissés tels quels (changés pendant le passage, pas par les outils de l'agent : autre session ou commande) : " + applied.others.join(", ").slice(0, 300) : "") +
      ((applied.conflicts || []).length ? "\n\n✋ Pas touché (déjà en cours de modification par quelqu'un d'autre) : " + applied.conflicts.join(", ").slice(0, 300) : ""));
  }
  // Un point important ou moyen dans le bilan : « attention », pour que l'accueil le montre dans ses alertes (revue du
  // 02/11 : le statut restait « ok » même quand l'agent signalait un service arrêté).
  return { cost: agent.cost, status: !res || applied.restartFailed ? "erreur" : shown.length ? "attention" : "ok", repeat,
    summary: applied.restartFailed ? "Redémarrage en échec après le commit " + applied.commit + " : " + applied.restartFailed : res ? res.resume : agent.error, commit: applied.commit || null };
}

// Agent patron (demande du propriétaire, 31/10 : « un agent patron en haut qui vérifiera que tout est bien fait, et lui
// a toutes les permissions ») : relit le travail de tous les agents du projet (réglages, consignes, passages, résultats,
// commits), corrige le code n'importe où dans le projet (sauf .env, data/, node_modules), change les réglages et les
// consignes des autres agents (lib/agents-admin.js, commité « Agent patron : … ») et peut les relancer. Garde-fous
// gardés : tests obligatoires sinon tout est annulé, 300 lignes au plus, jamais lui-même, message au propriétaire.
// args.question : demande du propriétaire transmise par la conversation (lancé depuis le chat, lib/boss.js) ; le 01/11,
// lancé sans elle, il avait laissé de côté un correctif que le propriétaire venait de valider.
// BOSS_CODE : ce qu'il peut changer dans le code de lui-même, pour le patron de chaque projet quelle que soit sa consigne
// (demande du propriétaire, 03/11 : « le patron doit pouvoir modifier le code s'il estime que c'est logique et utile »,
// « une correction globale, pas juste sur un ou deux agents ») ; les règles du projet (project.json « rules ») restent
// plus fortes.
const BOSS_CODE = "\n\n## Le code (règle commune à tous les patrons)\n" +
  "Tu peux corriger ou améliorer le code toi-même, sans attendre qu'on te le demande, chaque fois que tu l'estimes logique et utile : un défaut, un cas oublié, une vérification qui manque, un message d'erreur flou, du code fragile ou mort. Petit et sûr, test d'abord ; les tests du projet doivent passer, sinon tout est annulé ; dis dans ton bilan ce que tu as changé et pourquoi.\n" +
  "Propose dans `idees` au lieu de faire : une nouvelle fonctionnalité visible, une règle métier, un réglage d'un service. Le code du trading (ordres, règles, BE, TP, SL) : seulement avec l'accord du propriétaire (décris la correction dans `points`). Jamais contre une décision du propriétaire.";
async function supervisor(ctx, a, args = {}) {
  const fs = require("fs");
  const path = require("path");
  const crypto = require("crypto");
  const store = require("./store");
  const admin = require("./agents-admin");
  const G = require("./git-guard");
  const p = ctx.p;
  const all = store.listAgents(p.id);
  ctx.writeJson("boss-data.json", require("./boss").bossData(p, a.id));
  ctx.rm("boss.json");
  // Le patron code aussi pendant un travail en cours (03/11 : « il doit pouvoir modifier le code s'il estime que c'est
  // logique et utile ») : les fichiers que quelqu'un modifie lui sont signalés (lib/context.js claude), et git-guard les
  // remet comme ils étaient s'il y touche. Avant, la moindre modification en cours le mettait en lecture seule.
  const before = ctx.untrackedSet();
  const tools = [...CODE_TOOLS, "WebSearch", "WebFetch"];
  const asked = args.question ? "\n\n## Demande du propriétaire (conversation, déjà validée par lui : fais-la en priorité, y compris dans src/trading/, avec un test)\n" + String(args.question).slice(0, 2000) : "";
  // args.alerte : problème qu'un agent vient de signaler (runner.js escalate). Demande du propriétaire (02/11) : le patron
  // corrige dès qu'une erreur est détectée, sans attendre qu'on le lui demande, puis prévient. Zones protégées du projet
  // respectées sur ce chemin automatique (GOLD PILOT : jamais src/trading/ ni les comptes MT5 sur une simple alerte).
  const alert = args.alerte ? "\n\n## Problème signalé à l'instant par un agent (traite-le en priorité)\n" + String(args.alerte).slice(0, 3000) +
    "\n\nVérifie-le toi-même d'abord. Si sa cause est dans le code et que la correction est sûre : corrige-la maintenant, sans attendre qu'on te le demande (test d'abord ; tests obligatoires, sinon tout est annulé), puis dis ce que tu as corrigé." +
    (p.protected ? " Zones protégées (" + p.protected + ") : n'y touche pas sur une alerte, décris la correction pour que le propriétaire la valide." : "") +
    " Si ça se règle hors du code (serveur, VM, jeton, réglage d'un autre logiciel, compte), ne tente rien : donne au propriétaire la marche à suivre exacte. Faux signal : dis-le et ajuste la consigne de l'agent qui l'a levé." : "";
  const time = a.maxMinutes ? "\n\n(Tu as " + a.maxMinutes + " minutes au plus pour ce passage : va à l'essentiel et écris ton bilan avant la fin, sinon il est coupé et perdu.)" : "";
  const agent = await ctx.claude({ prompt: ctx.prompt(a) + asked + alert + time + BOSS_CODE +
    "\n\nDonnées : " + ctx.rel("boss-data.json") + "\nTon bilan : " + ctx.rel("boss.json"), tools, budget: a.budgetUsd || 5 });
  const res = ctx.readJson("boss.json", null);
  const applied = ctx.applyChanges(before, (res && res.commit) || "Agent patron : correction", res && res.resume ? [res.resume] : [],
    { allowed: G.zone("^(?!data/|\\.env|node_modules/|\\.git/)", args.alerte ? p.protected : null), maxLines: a.maxLines || 300,
      trailer: "Agent patron" + (args.alerte ? " · alerte d'un agent" : "") + " (goldpilot-agents)." });
  // Réglages et consignes des autres agents (jamais lui-même), commités dans le dépôt des agents.
  const changes = [], refusedChanges = [];
  for (const c of (res && res.agents) || []) {
    if (!c || !c.agent || c.agent === a.id) continue;
    const body = {};
    for (const k of ["enabled", "schedule", "budgetUsd", "prompt", "description", "maxLines"]) if (c[k] !== undefined) body[k] = c[k];
    if (!Object.keys(body).length) continue;
    try {
      const r = admin.updateAgent(p, c.agent, body, { by: "Agent patron", reason: c.pourquoi, protect: (x) => x.kind === "supervisor" });
      changes.push({ agent: c.agent, changed: r.changed, pourquoi: c.pourquoi || null });
    } catch (e) { refusedChanges.push({ agent: c.agent, error: e.message }); }
  }
  // Relances demandées : prises par le runner au passage suivant.
  const launched = [];
  for (const l of (res && res.lancer) || []) {
    if (!l || !l.agent || l.agent === a.id || !all.some((x) => x.id === l.agent)) continue;
    const dir = path.join(store.RUNTIME, "commands");
    fs.mkdirSync(dir, { recursive: true });
    store.writeJson(path.join(dir, Date.now() + "-" + crypto.randomBytes(3).toString("hex") + ".json"), { project: p.id, agent: l.agent, args: l.question ? { question: String(l.question).slice(0, 2000) } : {}, at: new Date().toISOString(), by: "boss" });
    launched.push(l.agent);
  }
  ctx.append("boss.jsonl", { at: new Date().toISOString(), cost: agent.cost, agentError: agent.error, commit: applied.commit, testsFailed: applied.testsFailed, tooBig: applied.tooBig, refused: applied.refused, changes, refusedChanges, launched, result: res });
  const name = (id) => (all.find((x) => x.id === id) || {}).name || id;
  const shown = ((res && res.points) || []).filter((x) => x.gravite !== "basse");
  if (!res || res.statut === "attention" || applied.commit || changes.length || launched.length || shown.length || applied.testsFailed) {
    await ctx.notify("👑 Agent patron · " + p.name + "\n\n" + (res ? res.resume || "" : "❌ Pas de bilan" + (agent.error ? " : " + agent.error.slice(0, 200) : "")) +
      (applied.commit ? "\n\n✅ Code corrigé (" + applied.commit + ")" + (applied.restartFailed ? "." : ", redémarré.") : "") +
      (applied.restartFailed ? "\n⚠️ Redémarrage en échec : " + applied.restartFailed : "") + (applied.testsFailed ? "\n\n❌ Correction annulée : des tests échouaient." : "") +
      ((applied.conflicts || []).length ? "\n\n✋ Pas touché (déjà en cours de modification par quelqu'un d'autre) : " + applied.conflicts.join(", ") : "") +
      (changes.length ? "\n\n⚙️ Agents ajustés :\n" + changes.map((c) => "• " + name(c.agent) + " : " + c.changed.join(", ") + (c.pourquoi ? " — " + c.pourquoi : "")).join("\n") : "") +
      (launched.length ? "\n\n▶ Relancés : " + launched.map(name).join(", ") : "") +
      (shown.length ? "\n\n" + shown.map((x) => (GRAV[x.gravite] || "•") + " " + x.sujet + "\n" + (x.detail || "") + (x.action ? "\n👉 " + x.action : "")).join("\n\n") : ""));
  }
  return { cost: agent.cost, status: !res || applied.restartFailed ? "erreur" : res.statut || "ok",
    summary: applied.restartFailed ? "Redémarrage en échec après le commit " + applied.commit + " : " + applied.restartFailed : res ? res.resume : agent.error, commit: applied.commit };
}

module.exports = { scout, custom, supervisor };

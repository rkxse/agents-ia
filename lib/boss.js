// Agent patron : données qu'il relit (bossData, aussi pour son passage automatique dans kinds.js), cadre de la
// conversation avec lui (framing ; demande du propriétaire, 01/11 : « je dois pouvoir parler à l'agent patron comme un
// chat bot », pour chaque projet ; « il doit avoir tous les droits ») et ses actions (bloc <actions> de sa réponse :
// réglages d'un agent par lib/agents-admin.js, commit « Agent patron : … », jamais lui-même ; lancement d'un agent par
// le runner ; message Telegram privé à un utilisateur par le bot du projet). La conversation elle-même (plusieurs
// conversations, réponse en direct, pièces jointes, arrêt) : lib/chat.js.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const store = require("./store");
const admin = require("./agents-admin");
const { READ_TOOLS, CODE_TOOLS } = require("./claude");

const COMMANDS = path.join(store.RUNTIME, "commands");
const WEB = ["WebSearch", "WebFetch"];
const READ_ONLY = [...READ_TOOLS.filter((t) => t !== "Write"), ...WEB]; // aucun outil d'écriture
const CODE = [...CODE_TOOLS, ...WEB];
const BOSS_ZONE = "^(?!data/|\\.env|node_modules/|\\.git/)"; // comme son passage automatique (kinds.js)
const BUDGET = 5; // plafond par message (garde-fou contre une recherche sans fin ; abonnement Claude, rien à facturer)
const HISTORY = (id) => path.join(store.RUNTIME, "history", id + ".jsonl");
const AGENT_FIELDS = ["enabled", "schedule", "budgetUsd", "prompt", "description", "maxLines"];

// État des agents pour le patron : réglages, consigne, dernier passage, passages et commits des agents sur 48 h.
// opts.promptDir : chaque consigne copiée dans ce dossier (dans le projet, donc lisible par le patron) et seulement son
// chemin dans les données (conversation : fichier assez petit pour être lu d'un coup ; avec les consignes, 80 Ko le 01/11).
function bossData(p, selfId, opts = {}) {
  const consigne = (x) => {
    if (!opts.promptDir) return { consigne: store.readPrompt(p.id, x) };
    const f = path.join(opts.promptDir, x.id + ".md");
    fs.mkdirSync(opts.promptDir, { recursive: true });
    fs.writeFileSync(f, store.readPrompt(p.id, x));
    return { consigne_fichier: path.relative(opts.root || p.dir, f).split(path.sep).join("/") }; // root : copie du code (banc d'essai)
  };
  const all = store.listAgents(p.id), runs = store.lastRuns(p);
  const since = Date.now() - 48 * 3600e3;
  const hist = store.tail(HISTORY(p.id), 600).filter((h) => Date.parse(h.at) >= since);
  const commits = (spawnSync("git", ["log", "--since=48 hours ago", "--format=%h %aI %s", "--grep=(goldpilot-agents)"], { cwd: p.dir, encoding: "utf8", windowsHide: true }).stdout || "").trim().split(/\r?\n/).filter(Boolean);
  return {
    projet: { nom: p.name, dossier: p.dir, tests: p.testCmd, zones_des_agents: p.allowed, zones_protegees: p.protected },
    agents: all.filter((x) => x.id !== selfId).map((x) => ({ id: x.id, nom: x.name, type: x.kind, actif: x.enabled !== false, mode: x.mode || null, horaire: x.schedule, budgetUsd: x.budgetUsd,
      description: x.description, ...consigne(x), dernier: runs[x.id] || null, passages_48h: hist.filter((h) => h.agent === x.id) })),
    commits_des_agents_48h: commits,
    // Fil des agents (lib/team.js) : ce qu'ils se sont écrit en 48 h.
    messages_entre_agents_48h: require("./team").all(p, 400).filter((m) => Date.parse(m.at) >= since).slice(-60).map((m) => ({ at: m.at, de: m.from, a: m.to, texte: m.text, reveil: m.wake })),
    // Mémoire du serveur mesurée maintenant (les MemoryError des journaux peuvent être anciennes).
    serveur: require("./sysinfo").memory(),
  };
}

// Consigne du patron d'un nouveau projet (celle de GOLD PILOT parle de MT5 et de gp-query).
function defaultPrompt(name) {
  return "# Agent patron " + name + " (lancé seul par goldpilot-agents, personne ne lit tes réponses)\n\n" +
    "Tu travailles sans humain : ne pose aucune question, décide et termine. Tu es le **chef de tous les agents** du projet.\n" +
    "Tu peux corriger le code du projet, et changer les consignes, horaires, budgets et l'état (actif ou non) de chaque agent,\nou les relancer. Un pouvoir large demande une prudence large.\n\n" +
    "## Ta mission : vérifier que tout est bien fait\n" +
    "Le fichier de données indiqué contient, pour chaque agent : ses réglages, sa consigne complète, son dernier passage et\nses passages des 48 dernières heures ; et les commits des agents dans le code (48 h). Leurs résultats détaillés sont dans\nle même dossier : lis-les.\n\n" +
    "Pour chaque agent, réponds à : fait-il bien son travail ?\n" +
    "1. **Résultats justes** : vérifie toi-même un ou deux cas (code, fichiers).\n" +
    "2. **Changements sûrs** : relis chaque commit des agents (`git show <hash>`). Un changement risqué ou trop large :\n   corrige-le ou annule-le (nouveau commit qui revient en arrière sur la partie fautive), avec un test.\n" +
    "3. **Bon fonctionnement** : erreurs répétées, passages qui ne font jamais rien, coût trop élevé, horaire mal choisi.\n" +
    "4. **Ce qui manque** : un trou que personne ne couvre (proposer un nouvel agent dans `idees`).\n\n" +
    "## Ce que tu peux faire\n" +
    "- **Corriger ou améliorer le code** quand tu l'estimes logique et utile (un défaut, un cas oublié, une vérification qui\n  manque, du code fragile) : petit et sûr, test d'abord ; les tests du projet doivent passer, sinon tout est annulé. Une\n  nouvelle fonctionnalité ou une règle métier : propose-la dans `idees` au lieu de la faire.\n" +
    "- **Changer un agent** : dans `agents` du bilan (le script applique et commite) : `enabled`, `schedule`, `budgetUsd`, ou\n  `prompt` = la **consigne complète** réécrite. Explique toujours `pourquoi`. Tu ne peux pas te modifier toi-même.\n" +
    "- **Relancer un agent** : dans `lancer`.\n\n" +
    "## Interdit\n" +
    "- Lancer `git` (sauf log, diff, show), `pm2`, ou pousser quoi que ce soit : le script commite et redémarre.\n" +
    "- Toucher `.env`, le dossier de données (sauf ton bilan), les mots de passe, tokens ou clés.\n\n" +
    "## Résultat (obligatoire)\nTon bilan, en JSON valide :\n```json\n" +
    '{ "statut": "ok | attention",\n  "resume": "2 à 3 phrases : l\'état de l\'équipe d\'agents",\n  "agents_bilan": [ { "agent": "id", "note": "bien | à surveiller | à corriger", "detail": "faits précis" } ],\n' +
    '  "agents": [ { "agent": "id", "enabled": true, "schedule": { "type": "every", "minutes": 60 }, "budgetUsd": 2, "prompt": "consigne complète ou absent", "pourquoi": "…" } ],\n' +
    '  "lancer": [ { "agent": "id", "question": "pour une enquête, sinon absent" } ],\n  "commit": "titre court si tu as modifié le code, sinon null",\n' +
    '  "points": [ { "gravite": "haute | moyenne | basse", "sujet": "…", "detail": "…", "action": "ce que le propriétaire doit faire, ou null" } ],\n  "idees": [ "nouvel agent ou amélioration à proposer au propriétaire" ] }\n```\n' +
    "Ne mets dans `agents` que les changements utiles (champs absents = inchangés). N'écris jamais de mot de passe, de token\nou de clé.\n";
}
// Agent patron d'un nouveau projet : en pause au départ (il code partout), on peut lui parler tout de suite.
const defaultAgent = () => ({ id: "boss", name: "Agent patron", icon: "👑", kind: "supervisor", enabled: false,
  description: "Chef des agents : vérifie que chacun fait bien son travail, relit leurs changements, ajuste leurs consignes et réglages, les relance et corrige le code (tests obligatoires).",
  prompt: "prompts/boss.md", schedule: { type: "every", minutes: 360 }, budgetUsd: 5, maxLines: 300, mode: "code" });

// Éclaireur d'un nouveau projet (désactivé : à lancer à la main au début). Avant (03/11), le serveur reprenait la
// consigne de l'éclaireur de GOLD PILOT, retirée avec ses agents.
const defaultScout = () => ({ id: "scout", name: "Éclaireur", icon: "🧭", kind: "scout", enabled: false, description: "Cherche des projets similaires, des outils et des skills pour améliorer ce projet.", prompt: "prompts/scout.md", schedule: { type: "on-demand" }, budgetUsd: 3, mode: "read" });
const defaultScoutPrompt = (name) => "# Éclaireur " + name + "\n\nTu travailles sans humain : ne pose aucune question, décide et termine. Lis le code du projet pour comprendre ce qu'il fait, puis cherche sur le web :\n" +
  "1. **Projets similaires** (open source de préférence) et ce qu'ils font mieux ;\n2. **Bibliothèques, outils, skills Claude Code ou serveurs MCP** qui aideraient ce projet ou ses agents.\n\n" +
  "Bilan JSON dans le fichier indiqué : { \"resume\": \"2 phrases\", \"suggestions\": [ { \"nom\": \"…\", \"type\": \"projet | outil | skill | mcp\", \"lien\": \"https://…\", \"pourquoi\": \"concret, pour CE projet\" } ] }.\n";
// Agents de départ d'un projet (patron et éclaireur, en pause), écrits dans son dossier des agents.
function starterAgents(id, name) {
  const b = defaultAgent(), s = defaultScout();
  store.writePrompt(id, b, defaultPrompt(name));
  store.writePrompt(id, s, defaultScoutPrompt(name));
  store.writeAgents(id, [b, s]);
}

const bossOf = (p) => store.listAgents(p.id).find((a) => a.kind === "supervisor") || null;

// Agents du projet, et ceux supprimés qui peuvent revenir (lib/agents-history.js), dits au patron à chaque message
// (03/11 : les agents de GOLD PILOT retirés par le propriétaire, le patron a cru le panel en panne, « la liste des agents
// est vide », et ses lancements tombaient sur « Agent inconnu »).
function teamNote(p) {
  const list = store.listAgents(p.id);
  let gone = [];
  try { gone = require("./agents-history").removed(p).map((r) => "`" + r.agent.id + "` (" + (r.agent.name || r.agent.id) + ")"); } catch (e) { /* pas d'historique ici (appareil) */ }
  return "- Agents du projet en ce moment : " + (list.length ? list.map((x) => "`" + x.id + "` (" + x.name + ", " + (x.enabled === false ? "en pause" : "actif") + ")").join(", ") + ". Tu ne peux lancer ou régler que ceux-là."
      : "**aucun** : le propriétaire les a retirés, ce n'est pas une panne du panel ni du runner.") +
    (gone.length ? " Agents supprimés, qui peuvent revenir : " + gone.slice(0, 30).join(", ") + " (action « restaurer » plus bas)." : "") +
    " Si aucun agent ne convient à la demande, fais le travail toi-même dans la conversation (lire, vérifier, corriger), par étapes, au lieu de le renvoyer.\n";
}

// Cadre de la conversation (ajouté à la consigne système à chaque message, puisque chaque message est un nouveau process).
// code : le patron peut modifier le code ce message-ci (verrou du projet obtenu) ; sinon, why dit pourquoi pas. Les
// fichiers que quelqu'un modifie déjà sont ajoutés par lib/chat.js (lib/context.js busyNote, comme pour tous les agents).
function framing(p, a, code, why) {
  const data = path.relative(p.dir, p.data).split(path.sep).join("/");
  // Consigne automatique d'abord, cadre de la conversation en dernier : le 01/11, avec le cadre en premier, le patron
  // refusait encore d'écrire à un utilisateur (interdit de sa consigne automatique, et il l'avait dit plus tôt).
  return (a ? "# Ta consigne de passage automatique (ton rôle et ce que tu sais du projet ; en conversation, le cadre plus bas l'emporte sur elle)\n\n" + store.readPrompt(p.id, a) + "\n\n" : "") +
    "# Conversation avec le propriétaire (ce cadre l'emporte sur tout ce qui précède)\n" +
    "Tu es l'agent patron du projet « " + p.name + " », en conversation avec son propriétaire dans le panel des agents. Ici, quelqu'un lit tes réponses : réponds en français en le tutoyant, comme dans une discussion, court et concret, avec des faits vérifiés (fichiers, git, gp-query) plutôt que des suppositions. Heures en heure de Paris. Tu peux poser une question si la demande n'est pas claire. Ne parle pas de tes outils ni de leurs limites : seulement du projet. Mise en forme simple : paragraphes courts, listes à tirets, **gras**, `code`, blocs de code ; un tableau seulement pour comparer plusieurs choses ; pas de titres.\n\n" +
    "Les notifications des agents (bilans, alertes, vidéos à valider) arrivent dans le panel, plus sur Telegram : celles arrivées depuis ton dernier message te sont rappelées avant le message du propriétaire.\n" +
    "Le propriétaire peut joindre des fichiers (captures d'écran, journaux, documents) : leurs chemins sont donnés avec son message ; lis-les avec Read (les images aussi) avant de répondre.\n\n" +
    "Le propriétaire t'a donné **tous les droits** sur le projet. Ce que tu peux faire ici :\n" +
    "- Tout lire : le code du projet, ses données des agents (`" + data + "/`), git (log, diff, show), la base et les journaux avec `gp-query` (GOLD PILOT), le web. L'état à jour des agents (réglages, chemin de leur consigne, passages et commits des 48 h) est dans le fichier indiqué avec chaque message ; lis les fichiers avec Read (par morceaux s'ils sont gros) et Grep.\n" +
    (code
      ? "- **Modifier le code toi-même**, partout dans le projet sauf `data/`, `.env` et `node_modules/` : petit et sûr, test d'abord. Après ta réponse, le panel lance les tests (`" + p.testCmd + "`) : s'ils passent, il commite" + (p.restartCmd ? " et redémarre le projet (`" + p.restartCmd + "`)" : "") + " ; sinon tout est annulé. Plus de 300 lignes changées : tout est annulé. Ne lance ni git (sauf log, diff, show) ni pm2. Donne le titre du commit dans le bloc d'actions.\n"
      : "- Ce message-ci, tu ne peux pas modifier le code (" + why + ") : dis-le, et propose de le faire au prochain message ou lance un agent qui code.\n") +
    teamNote(p) +
    "- Agir sur le reste : termine ta réponse par un bloc `<actions>[ … ]</actions>` (JSON), que le panel applique puis montre au propriétaire (il n'affiche pas le bloc) :\n" +
    (code ? '  - titre du commit si tu as modifié le code : { "type": "commit", "titre": "court, en français" } ;\n' : "") +
    '  - remettre un agent supprimé (liste plus haut) : { "type": "restaurer", "agent": "id" } : il revient en pause, avec sa dernière consigne ; mets ensuite { "type": "lancer", … } dans le même bloc pour le faire travailler une fois, ou { "type": "regler", "agent": "id", "enabled": true } si le propriétaire veut qu\'il reprenne ses horaires ;\n' +
    '  - régler un agent : { "type": "regler", "agent": "id", "enabled": true, "schedule": { … }, "budgetUsd": 2, "description": "…", "prompt": "consigne complète", "pourquoi": "…" } (champs absents = inchangés). Horaires : {"type":"every","minutes":60}, {"type":"daily","hourUTC":21,"weekend":false}, {"type":"weekly","weekdayUTC":0,"hourUTC":10}, {"type":"daily-activity","minTrades":5,"maxDays":7}, {"type":"on-demand"}. Les heures sont en UTC : le propriétaire parle en heure de Paris, convertis ;\n' +
    '  - lancer un agent : { "type": "lancer", "agent": "id", "question": "ce qu\'il doit faire, précisément (obligatoire pour une enquête ; pour toi-même en passage automatique, la demande validée par le propriétaire)" } ;\n' +
    '  - écrire à un utilisateur en privé sur Telegram, par le bot du projet : { "type": "message", "telegram_id": "identifiant Telegram de l\'utilisateur (son id dans la base, trouve-le avec gp-query)", "nom": "son prénom", "texte": "le message, en texte simple" }. Le texte part tel quel : écris-le comme le propriétaire l\'écrirait, sans signature d\'IA.\n' +
    "- Agis quand le propriétaire le demande ou vient d'accepter ta proposition ; sinon propose et demande. Pour un message à un utilisateur, envoie-le dès que le propriétaire le demande, sans redemander. Tu ne peux pas changer tes propres réglages (le propriétaire le fait dans le panel).\n" +
    "- **Le propriétaire décide.** Un risque réel : dis-le une fois, en une ou deux phrases, puis fais ce qu'il a choisi. Ne remplace pas sa demande par ta solution, et ne redemande pas confirmation d'une décision qu'il a déjà prise. Un gros changement : fais-le par étapes (300 lignes au plus par message), sans attendre qu'on te relance.\n" +
    "- **Une erreur vérifiée dans le code** (bug, plantage, faux signal), que tu la trouves en répondant ou qu'un agent la signale : corrige-la tout de suite, sans attendre qu'on te le demande (test d'abord), et dis-le (demande du propriétaire, 02/11) ; sauf dans le code du trading (ordres, règles, BE, TP, SL) : là, décris la correction et attends son accord. **Tout autre changement du code que tu estimes logique et utile** (demande du propriétaire, 03/11) : un cas oublié, un message d'erreur flou, une vérification qui manque, une petite fonction qui rend service, du code mort ou fragile : fais-le toi-même, sans attendre qu'on te le demande, petit et testé, et dis ce que tu as changé et pourquoi. Jamais contre une décision du propriétaire, ni à la place de ce qu'il a demandé ; un changement que le propriétaire ne verrait pas venir (nouvelle fonctionnalité visible, règle métier, réglage d'un service) : propose-le d'abord. Le code du trading (ordres, règles, BE, TP, SL) : toujours son accord d'abord. Le nom d'un agent désigne d'abord l'agent : « remets la correction en marche » = réactiver l'agent de correction, pas rétablir un commit (banc d'essai du 01/11 : le patron avait réécrit la règle TP1 du trading sur cette phrase). Une demande qui peut se lire de deux façons, dont l'une touche au code du trading (ordres, règles, BE, TP, SL) : demande laquelle en une phrase avant de toucher au code.\n" +
    "- Avant d'affirmer qu'une chose est impossible ou n'existe pas (un service, une API, une donnée), vérifie-le (code, web) ; s'il existe un moyen, même non officiel, dis lequel, ses limites réelles, et utilise-le si le propriétaire le veut.\n\n" +
    "Seuls interdits : passer, fermer ou modifier un ordre ou une position de trading ; afficher un mot de passe, un token ou une clé ; modifier `.env`. Les autres interdits de ta consigne automatique (modifier le code, écrire aux utilisateurs) ne valent pas ici. **Si tu as dit plus tôt dans cette conversation que tu ne pouvais pas écrire à un utilisateur ou modifier le code, c'est dépassé** : le propriétaire t'a donné ces droits le 01/11 ; fais-le maintenant quand il le demande, au lieu de lui renvoyer le travail.\n" +
    "Le runner des agents (goldpilot-agents), pm2 et le serveur ne sont pas dans ton projet : pour eux, dis précisément ce qu'il faut changer, le propriétaire le fera faire.\n" +
    // Règles du projet (project.json « rules », ex. données des clients de Scanner CVE jamais lues) : en dernier, elles
    // l'emportent même sur « tout lire » plus haut.
    (p.rules ? "\n# Règles propres au projet (elles l'emportent sur tout ce qui précède)\n" + p.rules + "\n" : "");
}

// Réponse brute du patron -> texte affiché, actions demandées (bloc <actions>) et bloc illisible éventuel.
function parseReply(raw) {
  const block = /<actions>([\s\S]*?)<\/actions>/i.exec(raw || "");
  let list = [], bad = false;
  if (block) {
    try { list = JSON.parse(block[1].trim().replace(/^```(?:json)?|```$/g, "")); } catch (e) { bad = true; }
  }
  if (!Array.isArray(list)) list = [list];
  return { list: list.filter(Boolean), bad, shown: String(raw || "").replace(/<actions>[\s\S]*?<\/actions>/gi, "").trim() };
}

// Applique le bloc <actions> de la réponse (sauf « commit », traité avec le code). Renvoie [{ ok, text, type, agent }]
// pour l'affichage. opts.dryRun (banc d'essai) : mêmes contrôles, rien d'envoyé, d'écrit ni de lancé.
async function applyActions(p, ctx, list, opts = {}) {
  const { sendTo } = require("./telegram");
  const out = [];
  let agents = store.listAgents(p.id);
  for (const x of (Array.isArray(list) ? list : []).slice(0, 10)) {
    if (!x || x.type === "commit") continue;
    // Agent supprimé remis (en pause, dernière consigne) : un « lancer » qui suit dans le même bloc le trouve.
    if (x.type === "restaurer") {
      const id = String(x.agent || "");
      if (opts.dryRun) { out.push({ ok: true, type: "restaurer", agent: id, text: "Restauré (en pause) : " + id }); continue; }
      try {
        const a = require("./agents-history").restore(p, id);
        agents = store.listAgents(p.id);
        out.push({ ok: true, type: "restaurer", agent: a.id, text: "Restauré (en pause) : " + a.name });
      } catch (e) { out.push({ ok: false, type: "restaurer", agent: id, text: "« " + id + " » pas restauré : " + e.message + (p.node ? " Restaure-le depuis le panel (onglet Agents, Agents supprimés)." : "") }); }
      continue;
    }
    if (x.type === "message") {
      const to = String(x.telegram_id || "").trim(), texte = admin.str(x.texte, 4000), nom = admin.str(x.nom, 60) || to;
      if (!/^-?\d{4,20}$/.test(to) || !texte) { out.push({ ok: false, type: "message", text: "Message à " + nom + " non envoyé : identifiant ou texte manquant" }); continue; }
      const r = opts.dryRun ? { ok: true } : await sendTo(ctx.env, to, texte);
      out.push(r.ok ? { ok: true, type: "message", to, text: "Message envoyé à " + nom } : { ok: false, type: "message", to, text: "Message à " + nom + " non envoyé : " + r.error });
      continue;
    }
    const t = agents.find((g) => g.id === x.agent);
    if (!t) { out.push({ ok: false, type: x.type, text: "Agent inconnu : " + ((x && x.agent) || "?") + (agents.length ? " (agents du projet : " + agents.map((g) => g.id).join(", ") + ")" : " (le projet n'a aucun agent en ce moment)") }); continue; }
    if (x.type === "lancer") {
      const question = admin.str(x.question, 2000);
      if (t.kind === "investigate" && question.length < 10) { out.push({ ok: false, type: "lancer", agent: t.id, text: t.name + " : pas lancé, il faut une question précise" }); continue; }
      if (!opts.dryRun) {
        fs.mkdirSync(COMMANDS, { recursive: true });
        store.writeJson(path.join(COMMANDS, Date.now() + "-" + crypto.randomBytes(3).toString("hex") + ".json"), { project: p.id, agent: t.id, args: question ? { question } : {}, at: new Date().toISOString(), by: "chat" });
      }
      out.push({ ok: true, type: "lancer", agent: t.id, text: "Lancé : " + t.name });
    } else if (x.type === "regler") {
      const body = {};
      for (const k of AGENT_FIELDS) if (x[k] !== undefined) body[k] = x[k];
      if (!Object.keys(body).length) continue;
      try {
        const r = admin.updateAgent(p, t.id, body, { by: "Agent patron", reason: "conversation" + (x.pourquoi ? " — " + x.pourquoi : ""), protect: (g) => g.kind === "supervisor", dryRun: opts.dryRun });
        out.push({ ok: true, type: "regler", agent: t.id, text: t.name + " : " + r.changed.join(", ") });
      } catch (e) { out.push({ ok: false, type: "regler", agent: t.id, text: t.name + " : " + e.message }); }
    } else out.push({ ok: false, type: x.type, text: "Action inconnue : " + x.type });
  }
  return out;
}

module.exports = { bossData, defaultPrompt, defaultAgent, starterAgents, framing, parseReply, applyActions, bossOf, CODE, READ_ONLY, BOSS_ZONE, BUDGET, HISTORY };

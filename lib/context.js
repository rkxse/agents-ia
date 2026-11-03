// Contexte d'un projet pour ses agents : variables (.env du projet), dossier de travail, consignes, Claude,
// notifications au propriétaire et garde-fous git liés au dossier du projet.
const fs = require("fs");
const path = require("path");
const store = require("./store");
const G = require("./git-guard");
const { readEnv } = require("./env");
const { runClaude } = require("./claude");

const COMMON_RULES = path.join(__dirname, "regles-communes.md");
// Fichiers en cours de modification par quelqu'un d'autre, dits à l'agent : il code à côté, sans y toucher.
const busyNote = (busy) => (busy.length ? "# Travail en cours dans le dépôt\nQuelqu'un (une personne, une autre session) modifie en ce moment : " + busy.slice(0, 30).map((f) => "`" + f + "`").join(", ") + (busy.length > 30 ? " (et " + (busy.length - 30) + " autres)" : "") +
  ". **N'y touche pas** : ton changement y serait retiré (son travail est gardé). Ne t'appuie pas non plus sur ce qu'ils contiennent de nouveau : ce n'est pas encore commité. Si ton travail doit passer par eux, dis-le dans ton bilan." : "");
function withCommonRules(system) {
  let common = "";
  try { common = fs.readFileSync(COMMON_RULES, "utf8").trim(); } catch (e) { /* fichier absent : rien à ajouter */ }
  return [system, common].filter(Boolean).join("\n\n") || undefined;
}

function makeContext(p, log) {
  const env = readEnv(path.join(p.dir, p.envFile || ".env"));
  fs.mkdirSync(p.data, { recursive: true });
  const D = (f) => path.join(p.data, f);
  const rel = (f) => path.relative(p.dir, D(f)).split(path.sep).join("/"); // chemin vu par l'agent (dossier du projet)
  const ctx = {
    p, env, log, D, rel,
    readJson: (f, d) => store.readJson(D(f), d),
    writeJson: (f, v) => { fs.mkdirSync(path.dirname(D(f)), { recursive: true }); fs.writeFileSync(D(f), JSON.stringify(v, null, 2)); },
    append: (f, o) => store.append(D(f), o),
    rm: (f) => fs.rmSync(D(f), { force: true }),
    // Dans la conversation « Parler au patron » du panel, plus sur Telegram (demande du propriétaire, 01/11).
    // extra : { video: id } pour une vidéo à valider. Promesse, comme l'envoi Telegram d'avant.
    notify: async (text, extra) => { try { require("./chat").note(p, text, extra); } catch (e) { log("notification impossible : " + e.message); } },
    // Avec l'outil « appeler_api » si le projet a des connexions à d'autres API (lib/connections.js), et ses règles propres
    // (project.json « rules ») dans la consigne système.
    // Durée maximale du passage en cours (runner.js : maxMinutes de l'agent), sinon celle de lib/claude.js.
    // Règles communes à tous les agents de tous les projets (lib/regles-communes.md : un défaut se corrige à sa cause,
    // pas par un contournement de consigne ; demande du propriétaire, 02/11), toujours ajoutées à la consigne système.
    // Passage en cours (untrackedSet) : les fichiers que Claude écrit avec ses outils y sont notés (track), pour que seuls
    // ceux-là soient gardés ou annulés après coup (git-guard passageChanges).
    // Travail en cours dans le dépôt (fichiers déjà modifiés au début du passage) : dit à tout agent qui peut écrire, quel
    // qu'il soit (03/11 : avant, un agent qui code se reportait ou passait en lecture seule tant que quelqu'un travaillait
    // dans le dépôt ; git-guard remet ces fichiers comme ils étaient s'il y touche).
    claude: (opts) => {
      const t = ctx.passage ? (ctx.passage.track = ctx.passage.track || { files: [], shell: false }) : undefined;
      const writes = !opts.tools || opts.tools.some((x) => /^(Edit|Write|MultiEdit|NotebookEdit)$/.test(x));
      const busy = ctx.passage && writes ? ctx.busy(ctx.passage) : [];
      return runClaude({ cwd: p.dir, ...require("./connections").mcpFor(p), ...(ctx.timeoutMs ? { timeoutMs: ctx.timeoutMs } : {}), ...(t ? { track: t } : {}), ...opts,
        system: withCommonRules([opts.system || (p.rules ? "# Règles propres au projet\n" + p.rules : ""), busyNote(busy), ctx.team || ""].filter(Boolean).join("\n\n")) });
    },
    prompt: (a) => store.readPrompt(p.id, a),
    changedFiles: () => G.changedFiles(p.dir),
    // Début d'un passage qui peut modifier le code : état du dépôt (fichiers déjà modifiés ou nouveaux, avec leur
    // empreinte) ; s'utilise comme l'ensemble des fichiers non suivis d'avant (has).
    passage: null,
    team: "", // fil des agents pour le passage en cours (lib/team.js prepare, rempli par le runner), ajouté à la consigne système
    untrackedSet: () => (ctx.passage = G.start(p.dir)),
    revert: (c, before) => G.revert(p.dir, c, before),
    // Fichiers suivis que quelqu'un modifie déjà (hors données des agents) : au début du passage (before) ou maintenant.
    // Plus de « dirty » (03/11) : aucun agent n'attend ni ne passe en lecture seule pour un travail en cours.
    busy: (before) => (before && before.snap ? [...before.snap.keys()].filter((f) => !before.untracked.has(f)) : G.dirtyTracked(p.dir).map((c) => c.file))
      .filter((f) => !f.startsWith("data/") && !f.startsWith(path.relative(p.dir, p.data).split(path.sep).join("/") + "/")),
    zone: (protectedToo) => G.zone(p.allowed, protectedToo ? p.protected : null),
    // Garde-fous d'un passage qui code : zones, taille, tests, commit, redémarrage (voir git-guard.js). Fichiers verrouillés
    // du projet (project.json « locked », ex. règles des agents et garde-fou des tests de Scanner CVE) : jamais modifiés,
    // même par le patron (sa zone ignore « protected ») ; un changement y est annulé avant le commit.
    applyChanges: (before, title, bodyLines, extra = {}) => {
      const z = extra.allowed || ctx.zone(false), locked = p.locked ? new RegExp(p.locked) : null;
      return G.applyChanges({ root: p.dir, before, title, bodyLines, testCmd: p.testCmd, restartCmd: p.restartCmd, msgFile: D("commit-msg.txt"), log, ...extra,
        allowed: locked ? { test: (f) => z.test(f) && !locked.test(f) } : z });
    },
    // Passage en lecture seule : toute modification de l'agent hors du dossier de données est annulée ; ce qu'une autre
    // personne ou session change pendant ce temps reste (avant le 03/11, annulé aussi). Renvoie les fichiers annulés.
    async readOnly(fn) {
      const before = ctx.untrackedSet();
      const dataRel = path.relative(p.dir, p.data).split(path.sep).join("/") + "/";
      const out = await fn();
      const outside = (c) => !c.file.startsWith(dataRel) && !c.file.startsWith("data/");
      const { mine, others } = G.passageChanges(p.dir, before);
      const touched = mine.filter(outside);
      touched.forEach((c) => ctx.revert(c, before));
      const left = others.filter(outside);
      if (left.length) log("changés pendant le passage, pas par l'agent (autre session ou commande) : laissés tels quels : " + left.map((c) => c.file).join(", ").slice(0, 300));
      return { out, touched: touched.map((c) => c.file) };
    },
    runAgent: null, // fourni par le runner : lancer un autre agent du projet (ex. enquête après le contrôle horaire)
  };
  return ctx;
}

module.exports = { makeContext, withCommonRules, busyNote };

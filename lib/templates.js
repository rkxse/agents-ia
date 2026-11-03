// Modèles proposés dans le panel pour créer un agent (type custom). Tout reste modifiable avant et après la création.
const T = [
  {
    id: "securite", name: "Revue de sécurité", icon: "🛡️", mode: "read", schedule: { type: "weekly", weekdayUTC: 1, hourUTC: 6 }, budgetUsd: 3,
    description: "Cherche chaque semaine les failles du code (injection, accès sans contrôle, secrets exposés, données d'un utilisateur visibles par un autre).",
    prompt: `# Revue de sécurité

Relis le code du projet à la recherche de vraies failles exploitables, en commençant par ce qui a changé récemment
(\`git log --since="8 days ago" --stat\`, puis \`git show\`) :
- entrées utilisateur non vérifiées (injection SQL ou de commande, chemins de fichiers, HTML non échappé) ;
- routes ou actions sans contrôle d'accès, ou qui laissent un utilisateur voir ou modifier les données d'un autre ;
- secrets (mots de passe, tokens, clés) écrits dans le code, les journaux ou les réponses ;
- dépendances ou appels réseau dangereux.

Ne signale que ce que tu as vérifié dans le code, avec le fichier et la ligne, et comment l'exploiter. Pas de conseils
génériques. Gravité « haute » seulement pour une faille exploitable aujourd'hui.`,
  },
  {
    id: "tests", name: "Tests manquants", icon: "🧪", mode: "code", schedule: { type: "daily", hourUTC: 21, weekend: true }, budgetUsd: 3, maxLines: 200,
    description: "Ajoute chaque jour des tests sur une partie importante du code qui n'en a pas, sans changer le code lui-même.",
    prompt: `# Tests manquants

Trouve UNE partie importante du code sans test (règles métier, calculs, lecture des données reçues) et ajoute des
tests qui vérifient son comportement actuel. Ne modifie PAS le code testé : seulement des fichiers de test.
Suis le style des tests existants. Si un test révèle un vrai bug, ne le corrige pas : décris-le dans tes points
(gravité haute) avec le test qui le montre, et marque ce test comme « skip » avec une explication.`,
  },
  {
    id: "carte", name: "Carte à jour", icon: "🗺️", mode: "code", schedule: { type: "weekly", weekdayUTC: 0, hourUTC: 8 }, budgetUsd: 2, maxLines: 120,
    description: "Met à jour chaque semaine la carte du projet (PROJECT_MAP.md, carte/) selon les derniers changements du code.",
    prompt: `# Carte à jour

Compare la carte du projet (\`PROJECT_MAP.md\` et le dossier \`carte/\`) aux changements de la semaine
(\`git log --since="8 days ago" --stat\`). Corrige seulement ce qui est faux ou manquant : fichiers ajoutés, renommés ou
supprimés, rôles qui ont changé, nouvelles règles. Ne modifie que la carte, jamais le code. Phrases courtes.`,
  },
  {
    id: "erreurs", name: "Surveillance des erreurs", icon: "🚨", mode: "read", schedule: { type: "every", minutes: 120 }, budgetUsd: 1.5,
    description: "Lit les journaux d'erreurs toutes les 2 h et signale les erreurs nouvelles ou qui se répètent, avec leur cause probable.",
    prompt: `# Surveillance des erreurs

Lis les dernières erreurs du projet dans ses journaux : la commande ou le fichier indiqué dans CLAUDE.md ou
PROJECT_MAP.md s'il y en a, sinon les fichiers *.log et le dossier logs/ (pour GOLD PILOT :
\`gp-query logs "Error|erreur|impossible|échec" 150\`). Si le projet n'a aucun journal, dis-le en une phrase et
indique où il devrait en écrire.
Ignore le bruit connu et sans effet (coupures réseau brèves, délais d'un service extérieur). Pour chaque erreur
nouvelle ou qui se répète : combien de fois, depuis quand, le code qui la produit (cherche le message dans le code)
et sa cause probable. Gravité « haute » si des utilisateurs, des paiements ou des ordres sont touchés.`,
  },
  {
    id: "vide", name: "Agent personnalisé", icon: "🤖", mode: "read", schedule: { type: "on-demand" }, budgetUsd: 2,
    description: "Un agent à ta façon : écris ce qu'il doit faire.",
    prompt: `# Mon agent

Décris ici ce que l'agent doit faire, ce qu'il doit regarder (fichiers, données) et ce qu'il doit rendre.`,
  },
];

module.exports = { list: () => T, get: (id) => T.find((t) => t.id === id) || null };

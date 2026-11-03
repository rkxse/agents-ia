# Agents IA

Un panel web pour faire travailler des agents IA (Claude Code) sur tes projets : ils relisent le code, corrigent les
défauts, surveillent les services, cherchent des pistes d'amélioration, et se parlent entre eux. Tout se règle depuis
le site, y compris depuis un téléphone.

## Ce que ça fait

- **Des agents par projet** : chacun a une consigne, un horaire (toutes les N minutes, chaque jour, chaque semaine, à la
  demande), un mode (lecture seule ou modification du code) et une durée maximale. Modèles prêts à l'emploi (revue de
  sécurité, tests manquants…) ou agent écrit en une phrase.
- **Un agent patron** : il relit le travail des autres agents, ajuste leurs consignes et leurs horaires, les relance,
  et corrige ou améliore le code quand c'est logique et utile. On lui parle dans le panel comme dans une conversation
  (pièces jointes, réponse en direct, arrêt, reprise d'un message).
- **Le fil des agents** : un agent peut écrire à un autre agent du projet ; le destinataire est réveillé tout de suite
  s'il est actif. Garde-fous contre les conversations sans fin (messages par passage, réveils par heure, longueur de
  chaîne).
- **Des changements sûrs** (`lib/git-guard.js`) : zones du code permises ou interdites, fichiers verrouillés, taille
  maximale, tests obligatoires avant chaque commit, redémarrage du projet ensuite ; sinon tout est annulé. Un agent ne
  touche jamais au travail en cours d'une personne ou d'une autre session dans le même dépôt.
- **Des ordinateurs connectés** : un projet peut tourner sur ton propre ordinateur (`node.js`), avec ton propre Claude ;
  le panel règle ses agents, les lance et affiche leurs résultats. Mise à jour automatique, et jamais vers une version
  qui ne se charge pas (`lib/loadcheck.js`).
- **Le panel** (`server.js`, `public/index.html`) : carte des agents et des fichiers, chronologie, exécutions,
  changements avec leur diff et annulation propre, réglages du projet, agents supprimés à restaurer, connexions des
  agents aux API d'autres projets (le jeton n'est jamais montré à l'IA), clés d'API, notifications push, page Services
  (état, journal et redémarrage du runner et du panel).
- **Comptes** : chacun ne voit que ses projets ; double authentification (application, clés de sécurité WebAuthn, codes
  de secours).

## Installation

### 1. Prérequis

- **Node.js 22** ou plus récent ([nodejs.org](https://nodejs.org)) et **git** ([git-scm.com](https://git-scm.com)).
- **Claude Code** ([claude.ai/code](https://claude.ai/code)), connecté sur la machine : lance `claude`, puis `/login`.
  Les agents tournent avec ce compte Claude.
- Windows, Linux ou macOS. Aucune dépendance npm : rien à installer de plus.
- Pour un accès depuis Internet (téléphone compris) : un nom de domaine et un proxy HTTPS (Caddy, nginx…) devant le panel.

### 2. Récupérer le code

```bash
git clone https://github.com/<ton-compte>/agents-ia.git
cd agents-ia
npm test          # vérifie que tout marche sur ta machine (dossiers jetables, rien n'est écrit dans data/)
```

### 3. Lancer le panel et le runner

```bash
node server.js    # le panel, sur http://127.0.0.1:3017 (variable PORT pour changer)
node runner.js    # le runner : fait passer les agents à leurs horaires
```

Pour qu'ils tournent en permanence et repartent tout seuls, le plus simple est [pm2](https://pm2.keymetrics.io) :

```bash
npm install -g pm2
pm2 start server.js --name agents-panel
pm2 start runner.js --name agents-runner
pm2 save          # puis « pm2 startup » pour les relancer au démarrage de la machine
```

Le runner se relance seul quand son code change (mise à jour par `git pull`) ; la page Services du panel redémarre l'un
ou l'autre. Si tu ne gardes pas le nom `goldpilot-agents` pour le runner sous pm2, donne son nom au panel :
`AGENTS_RUNNER_PM2=agents-runner`.

### 4. Créer le compte administrateur

Sur la machine du panel, crée un code d'installation (à usage unique, valable 24 h) :

```bash
node -e "console.log(require('./lib/auth').setupCode())"
```

Puis ouvre `http://localhost:3017/#/setup?code=LE_CODE` (ou l'adresse publique du panel) et choisis ton e-mail et ton mot
de passe. Active ensuite la double authentification dans « Sécurité du compte ». D'autres personnes peuvent s'inscrire
elles-mêmes : chacune ne voit que ses projets, et leurs agents tournent sur leurs propres ordinateurs.

### 5. Ajouter un projet

Dans le panel, **Ajouter un projet** :

- **Sur ce serveur** (administrateur) : le dossier d'un dépôt git, sa commande de tests (`npm test`, `pytest`…), sa
  commande de redémarrage et les zones du code que les agents peuvent modifier. Le projet démarre avec son agent patron
  et son éclaireur, en pause ; ajoute ensuite des agents (modèles, ou une phrase qui dit ce qu'il doit faire).
- **Depuis ton ordinateur** : le panel donne une commande à coller dans PowerShell (Windows) ou un terminal (macOS,
  Linux), ouvert dans le dossier du projet. Elle vérifie Node, git et Claude, installe le petit programme qui fait tourner
  les agents sur cet ordinateur, et le lance à chaque démarrage. Rien n'est modifié dans les fichiers du projet.

`projects/exemple/` montre la forme des réglages d'un projet ; les agents d'un projet sont rangés dans son dossier
`agents-ia/` (ignoré par git).

### 6. Mettre le panel sur Internet (facultatif)

Le panel n'écoute qu'en local : place un proxy HTTPS devant, qui transmet l'adresse du visiteur dans `X-Real-IP`
(limites d'essais de connexion). Exemple avec Caddy :

```
agents.exemple.fr {
  reverse_proxy 127.0.0.1:3017 {
    header_up X-Real-IP {remote_host}
  }
}
```

Et indique l'adresse publique au panel (clés de sécurité, liens d'installation des ordinateurs) :
`PANEL_ORIGINS=https://agents.exemple.fr`.

### Variables d'environnement

| Variable | Rôle | Par défaut |
|---|---|---|
| `PORT` | port du panel (toujours 127.0.0.1) | `3017` |
| `PANEL_ORIGINS` | adresse publique du panel (une ou plusieurs, séparées par des virgules) | `https://agent.rvkxse.com` |
| `AGENTS_RUNNER_PM2` | nom du runner sous pm2 (page Services) | `goldpilot-agents` |
| `AGENTS_RUNTIME` | dossier des données (comptes, passages, conversations) | `data/` |
| `AGENTS_PROJECTS` | dossier des réglages des projets | `projects/` |

### Mettre à jour

```bash
git pull
npm test
pm2 restart agents-panel   # le runner se relance seul ; les ordinateurs connectés se mettent à jour seuls
```

## Organisation

- `server.js` : panel web et API ; `public/` : l'interface (une page, sans framework).
- `runner.js` : toutes les minutes, les demandes du panel puis les agents dont l'horaire est venu, un travail à la fois
  par projet ; se relance seul quand le code des agents change.
- `node.js` : programme d'un ordinateur connecté.
- `lib/` : agents (types, consignes, patron, fil des agents), garde-fous git, conversations, comptes, appareils,
  connexions, clés d'API, notifications.
- `docs/API.md` : l'API pour relier d'autres projets au panel, dans les deux sens.
- `test/` : tests (`node --test`), dans des dossiers jetables.

Les agents d'un projet sont rangés dans le projet lui-même (`agents-ia/`, ignoré par git) : supprimer ce dossier retire
tous ses agents sans toucher au code.

## Licence

[MIT](LICENSE) : tu peux utiliser ce code, le copier, le modifier, le redistribuer et le vendre, à condition de garder la
mention de licence.

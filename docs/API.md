# API d'agent.rvkxse.com

Deux sens, pour relier un autre projet (bot, site, scanner…) au panel des agents :

1. **Ton projet → le panel** : avec une **clé d'API**, il envoie des notifications, lance un agent, parle à l'agent patron, lit l'état des agents.
2. **Les agents → ton projet** : avec une **connexion** déclarée dans le panel, les agents et le patron appellent l'API de ton projet (outil `appeler_api`).

Tout se règle dans le panel : **API & connexions** (barre latérale).

---

## 1. Ton projet → le panel (clés d'API)

### Authentification

- Crée une clé : panel → API & connexions → **Nouvelle clé**. Tu choisis ses droits et ses projets (aucun coché = tous les tiens) ; ton mot de passe est demandé.
- La clé (`agk_…`) n'est **montrée qu'une fois** : range-la dans les secrets du projet (variable d'environnement, coffre). Perdue = en créer une autre et retirer l'ancienne.
- Chaque requête : `Authorization: Bearer agk_…`, en HTTPS, corps en JSON (`Content-Type: application/json`).
- Une clé n'agit que sur les projets de son propriétaire. Compte bloqué ou clé retirée : `401` immédiatement.

| Droit | Permet |
|---|---|
| `lire` | projets, agents, passages, notifications, conversations avec le patron |
| `notifier` | envoyer une notification (dans le panel et sur le téléphone du propriétaire) |
| `lancer` | lancer un agent |
| `patron` | écrire à l'agent patron : il peut modifier le code et écrire aux utilisateurs, à donner avec prudence |

Adresse de base : `https://agent.rvkxse.com/api/v1`

### Routes

| Méthode | Chemin | Droit | Rôle |
|---|---|---|---|
| GET | `/api/v1` | — | vérifier la clé : `{ version, user, key: { name, scopes, projects } }` |
| GET | `/api/v1/projects` | lire | `{ projects: [{ id, name, description, device, agents, lastRunAt }] }` |
| GET | `/api/v1/projects/{projet}` | lire | `{ project, agents: [{ id, name, kind, enabled, schedule, next, last: { at, status, summary } }] }` |
| GET | `/api/v1/projects/{projet}/runs?since=ISO&agent=id&limit=50` | lire | passages, les plus récents d'abord (`limit` ≤ 500) |
| GET | `/api/v1/projects/{projet}/notifications?since=ISO` | lire | `{ notifications: [{ at, text, source }] }` |
| POST | `/api/v1/projects/{projet}/notifications` | notifier | `{ "title": "…", "text": "…", "level": "info" \| "attention" \| "urgent" }` |
| POST | `/api/v1/projects/{projet}/agents/{agent}/run` | lancer | `{}` (agent d'enquête : `{ "question": "…" }`) → `{ queued: true }` |
| POST | `/api/v1/projects/{projet}/boss` | patron | `{ "text": "…", "conversation": "c-…" (facultatif) }` → `{ conversation, pending: true }` |
| GET | `/api/v1/projects/{projet}/boss` | lire | conversations avec le patron |
| GET | `/api/v1/projects/{projet}/boss/{conversation}` | lire | `{ pending, messages: [{ role: "user" \| "boss", at, text, actions, error }] }` |

- **Notification** : `level` donne l'icône (🔌 info, ⚠️ attention, 🚨 urgent) ; `title` devient le titre de la notification sur le téléphone (par défaut, le nom de la clé).
- **Lancer un agent** : la demande part au runner (sous une minute) ; suis le résultat avec `/runs?agent=…&since=…`.
- **Patron** : la réponse s'écrit en arrière-plan ; interroge `/boss/{conversation}` jusqu'à `pending: false`. Une réponse à la fois par projet (`409` sinon). Projet sur un autre appareil : le patron répond sur cet appareil, qui doit être allumé (réponse perdue après 15 min sans nouvelles).

### Erreurs et limites

Réponse d'erreur : `{ "error": "message lisible" }` avec `401` (clé absente, fausse ou retirée), `403` (droit manquant), `404` (projet ou agent inconnu, ou hors des projets de la clé), `409` (patron occupé), `415` (pas du JSON), `429` (trop de requêtes).

Limites par clé : 120 requêtes par minute ; 30 notifications par minute ; 10 messages au patron par minute.

### Exemples

```bash
curl -X POST "https://agent.rvkxse.com/api/v1/projects/mon-projet/notifications" \
  -H "Authorization: Bearer $AGENTS_API_KEY" -H "Content-Type: application/json" \
  -d '{"title":"Nouvelle CVE critique","text":"OpenSSL 3.0.x : 4 serveurs concernés","level":"urgent"}'
```

```python
import os, requests
API = "https://agent.rvkxse.com/api/v1"
H = {"Authorization": "Bearer " + os.environ["AGENTS_API_KEY"]}
requests.post(f"{API}/projects/mon-projet/notifications", headers=H, timeout=15,
              json={"title": "Point du matin", "text": "3 CVE critiques, 2 correctifs en attente", "level": "attention"}).raise_for_status()
```

```js
await fetch("https://agent.rvkxse.com/api/v1/projects/mon-projet/agents/scout/run", {
  method: "POST", headers: { Authorization: "Bearer " + process.env.AGENTS_API_KEY, "Content-Type": "application/json" }, body: "{}",
});
```

---

## 2. Les agents → ton projet (connexions)

Dans le panel : API & connexions → **Connexions des agents** → choisis le projet → **Ajouter une connexion** :

| Champ | Exemple | Rôle |
|---|---|---|
| Nom | `scanner-cve` | nom donné à l'outil |
| À quoi elle sert | `Scanner de vulnérabilités : serveurs, CVE, correctifs` | lu par les agents pour savoir quand l'utiliser |
| Adresse de l'API | `https://scanner.exemple.fr` ou `http://127.0.0.1:8000` | origine de l'API |
| Chemins permis (début) | `/api/v1/agent/` | tout autre chemin est refusé |
| En-tête / valeur | `Authorization` / `Bearer …` | ajouté à chaque appel |
| Écriture | décoché | lecture seule (GET) ; cocher autorise aussi POST |

Ce qui se passe :

- Les agents et le patron du projet reçoivent l'outil **`appeler_api`** (`service`, `chemin`, `methode`, `corps`), fourni par un petit serveur MCP du panel lancé avec Claude Code.
- **La valeur de l'en-tête (jeton) n'est jamais montrée à l'IA** : le serveur MCP l'ajoute lui-même, et la masque si l'API la renvoie.
- Refusé : autre site, chemin hors du préfixe ou avec `..`, méthode non permise, redirection. Délai 30 s ; réponse coupée à 60 000 caractères.
- Le jeton est gardé hors du dépôt du panel et n'est jamais renvoyé au navigateur (seulement ses 4 derniers caractères).

### Où tournent les agents (donc d'où partent les appels)

- **Projet connecté depuis son ordinateur** (panel → Ajouter un projet → Ordinateurs connectés) : les agents tournent **sur cet ordinateur**. Une API locale (`http://127.0.0.1:…`) y est joignable telle quelle : **rien à exposer sur Internet**. La connexion (avec son jeton) est envoyée à cet ordinateur.
- **Projet sur le serveur du panel** : l'API doit être joignable depuis ce serveur (HTTPS public, par exemple un tunnel Cloudflare limité au seul préfixe des agents).

### Ce que ton API devrait exposer pour les agents

- Un préfixe dédié en **lecture seule** (ex. `/api/v1/agent/…`) et un **jeton dédié aux agents**, révocable, distinct des autres jetons de ton projet.
- Des réponses JSON compactes, paginées (`?limit=`), sans secret.
- **Seulement les données nécessaires** : ce que les agents lisent est traité par Claude (Anthropic). Par défaut, éviter noms d'hôtes, adresses IP et noms de clients si l'analyse n'en a pas besoin.

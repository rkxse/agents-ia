# Test de charge du panel (k6)

`scripts/panel-charge.js` simule beaucoup de clients en même temps, par les vraies routes du panel :

- **navigation** : des utilisateurs connectés qui ouvrent le menu, l'accueil, la sécurité, leur projet, sa chronologie et
  sa carte, puis lisent 3 à 5 s (comme une page qui se rafraîchit) ;
- **appareils** : des ordinateurs connectés qui se synchronisent toutes les 5 s (rythme du vrai `node.js`) ;
- **connexions** : 3 connexions par mot de passe par seconde.

Les comptes et les ordinateurs sont créés au début (inscription, code de connexion, enregistrement de l'appareil).

## Jamais sur le panel en ligne

Le test écrit des milliers de comptes et de projets : il se lance sur une **copie isolée** du panel (autre port, dossiers
de données jetables), jamais sur `agent.rvkxse.com`. Le serveur fait aussi tourner GOLD PILOT : les tests lourds de
préférence quand l'or est fermé.

```powershell
# 1. Copie isolée du panel sur le port 3099 (dossiers jetables, pas de notifications)
$iso = "$env:TEMP\panel-isole"; New-Item -ItemType Directory -Force "$iso\data", "$iso\projects" | Out-Null
$env:AGENTS_RUNTIME = "$iso\data"; $env:AGENTS_PROJECTS = "$iso\projects"; $env:PORT = "3099"; $env:AGENTS_NO_PUSH = "1"
$p = Start-Process node server.js -WindowStyle Hidden -PassThru
Remove-Item Env:AGENTS_RUNTIME, Env:AGENTS_PROJECTS, Env:PORT, Env:AGENTS_NO_PUSH

# 2. Le test (200 clients et 100 ordinateurs par défaut ; USERS, DEVICES, BASE_URL réglables)
k6 run k6/scripts/panel-charge.js
k6 run -e USERS=1000 -e DEVICES=500 k6/scripts/panel-charge.js

# 3. Ménage
Stop-Process -Id $p.Id; Remove-Item -Recurse -Force $iso
```

Seuils : moins de 1 % d'échecs, pages sous 500 à 800 ms et connexion sous 1,5 s pour 95 % des requêtes.

## Résultats (01-02/11/2026, serveur 6 cœurs partagé avec k6 et GOLD PILOT)

| Charge | Avant les corrections | Après |
|---|---|---|
| 200 clients + 100 ordinateurs | 87 % d'échecs, pages en 4 s | 0 % d'échecs, pages en 20 ms |
| 1000 clients + 500 ordinateurs | 67 % d'échecs | 0 % d'échecs (146 782 requêtes), pages sous 100 ms |
| 2000 clients + 1000 ordinateurs | — | limite atteinte : 26 % de connexions refusées, ~640 requêtes/s |

Points faibles corrigés : mot de passe calculé sans bloquer le panel (scrypt asynchrone) ; fichiers gardés en mémoire
tant qu'ils ne changent pas (`lib/store.js`) ; état des ordinateurs en mémoire au lieu de réécrire `nodes.json` à chaque
synchronisation ; journaux git gardés 20 s ; seuls les projets et ordinateurs utiles copiés ; connexions HTTP gardées
65 s ; sessions limitées à 20 par compte.

Au-delà d'environ 1000 clients actifs en même temps, il faudrait répartir le panel sur plusieurs process (l'état en mémoire
— limites d'essais, tickets de double authentification, état des ordinateurs — devrait alors être partagé).

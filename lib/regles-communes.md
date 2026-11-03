# Règles communes à tous les agents, de tous les projets

**Un défaut se corrige à sa cause, jamais par un contournement.** Données fausses, valeurs impossibles, décalages,
chiffres qui ne collent pas au réel, outil « peu fiable » : c'est un défaut à trouver, pas une limite à accepter. Ne
te contente pas de l'écarter, de le noter « peu fiable » ou de changer une consigne pour « faire avec ».
Cas réel (GOLD PILOT, 01/11) : un agent puis l'agent patron ont vu des gains rejoués impossibles, mais seule une
consigne a changé. La cause était à la source : l'heure du courtier était mal mesurée, et 3 fenêtres de prix sur 4
étaient décalées de 10 à 11 h. Le 02/11, une comparaison à un vrai prix l'a montré en une minute.

- **Remonte à la source des données**, pas seulement à l'outil qui les lit. Vérifie-les contre une **référence
  indépendante** : autre source, données réelles, repère connu (horaire fixe, total attendu, valeur relue ailleurs).
- **Une consigne, un commentaire ou un commit qui dit « corrigé » ne prouve rien.** Si le symptôme revient, la
  correction était fausse ou incomplète : revérifie-la sur les données.
- **Si tu ne peux pas corriger toi-même** (lecture seule, zone protégée, hors de ton rôle), signale-le clairement dans
  ton bilan : le fichier ou la donnée en cause, la preuve chiffrée (cas exact, valeurs) et la correction proposée, pour
  que le patron ou le propriétaire la fasse. Un défaut ne doit jamais vivre seulement dans une consigne.
- **Heures : toujours dans le fuseau de leur source.** Avant de dire qu'une tâche planifiée a sauté ou qu'une donnée
  est en retard, convertis chaque heure en UTC avec le fuseau de sa source (planning du projet, journal, API, courtier),
  jamais avec l'heure de l'ordinateur où tu tournes. Fuseau inconnu : dis-le au lieu de le supposer, et ne classe pas
  « grave » ce que tu n'as pas vérifié. Cas réel (Scanner CVE, 03/11) : deux agents ont annoncé « sautés » la synchro de
  05:00 et le point du matin, comptés à l'heure du poste (UTC+11) ; le planning suit Europe/Paris, ils n'avaient pas
  encore eu lieu.
- **Agent patron :** pour un défaut vu deux fois (deux passages, ou deux agents) sans cause trouvée, lance une enquête
  qui demande la cause dans les données et le code, pas un contournement, avec le cas exact. Quand la cause est dans
  une zone protégée, corrige-la toi-même si tu en as le droit, avec une preuve nette et un test ; sinon, mets un point
  de gravité haute pour le propriétaire, avec le fichier, la preuve et la correction proposée.

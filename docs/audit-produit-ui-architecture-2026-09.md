# Audit produit, UI et architecture — 16 septembre 2026

## Verdict

Hivekeep a une vraie proposition de valeur et une base visuelle déjà plus aboutie que beaucoup de projets auto-hébergés. Les Agents persistants, les Mini Apps, les outils rendus dans la conversation et l'observabilité des coûts forment un ensemble différenciant.

Le principal problème n'est pas le manque de fonctionnalités. Le produit expose trop directement sa structure technique. L'utilisateur rencontre des Agents, tâches, tâches planifiées, files, toolboxes, MCP, domaines d'outils, registres de modèles, fournisseurs, compactage, Scout, webhooks et déclencheurs comme autant de concepts de premier rang. Cette richesse réduit la lisibilité de la promesse centrale.

La priorité devrait être double : corriger quelques risques de sécurité et de persistance, puis ramener l'interface à cinq objets compréhensibles : **Agent**, **conversation privée**, **exécution**, **automatisation** et **production**.

## Méthode

L'étude couvre :

- le premier démarrage complet sur une base vierge ;
- les écrans authentifiés sur une base de démonstration ;
- les rendus desktop 1440 × 1000 et mobile 390 × 844 dans Chromium ;
- la navigation, les réglages, les états vides et les composants principaux ;
- les services serveur, la file, les plugins, la sécurité, la configuration et les tests ;
- la cohérence entre le README, la documentation, les textes UI et le comportement réel.

Les vérifications automatiques donnent :

- `bun run typecheck` : succès ;
- `bun run build` : succès, avec de nombreux avertissements de chunks supérieurs à 500 Ko ;
- suite globale : 3 909 tests réussis, 84 ignorés ;
- test de file globale lancé seul : échec avant l'exécution des tests ;
- bundle client produit : environ 45 Mo, avec des chunks minifiés jusqu'à 6,76 Mo.

## Ce qui fonctionne bien

- Le système visuel est cohérent : tokens de couleurs, modes clair/sombre, palettes, surfaces et composants ont une même signature.
- Les écrans vides sont présents et les actions principales sont généralement identifiables.
- La conversation, les outils, les tâches et les Mini Apps forment un socle produit original.
- TypeScript est strict et les services serveur disposent de nombreux tests ciblés.
- SQLite est configuré avec WAL, clés étrangères et délai d'attente ; les migrations contrôlent aussi leur intégrité.
- Le processus et l'image Docker tournent sans privilèges.
- Les routes sont chargées à la demande et les erreurs de chargement disposent d'un mécanisme de reprise.

Ces qualités méritent d'être conservées. La refonte proposée porte surtout sur la hiérarchie, les contrats et la réduction du nombre de choix visibles.

## P0 — Risques à corriger avant une refonte visuelle

### 1. Le nettoyage des secrets au démarrage est lancé trop tard

Le commentaire promet un balayage des messages `reveal_secret` avant le worker, mais l'import dynamique n'est pas attendu. `startQueueWorker()` est appelé immédiatement après :

- [main.ts](../src/server/main.ts#L135) ;
- [secret-redaction.ts](../src/server/services/secret-redaction.ts#L93) ;
- [agent-engine.ts](../src/server/services/agent-engine.ts#L3538).

Après un crash au mauvais moment, le worker peut donc reprendre un message contenant un secret brut avant que le balayage l'ait supprimé.

**Action :** importer et attendre `sweepRevealedSecrets()` avant tout démarrage de worker. Échouer de façon sûre si le balayage ne peut pas s'exécuter. Ajouter un test avec un balayage volontairement ralenti.

### 2. La file persistante ne persiste pas tout le message

Les identifiants de fichiers et les métadonnées de canal vivent dans des `Map` en mémoire, alors que seul l'item principal est stocké en base :

- [queue.ts](../src/server/services/queue.ts#L11) ;
- [queue.ts](../src/server/services/queue.ts#L73) ;
- [schema.ts](../src/server/db/schema.ts#L706).

Après un redémarrage entre l'enqueue et le traitement, le texte repart mais les pièces jointes et le contexte de canal sont perdus. Le système qualifie pourtant cette file de persistante.

**Action :** stocker les métadonnées en JSON et les associations de fichiers dans la même transaction que l'item de file. Le token de réconciliation purement UI peut rester en mémoire. Tester un redémarrage réel entre enqueue et dequeue.

### 3. Le modèle de sécurité des plugins promet plus qu'il ne garantit

L'installation lance `npm install` avant de valider le manifeste, donc les scripts de cycle de vie du paquet peuvent déjà s'exécuter. Le plugin est ensuite importé dans le processus principal. Seules les requêtes faites avec `ctx.http.fetch` sont filtrées ; un `globalThis.fetch`, le système de fichiers, l'environnement et les dépendances du processus restent accessibles :

- [plugins.ts](../src/server/services/plugins.ts#L923) ;
- [plugins.ts](../src/server/services/plugins.ts#L1938) ;
- [plugin-manifest.schema.json](../packages/sdk/schemas/plugin-manifest.schema.json#L63) ;
- [plugins/api.md](../docs-site/src/content/docs/plugins/api.md#L86).

L'interface permet pourtant une installation en un clic et la documentation parle de sécurité par défaut et de permissions granulaires.

**Action immédiate :** présenter les plugins comme du code de confiance, afficher source/version/intégrité avant installation et utiliser `--ignore-scripts` si le modèle de plugin le permet. **Action structurelle :** exécuter chaque plugin dans un worker ou processus isolé et faire passer fichiers, HTTP, coffre et Agents par un broker de capacités.

### 4. La suite globale donne une confiance excessive

Des `mock.module()` Bun fuient entre fichiers. Plusieurs groupes détectent alors que le schéma n'est plus réel et se mettent en `skip`. La suite globale reste verte avec 84 tests ignorés. Le test de file globale, lancé seul, échoue à cause d'un mock incomplet :

- [migrations.test.ts](../src/server/db/migrations.test.ts#L63) ;
- [tasks-global-queue.test.ts](../src/server/services/tasks-global-queue.test.ts#L35).

Les zones sautées couvrent notamment les cascades, les secrets, les toolboxes, le registre de modèles et la file globale.

**Action :** isoler les groupes qui utilisent des mocks de module dans des processus distincts, préférer l'injection de dépendances et faire échouer la CI sur tout `skip` absent d'une allowlist explicite.

### 5. Le premier démarrage empile trois parcours contradictoires

Un nouvel administrateur rencontre :

1. un wizard de trois étapes, incluant 18 palettes et la connexion obligatoire d'un fournisseur ;
2. une modal Queenie spéciale ;
3. une checklist de sept éléments.

Le commentaire du wizard décrit pourtant un parcours minimal de deux étapes et affirme que les fournisseurs ont été déplacés après l'arrivée dans l'application :

- [OnboardingPage.tsx](../src/client/pages/onboarding/OnboardingPage.tsx#L9) ;
- [StepPreferences.tsx](../src/client/pages/onboarding/StepPreferences.tsx#L68) ;
- [StepBootstrapProvider.tsx](../src/client/pages/onboarding/StepBootstrapProvider.tsx#L9) ;
- [ChatPage.tsx](../src/client/pages/chat/ChatPage.tsx#L83).

La checklist considère aussi le premier Agent créé dès que `agents.length > 0`, ce qui inclut Queenie, alors que la page de chat l'exclut explicitement. Ses quatre capacités optionnelles sont comptées comme « pending » et produisent ainsi un badge global « 4 » sur une installation déjà utilisable :

- [useSetupChecklist.ts](../src/client/hooks/useSetupChecklist.ts#L118) ;
- [ChatPage.tsx](../src/client/pages/chat/ChatPage.tsx#L135).

**Parcours proposé :** compte → fournisseur LLM → conversation normale avec Queenie → création guidée du premier Agent. La langue vient du navigateur ; l'apparence attend les réglages. Les capacités optionnelles apparaissent ensuite quand elles deviennent utiles.

### 6. Le tiroir Agents reste ouvert après sélection sur mobile

Le bug a été reproduit à 390 px : l'utilisateur ouvre le tiroir, touche un Agent, la route change mais le tiroir continue de couvrir la conversation. `AgentList` appelle seulement `onSelectAgent` et ne ferme pas `openMobile` :

- [AgentList.tsx](../src/client/components/sidebar/AgentList.tsx#L183) ;
- [sidebar.tsx](../src/client/components/ui/sidebar.tsx#L193).

**Action :** fermer le tiroir dans l'action de sélection et couvrir le parcours par un test Playwright mobile.

### 7. Une erreur locale remplace toute l'application

L'unique `ErrorBoundary` enveloppe toute l'application et remplace le shell complet par un écran de rechargement qui affiche le message JavaScript brut :

- [main.tsx](../src/client/main.tsx#L19) ;
- [ErrorBoundary.tsx](../src/client/components/common/ErrorBoundary.tsx#L24).

Le problème est déjà visible publiquement : [la capture Tasks du site](../site/public/screenshots/tour/tasks.webp) montre « Cannot read properties of undefined (reading 'icon') ». Elle est encore utilisée dans [la page Tour](../site/src/components/pages/TourPage.astro#L65) et comme visuel de [la page d'accueil](../site/src/components/pages/Home.astro#L565).

**Action :** remplacer immédiatement l'asset public, corriger sa cause et ajouter des boundaries par route et panneau. Le shell doit rester utilisable ; le diagnostic technique peut être copié ou développé, sans être le message principal.

## P1 — Refaire l'architecture de l'information

### Navigation actuelle

La barre principale met au même niveau Agents, Tasks, Scheduled Tasks, Files, Mini Apps, Models et Terminal. Models et Terminal sont des outils d'administration avancés. La barre supérieure ajoute l'état SSE, la file, la checklist, la palette, le thème, les notifications et le compte.

Sur mobile, cet ensemble devient une ligne de huit petits signaux et icônes. La hiérarchie est visuellement régulière, mais aucune action ne domine. L'utilisateur doit connaître la signification de nombreux pictogrammes.

Les réglages ajoutent 24 sections en cinq groupes dans une modal de 720 px :

- [ActivityBar.tsx](../src/client/components/layout/ActivityBar.tsx#L23) ;
- [AppTopBar.tsx](../src/client/components/layout/AppTopBar.tsx#L57) ;
- [SettingsPage.tsx](../src/client/pages/settings/SettingsPage.tsx#L92).

Plusieurs regroupements suivent les modules du code plutôt que le besoin : Vault, Memories et Files sont sous « Extensions », Contacts sous « Connections », Plugins et Marketplace sont séparés, Models et Model Registry aussi.

### Nouvelle navigation proposée

#### Niveau principal

1. **Accueil** — ce qui demande de l'attention ;
2. **Agents** — conversations et création ;
3. **Productions** — Apps et fichiers utiles ;
4. **Automatisations** — planifications, déclencheurs et historique ;
5. **Centre de contrôle** — administration.

Sur mobile, les quatre premières destinations peuvent devenir une barre basse. Le Centre de contrôle reste dans le menu du compte. L'en-tête garde le contexte courant, une recherche et les notifications.

#### Centre de contrôle

- **IA** : fournisseurs, modèles par défaut, registre avancé ;
- **Connexions** : canaux, mail, calendrier et contacts ;
- **Extensions** : plugins installés/marketplace, MCP, capacités personnalisées ;
- **Données et sécurité** : coffre, liens partagés, mémoire, sauvegardes ;
- **Système** : utilisateurs, notifications, journaux, coûts et mises à jour.

Terminal, registre de modèles, dossiers hôte, MCP et domaines d'outils passent sous un mode avancé. Le Centre de contrôle devrait être une vraie route plein écran, avec URLs partageables et historique navigateur, plutôt qu'une immense modal.

### Unifier activité, tâches et automatisations

Les tâches, crons, webhooks, déclencheurs mail, approbations et file d'exécution sont aujourd'hui dispersés. Le modèle utilisateur peut se limiter à :

- **discuter maintenant** ;
- **exécuter en arrière-plan** ;
- **planifier ou déclencher**.

Renommer Tasks en **Exécutions** ou **Activité**. Regrouper crons, déclencheurs mail, webhooks et approbations dans **Automatisations**. Garder Scout, sous-Agents, slots de concurrence et politiques de queue dans les détails avancés.

### Créer un vrai écran « À traiter »

L'attention est fragmentée entre badges, file, notifications et toasts. L'accueil devrait agréger :

- messages d'Agents non lus ;
- exécutions terminées ;
- demandes d'intervention humaine ;
- automatisations à approuver ;
- fournisseurs ou canaux en erreur ;
- événements récents importants.

La file et l'état SSE n'ont pas besoin d'être des contrôles toujours visibles. Ils peuvent apparaître seulement en cas d'activité ou de problème.

## P1 — Recentrer les parcours principaux

### Conversation

L'écran de chat est visuellement propre, mais l'en-tête expose en permanence modèle, estimation de tokens, seuil de compactage, résumés et plusieurs icônes techniques. Sur mobile, un second en-tête s'ajoute à la barre globale.

Proposition :

- nom, rôle, état et nature **partagée/privée** restent visibles ;
- recherche, tâche, session privée et réglages Agent vont dans un menu cohérent ;
- modèle, tokens, compactage et appels d'outils passent dans un panneau « Détails » ;
- le composeur garde pièce jointe, mode d'exécution et envoi ;
- les suggestions initiales dépendent du rôle de l'Agent au lieu de quatre phrases génériques.

La recherche actuelle ne couvre que les messages chargés : [ConversationSearch.tsx](../src/client/components/chat/ConversationSearch.tsx#L105). Une conversation censée durer des mois exige une recherche serveur sur conversations, mémoires, fichiers, Apps et exécutions.

Les badges de canaux d'un Agent appellent encore `navigate('/settings/channels')`, mais cette route n'existe pas et le wildcard renvoie vers la page de chat : [AgentList.tsx](../src/client/components/sidebar/AgentList.tsx#L66), [App.tsx](../src/client/App.tsx#L218). Utiliser l'action globale d'ouverture des réglages ou, avec le Centre de contrôle proposé, une vraie route.

### Partagé, privé et destructif

Le README promet une conversation sans remise à zéro et des originaux jamais supprimés. Le produit propose en parallèle une conversation principale partagée, des Quick Sessions privées et une suppression réelle de l'historique :

- [README.md](../README.md#L42) ;
- [multi-user.md](../docs-site/src/content/docs/features/multi-user.md#L42) ;
- [messages.ts](../src/server/routes/messages.ts#L470).

Afficher un contrat clair :

- **Conversation partagée** : durable, visible du foyer ;
- **Conversation privée temporaire** : personnelle, avec rétention annoncée ;
- **Exécution** : travail asynchrone avec journal et résultat.

Renommer Quick Session. À sa fermeture, générer un résumé prérempli que l'utilisateur peut corriger. Toute suppression doit détailler ce qui sera effacé, ce qui restera en mémoire et proposer un export ou une archive.

### Création d'un Agent

[AgentFormModal.tsx](../src/client/components/agent/AgentFormModal.tsx#L131) fait 1 639 lignes et expose cinq onglets. Les modèles Scout, fournisseurs, raisonnement, compactage et héritage arrivent trop tôt.

Flux recommandé :

1. décrire l'Agent en une phrase ou choisir un modèle ;
2. générer identité, rôle, personnalité, expertise et avatar ;
3. confirmer le modèle principal et un pack de capacités ;
4. créer.

Édition normale : **Identité**, **Capacités**, **Mémoire**. Édition avancée : runtime, Scout, raisonnement et compactage. « Toolboxes » devient « Capacités » ou « Packs de capacités ». Les politiques doivent être explicites : **Toutes**, **Sélectionnées** ou **Minimales**.

### États vides

Les écrans Tasks, Mini Apps et Files sont propres mais passifs. « Ask an Agent to create one » n'est pas une action.

- Mini Apps : bouton **Construire une app**, choix de l'Agent, demande préremplie ;
- Exécutions : modèles « rechercher », « analyser », « produire », ou départ depuis un Agent ;
- Files : expliquer les sources disponibles et proposer d'ouvrir le workspace d'un Agent ;
- Automatisations : modèles quotidiens, hebdomadaires et événementiels.

## P1 — Cohérence et confiance

### Queenie utilise une base statique déjà périmée

La totalité de `queenie-knowledge.md` est injectée dans son prompt. Le document annonce notamment DeepSeek comme non intégré et présente une liste de fournisseurs incomplète, alors que le produit les prend en charge :

- [prompt-builder.ts](../src/server/services/prompt-builder.ts#L9) ;
- [queenie-knowledge.md](../src/server/assets/queenie-knowledge.md#L57) ;
- [queenie-knowledge.md](../src/server/assets/queenie-knowledge.md#L131) ;
- [README.md](../README.md#L146).

Les fournisseurs, capacités, modèles et outils doivent être générés au runtime depuis les registres. Le document statique ne devrait contenir que les principes de dialogue.

### La documentation et le produit divergent

Exemples :

- le Hub est retiré du code mais reste documenté ;
- le README décrit un reranking mémoire que la documentation Memory v2 dit supprimé ;
- la documentation affirme que la mémoire ne fonctionne pas sans embeddings, alors que le serveur garde FTS ;
- la palette de commandes ouvre une section Settings `search` inexistante et ignore environ la moitié des sections actuelles : [CommandPalette.tsx](../src/client/components/common/CommandPalette.tsx#L38).

Créer un inventaire canonique des objets produit, avec nom, visibilité, propriétaire et cycle de vie. Générer ou valider à partir de cet inventaire la navigation, la checklist, le contexte Queenie et les tableaux de documentation.

## P2 — Solidifier l'architecture

### Les plugins ne sont pas persistants dans Docker

Le gestionnaire écrit dans `<cwd>/plugins`. L'image ne crée avec les bons droits que `/app/data` et Compose ne persiste que ce répertoire. L'installation risque donc `EACCES`, puis disparaît à la recréation du conteneur :

- [plugins.ts](../src/server/services/plugins.ts#L701) ;
- [Dockerfile](../docker/Dockerfile#L72) ;
- [docker-compose.yml](../docker/docker-compose.yml#L19).

Déplacer les plugins vers `${config.dataDir}/plugins`, avec migration de l'ancien chemin et test conteneur install → restart → recreate.

### Les limites de tâches ne sont pas atomiques

`spawnTask()` compte les slots et la file, attend plusieurs opérations, puis insère. Deux appels concurrents peuvent tous deux voir la même place disponible : [tasks.ts](../src/server/services/tasks.ts#L781).

Sérialiser le scheduler ou utiliser une transaction SQLite `BEGIN IMMEDIATE` couvrant le compte et la réservation. Tester les spawns et promotions concurrents avec `Promise.all`.

### Le processus continue après une exception non interceptée

[main.ts](../src/server/main.ts#L44) garde volontairement le processus vivant après `uncaughtException`, tout en reconnaissant que l'état peut être incohérent. L'arrêt ne stoppe pas le worker, les schedulers, les canaux et la base avant `process.exit` : [main.ts](../src/server/main.ts#L313).

Après isolation des plugins, préférer un drain borné puis laisser systemd ou Docker relancer le service. Conserver le handle Bun, arrêter les nouvelles requêtes, les workers, les adaptateurs et la base dans cet ordre.

### La configuration numérique n'est pas validée

De nombreuses variables passent directement dans `Number()`. Le corps HTTP est presque illimité par défaut : [config.ts](../src/server/config.ts#L165), [main.ts](../src/server/main.ts#L302).

Valider l'environnement avec Zod, bornes comprises, et échouer au démarrage sur une valeur invalide. Fixer un plafond global fini et des plafonds propres aux routes d'upload.

### Quelques modules ont un rayon de changement trop large

Les fichiers les plus critiques cumulent orchestration, persistance et effets de bord :

- `agent-engine.ts` : 3 574 lignes ;
- `tasks.ts` : 3 209 lignes ;
- `plugins.ts` : 2 474 lignes ;
- `channels.ts` : 2 135 lignes ;
- `ChatPanel.tsx` : 1 430 lignes ;
- `AgentFormModal.tsx` : 1 639 lignes.

Découpage conseillé :

- queue repository durable / turn runner / event publisher ;
- scheduler de tâches / machine d'état / executor / queries ;
- installer de plugins / discovery / runtime / registry ;
- adaptateurs de canaux / delivery / mapping ;
- chat timeline / header / composer / panneaux de détails.

Le but n'est pas de réduire arbitrairement le nombre de lignes. Il est de rendre les transactions, redémarrages et tests isolables.

### Le client manque de garde-fous

Le build atteint environ 45 Mo. Des chunks minifiés pèsent 6,76, 5,21 et 4,98 Mo. Il n'existe ni budget de bundle, ni script de lint, ni scénario E2E. Sur 193 fichiers de test, 13 seulement concernent le client.

Ajouter :

- analyse de bundle et budget gzip en CI ;
- imports à la demande pour les langages CodeMirror, icônes et rendus spécialisés ;
- lint sans nouvelle suppression non justifiée ;
- scénarios Playwright pour onboarding, mobile, chat, admin/membre, plugin, tâche suspendue et panne fournisseur ;
- audit accessibilité et captures visuelles des écrans clés.

## Détails UI observés

- À 390 px, le premier écran d'onboarding mesure 419 px de large et crée un débordement horizontal.
- Le bouton d'avatar du premier démarrage n'a pas de nom accessible.
- Plusieurs boutons d'icône du chat, du composeur et du panneau d'outils n'ont pas de nom accessible ; le trigger du compte est annoncé par ses seules initiales. Les switches du registre de modèles n'ont pas de label associé.
- Sur la page Agent mobile, 21 contrôles visibles ont au moins une dimension inférieure à 44 px. À 320 px, le bouton d'état SSE se compresse jusqu'à environ 10 px.
- Des textes informatifs de 10 à 12 px sont rendus avec une opacité qui donne des contrastes mesurés autour de 2,47:1 à 3,08:1 en thème clair, sous le seuil de 4,5:1.
- Les contenus du panneau Tool Calls restent montés hors zone visible quand le panneau est fermé, ce qui pollue l'arbre accessible.
- L'étape fournisseur répète presque la même explication dans deux blocs.
- L'étape d'apparence occupe plus d'un écran desktop avant que l'utilisateur ait vu l'application.
- La modal Settings mobile comprime fortement le texte dès qu'une carte contient un bouton latéral.
- L'état vide Files mobile demande de choisir un fichier « dans l'arbre », alors que l'arbre est caché et qu'aucun CTA ne l'ouvre.
- L'état vide Scheduled Tasks répète « New job » ; Tasks et Mini Apps affichent encore filtres ou vues sans proposer d'action centrale utile.
- Les noms de modèles affichent brièvement l'identifiant brut ou « Select a model » pendant le chargement.
- La page d'accueil Agents ne sélectionne pas automatiquement l'unique Agent lors de la première visite ; elle affiche un écran vide demandant une sélection.
- La palette de commandes n'effectue aucune recherche dans les conversations ou productions malgré son apparence de recherche globale.
- Le document reste déclaré `<html lang="en">` après un passage de l'interface en français, car `changeAppLanguage()` ne synchronise pas l'attribut `lang` : [index.html](../src/client/index.html#L2), [i18n.ts](../src/client/lib/i18n.ts#L56).
- L'application charge ses polices depuis Google Fonts : [index.html](../src/client/index.html#L16). Cela ajoute une dépendance réseau et un appel du navigateur à Google, en tension avec la promesse auto-hébergée et l'usage hors ligne. Héberger les WOFF2 ou utiliser une pile système.

Le système de thèmes est lui-même devenu une petite plateforme : 18 palettes codées en dur, modes clair/sombre et variante « soft », pour un `globals.css` de plus de 4 600 lignes. Réduire à un système de couleurs et trois ou quatre accents. Déplacer l'apparence dans les préférences et remplacer « réduire le contraste » par un vrai mode de contraste renforcé.

## Cible de refonte

### Desktop

- Barre latérale : Accueil, Agents, Productions, Automatisations.
- En bas : Centre de contrôle et compte.
- En-tête : titre/contexte, recherche globale, attention.
- Vue Agent : liste d'Agents, conversation, panneau contextuel ouvert seulement à la demande.
- Centre de contrôle : route plein écran avec recherche, catégories et URLs stables.

### Mobile

- En-tête simple : contexte courant, recherche, compte.
- Barre basse : Accueil, Agents, Productions, Automatisations.
- Sélecteur d'Agent en feuille dédiée qui se ferme après choix.
- Conversation avec un seul en-tête compact et composeur stable.
- Réglages en plein écran, navigation par catégories, sans modal centrée.

### Modèle produit

1. **Agent** : identité durable et conversation partagée ;
2. **Conversation privée** : espace personnel temporaire ;
3. **Exécution** : travail asynchrone ;
4. **Automatisation** : règle qui lance des exécutions ;
5. **Production** : fichier ou app créé par un Agent.

Scout devient une stratégie d'exécution, le compactage une mécanique de mémoire, la toolbox une politique de capacités et le registre de modèles une fonction d'administration.

## Feuille de route proposée

### Lot 0 — Confiance et données, 1 à 2 semaines

- attendre le balayage de secrets avant le worker ;
- persister fichiers et métadonnées de la file ;
- corriger l'isolation des tests et interdire les skips silencieux ;
- rendre les plugins persistants en Docker et clarifier leur niveau de confiance ;
- rendre les réservations de tâches atomiques ;
- corriger le tiroir mobile et le débordement onboarding.

### Lot 1 — Premier démarrage et navigation, 2 à 4 semaines

- fusionner wizard, Queenie et checklist en un seul parcours ;
- réduire la navigation principale ;
- transformer Settings en Centre de contrôle plein écran ;
- regrouper Tasks, Crons et déclencheurs ;
- simplifier les barres desktop et mobile.

### Lot 2 — Parcours de valeur, 3 à 6 semaines

- simplifier la création d'un Agent ;
- créer l'accueil « À traiter » ;
- rendre les états vides actionnables ;
- ajouter une recherche globale serveur ;
- clarifier partagé, privé et suppression.

### Lot 3 — Industrialisation, en continu

- isoler les plugins ;
- découper les grands orchestrateurs ;
- ajouter sauvegarde et restauration dans le produit ;
- instaurer budgets bundle, lint, E2E, accessibilité et tests visuels ;
- générer la documentation de capacités depuis les registres réels.

## Mesure du succès

- premier échange utile avec Queenie en moins de trois minutes ;
- premier Agent créé sans ouvrir les réglages avancés ;
- aucun concept technique requis avant le premier résultat ;
- toutes les tâches en attente visibles au même endroit ;
- sélection d'un Agent en deux gestes maximum sur mobile ;
- zéro test critique ignoré en CI ;
- reprise après redémarrage sans perte de fichier ni métadonnée ;
- aucun chunk initial supérieur au budget fixé ;
- documentation, checklist et capacités runtime issues de la même source.

# Plan d'exécution — fiabilité et refonte Hivekeep

Date : 16 septembre 2026. Référence : [audit du projet](audit-produit-ui-architecture-2026-09.md). Base étudiée : `da74931e`.

État mis à jour le 16 septembre 2026 sur la branche `feat/hivekeep-refonte`. La première implémentation est présente dans l'arbre de travail ; elle n'est pas déployée sur une instance existante. Le [bilan de livraison](refonte-bilan-2026-09.md) distingue les résultats, les preuves et les limites.

Une case cochée désigne un changement implémenté et vérifié par lecture ou test ciblé. Les paragraphes **Validation cible** restent les critères initiaux : ils ne signifient pas que chaque variante a été testée. Les cases ouvertes signalent un travail partiel, différé ou une preuve encore manquante. Les résultats globaux figurent dans le bilan de livraison.

| Lot | État au 16 septembre | Reste principal |
| --- | --- | --- |
| 0 | Runner isolé, fixtures et parcours navigateur livrés | Matrice visuelle exhaustive à étendre ; outils et erreurs simulés vérifiés |
| 1 | Démarrage, queue, tâches et stockage des plugins corrigés ; confidentialité renforcée ; image Docker vérifiée | Capture publique Tasks remplacée et inspectée |
| 2 | Navigation desktop/mobile et réglages routés livrés directement dans l'application | Pas de maquette autonome ; audit visuel/accessibilité exhaustif à compléter |
| 3 | Onboarding, création/édition et conversations simplifiés | Parcours fournisseur réel et mesure des trois minutes non démontrés |
| 4 | Accueil, regroupements Automatisations/Productions et recherche conversationnelle livrés | Déroulé uniforme livré ; intégrations externes réelles à qualifier |
| 5 | Configuration, arrêt borné, sauvegarde/restauration et polices locales livrés | Budgets performance actifs ; lint progressif à poursuivre |

## Objectif et parti pris

Faire de Hivekeep une équipe d'assistants persistants facile à utiliser au quotidien, avec une administration lisible et une reprise fiable après incident.

Hypothèse produit : l'usage principal reste personnel ou en petit groupe, avec un administrateur technique et des membres qui peuvent l'être beaucoup moins. Les fonctions expertes restent accessibles par révélation progressive. Les fonctionnalités et préférences existantes sont conservées pendant la migration.

La refonte avance par parcours livrables. Les grands modules sont découpés quand un changement l'exige, avec des responsabilités testables. Chaque PR doit pouvoir être relue et validée indépendamment.

## Ordre des lots

| Lot | Résultat attendu | Dépendances | Livraison |
| --- | --- | --- | --- |
| 0. Référence de validation | Tests fiables et scénarios reproductibles | Aucune | Outillage de validation |
| 1. Fiabilité immédiate | Reprise des messages, secrets et tâches sécurisée ; bugs visibles corrigés | Lot 0 pour les tests concernés | Version de stabilisation |
| 2. Direction UI et navigation | Maquettes, nouveau cadre desktop/mobile, réglages adressables | Conception parallèle au lot 1 ; intégration après lot 0 | Nouveau cadre avec écrans existants |
| 3. Parcours Agent | Démarrage simple, création rapide, conversation lisible | Navigation du lot 2 | Première refonte utilisable |
| 4. Travail et productions | Accueil utile, automatisations regroupées, Apps et fichiers accessibles | Lots 2 et 3 | Refonte fonctionnelle complète |
| 5. Exploitation et performance | Sauvegarde restaurable, chargement mesuré, limites et arrêt maîtrisés | Peut avancer par sujets indépendants dès le lot 1 | Améliorations progressives |

La stabilisation ne dépend pas des maquettes. Les maquettes ne dépendent pas des migrations serveur. L'isolation forte des plugins et une recherche globale multi-contenus constituent ensuite des projets dédiés.

## Lot 0 — Une référence de validation fiable

### PR 0A — Rendre les tests interprétables

**État : livré.** Le runner lance chaque fichier dans un processus et un répertoire temporaire distincts, avec environnement minimal et clé synthétique. Un skip ou une suite sans test exécuté échoue. Bun est épinglé à `1.4.0`. La dernière passe complète annoncée compte 4 052 tests réussis, aucun échec et aucun skip, dans 208 fichiers. Toute nouvelle modification doit conserver ce résultat.

- [x] Corriger le mock incomplet de `tasks-global-queue.test.ts`.
- [x] Exécuter les groupes avec `mock.module()` dans des processus isolés ; conserver un parallélisme borné.
- [x] Remplacer les skips déclenchés par la contamination des mocks. Toute exception restante doit avoir une raison et un suivi explicites.
- [x] Aligner la version de Bun utilisée pour les vérifications locales, la CI et Docker.

**Validation cible :** les tests critiques queue, migrations, secrets et permissions s'exécutent seuls et dans le runner complet avec les mêmes résultats. Le nombre de tests exécutés et ignorés apparaît dans la CI.

### PR 0B — Créer des scénarios de démonstration déterministes

**État : livré en partie.** La fixture démarre un serveur jetable avec deux comptes, un fournisseur local simulé, historique long, tâches, planification, fichier et Mini App. Les suites navigateur couvrent navigation et confidentialité. Les réponses lentes et erreurs fournisseur sont simulées ; la simulation complète des appels d'outils et la matrice de captures français/anglais restent à compléter.

- [x] Préparer une base temporaire avec administrateur, membre, Agents, conversations, pièces jointes, tâches, automatisations et une Mini App.
- [x] Utiliser un fournisseur simulé pour streaming, erreurs, appels d'outils et réponses retardées. Les tests automatisés ne lisent pas les identifiants LLM du serveur de développement.
- [x] Ajouter quelques parcours Playwright : connexion, changement d'Agent mobile, envoi et retour pendant une réponse, accès admin/membre.
- [x] Capturer une référence desktop/mobile, clair/sombre, français/anglais ; ajouter les parcours au fil des lots.

**Validation cible :** scénario rejouable sur base vierge sans appel LLM payant et sans toucher à une instance existante.

**Fichiers de départ :** [CI](../.github/workflows/ci.yml), [scripts package](../package.json), [test de file globale](../src/server/services/tasks-global-queue.test.ts), [seed actuel](../scripts/seed-test-db.ts).

## Lot 1 — Fiabilité immédiate

### PR 1A — Ordonner le démarrage

**État : livré.** Le balayage attendu précède plugins et producteurs d'inférences. Deux tests démarrent le vrai serveur dans un sous-processus avec base temporaire : nettoyage avant disponibilité, puis échec du balayage entraînant une sortie non nulle sans travail de queue.

- [x] Attendre le balayage des secrets avant les workers et les promotions de tâches susceptibles de déclencher une inférence. En cas d'échec, exposer un diagnostic sans reprendre les inférences.

**Validation cible :** un balayage lent ou défaillant empêche toute inférence prématurée.

### PR 1B — Fiabiliser la file

**État : livré.** Migration additive `0119` ; enveloppe durable et reçu `created_message_id` commis avec le message entrant. Les tests redémarrent réellement des processus et vérifient le rollback du reçu. Les anciennes métadonnées déjà perdues ne sont pas récupérables et les effets externes ne sont pas garantis « exactement une fois ».

- [x] Ajouter une migration compatible pour les métadonnées et associations de fichiers des items de file.
- [x] Persister l'item complet dans une transaction avant de publier son état. Conserver les données nécessaires tant que le traitement n'est pas confirmé.
- [x] Distinguer un item repris avant création du message d'un item repris après création ; réutiliser l'identité du message déjà créé.

**Validation cible :** redémarrage réel avant prise en charge et après création du message ; texte, fichiers et contexte sont conservés, sans message utilisateur dupliqué.

### PR 1C — Réserver les slots de tâches de façon atomique

**État : livré.** Création, promotion et reprise réservent dans une transaction SQLite synchrone. Les tests concurrents couvrent les plafonds et le gagnant unique d'une promotion forcée. Cette dernière conserve son contournement explicite des limites.

- [x] Reproduire les appels concurrents de création et de promotion.
- [x] Centraliser compte et réservation dans une transaction courte ou un ordonnanceur sérialisé couvrant `spawnTask()` et `promoteGlobalQueue()`.
- [x] Préparer le contexte hors transaction, compter et réserver dans une section synchrone courte, puis publier les événements et lancer l'exécution après commit. Aucun appel réseau ou LLM sous verrou ; libérer proprement une réservation en cas d'échec ultérieur.

**Validation cible :** les scénarios concurrents respectent les plafonds globaux, par groupe et de file ; annuler, terminer ou suspendre une tâche libère le slot selon les règles actuelles.

### PR 1D — Rendre l'installation des plugins durable et explicite

**État : livré et vérifié dans l'image Docker finale.** Stockage sous `dataDir`, migration vérifiée sans suppression des sources, installation préparée sans scripts npm et activation avec restauration de la version précédente. Le smoke test de l'image du projet vérifie installation/migration puis chargement après recréation, avec UID `1001`, réseau désactivé et volume commun. Les plugins restent du code de confiance dans le processus serveur.

- [x] Tester l'installation avec l'UID réel du conteneur et après sa recréation.
- [x] Déplacer le stockage des plugins et le répertoire temporaire d'installation sous `config.dataDir`. Copier et vérifier l'ancien contenu, gérer les collisions sans écrasement et permettre une reprise après interruption ; conserver l'ancien emplacement pendant la transition.
- [x] Valider la version et le manifeste avant activation ; vérifier la faisabilité d'une installation sans scripts npm et traiter explicitement les plugins qui en dépendent.
- [x] Afficher la source, la version et le niveau réel d'accès du code installé. Corriger les promesses de sandbox non garanties.

**Validation cible :** plugin local de test installé, chargé puis toujours présent après recréation Docker ; échec d'installation sans activation partielle. Les plugins existants restent retrouvables pendant la migration.

### PR 1E — Réparer les défauts UX immédiats

**État : corrections principales livrées.** Navigation mobile, liens de canaux, noms accessibles, langue et boundaries sont modifiés. Les parcours passent sans débordement global de 320 à 1440 px ; cela ne prouve pas l'accessibilité de tous les contrôles. La capture publique Tasks a été remplacée par un écran fonctionnel puis inspectée. Les 24 réglages et formulaires visités ne présentent plus de bouton visible sans nom accessible.

- [x] Fermer le tiroir mobile après sélection et supprimer le débordement du premier démarrage.
- [x] Réparer le lien des badges de canaux ; ajouter des boundaries aux routes et panneaux critiques pour conserver la navigation après une erreur locale.
- [x] Ajouter les noms accessibles manquants, associer labels et switches, synchroniser `html.lang`.
- [x] Retirer les contrôles des panneaux fermés de la navigation clavier et de l'arbre accessible.
- [x] Remplacer la capture Tasks du site qui montre une erreur, après capture et inspection d'un écran fonctionnel. Vérifier séparément si sa cause existe encore sur la version courante.

**Validation cible :** parcours mobile automatisé, navigation clavier, erreur provoquée dans un panneau sans disparition du shell, visuels du site inspectés.

**Fichiers de départ :** [démarrage](../src/server/main.ts), [queue](../src/server/services/queue.ts), [schéma](../src/server/db/schema.ts), [tâches](../src/server/services/tasks.ts), [plugins](../src/server/services/plugins.ts), [navigation Agent](../src/client/components/sidebar/AgentList.tsx).

## Lot 2 — Direction UI et nouvelle navigation

### PR 2A — Fixer les écrans de référence

**État : prototype livré sous forme d'application de démonstration fonctionnelle.** Le cadre et les nouveaux écrans servent de référence navigable ; aucune maquette autonome n'a été produite. Des captures desktop/mobile et clair/sombre existent. Le contrôle automatique de débordement couvre 320, 390, 768 et 1440 px. Clavier mobile, contraste de toutes les palettes et matrice exhaustive des états restent ouverts.

- [x] Réaliser une maquette cliquable avec contenu réaliste autour de cinq parcours : retrouver un travail, converser, créer un Agent, automatiser et configurer. Couvrir aussi les sessions privées, les exécutions et les productions rencontrées dans ces parcours.
- [ ] Produire les variantes 1440 px et 390 px, puis vérifier 320 px, tablette, contenu long et clavier mobile.
- [x] Couvrir états vide, chargé, en cours, attente humaine, erreur et déconnexion.
- [x] Conserver la signature visuelle Hivekeep : accent coloré, Agents identifiables, surfaces plus lisibles et typographie hiérarchisée.
- [ ] Définir les tokens de contraste, les cibles tactiles principales d'au moins 44 px et les états focus/disabled/chargement. Vérifier le contraste des textes courants, le clavier, le français/anglais et les thèmes clair/sombre.

**Critère de passage :** les cinq parcours se comprennent sans ouvrir de réglages experts. Le prototype devient la référence pour la revue visuelle des PR suivantes.

Les 18 palettes existantes restent utilisables. Leur exposition passe dans les préférences ; une éventuelle réduction ultérieure doit disposer d'une correspondance de migration. Le premier chantier visuel améliore la lisibilité et l'organisation.

### PR 2B — Préparer la navigation et la continuité

**État : livré pour les parcours exercés.** Registre commun, aliases, sauvegarde des brouillons avec pièces jointes, état de session privée et réhydratation du flux sont présents. Les tests navigateur vérifient navigation immédiate, retour pendant streaming, reprise privée sans doublon et position de lecture au-delà des 50 derniers messages. Un fichier dont l'upload n'est pas terminé doit être rattaché après un rechargement complet.

- [x] Définir un registre typé : identifiant, route, libellé, icône, accès et catégorie.
- [ ] L'utiliser pour navigation desktop/mobile, palette de commandes, liens des écrans et checklist.
- [x] Prévoir une vraie page introuvable et des alias pour les anciennes URLs.
- [x] Avant tout démontage du chat, sauvegarder les brouillons même avant la fin du debounce et conserver les références de fichiers téléversés et l'état des envois en cours.
- [x] Préserver Agent, session privée, position de lecture et retour navigateur. Réutiliser le singleton SSE et la réhydratation de `useChat` ; prévoir la resynchronisation équivalente pour `useQuickChat`.

**Validation cible :** départ moins de 300 ms après une frappe, téléversement puis retour, navigation pendant streaming et reconnexion en session privée : aucune perte de saisie, double soumission ou réponse dupliquée.

### PR 2C — Livrer le nouveau cadre

**État : livré.** Quatre destinations principales avec libellés sur desktop et navigation basse mobile ; les réglages sont routés et les composants métier existants sont réutilisés. Les tests de continuité portent sur le chat partagé et privé.

- [x] Desktop : navigation principale avec libellés, liste d'Agents dans la vue Agents, en-tête limité au contexte, à la recherche et aux notifications.
- [x] Mobile : navigation basse Accueil / Agents / Productions / Automatisations et un seul en-tête de conversation.
- [x] Afficher la perte de connexion dans une bannière ; regrouper les attentes humaines sans badge pour les capacités facultatives.
- [x] Déplacer apparence, registre de modèles et terminal dans les surfaces adaptées.
- [x] Conserver d'abord les pages et la modale de réglages existantes dans ce cadre ; intégrer les nouveaux écrans progressivement.

**Validation cible :** quitter une conversation pendant une réponse puis revenir affiche la bonne réponse, sans duplication ; le texte saisi juste avant navigation est conservé ; les abonnements SSE ne se multiplient pas.

### PR 2D — Rendre les réglages adressables

**État : livré.** Registre des sections, routes, filtre Agent et destination de retour conservés. Les retours OAuth et anciennes URLs restent traités dans le code. Les tests navigateur vérifient plusieurs liens directs et les droits membre/admin ; les intégrations OAuth externes n'ont pas été réauthentifiées sur le serveur de développement.

- [x] Transformer les 24 sections en pages, en réutilisant d'abord leurs composants. Préserver les fonctions personnelles et administratives présentes dans la section Général.
- [x] Adapter les appels `onOpenSettings(section, filters)` aux routes ; conserver filtres, Agent concerné et retour à la conversation.
- [x] Préserver les retours OAuth avec `email_connected` / `email_error`, les invitations et les URLs de fichiers avec source, identifiant et paramètre `path`.

**Validation cible :** accès direct, refresh, précédent/suivant et liens profonds fonctionnels ; aucune entrée sans destination ; permissions vérifiées côté serveur. Les scénarios de continuité de la PR 2B restent valides.

### Correspondance des destinations

| Actuel | Cible | Accès et continuité |
| --- | --- | --- |
| `/` | Accueil ; liste des Agents sous `/agents` | Livraison progressive de l'accueil ; accès aux conversations conservé |
| `/agent/:slug` | Agents, URL conservée | Conversation partagée clairement indiquée |
| `/tasks` | Accueil → Exécutions | Liste complète et liens de détail conservés |
| `/crons` | Automatisations → Planifications | Ancienne URL redirigée |
| Webhooks, déclencheurs de comptes | Automatisations → Déclencheurs | Visibilité et mutations selon droits existants |
| `/files`, `/mini-apps` | Productions → Fichiers / Apps | Liens des fichiers et Apps maintenus |
| Fournisseurs, modèles, registre et génération d'avatars | Réglages → IA | Administration ; alias de `/models` conservé |
| Canaux et comptes connectés | Réglages → Connexions | Administration selon droits actuels |
| Plugins et marketplace | Réglages → Extensions → Installés / Catalogue | Une seule destination |
| MCP, toolboxes, outils/domaines personnalisés | Réglages → Extensions → Avancé | Les packs restent accessibles depuis l'Agent |
| Coffre, mémoire, stockage de fichiers, API externe | Réglages → Données et accès | Droits existants par section ; distinguer stockage et navigateur de fichiers |
| Utilisateurs, logs, coûts, mises à jour, terminal | Réglages → Système | Administration ; terminal avancé |
| Compte, contacts, notifications et préférences | Surfaces personnelles dans Réglages | Accès membre conservé |

Les réglages restent une entrée accessible aux membres, avec leur sous-ensemble autorisé. Les déplacer dans un « Centre de contrôle » réservé aux administrateurs ne doit pas supprimer les fonctions personnelles existantes.

La création et l'édition d'Agents restent administratives. Les membres conservent leurs réglages Général, Fichiers, Contacts et Notifications, ainsi que la lecture des planifications. Le regroupement Automatisations ne leur ouvre pas les webhooks ou comptes connectés réservés aux administrateurs. « Avancé » décrit la présentation, jamais une permission.

**Fichiers de départ :** [App](../src/client/App.tsx), [réglages](../src/client/pages/settings/SettingsPage.tsx), [barre principale](../src/client/components/layout/ActivityBar.tsx), [barre supérieure](../src/client/components/layout/AppTopBar.tsx), [palette de commandes](../src/client/components/common/CommandPalette.tsx), [brouillons](../src/client/hooks/useDraftMessage.ts).

## Lot 3 — Démarrer, créer un Agent, discuter

### PR 3A — Un seul parcours de premier démarrage

**État : livré, mesure d'usage à faire.** Préférences facultatives retirées du chemin obligatoire, Queenie rejoint la conversation normale, définition du premier Agent commune et capacités issues du registre. Les tests serveur d'onboarding passent. La fixture crée les comptes et le fournisseur via API ; elle ne démontre pas le parcours navigateur complet avec fournisseur réel ni le délai de trois minutes.

- [x] Compte → connexion d'un fournisseur → conversation normale de Queenie → premier Agent.
- [x] Reprendre correctement après refresh, erreur fournisseur ou fermeture pendant une étape ; le serveur fournit l'état de progression.
- [x] Déplacer apparence et capacités facultatives dans les préférences et suggestions contextuelles.
- [x] Utiliser une définition commune du « premier Agent », excluant Queenie.
- [x] Générer les capacités de Queenie à partir des registres réels ; conserver les principes de dialogue dans le texte statique.

**Validation cible :** installation neuve jusqu'à un premier échange utile, reprise d'un onboarding interrompu et absence de réapparition chez un utilisateur existant. Objectif d'usage : moins de trois minutes hors création des identifiants fournisseur.

### PR 3B — Simplifier la création et l'édition

**État : implémenté.** Suggestions de départ, saisie manuelle et navigation Identité/Capacités/Mémoire avec réglages avancés sont présentes. L'aperçu suit le resolver : sélection vide = capacités de base ; « toutes » concerne les outils natifs et personnalisés activés, MCP et plugins exigeant toujours un choix explicite. Le scénario complet génération/échec/édition via formulaire navigateur reste à ajouter.

- [x] Création à partir d'une phrase ou d'un modèle, aperçu de l'identité, choix de capacités puis création.
- [x] Garder une saisie manuelle utilisable quand la génération échoue.
- [x] Édition courante : Identité / Capacités / Mémoire. Paramètres avancés : modèle, Scout, raisonnement et compactage.
- [x] Afficher les capacités effectives ; définir explicitement Minimales / Sélectionnées / Toutes à partir du resolver réel, y compris MCP et plugins.

**Validation cible :** un Agent créé peut répondre immédiatement ; éditer un Agent existant ne réinitialise aucun réglage caché et n'élargit pas silencieusement ses droits.

### PR 3C — Simplifier la conversation et expliciter sa portée

**État : livré et confidentialité testée avec deux comptes.** Portée, expiration/conservation et destination d'un résumé partagé sont explicites. Les protections couvrent aussi SSE brut, aperçu du contexte, compteurs de queue, réactions, pièces jointes et variantes d'URL encodées. Les captures navigateur privées utilisent les pièces jointes de session. Les outils de cartes structurées partagées sont interdits dans cette portée : les questions privées restent textuelles. Les outils agissant dans un espace partagé peuvent toujours y produire des effets visibles : le texte de session privée l'indique.

- [x] En-tête avec Agent, état et visibilité ; panneau de détails pour contexte, coûts et historique d'outils. Garder les résultats d'outils utiles dans le fil.
- [x] Composeur avec actions principales ; réglages experts accessibles à la demande.
- [ ] Suggestions adaptées au rôle et états d'attente/erreur avec une action de reprise claire.
- [x] Nommer explicitement la conversation partagée et la session privée temporaire, en indiquant expiration et conservation réelles.
- [x] Préciser les effets de supprimer/rembobiner sur messages, fichiers et mémoire ; rendre l'export accessible.

**Validation cible :** deux utilisateurs ne voient pas les messages privés de l'autre, via liste, détail, recherche ou SSE. Toute proposition de transférer un résumé privé vers la mémoire partagée affiche clairement sa destination et demande une action de l'utilisateur. Aucun transfert implicite.

**Fichiers de départ :** [onboarding](../src/client/pages/onboarding/OnboardingPage.tsx), [checklist](../src/client/hooks/useSetupChecklist.ts), [formulaire Agent](../src/client/components/agent/AgentFormModal.tsx), [chat](../src/client/components/chat/ChatPanel.tsx), [resolver de capacités](../src/server/services/toolset-resolver.ts), [sessions privées](../src/server/routes/quick-sessions.ts).

## Lot 4 — Rendre le travail visible

### PR 4A — Accueil et exécutions

**État : accueil livré, couverture fonctionnelle partielle.** Non-lus, tâches demandant une réponse, questions de conversation partagée, approbations et résultats récents ouvrent leur destination. L'inbox de questions dispose d'un endpoint paginé avec total SQL avant pagination, et les résultats récents utilisent des requêtes bornées. Les états se resynchronisent. L'inbox des questions de conversation est paginée côté serveur et la résolution d'une demande depuis l'accueil est testée, y compris après erreur d'envoi. Les listes actives historiques restent bornées à 100 éléments par statut ; leur pagination exhaustive reste à étendre.

- [x] Regrouper non-lus, demandes humaines, résultats récents et erreurs utiles à l'utilisateur.
- [x] Donner à chaque élément une action directe : répondre, approuver, reprendre ou ouvrir le résultat.
- [x] Conserver une liste complète d'exécutions et leur historique ; différencier attente humaine, attente technique et traitement actif.
- [ ] Paginer les listes ; appliquer les droits aux données agrégées et aux compteurs avant de les renvoyer.

**Validation cible :** une tâche en attente se retrouve et se résout depuis l'accueil ; reprise après déconnexion avec resynchronisation des états.

### PR 4B — Automatisations

**État : regroupement livré.** Planifications, webhooks et déclencheurs de comptes partagent une destination, avec accès administratif conservé. Les moteurs et composants existants sont réutilisés. Le composant AutomationFlow décrit déclencheur → Agent → action → destination pour les trois moteurs, avec dernier événement et prochaine échéance ou événement attendu. Création, modification, approbation, désactivation, suppression et refus membre sont testés pour les planifications. La qualification des fournisseurs externes réels reste distincte.

- [x] Regrouper planifications, webhooks et déclencheurs de comptes dans une navigation commune.
- [x] Présenter déclencheur → Agent → action → destination du résultat, avec dernier résultat et prochaine exécution.
- [x] Réutiliser les moteurs existants ; adapter leurs contrats d'affichage sans fusionner d'emblée leurs schémas ni leurs cycles de vie.

**Validation cible :** création, modification, approbation et désactivation conservent horaires, fuseaux, règles de livraison et droits existants.

### PR 4C — Productions et recherche dans l'historique

**État : livré.** Apps et fichiers ont une destination commune, la création d'app prépare un brouillon et le navigateur de fichiers mobile est accessible. La recherche paginée interroge l'historique partagé côté serveur et ouvre le contexte d'un résultat ancien ; tests dédiés et parcours navigateur passent. Ce n'est pas encore une recherche transverse dans les Agents, exécutions et fichiers.

- [x] Rassembler Apps et fichiers dans une destination avec état vide actionnable et lien vers l'Agent.
- [x] « Construire une app » ouvre un brouillon prérempli, sans lancer automatiquement une exécution.
- [x] Sur mobile, rendre explicite l'ouverture de l'arbre de fichiers.
- [x] Remplacer d'abord la recherche limitée aux messages chargés par une recherche serveur paginée dans la conversation ; ouvrir un résultat ancien dans sa fenêtre de messages.

**Validation cible :** retrouver un message ancien sans charger tout l'historique ; ouvrir une production depuis son Agent et revenir à la conversation ; aucune donnée privée retournée à un autre membre.

## Lot 5 — Exploitation et performance

**État : socle d'exploitation livré, industrialisation partielle.** Tests de configuration, vrais sous-processus SIGTERM et restauration de données synthétiques passent. La sauvegarde est hors ligne et exige l'arrêt préalable des écritures. Les polices sont locales et des imports lourds ont été différés. Des budgets de JavaScript gzip (450 000 octets au login, 950 000 au premier chat) et une mesure du code source exécuté à froid sont ajoutés au parcours CI ; ils passent : 342 777 octets gzip au login et 739 840 au premier chat, en contexte froid. Le lint progressif et la revue exhaustive des visuels restent ouverts. La politique des exceptions non interceptées après le démarrage reste conservatrice : les gardes existants restent actifs, contrairement aux échecs de récupération au boot qui arrêtent le processus.

- [x] **Performance :** mesurer le JavaScript réellement transféré et exécuté au login et au premier chat, à froid. Les 45 Mo de `dist` sont une mesure d'artefacts cumulés. Identifier les imports responsables, charger les fonctions spécialisées à la demande, puis fixer un budget CI sur ces parcours.
- [x] **Configuration :** valider nombres et bornes au démarrage ; choisir des plafonds HTTP/upload finis à partir des usages actuels, avec erreurs compréhensibles et documentation de migration.
- [ ] **Arrêt et reprise :** arrêter admissions, ordonnanceurs et workers, borner l'attente des travaux puis fermer canaux et base ; tester SIGTERM et arrêt forcé. Définir la politique d'exception fatale avant de retirer les gardes actuels.
- [x] **Sauvegarde :** inventorier DB, fichiers, clé de chiffrement, plugins et autres données durables ; produire une sauvegarde cohérente et tester sa restauration dans un répertoire isolé. Le script `db:snapshot` actuel couvre SQLite seulement. L'indication UI de dernière sauvegarde vérifiée est une nouvelle fonction à livrer avec ce lot.
- [ ] **Qualité continue :** lint progressif des fichiers modifiés, tests de navigation et d'accessibilité, captures des parcours principaux, scripts vérifiés par ShellCheck.
- [x] **Cohérence :** polices servies localement ; documentation et captures actualisées avec chaque parcours livré ; valeurs des capacités générées depuis les registres.

**Validation cible :** budgets fondés sur des mesures reproductibles ; restauration complète avec déchiffrement des données de test ; arrêt borné sans état durable perdu ; configuration invalide refusée avec le nom de la variable.

## Chantiers dédiés après la première refonte

### Isolation des plugins

**État : différé.** Les protections d'installation ne constituent pas une sandbox et aucun runtime séparé avec broker de capacités n'est livré dans cette refonte.

Rédiger un contrat de menace et un protocole de capacités avant de déplacer le runtime. Un worker ou un sous-processus fournit une séparation de pannes, pas une sandbox contre du code malveillant. Une restriction des fichiers, du réseau et des secrets exige des contrôles OS ou une autre frontière d'exécution réellement contraignante.

Séquence : runtime séparé → protocole versionné → accès médiatisés et grants explicites → restrictions vérifiées → migration SDK et compatibilité des plugins. Tester les tentatives d'accès direct à un fichier, au réseau et aux secrets sans droit, ainsi que le crash et l'épuisement de ressources.

### Recherche globale

**État : différé.** Seule la recherche complète dans l'historique partagé d'une conversation est livrée ; aucune indexation transverse des productions ou fichiers n'est annoncée.

Après la recherche complète dans une conversation, étendre aux Agents, exécutions et métadonnées des productions. Ajouter les contenus de fichiers seulement avec une politique d'indexation et de permissions définie. Les résultats et leurs extraits doivent être autorisés avant calcul des compteurs et restitution.

### Refactorings ciblés

**État : commencé.** Persistance du message de queue, validation numérique, arrêt, stockage des plugins, sauvegarde et recherche disposent de modules ciblés. L'extraction complète des moteurs Agent/tâches et des grands composants de chat reste progressive.

Extraire progressivement repository de queue, scheduler de tâches, runtime plugins et livraison des canaux, puis timeline/composeur/panneaux du chat. Chaque extraction accompagne un besoin concret ou un test d'intégration difficile, avec comportement externe conservé.

## Règles de migration et de livraison

1. Commencer par des migrations additives. Les anciennes lignes sans métadonnées restent lisibles ; les pièces jointes déjà perdues en mémoire ne sont pas reconstructibles automatiquement.
2. Ne pas confondre réversibilité du code et des données : après de nouvelles écritures, ne pas restaurer un ancien snapshot pour annuler un changement UI. Prévoir les versions serveur compatibles avec le schéma et les items en file avant chaque release. Un ancien binaire qui ignore les nouveaux champs ne constitue pas un retour arrière transparent : vider la file ou conserver le correctif de lecture avant cette bascule.
3. Conserver identifiants, URLs profondes, préférences et limites d'accès ; documenter les alias et toute évolution de sémantique.
4. Vérifier chaque lot sur base vierge et sur une copie de base existante. Les opérations externes sont simulées ; aucune garantie d'exécution « exactement une fois » n'est déduite de la seule déduplication des messages.
5. Tester l'envoi, le streaming, le changement de page, le refresh, le retour arrière et le changement d'utilisateur sur un même navigateur, notamment pour les brouillons et caches privés.
6. Livrer les correctifs de fiabilité indépendamment des changements visuels. Intégrer la nouvelle UI par routes et composants, puis retirer les anciennes surfaces une fois remplacées.

## Découpage initial des PR — repère de revue

1. **Tests et fixtures isolées** : mock de file, runner sans contamination, base de démonstration sans identifiants hôte.
2. **Démarrage puis queue durable**, en deux PR : ordre de nettoyage des secrets, puis migration des données et scénarios de reprise.
3. **Corrections visibles** : tiroir mobile, liens canaux, accessibilité élémentaire, confinement des erreurs, capture du site.
4. **Maquettes des cinq écrans clés**, en parallèle des PR serveur.
5. **Transactions des tâches et plugins persistants**, en PR séparées par sous-système.
6. **Registre de navigation et continuité du chat**, puis nouveau cadre desktop/mobile, puis réglages routés.

Ce découpage initial sert désormais de grille de revue du travail présent dans la branche ; il ne désigne pas des PR déjà publiées. Les cases ouvertes ci-dessus et les limites du bilan constituent la suite du travail.

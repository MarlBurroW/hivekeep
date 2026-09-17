# Bilan de la refonte — septembre 2026

Suite : [améliorations UI du 17 septembre](ui-polish-2026-09-17.md), avec simplification du chat, nouvelles cartes d'apps, navigation mobile et correction des filtres.

Puis : [fichiers du workspace depuis le chat](chat-workspace-files-2026-09-17.md), avec navigation, recherche, import et ajout des chemins au brouillon sans quitter la conversation.

État au 16 septembre 2026, branche `feat/hivekeep-refonte`, à partir de `da74931e`. Documents de référence : [audit initial](audit-produit-ui-architecture-2026-09.md) et [plan d'exécution avec avancement](plan-refonte-2026-09.md).

La première implémentation réorganise Hivekeep autour du travail à traiter, des Agents, des productions et des automatisations. Elle corrige aussi les pertes de contexte dans la file, les réservations concurrentes de tâches et plusieurs chemins d'accès aux sessions privées. Le code est présent dans la branche de travail ; aucune instance existante ni donnée de production n'a été migrée pour ces vérifications.

L'audit initial reste un constat historique. Ses nombres de tests, poids de build et défauts observés décrivent la version étudiée, pas l'état final de cette branche. Les vérifications finales de typage, build, navigateur et image Docker passent. Voir aussi la [démonstration isolée](refonte-demo.md).

## Résultat produit

| Parcours | Résultat livré |
| --- | --- |
| Retrouver le travail utile | Accueil avec conversations non lues, demandes humaines, approbations et résultats récents ; accès aux exécutions et à leurs détails |
| Naviguer | Quatre destinations principales avec libellés sur desktop et barre basse mobile ; pages introuvables explicites ; anciennes URLs conservées ou redirigées |
| Configurer | Réglages adressables par URL, regroupés par usage ; filtre Agent et destination de retour conservés ; sous-ensemble personnel toujours accessible aux membres |
| Démarrer | Parcours recentré sur compte, fournisseur et conversation normale avec Queenie ; préférences facultatives sorties du chemin obligatoire |
| Créer ou éditer un Agent | Suggestions de départ, génération et saisie manuelle ; Identité, Capacités et Mémoire au premier niveau ; paramètres experts regroupés |
| Converser | Portée partagée/privée visible, actions expertes moins présentes, export et conséquences des actions destructives explicités |
| Revenir à une conversation | Brouillon et fichiers déjà téléversés conservés ; retour pendant réponse ; reprise du flux privé ; restauration de la position de lecture |
| Automatiser | Planifications, webhooks et déclencheurs de comptes rassemblés ; droits et moteurs existants conservés |
| Retrouver une production | Apps et fichiers dans une destination commune ; « construire une app » prépare un brouillon ; accès mobile à l'arbre des fichiers |
| Chercher dans une conversation | Recherche serveur paginée dans tout l'historique partagé ; ouverture du contexte d'un message ancien sans charger tout l'historique |

Le prototype cliquable est l'application de démonstration elle-même, avec contenu réaliste et fournisseur local simulé. Il n'y a pas de maquette autonome supplémentaire. Les thèmes et palettes restent disponibles ; les polices sont servies localement.

## Architecture et fiabilité

### Démarrage, file et tâches

Le serveur attend la récupération des secrets révélés avant de lancer plugins, workers et producteurs d'inférences. Un échec de cette récupération arrête le démarrage ; il n'est plus absorbé par les gardes d'erreurs du runtime.

La migration additive `0119_durable_queue_payload` place identifiants de fichiers, métadonnées de canal et token de réconciliation dans la base. L'enveloppe complète est écrite avant publication. Le message utilisateur et son reçu `created_message_id` sont commis ensemble : après redémarrage, un worker reprend cette identité au lieu de créer un second message.

Les pièces jointes envoyées par un utilisateur sont réservées dans la transaction d'enqueue. Un fichier déjà lié, attribué à une autre portée ou réclamé par un autre item actif est refusé. Deux envois concurrents partagé/privé ne peuvent pas s'approprier le même fichier.

Création, promotion et reprise de tâches comptent puis réservent leurs places dans une transaction SQLite courte. Le travail asynchrone reste hors du verrou. Les limites globales, par groupe et de file s'appliquent aux admissions ordinaires ; une promotion forcée garde son contournement explicite, avec un seul gagnant.

Cette déduplication concerne le message entrant. Elle ne rend pas les appels LLM, outils ou livraisons externes « exactement une fois ». Une ancienne pièce jointe dont l'association a déjà été perdue en mémoire n'est pas reconstruite par la migration.

### Portée des sessions privées

Les événements SSE portant une session sont filtrés par propriétaire, y compris les mises à jour de queue. Ils ne passent plus par les observateurs partagés. Les aperçus de contexte et réactions vérifient aussi la portée et l'Agent ; les compteurs publics excluent les items privés.

Les cartes de question, demandes d'accès aux outils et interventions navigateur utilisent un stockage partagé. Leurs outils (`prompt_human`, `request_tool_access`, `browser_request_human`) sont donc exclus des sessions privées et refusent aussi une invocation directe dans cette portée. En privé, l'Agent pose ses questions dans le texte normal de la conversation. Les captures navigateur privées sont enregistrées comme pièces jointes de la session, avec le même contrôle d'accès que les autres fichiers, sans URL de partage publique.

La migration `0120_private_file_scope` ajoute la portée privée aux fichiers. Le contrôle d'accès couvre les téléchargements bruts et les variantes d'URL encodées, les fichiers téléversés et ceux produits par les outils concernés. Les tests utilisent deux comptes réels et observent le SSE brut, au-delà de ce que masque l'interface.

La durée de session et la conservation de l'historique sont affichées. Enregistrer un résumé dans la mémoire partagée demande une action explicite et indique la destination. Les actions d'outils dans des espaces partagés peuvent toujours y créer des effets visibles ; la session privée ne constitue pas une sandbox d'exécution. Les journaux opérationnels sur disque ne sont pas présentés comme un stockage privé chiffré de bout en bout.

### Plugins

Le stockage actif et la préparation des installations passent sous `HIVEKEEP_DATA_DIR`. La migration vérifie les copies, conserve les anciens dossiers et traite les collisions sans écrasement silencieux. L'installation utilise `--ignore-scripts`, vérifie la version et le manifeste avant activation et conserve une voie de reprise de la version précédente en cas d'échec.

L'interface et la documentation présentent les plugins comme du code de confiance, avec source et version. Un plugin nécessitant un script de compilation à l'installation doit publier ses artefacts. **Les plugins s'exécutent encore dans le processus serveur** : les permissions proposées par le SDK ne constituent pas une restriction OS contre du code malveillant.

### Configuration, arrêt et sauvegarde

Les paramètres numériques refusent les valeurs non finies, vides ou hors bornes, avec un diagnostic nommant la variable. Les plafonds par défaut deviennent finis : 256 Mo par requête HTTP, 128 Mo par fichier stocké et 100 Mo par upload d'espace de travail. Une ancienne valeur `0` choisit désormais le plafond par défaut avec avertissement. La documentation explique comment ajuster ensemble taille de fichier et enveloppe HTTP.

SIGTERM/SIGINT arrêtent les nouvelles admissions, les ordonnanceurs et les workers, attendent les travaux suivis dans une fenêtre bornée, puis interrompent les flux restants et ferment les ressources. Les valeurs par défaut sont 20 secondes de drain et 5 secondes de nettoyage. Les signaux répétés partagent le même arrêt. Les interruptions suivent les règles existantes : un tour de conversation interrompu proprement n'est pas automatiquement rejoué ; une tâche laissée en cours est marquée en échec à la reprise.

`bun run backup` couvre la base, la clé effective, les fichiers, les plugins et les stockages applicatifs configurés, avec manifeste d'empreintes et restauration vers un répertoire neuf. Les chemins persistés sont adaptés au dossier restauré. Réglages → Général affiche la dernière vérification enregistrée pour l'installation, sans annoncer une sauvegarde automatique.

La sauvegarde exige l'arrêt préalable des écritures (`--stopped` ne les arrête pas). Les dossiers externes ajoutés manuellement exigent une inclusion explicite. Liens sortant des racines et fichiers spéciaux sont refusés ; la sérialisation SQLite consomme une mémoire proportionnelle à la base. Configuration du service, proxy, code et variables externes restent à conserver séparément. Voir [sauvegarde et retour arrière](backup-and-rollback.md) et [contrats de reprise et d'arrêt](dev-notes/recovery-and-shutdown.md).

## Validations réalisées

Les tests utilisent bases/répertoires temporaires, clés synthétiques et fournisseur LLM simulé. Ils ne lisent pas les identifiants fournisseur du serveur et n'appellent pas de LLM payant. Ils ne constituent pas une restauration testée de la production.

| Vérification | Résultat connu et portée |
| --- | --- |
| Suite isolée complète | **4 052 réussites, 0 échec, 0 skip, 208 fichiers** ; un processus par fichier, parallélisme borné, environnement minimal |
| Typage | `bun run typecheck` réussi sur le code final |
| Reprise de queue | Vrais sous-processus avant/après création du message ; payload conservé, reçu transactionnel et rollback ; races d'attachement et exclusion de queue privée |
| Démarrage et migrations | Vrai démarrage avec récupération de secrets, échec bloquant ; migrations neuves, répétées et avec données préexistantes synthétiques |
| Tâches et configuration | Réservations/promotions concurrentes, plafonds et configuration invalide couverts par suites ciblées |
| Arrêt | Sous-processus recevant SIGTERM : drain, interruption après délai et nettoyage bloqué |
| Sauvegarde | Roundtrip avec WAL, déchiffrement d'un secret connu après restauration, chemin DB de pièce jointe relu et plugin chargé ; corruption et écrasement refusés |
| Plugins en conteneur | Image finale du projet construite ; installation/migration et chargement avec SDK/zod, puis chargement après recréation, UID `1001`, réseau coupé et volume partagé |
| Sauvegarde dans l'image | CLI `create`, `verify`, `restore` vers un dossier neuf : contenu et chemins restaurés, déchiffrement avec la clé restaurée, chargement du plugin restauré ; données synthétiques uniquement |
| Parcours espace de travail | **14 scénarios passés** : accès, routes/alias, brouillon, streaming, recherche ancienne, droits, confidentialité, résolution des demandes humaines, erreur/reprise et interruption/reconnexion SSE ; contrôle de débordement à 320/390/768/1440 px et captures clair/sombre |
| Parcours conversation | **4 scénarios passés** : brouillon et pièce jointe, position de lecture ancienne, état de session privée, reprise privée unique avec refus d'accès depuis un second compte |
| Inbox et outils privés | Tests ciblés supplémentaires : inbox partagée paginée, total SQL et bornes ; refus sans effet des trois producteurs de cartes partagées en privé ; capture navigateur enregistrée dans la session |

Deux autres suites complètent ces parcours : [product-e2e.ts](../scripts/product-e2e.ts) (**9 scénarios**, création/édition Agent sans perte des paramètres avancés, planifications, droits membre, 24 réglages, clavier et noms accessibles) et [provider-e2e.ts](../scripts/provider-e2e.ts) (**3 scénarios**, outil réellement exécuté, erreur fournisseur persistée et reprise). Les **30 scénarios** passent sur une [fixture isolée](../scripts/workspace-fixture.ts). Les quatre suites passent avec le sandbox Chromium activé explicitement. Elles et le smoke Docker sont raccordés à la CI ; commandes dans le [guide de démonstration](refonte-demo.md).

Rapports conservés : [espace de travail et performance](refonte/workspace-validation.json), [produit et accessibilité élémentaire](refonte/product-validation.json). Une fermeture isolée de Chromium a interrompu une passe ; la relance intégrale instrumentée est passée, sans ajouter de retry automatique.

Les résultats bruts de la [suite isolée](refonte/unit-tests.txt), du [smoke Docker](refonte/docker-validation.txt), de la [continuité](refonte/experience-validation.txt) et du [fournisseur simulé](refonte/provider-validation.txt) sont également conservés.

### Vérification finale

| Contrôle final | Résultat |
| --- | --- |
| Build client | Réussi ; imports spécialisés différés et polices locales |
| Parcours navigateur après derniers changements | 14 espace de travail + 4 continuité + 9 produit + 3 fournisseur simulé ; aucune exception navigateur dans les parcours inspectés |
| JavaScript à froid | Login : **342 777 octets gzip**, 1 057 627 octets de source chargée, 583 754 couverts. Chat : **739 840 octets gzip**, 2 831 753 de source chargée, 1 404 718 couverts |
| Budget CI | Passe : **450 000 octets gzip au login**, **950 000 au premier chat** ; absence de chargement prématuré de MiniAppViewer/éditeur vérifiée |
| Image Docker finale | Build réussi ; smoke tests plugin et sauvegarde/restauration réussis dans l'image finale du projet |
| Capture publique Tasks | WebP 1600×1000 remplacé et inspecté ; écran fonctionnel sans exception navigateur |

Les octets de source couverts sont un indicateur d'exécution, pas une mesure de temps CPU. Les tailles cumulées des artefacts `dist` de l'audit ne sont pas comparables directement aux octets gzip transférés sur un parcours.

## Limites et suite explicite

| Sujet | Reste à faire ou limite conservée |
| --- | --- |
| Isolation forte des plugins | Projet dédié : modèle de menace, runtime séparé, protocole versionné, broker de capacités, contrôles OS et tests d'accès sans droit. Un worker seul ne suffit pas. |
| Recherche globale transverse | Étendre après définition des droits aux Agents, exécutions et métadonnées de productions ; indexer le contenu des fichiers seulement avec une politique dédiée. Autoriser avant extraits et compteurs. |
| Automatisations | Regroupement et déroulé uniforme livrés pour les trois moteurs. CRUD/approbation des planifications et refus des cinq mutations pour un membre vérifiés. Les trois résumés API ne donnent pas d’identifiant du dernier résultat : les accès existants aux détails/historiques restent utilisés. Intégrations externes et cas limites de fuseaux à qualifier séparément. |
| Accueil | Inbox paginée et résolution d’une attente depuis l’accueil vérifiées, avec échec/reprise. Résultats récents bornés. Les anciennes listes de tâches actives restent limitées à 100 entrées par statut ; pagination exhaustive à étendre si ces volumes sont atteints. |
| Onboarding et création | Création manuelle, échange et édition sans perte des paramètres avancés vérifiés. Tests serveur pour reprise de l’onboarding. Génération par un vrai fournisseur et premier démarrage chronométré avec un utilisateur restent à qualifier ; l’objectif de trois minutes n’est pas démontré. |
| Accessibilité et visuels | Clavier, palette, noms des boutons visibles, 24 réglages, largeurs 320/390/768/1440 et variantes FR/EN clair/sombre contrôlés. Lecteurs d’écran, contraste exhaustif des 18 palettes, clavier virtuel et matrice complète restent à auditer ; aucun engagement WCAG global. |
| Upload interrompu | Les fichiers dont le téléversement n'est pas fini doivent être rattachés après un rechargement complet. |
| Questions privées | Questions textuelles dans le fil ; pas de carte structurée partagée ni de demande permanente de capacités depuis une session privée. |
| Arrêt forcé | Du code bloquant la boucle JavaScript empêche les timers de s'exécuter ; le timeout du superviseur reste nécessaire. La politique des exceptions fatales après boot conserve les gardes existants. |
| Effets externes | Les outils, fournisseurs et canaux nécessitent leurs propres protections d'idempotence ; aucun engagement d'exécution exactement une fois. |
| Qualité continue | Lint progressif et extension des tests/captures restent à poursuivre ; les extractions ciblées n'ont pas réécrit les grands moteurs et composants en entier. |
| Exploitation réelle | Restaurer une sauvegarde de l'installation dans un environnement séparé avant toute bascule ; aucune sauvegarde/restauration de production n'a été effectuée ici. |

## Captures de référence

- [Accueil desktop](refonte/home-desktop.png), [mobile](refonte/home-mobile.png) et [sombre](refonte/home-dark.png).
- [Conversation](refonte/agent-atlas.png), [réglages](refonte/settings-general.png), [automatisations](refonte/automations-plans.png) et [productions](refonte/productions-apps.png).
- [Anglais mobile](refonte/home-english-mobile.png) et [réglages anglais desktop](refonte/settings-english-desktop.png).

## Migration et retour arrière

Les migrations `0119` et `0120` sont additives. Les anciennes lignes restent lisibles ; cela ne rend pas un ancien binaire compatible avec les nouvelles métadonnées de queue. Avant un retour à une version antérieure, drainer la file ou conserver les correctifs de lecture nécessaires.

Un retour de code/UI ne doit pas restaurer une vieille base après de nouvelles écritures. Les plugins conservés à l'ancien emplacement ne reflètent pas automatiquement les installations ultérieures dans `dataDir`. Une restauration complète se prépare dans un répertoire neuf, avec la bonne clé et une version applicative compatible, puis se vérifie avant de réactiver intégrations et ordonnanceurs.

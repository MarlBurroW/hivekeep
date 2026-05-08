# KinBot

## Description du projet

KinBot est une plateforme d'**agents IA spécialisés** conçue pour assister une personne ou un petit groupe (famille, amis, colocation) dans leur quotidien.

Le principe : l'utilisateur crée des **Kins** — des agents experts dans un domaine précis (nutrition, finance personnelle, organisation de voyages, développement, rédaction, recherche...). Chaque Kin a sa personnalité, ses connaissances, ses outils, et une mémoire continue de toutes les interactions passées. Les Kins peuvent collaborer entre eux, déléguer des sous-tâches, et exécuter des tâches planifiées de manière autonome.

Contrairement aux chatbots classiques ou chaque conversation repart de zéro, un Kin **connaît son contexte** : il sait qui lui parle, ce qui a été demandé précédemment, et peut agir de manière proactive. C'est un assistant permanent, pas un outil jetable.

KinBot est une application web auto-hébergée (a domicile ou sur un VPS), multi-utilisateur, pensée pour rester **simple a déployer et a maintenir**.

---

## 1. Onboarding

La première connexion a l'interface lance un wizard d'onboarding. Ce wizard permet de créer le premier utilisateur (administrateur) et d'effectuer la configuration minimale nécessaire au fonctionnement de la plateforme.

### Ecran 1 - Identité de l'utilisateur

Champs requis :
- Photo / Avatar
- Prénom
- Nom
- Email
- Pseudonyme
- Langue (Français ou Anglais)
- Mot de passe (avec confirmation)

### Ecran 2 - Providers

Cet écran permet de configurer au moins un provider. Chaque provider est configuré **une seule fois** (type + API Key), et le système détecte automatiquement les capacités disponibles (voir section 13 — Architecture extensible).

Providers supportés au lancement :

| Provider | Authentification | Capacités |
|---|---|---|
| **Anthropic** | API Key (Console) | `llm` |
| **OpenAI** | API Key | `llm`, `embedding`, `image` |
| **Gemini** | API Key | `llm`, `image` |
| **Voyage AI** | API Key | `embedding` |

**Validation a l'écran 2** :
- L'écran valide la connectivité avec chaque provider configuré
- **Condition minimale pour continuer** : les providers configurés doivent couvrir au moins les capacités `llm` et `embedding`, indispensables au fonctionnement de la plateforme (complétion LLM + mémoire long terme)
- Si un seul provider couvre les deux (ex: OpenAI), un seul suffit. Sinon, l'utilisateur doit en configurer plusieurs (ex: Anthropic pour `llm` + Voyage AI pour `embedding`)
- La capacité `image` est optionnelle — si aucun provider configuré ne la supporte, les fonctionnalités de génération d'image (avatar auto-généré, etc.) seront indisponibles. L'utilisateur pourra ajouter un provider avec cette capacité plus tard dans les Settings

### Ecran 3 - Search Providers (optionnel)

Cet écran permet de configurer un ou plusieurs **search providers** — des services de recherche web que les Kins pourront utiliser pour accéder a des informations en temps réel. Ce step est **optionnel** : l'utilisateur peut le passer et configurer ses search providers plus tard dans les Settings.

Le fonctionnement est identique aux AI providers : configuration unique (type + API Key), test de connexion, et le système détecte la capacité `search`.

Search providers supportés au lancement :

| Provider | Authentification | Capacités |
|---|---|---|
| **Brave Search** | API Key (brave.com/search/api) | `search` |

> **Note** : d'autres search providers pourront être ajoutés ultérieurement (SearXNG, Tavily, etc.) en implémentant la même interface.

**Validation a l'écran 3** :
- L'écran valide la connectivité avec chaque search provider configuré
- Aucune condition minimale — le step est optionnel. Un bouton "Passer" permet de continuer sans configurer de search provider
- Si aucun search provider n'est configuré, les outils de recherche web des Kins ne seront pas disponibles

---

## 2. Interface principale

### Direction design

L'interface de KinBot doit être **clean et soignée**, tout en gardant un côté **chaleureux et ludique**. On ne cherche pas l'austérité d'un outil enterprise, ni le côté enfantin d'une app gamifiée. L'objectif est un équilibre entre professionnalisme et personnalité.

| Aspect | Direction |
|---|---|
| **Ton général** | Moderne, aéré, accueillant — dans l'esprit de Notion ou Arc Browser |
| **Formes** | Coins arrondis généreux, cartes avec ombres douces, espacement confortable |
| **Couleurs** | Palette chaude et douce (pas de gris froid corporate). Accents de couleur vifs mais non agressifs |
| **Typographie** | Police sans-serif arrondie et lisible (ex: Inter, Plus Jakarta Sans) |
| **Avatars des Kins** | Illustrations ou icônes expressives, pas de photos stock. Chaque Kin a une identité visuelle distinctive |
| **Micro-interactions** | Animations subtiles : transitions fluides, hover doux, apparitions progressives. Rien de tape-a-l'oeil |
| **Dark mode** | Prévu dès le départ. Tons sombres chauds (pas du noir pur) |
| **Ton des messages** | Bulles de chat avec distinction claire par source (couleur, position, avatar). Lisibilité avant tout |

L'idée est que l'utilisateur se sente chez lui, pas dans un cockpit.

> **Prérequis** : avant tout développement frontend, un **design system** (palette, typographie, composants de base, spacings) et des **maquettes des écrans principaux** (onboarding, chat, sidebar, settings) doivent être produits et **validés par le porteur du projet**. Le développement UI ne démarre qu'après cette validation.

### Layout

La vue principale est divisée en deux parties :
- **Sidebar gauche** : navigation entre Kins et tâches
- **Panel principal** : interface de chat correspondant a l'élément sélectionné dans la sidebar

### Panel de chat — origines des messages

Dans la session principale d'un Kin, les messages entrants peuvent provenir de **plusieurs sources distinctes**. L'interface doit rendre l'origine de chaque message immédiatement identifiable visuellement (avatar + nom de l'envoyeur).

| Source | Affichage |
|---|---|
| **Utilisateur** | Avatar et prénom/pseudonyme de l'utilisateur |
| **Autre Kin** | Avatar et nom du Kin expéditeur |
| **Retour de tâche (sous-Kin)** | Indicateur de tâche + nom de la tâche |
| **Retour de cron** | Indicateur de cron + nom du cron |

### Sidebar

La sidebar est organisée en sections distinctes :

| Section | Contenu |
|---|---|
| **Kins** | Liste des Kins de l'utilisateur. Cliquer sur un Kin ouvre sa session principale continue |
| **Tâches** | Liste de toutes les tâches (sous-Kins) en cours, tous Kins confondus. Permet de suivre l'avancement et de consulter la session d'une tâche |

La sidebar donne également accès aux sections **Mon compte** et **Settings**.

### Mon compte

Permet de modifier les informations personnelles :
- Prénom, Nom, Pseudonyme
- Photo / Avatar
- Langue
- Mot de passe

### Settings

- Gestion des AI providers (ajout / modification / suppression)
- Gestion des search providers (ajout / modification / suppression)
- Gestion des serveurs MCP
- Gestion du **Vault** (voir section ci-dessous)

### Vault (secrets)

Le Vault est un coffre-fort centralisé permettant de stocker des secrets (clés API, tokens, mots de passe de services tiers, etc.) que les Kins peuvent consulter lors de l'exécution de leurs tâches.

| Aspect | Description |
|---|---|
| **Gestion** | L'administrateur crée, modifie et supprime les entrées du Vault via l'interface Settings |
| **Structure** | Chaque secret est une paire clé/valeur nommée (ex: `GITHUB_TOKEN`, `NOTION_API_KEY`) |
| **Stockage** | Les valeurs sont chiffrées en base de données (encryption at rest) |
| **Accès par les Kins** | Les Kins disposent d'un outil `get_secret(key)` pour récupérer un secret par sa clé. La valeur n'est jamais injectée dans le prompt système — elle est uniquement accessible via l'outil, a la demande |
| **Visibilité** | Les valeurs ne sont jamais affichées en clair dans l'interface (masquées par défaut). Les Kins ne doivent jamais inclure les valeurs de secrets dans leurs réponses visibles par l'utilisateur |
| **Caviardage** | Quand un utilisateur transmet un secret via le chat (ex: "voici mon token GitHub : ghp_xxxx"), le Kin peut le stocker dans le Vault puis **caviarder le message original** dans l'historique via un outil dédié `redact_message(message_id, redacted_text)`. Le secret est remplacé par un placeholder (ex: `[SECRET: GITHUB_TOKEN]`) dans le message stocké en DB, rendant la valeur irrécupérable depuis l'historique |
| **Priorité sur le compacting** | Le caviardage est **synchrone et prioritaire** sur le compacting. Quand le Kin détecte un secret dans un message, l'appel a `redact_message` est traité **avant** que le message puisse être inclus dans un cycle de compacting. Cela garantit qu'un secret ne se retrouve jamais dans un résumé compacté. Concrètement, un message flaggé pour caviardage est exclu du compacting tant que la redaction n'est pas effective |

---

## 3. Création du premier Kin

Une fois l'onboarding terminé, l'utilisateur dispose d'au moins les capacités `llm` et `embedding` couvertes par ses providers. La plateforme affiche automatiquement la modale de création d'un premier Kin, pour guider l'utilisateur vers l'action la plus naturelle après la configuration initiale.

---

## 4. Concept de Kin

Un **Kin** dans KinBot est une entité autonome dotée d'une identité, d'une expertise et d'outils.

**Principe fondamental** : chaque Kin ne possède qu'une **seule session principale continue**. Il n'y a pas de concept de "nouvelle conversation". Les utilisateurs parlent tous dans le même fil, et le Kin garde en permanence le contexte de ce qui a été fait récemment grâce au compacting (voir section 5). Cela garantit une continuité de contexte : le Kin sait toujours ou il en est.

**Les Kins sont partagés** entre tous les utilisateurs de la plateforme. Ils forment un **squad commun** accessible a tous. Le système multi-utilisateur permet simplement a plusieurs personnes (famille, amis) d'interagir avec les mêmes Kins. Chaque message dans la session est **tagué avec l'identité de l'utilisateur** qui l'a envoyé, afin que le Kin sache toujours a qui il s'adresse.

### Attributs configurables par l'utilisateur

| Attribut | Description |
|---|---|
| **Nom** | Nom du Kin |
| **Rôle** | Description courte de sa fonction (ex: "Expert en médecine douce") |
| **Avatar** | Image représentant le Kin. Trois modes de création : **Upload** (l'utilisateur charge une image existante), **Génération automatique** (le Kin génère son propre avatar via le provider d'images, en se basant sur son nom, rôle, caractère et expertise — prompt caché), ou **Prompt personnalisé** (l'utilisateur rédige un prompt libre envoyé au provider d'images). Nécessite un provider de génération d'image configuré pour les deux derniers modes |
| **Caractère** | Personnalité et ton du Kin (équivalent du SOUL.md d'OpenClaw) |
| **Expertise** | Objectif du Kin et ensemble des connaissances nécessaires pour répondre au mieux |
| **Modèle LLM** | Modèle utilisé par le Kin pour ses appels LLM (ex: `claude-sonnet-4-20250514`, `gpt-4o`). Doit correspondre a un modèle disponible via l'un des providers configurés |
| **Outils (MCP)** | Serveurs MCP de la plateforme auxquels le Kin a accès |

### Attributs gérés automatiquement par le Kin

#### Registre de contacts

Le Kin maintient une liste de tous les interlocuteurs qu'il rencontre. Un prompt système caché lui indique de mettre a jour ce registre de manière autonome :
- Ajouter de nouveaux contacts (avec génération d'un UUID)
- Enregistrer des faits marquants et préférences pour chaque contact

Les contacts peuvent être :
- Des **humains** : membres de la famille de l'utilisateur, amis (pouvant interagir via Telegram, Discord, WhatsApp...)
- D'autres **Kins** de la plateforme

#### Injection et consultation des contacts

Pour éviter que le prompt système n'explose avec des centaines de contacts, seul un **résumé compact** est injecté dans le prompt système : la liste des noms/pseudonymes des contacts avec leur UUID (sans les détails). Cela permet au Kin de savoir qui il connaît sans surcharger le contexte.

Pour accéder aux détails d'un contact, le Kin dispose d'outils dédiés :

| Outil | Description |
|---|---|
| `get_contact(contact_id)` | Récupère la fiche complète d'un contact (faits marquants, préférences, notes) |
| `search_contacts(query)` | Recherche dans les contacts par nom, relation ou mot-clé (ex: "frère de Nicolas", "allergique") |
| `create_contact(name, type, notes?)` | Crée un nouveau contact (humain ou Kin) |
| `update_contact(contact_id, updates)` | Met a jour les informations d'un contact |

#### Outils auto-générés

En plus des **outils MCP** assignés au Kin par l'utilisateur (voir "Attributs configurables"), le Kin peut créer ses propres outils pour enrichir sa boîte a outils au fil du temps.

| Aspect | Description |
|---|---|
| **Création** | Le Kin génère un script ou un binaire dans son workspace (ex: `tools/scrape_url.sh`, `tools/convert_pdf.py`) |
| **Enregistrement** | Le Kin enregistre l'outil dans son attribut `tools` via un outil dédié `register_tool(name, description, parameters, path)`. Cet attribut est persisté en DB |
| **Disponibilité** | La liste des outils custom est injectée dans le prompt système au début de chaque appel LLM, aux côtés des outils MCP et des outils natifs de la plateforme |
| **Exécution** | Quand le Kin souhaite utiliser un outil custom, il appelle `run_custom_tool(tool_name, args)` qui exécute le script correspondant dans le workspace |
| **Confinement** | L'exécution d'un outil custom est restreinte au workspace du Kin (path validation). Le script ne peut pas accéder a des fichiers en dehors de son workspace |
| **Gestion** | Le Kin peut lister (`list_custom_tools()`), modifier et supprimer ses outils custom |

**Distinction MCP vs custom** : les outils MCP sont des serveurs externes configurés par l'utilisateur au niveau de la plateforme. Les outils custom sont des scripts créés par le Kin lui-même, stockés localement et exécutés dans son workspace. Les deux types coexistent dans la boîte a outils du Kin.

#### Workspace

Chaque Kin dispose d'un dossier de travail local (avec un chemin par défaut). Il peut y cloner des repos, créer ses outils custom, télécharger des fichiers, etc.

---

## 5. Sessions et compacting

Chaque Kin possède une **session principale continue**. Contrairement a un chat classique ou chaque conversation est indépendante, la session principale d'un Kin est persistante : elle représente le fil de conscience continu du Kin.

### Compacting

Au fur et a mesure que la session principale grandit, un mécanisme de **compacting** résume les échanges anciens pour maintenir une fenêtre de contexte exploitable. Le Kin conserve ainsi une mémoire de travail synthétisée de son historique, sans perdre les informations importantes.

### Persistance des messages originaux

Le compacting ne supprime **jamais** les messages originaux de la base de données. Il génère une couche de résumé qui est injectée dans le contexte du LLM, mais les échanges bruts restent consultables :
- Par les **utilisateurs**, via l'interface (historique scrollable)
- Par le **Kin lui-même**, via un outil dédié (`search_history(query)`) qui lui permet de fouiller ses échanges passés au-delà de sa fenêtre de contexte active

### Mémoire long terme

Le compacting gère la **mémoire de travail** (résumé glissant de la conversation récente). La mémoire long terme est un mécanisme complémentaire qui **extrait et structure les connaissances durables** issues des échanges.

#### Pipeline d'extraction

Après chaque interaction (ou au moment du compacting), un **modèle léger et peu coûteux** (ex: Haiku) analyse les échanges récents et extrait les informations a retenir :

| Type de mémoire | Exemples |
|---|---|
| **Faits utilisateur** | "Nicolas est végétarien", "Marie est allergique aux arachides" |
| **Préférences** | "Nicolas préfère les résumés courts", "La famille part en vacances en août" |
| **Décisions prises** | "On a choisi Next.js pour le projet X", "Le budget mensuel courses est de 600€" |
| **Connaissances métier** | Informations spécifiques au domaine d'expertise du Kin accumulées au fil des échanges |

Chaque mémoire extraite est stockée avec :
- Un **contenu textuel** (le fait ou la connaissance)
- Un **embedding** (vecteur de représentation sémantique)
- Une **source** (référence au message ou a la session d'origine)
- Un **timestamp** de création
- Une **catégorie** (fait, préférence, décision, connaissance)
- Un **sujet** (a quel contact ou contexte se rapporte cette mémoire)

#### Restitution automatique

Au moment de construire le contexte d'un appel LLM, le système récupère les mémoires pertinentes par **recherche sémantique** (similarité cosinus sur les embeddings) en fonction du message entrant et du contexte actuel. Les mémoires les plus pertinentes sont injectées dans le prompt système.

#### Outils mémoire du Kin

Le Kin dispose d'outils dédiés pour interagir proactivement avec sa mémoire long terme :

| Outil | Description |
|---|---|
| `recall(query)` | Recherche sémantique dans la mémoire. Retourne les mémoires les plus pertinentes par rapport a la requête |
| `memorize(content, category, subject)` | Enregistre explicitement une mémoire (sans attendre le pipeline automatique). Utile quand le Kin identifie une information importante a retenir immédiatement |
| `update_memory(memory_id, new_content)` | Met a jour une mémoire existante (ex: correction, information actualisée) |
| `forget(memory_id)` | Supprime une mémoire devenue obsolète ou incorrecte |
| `list_memories(subject?, category?)` | Liste les mémoires, filtrable par sujet ou catégorie |

Cela permet au Kin de **gérer activement ses connaissances** : mémoriser un fait important sur le moment, corriger une information devenue fausse, ou nettoyer des mémoires obsolètes.

#### Cycle de vie des mémoires

Les mémoires sont alimentées par **deux canaux** :

| Canal | Description |
|---|---|
| **Automatique** | Le pipeline d'extraction analyse les échanges et crée/met a jour des mémoires en arrière-plan |
| **Explicite** | Le Kin utilise ses outils (`memorize`, `update_memory`, `forget`) pour gérer ses mémoires proactivement |

L'utilisateur peut également consulter et supprimer des mémoires via l'interface du Kin (section Settings du Kin).

#### Stockage et recherche hybride

La recherche dans la mémoire long terme utilise une **approche hybride** combinant deux moteurs :

| Moteur | Technologie | Usage |
|---|---|---|
| **Recherche sémantique** | sqlite-vec (KNN sur embeddings) | Trouver des mémoires par proximité de sens, même si les mots diffèrent (ex: "régime alimentaire" retrouve "Nicolas est végétarien") |
| **Recherche textuelle** | SQLite FTS5 (full-text search) | Trouver des mémoires par correspondance exacte de mots-clés (ex: "Next.js" retrouve la décision sur le choix de framework) |

Les deux moteurs sont interrogés en parallèle et les résultats sont fusionnés (rank fusion) pour maximiser la pertinence. La recherche sémantique excelle pour les requêtes vagues ou reformulées, tandis que FTS5 est imbattable pour les termes précis (noms propres, noms techniques, identifiants).

Cette approche s'applique également a `search_history(query)` pour la recherche dans l'historique des messages.

### Purge et rollback

Si le contexte compacté devient incohérent (hallucinations accumulées, mauvais résumé), l'utilisateur peut :
- **Purger le compacting** : réinitialiser le résumé compacté, forçant le Kin a repartir d'un contexte vierge (les messages originaux restent en DB)
- **Rollback** : revenir a un état compacté antérieur (les snapshots de compacting sont conservés)

### Queue de traitement

Chaque Kin possède une **queue FIFO** qui sérialise le traitement de tous les messages entrants. Un Kin ne traite qu'**un seul message a la fois** : tant qu'il n'a pas terminé de répondre au message courant, les messages suivants restent en attente dans la queue.

#### Pourquoi ?

La session principale est un contexte partagé unique. Si deux messages étaient traités en parallèle (ex: un utilisateur et un cron au même moment), le Kin produirait deux réponses basées sur le même état du contexte, créant des incohérences dans l'historique.

#### Sources de messages enqueués

Toutes les sources convergent vers la même queue :

| Source | Exemple |
|---|---|
| **Utilisateur** | Message envoyé via l'interface de chat |
| **Autre Kin** | Message inter-Kins (`request` ou `inform`) |
| **Sous-Kin (mode `await`)** | Résultat d'une tâche via `report_to_parent`. **Déclenche un tour de traitement LLM** sur le Kin parent, qui peut ainsi exploiter le résultat et poursuivre son travail |

> **Note** : les résultats de crons et de sous-Kins en mode `async` ne passent pas par la queue. Ils sont déposés directement dans l'historique comme messages informatifs sans déclencher de traitement LLM. Seuls les sous-Kins en mode `await` entrent dans la queue, car le Kin parent attend le résultat pour continuer son travail (voir sections 7 et 8).

#### Priorité

Les messages **utilisateur** sont prioritaires sur les messages automatiques (inter-Kins, tâches). Si un utilisateur envoie un message alors que la queue contient déjà des messages automatiques en attente, son message est inséré **en tête de queue** (après le message en cours de traitement).

#### Feedback UI

| Situation | Comportement |
|---|---|
| **Kin en cours de traitement** | L'interface affiche un indicateur de traitement en cours (typing indicator) |
| **Messages en attente** | Un badge sur le Kin dans la sidebar indique le nombre de messages en queue |
| **Message utilisateur enqueué** | L'utilisateur voit son message affiché dans le chat avec un statut "en attente de traitement" jusqu'a ce que le Kin le prenne en charge |

---

## 6. Communication inter-Kins

Les Kins disposent d'outils natifs pour communiquer entre eux au sein de la plateforme.

### Messagerie directe

Un Kin peut envoyer un message a un autre Kin de la plateforme. Le message est déposé dans la queue FIFO du Kin destinataire, qui le traite a son tour.

Outils disponibles :

| Outil | Description |
|---|---|
| `send_message(kin_id, message, type)` | Envoie un message a un Kin cible. `type` est `request` (réponse attendue) ou `inform` (informatif, pas de réponse attendue). Si `type` est `request`, le système génère un `request_id` unique retourné a l'expéditeur |
| `reply(request_id, message)` | Répond a un `request` reçu. La réponse est déposée dans la queue FIFO du Kin demandeur, **corrélée au request original** via le `request_id`. La réponse est toujours de type `inform` — elle ne déclenche jamais de réponse automatique du destinataire |
| `list_kins()` | Liste les Kins disponibles sur la plateforme |

Cela permet la collaboration entre Kins sans intervention humaine (ex: un Kin "Recherche" qui transmet ses résultats a un Kin "Rédaction").

### Flux d'un échange inter-Kins (request/reply)

```
1. Kin A appelle send_message(kin_B, "Recherche les prix des vols pour Rome", "request")
   → le système génère request_id: "req_abc123"
   → le message entre dans la queue FIFO de Kin B (type: request, request_id: req_abc123, from: Kin A)
   → Kin A reçoit le request_id pour référence

2. Kin B traite le message, voit que c'est un request de Kin A
   → Kin B effectue son travail...
   → Kin B appelle reply("req_abc123", "Voici les 3 meilleurs vols...")
   → la réponse entre dans la queue FIFO de Kin A (type: inform, in_reply_to: req_abc123)

3. Kin A traite la réponse et peut la corréler a sa demande originale grâce au request_id
```

La réponse via `reply` est **toujours de type `inform`**, ce qui garantit par design qu'elle ne déclenche pas de réponse automatique en retour. Pas de ping-pong possible.

### Garde-fous

Pour éviter les boucles infinies de messages entre Kins (A envoie a B, B répond a A, A réagit, etc.) :

| Mécanisme | Description |
|---|---|
| **Type de message** | Chaque message inter-Kins porte un type : `request` (réponse attendue) ou `inform` (informatif, pas de réponse attendue). Un message `inform` ne déclenche pas de réponse automatique. Les réponses via `reply` sont toujours `inform` |
| **Corrélation** | Chaque `request` porte un `request_id` unique. La réponse via `reply(request_id, message)` est corrélée au request original, permettant au Kin demandeur de faire le lien entre sa question et la réponse reçue |
| **Rate limiting** | Limite du nombre de messages qu'un Kin peut envoyer a un autre Kin dans une fenêtre de temps donnée |
| **Compteur de profondeur** | Chaque chaîne de messages inter-Kins porte un compteur incrémenté a chaque échange. Au-delà d'un seuil configurable, la chaîne est interrompue |

---

## 7. Spawning de sous-Kins (Tâches)

Un Kin peut **spawner un sous-Kin** pour déléguer une tâche temporaire. Le sous-Kin est une instance éphémère créée dans un but précis, qui disparaît une fois la tâche terminée.

### Deux modes de spawning

| Mode | Description |
|---|---|
| **Clone de soi-même** | Le Kin crée une copie de lui-même (même caractère, même expertise) dédiée a une sous-tâche spécifique |
| **Spawn d'un autre Kin** | Le Kin instancie un autre Kin de la plateforme pour lui confier une tâche qui relève de l'expertise de cet autre Kin |

### Cycle de vie d'une tâche

Une tâche (sous-Kin) possède un **état** qui évolue au cours de son exécution :

```
pending → in_progress → completed
                      → failed
                      → cancelled
```

### Outils du sous-Kin

Le sous-Kin dispose d'outils pour interagir avec sa session parente :

| Outil | Description |
|---|---|
| `report_to_parent(message)` | Envoie un message / un résultat intermédiaire a la session parente |
| `update_task_status(status)` | Met a jour l'état de la tâche (`in_progress`, `completed`, `failed`) |
| `request_input(question)` | Demande une clarification ou une décision au Kin parent. La question est déposée dans la queue FIFO du parent et **déclenche un tour LLM** pour qu'il puisse répondre via `respond_to_task`. Limité a **3 appels par sous-Kin** pour éviter un ping-pong interminable — au-delà, le sous-Kin doit avancer avec ce qu'il a ou échouer |

### Outils du Kin parent

Le Kin parent dispose d'outils pour gérer ses sous-Kins :

| Outil | Description |
|---|---|
| `spawn_self(task_description, mode, model?)` | Clone de soi-même avec une mission spécifique. Si `model` est omis, le sous-Kin hérite du modèle du parent |
| `spawn_kin(kin_id, task_description, mode, model?)` | Instancie un autre Kin avec une mission spécifique. Si `model` est omis, le sous-Kin hérite du modèle du Kin cible |
| `respond_to_task(task_id, answer)` | Répond a une demande de clarification d'un sous-Kin (`request_input`). La réponse est injectée dans la session du sous-Kin et déclenche la reprise de son traitement |
| `cancel_task(task_id)` | Annule une tâche en cours |
| `list_tasks()` | Liste les tâches en cours et leur état |

### Modes de spawning

Le paramètre `mode` détermine le comportement du Kin parent après le spawn :

| Mode | Comportement |
|---|---|
| **`await`** | Le Kin parent **attend le résultat** du sous-Kin avant de reprendre. Son tour de traitement se termine, et quand le sous-Kin complète sa tâche, le résultat entre dans la queue FIFO et **déclenche un tour LLM** pour que le parent puisse exploiter le résultat et poursuivre son travail. Utile quand le résultat est nécessaire pour continuer (ex: "recherche ces infos, j'en ai besoin pour rédiger la suite") |
| **`async`** | Le Kin parent **continue a travailler** sans attendre. Le résultat du sous-Kin est déposé dans la session principale comme message informatif (comme un cron), **sans déclencher de traitement LLM**. Le Kin verra le résultat dans son contexte au prochain échange naturel. Utile pour les tâches parallèles indépendantes (ex: "génère cette image pendant que je continue a discuter") |

Le mode par défaut est **`await`**, car dans la majorité des cas le Kin a besoin du résultat pour poursuivre.

### Flux de clarification (`request_input`)

Quand un sous-Kin a besoin d'une clarification du parent, le flux est le suivant :

```
1. Parent spawne sous-Kin (mode await) → tour LLM parent TERMINE
2. Sous-Kin travaille...
3. Sous-Kin appelle request_input(question)
   → la question entre dans la queue FIFO du parent (type: task_input)
   → déclenche un nouveau tour LLM sur le parent
4. Parent voit la question, appelle respond_to_task(task_id, answer)
   → la réponse est injectée dans la session du sous-Kin
   → déclenche la reprise du sous-Kin
5. Sous-Kin termine → report_to_parent(result)
   → entre dans la queue FIFO du parent
   → déclenche un nouveau tour LLM sur le parent
```

Il n'y a **aucun deadlock** car personne n'est bloqué dans un thread : ce sont des tours LLM successifs déclenchés par des messages dans la queue. Le parent ne "bloque" pas en attendant — son tour se termine simplement, et un nouveau tour est déclenché quand un message arrive.

> **Garde-fou** : le nombre de `request_input` par sous-Kin est limité (par défaut : 3). Au-delà, le sous-Kin doit avancer avec les informations dont il dispose ou passer en état `failed`.

### Profondeur maximale

Le spawning est limité en profondeur : un sous-Kin **ne peut pas spawner de sous-Kins au-delà d'une profondeur configurable** (par défaut : 3 niveaux). Cela empêche les chaînes de délégation récursives incontrôlées.

### Résolution

Quand un sous-Kin termine sa tâche, il passe son état a `completed` et envoie son résultat final a la session parente via `report_to_parent`. Le comportement dépend du mode de spawning :
- **`await`** : le résultat entre dans la queue FIFO et déclenche un tour de traitement LLM sur le parent
- **`async`** : le résultat est déposé dans l'historique comme message informatif, sans déclencher de traitement

Le sous-Kin est ensuite détruit.

---

## 8. Tâches planifiées (Crons)

Les Kins peuvent exécuter des tâches de manière récurrente grâce a un système de **crons**. Un cron déclenche le spawn d'un sous-Kin a intervalle régulier, avec une mission définie. Le sous-Kin exécute sa tâche puis renvoie son résultat dans la session principale du Kin, exactement comme un sous-Kin classique (voir section 7).

### Qui peut créer un cron ?

| Source | Description |
|---|---|
| **L'utilisateur** | Via l'interface, il peut planifier une tâche récurrente sur un Kin |
| **Le Kin lui-même** | Via ses outils, il peut proposer la création d'une tâche récurrente. **En V1, la création nécessite une confirmation de l'utilisateur** avant d'être activée |

### Définition d'un cron

| Attribut | Description |
|---|---|
| **Nom** | Libellé de la tâche planifiée |
| **Expression cron** | Planification au format cron (ex: `0 9 * * *` pour tous les jours a 9h) |
| **Description de la tâche** | Instructions données au sous-Kin a chaque exécution |
| **Kin cible** | Le Kin sur lequel le cron s'exécute (par défaut : soi-même) |
| **Modèle LLM** | Modèle utilisé par le sous-Kin du cron. Si non spécifié, hérite du modèle du Kin cible |
| **Actif / Inactif** | Permet de suspendre un cron sans le supprimer |

### Outils du Kin pour gérer ses crons

| Outil | Description |
|---|---|
| `create_cron(name, schedule, task_description)` | Crée une nouvelle tâche planifiée |
| `update_cron(cron_id, ...)` | Modifie un cron existant (planification, description, état) |
| `delete_cron(cron_id)` | Supprime un cron |
| `list_crons()` | Liste ses tâches planifiées et leur état |

### Exécution

A chaque déclenchement, le système spawn un sous-Kin éphémère avec la description de la tâche du cron. Ce sous-Kin suit le même cycle de vie qu'une tâche classique (`pending → in_progress → completed/failed`).

### Restitution du résultat

Le résultat d'un cron est **déposé dans la session principale** du Kin comme un message informatif, mais **ne déclenche pas de tour de traitement LLM** sur l'agent principal. Contrairement a un message utilisateur ou inter-Kins qui entre dans la queue FIFO et nécessite une réponse, le résultat du cron est simplement ajouté a l'historique.

| Aspect | Comportement |
|---|---|
| **Visibilité** | Le résultat apparaît dans le chat (visible par l'utilisateur et par le Kin) |
| **Contexte** | Le Kin verra le résultat dans son contexte au prochain échange naturel (message utilisateur, message inter-Kins, etc.) |
| **Pas de blocage** | Le résultat ne passe pas par la queue FIFO et ne déclenche pas d'appel LLM. L'agent principal reste disponible |
| **Action si nécessaire** | Si le résultat du cron nécessite une action (ex: alerte), c'est au sous-Kin du cron de la prendre (envoyer une notification, un message inter-Kins, etc.) avant de terminer |

---

## 9. Stack technique

Architecture monolithique en un seul process, conçue pour un déploiement simple (un seul `docker run`).

### Backend

| Brique | Technologie | Rôle |
|---|---|---|
| **Runtime** | Bun | Runtime TypeScript natif, performant, SQLite intégré |
| **Framework HTTP** | Hono | API REST + SSE, léger, type-safe, middleware simple |
| **Base de données** | SQLite (via `bun:sqlite`) | Persistance en un seul fichier, zéro dépendance externe |
| **Recherche vectorielle** | sqlite-vec | Extension SQLite pour la recherche KNN sur les embeddings (mémoire long terme) |
| **Recherche textuelle** | SQLite FTS5 | Full-text search natif pour la recherche hybride (mémoire + historique) |
| **ORM** | Drizzle | Type-safe, migrations, requêtes proches du SQL |
| **LLM** | Vercel AI SDK (`ai`) | Orchestration multi-provider (Anthropic, OpenAI), streaming, tool calling |
| **Embeddings** | Vercel AI SDK (`ai`) | Génération d'embeddings multi-provider (OpenAI, Voyage AI) pour la mémoire long terme |
| **Auth** | Better Auth | Multi-user, sessions, compatible SQLite/Drizzle |
| **Crons** | croner | Scheduler in-process, pas besoin de Redis |
| **Real-time** | SSE (via Hono) | Streaming des réponses LLM et mises a jour des tâches |

### Frontend

| Brique | Technologie | Rôle |
|---|---|---|
| **Framework** | React | Composants UI, gestion d'état |
| **Bundler** | Vite | Dev server rapide, HMR, build optimisé |
| **Styling** | Tailwind CSS | Utility-first, rapide a prototyper |
| **Composants** | shadcn/ui | Composants accessibles et personnalisables, basés sur Radix UI |
| **AI Client** | Vercel AI SDK (`ai/react`) | Hooks React pour le streaming LLM (`useChat`, `useCompletion`) |

### Vue d'ensemble

```
KinBot
├── Frontend (React + Vite + Tailwind + shadcn/ui)
│   └── Vercel AI SDK (ai/react)
│
└── Backend (Bun + Hono)
    ├── Drizzle + SQLite (persistance)
    ├── Vercel AI SDK (orchestration LLM)
    ├── Better Auth (authentification)
    └── croner (tâches planifiées)
```

**Principe** : zéro dépendance d'infrastructure externe. Un seul process, un seul fichier DB, un seul conteneur Docker.

> **Documentation technique** :
> - [schema.md](schema.md) — Schéma détaillé de la base de données SQLite
> - [structure.md](structure.md) — Arborescence du projet et conventions
> - [prompt-system.md](prompt-system.md) — Construction du prompt système des Kins
> - [config.md](config.md) — Configuration centralisée et valeurs par défaut
> - [api.md](api.md) — Contrats API REST et SSE (request/response)
> - [compacting.md](compacting.md) — Algorithme de compacting et extraction de mémoires

---

## 10. Communication Frontend / Backend

### Approche hybride : REST + SSE

La communication entre le frontend et le backend repose sur deux canaux complémentaires :

| Canal | Usage | Direction |
|---|---|---|
| **API REST** | CRUD, actions utilisateur, envoi de messages | Client → Serveur |
| **SSE** (Server-Sent Events) | Streaming LLM, mises a jour de tâches, notifications | Serveur → Client |

### API REST

Toutes les opérations classiques passent par une API REST :

| Domaine | Exemples de routes |
|---|---|
| **Auth** | `POST /api/auth/login`, `POST /api/auth/register`, `POST /api/auth/logout` |
| **Compte** | `GET /api/me`, `PATCH /api/me` |
| **Kins** | `GET /api/kins`, `POST /api/kins`, `PATCH /api/kins/:id`, `DELETE /api/kins/:id` |
| **Chat** | `POST /api/kins/:id/messages` (envoie un message, déclenche le streaming SSE en réponse) |
| **Providers** | `GET /api/providers`, `POST /api/providers`, `PATCH /api/providers/:id` |
| **Tâches** | `GET /api/tasks`, `GET /api/tasks/:id` |
| **Crons** | `GET /api/crons`, `POST /api/crons`, `PATCH /api/crons/:id`, `DELETE /api/crons/:id` |
| **MCP** | `GET /api/mcp-servers`, `POST /api/mcp-servers` |

### SSE (Server-Sent Events)

Le SSE est utilisé pour tout ce qui est poussé du serveur vers le client en temps réel :

| Canal SSE | Contenu |
|---|---|
| **Chat stream** | Tokens du LLM en streaming lors d'une réponse du Kin (natif Vercel AI SDK) |
| **Événements** | Changement d'état d'une tâche, résultat d'un sous-Kin, exécution d'un cron, message inter-Kins |

Le frontend maintient une connexion SSE persistante par session active. Le Vercel AI SDK côté React (`useChat`) gère nativement le streaming SSE.

### Pourquoi pas WebSocket ?

- Le seul flux bidirectionnel est "user envoie un message / serveur stream la réponse", et REST + SSE couvre ça parfaitement
- SSE est plus simple a implémenter, débugger et maintenir (HTTP standard, reconnexion automatique native)
- Better Auth et Vercel AI SDK fonctionnent nativement en REST + SSE
- Pas de protocole custom a gérer

---

## 11. Authentification

### Mécanisme

L'authentification est gérée par **Better Auth** avec des sessions côté serveur stockées en SQLite.

| Aspect | Choix |
|---|---|
| **Méthode** | Email + mot de passe |
| **Sessions** | Côté serveur (stockées en DB via Drizzle) |
| **Token** | Cookie HTTP-only sécurisé |
| **Middleware** | Hono middleware qui vérifie la session sur chaque requête API |

### Flux

1. L'utilisateur se connecte via `POST /api/auth/login`
2. Better Auth crée une session en DB et renvoie un cookie HTTP-only
3. Chaque requête API et connexion SSE inclut automatiquement le cookie
4. Le middleware Hono valide la session avant de traiter la requête

### Multi-utilisateur

- Le premier utilisateur créé lors de l'onboarding est **administrateur**
- Les utilisateurs suivants peuvent être invités par l'administrateur
- **Les Kins sont partagés** entre tous les utilisateurs. Il n'y a pas de Kins "privés" : tous les utilisateurs accèdent au même squad de Kins
- Le système multi-utilisateur permet aux Kins de **reconnaître qui leur parle** (chaque message est tagué avec l'identité de l'utilisateur)
- L'administrateur gère les comptes utilisateurs et la configuration globale (providers, serveurs MCP)

---

## 12. Aspects opérationnels

### Upload de fichiers

Les utilisateurs peuvent envoyer des fichiers (images, PDF, documents) au Kin via l'interface de chat, de manière classique. Les fichiers sont stockés localement et référencés dans la session.

### Gestion des erreurs LLM

| Contexte | Comportement |
|---|---|
| **Dans une tâche (sous-Kin)** | La tâche passe en état `failed` avec le détail de l'erreur. Le Kin parent est notifié via `report_to_parent` |
| **Dans un agent principal** | Un **warning visuel** est affiché sur le Kin dans la sidebar, et un message d'erreur apparaît dans le chat pour informer l'utilisateur |

Les erreurs gérées incluent : rate limits du provider, timeouts, provider indisponible, réponse malformée.

### Limites de concurrence

| Ressource | Limite |
|---|---|
| **Agents principaux (Kins)** | Pas de limite — tous les Kins peuvent être actifs simultanément |
| **Tâches (sous-Kins)** | Limite configurable du nombre de tâches concurrentes (tous Kins confondus) |
| **Crons** | Limite configurable du nombre de crons actifs et du nombre d'exécutions concurrentes |

La seule contrainte sur les agents principaux est le rate limit du provider LLM.

---

## 13. Architecture extensible

L'architecture de KinBot est conçue dès le départ pour être **pluggable**, **hookable** et **observable**, afin de faciliter l'ajout futur d'un système de plugins.

### Interfaces standardisées (Providers)

Chaque type de service externe est abstrait derrière une interface TypeScript standard. Les implémentations concrètes sont interchangeables.

#### Architecture : configuration unique, capacités multiples

Un même provider (ex: OpenAI) peut offrir plusieurs capacités (LLM, embeddings, images). Pour éviter de configurer la même API key plusieurs fois, l'architecture sépare la **configuration du provider** de ses **capacités** :

```typescript
// Configuration unique du provider (une seule API key)
interface ProviderConfig {
  id: string
  name: string
  type: 'anthropic' | 'openai' | 'gemini' | 'brave-search' | string
  config: Record<string, unknown>  // API key, base URL, etc.

  // Validation
  validateConfig(): Promise<boolean>
  testConnection(): Promise<boolean>

  // Capacités exposées par ce provider
  capabilities: ProviderCapability[]  // ['llm', 'embedding', 'image', 'search']
}

type ProviderCapability = 'llm' | 'embedding' | 'image' | 'search'
```

A partir d'un `ProviderConfig`, le système instancie les interfaces de capacité correspondantes. L'utilisateur configure un provider **une seule fois** (ex: "OpenAI" avec sa clé API), et la plateforme détecte automatiquement les capacités disponibles ou l'utilisateur les active manuellement.

#### AI Providers

| Provider | Capacités |
|---|---|
| **Anthropic** | `llm` |
| **OpenAI** | `llm`, `embedding`, `image` |
| **Gemini** | `llm`, `image` |
| **Voyage AI** | `embedding` |

#### Search Providers

| Provider | Capacités |
|---|---|
| **Brave Search** | `search` |

#### LLM Capability

```typescript
interface LLMCapability {
  // Complétion
  chat(params: ChatParams): AsyncIterable<ChatStreamEvent>

  // Capacités
  supportsTools(): boolean
  supportsVision(): boolean
  listModels(): Promise<Model[]>
}
```

#### Embedding Capability

```typescript
interface EmbeddingCapability {
  // Génération d'embeddings
  embed(params: EmbedParams): Promise<number[][]>

  // Modèles disponibles
  listModels(): Promise<EmbeddingModel[]>
}
```

#### Image Capability

```typescript
interface ImageCapability {
  // Génération d'image
  generate(params: ImageGenerationParams): Promise<GeneratedImage>
}
```

#### Search Capability

```typescript
interface SearchCapability {
  // Recherche web
  search(params: SearchParams): Promise<SearchResult[]>
}

interface SearchParams {
  query: string
  count?: number     // nombre de résultats (défaut: 5)
  freshness?: string // filtre de fraîcheur (ex: "day", "week", "month")
}

interface SearchResult {
  title: string
  url: string
  description: string
  age?: string
}
```

Quand un Kin a besoin d'un appel LLM, le système résout quel `ProviderConfig` utiliser a partir du modèle configuré sur le Kin. Quand le pipeline de mémoire a besoin d'embeddings, il utilise le `ProviderConfig` qui expose la capacité `embedding`. Même logique pour la génération d'images et la recherche web.

Ces interfaces permettent d'ajouter de nouveaux providers (Mistral, Groq, local/Ollama...) sans modifier le code existant.

### Event Bus

Un bus d'événements central permet a n'importe quelle partie du système d'émettre et d'écouter des événements. C'est le socle de l'observabilité et du futur système de plugins.

```typescript
interface EventBus {
  emit(event: KinBotEvent): void
  on(eventType: string, handler: EventHandler): Unsubscribe
}
```

Événements émis par le système :

| Catégorie | Événements |
|---|---|
| **Kin** | `kin.created`, `kin.deleted`, `kin.message.received`, `kin.message.sent` |
| **Tâche** | `task.spawned`, `task.status.changed`, `task.completed`, `task.failed` |
| **Cron** | `cron.created`, `cron.triggered`, `cron.execution.completed` |
| **Contact** | `contact.created`, `contact.updated` |
| **Auth** | `user.login`, `user.logout`, `user.created` |
| **Provider** | `provider.added`, `provider.removed`, `provider.error` |

### Hooks

Des points d'accroche définis a des moments clés du cycle de vie permettent d'intercepter ou d'enrichir le comportement par défaut :

| Hook | Moment | Usage possible |
|---|---|---|
| `beforeChat` | Avant l'envoi au LLM | Modifier le prompt, ajouter du contexte, filtrer |
| `afterChat` | Après la réponse du LLM | Logger, post-traiter, déclencher des actions |
| `beforeToolCall` | Avant l'exécution d'un outil | Validation, rate limiting, audit |
| `afterToolCall` | Après l'exécution d'un outil | Logger le résultat, déclencher des side effects |
| `beforeCompacting` | Avant le compacting d'une session | Extraire des infos a sauvegarder |
| `afterCompacting` | Après le compacting | Vérifier la qualité du résumé |
| `onTaskSpawn` | Au spawn d'un sous-Kin | Appliquer des limites, logger |
| `onCronTrigger` | Au déclenchement d'un cron | Conditionner l'exécution |

### Préparation au système de plugins

Ces trois piliers (interfaces, event bus, hooks) sont les fondations du futur système de plugins. Un plugin pourra :
- Enregistrer un nouveau type de provider (LLM, image, ou autre)
- Écouter des événements via l'event bus
- S'accrocher aux hooks pour modifier le comportement
- Exposer de nouveaux outils MCP aux Kins
- Ajouter des routes API et des composants UI

---

## 14. Navigation web stateful

Au-delà des outils one-shot historiques (`browse_url`, `extract_links`, `screenshot_url`, `http_request`) qui font une requête isolée, KinBot fournit une famille de **14 outils `browser_*`** qui opèrent sur une **session de navigateur persistante par Kin**. Pile sous-jacente : Playwright + Chromium, avec stealth plugin (`playwright-extra` + `puppeteer-extra-plugin-stealth`).

### Cas d'usage

- **Login + scraping authentifié** : se connecter une fois (ou injecter des cookies déjà valides), puis naviguer, lire, soumettre des formulaires en restant authentifié sur plusieurs tours LLM
- **Workflows multi-étapes** : remplir un formulaire en 3 pages, valider une commande, naviguer un dashboard
- **Interaction avec des SPAs** : cliquer, taper, attendre des transitions React/Vue/Angular
- **Resolution de captcha en HITL** : voir `browser_request_human` plus bas

### Tools disponibles

Tous opt-in par Kin via `tool_config.enabledOptInTools` (jamais activés par défaut).

| Tool | Rôle |
|---|---|
| `browser_open_session` | Ouvre une session, optionnellement avec une URL de départ et une injection de cookies |
| `browser_close_session` | Ferme la session et libère les ressources |
| `browser_list_sessions` | Liste les sessions actives du Kin |
| `browser_navigate` | Va à une URL dans la session |
| `browser_click` / `browser_type` / `browser_select` / `browser_press_key` | Actions sur des éléments référencés via le snapshot |
| `browser_scroll` / `browser_wait_for` | Navigation passive (scroll, attente de condition) |
| `browser_screenshot` | Capture la page et sauve en fichier shareable |
| `browser_set_cookies` / `browser_get_cookies` / `browser_clear_cookies` | Gestion des cookies de la session |
| `browser_request_human` | Pause + screenshot + bouton continuer (pour captcha / blocage visuel) |

### Identification des éléments — accessibility snapshot

Plutôt que d'imposer au LLM de générer des sélecteurs CSS fragiles, chaque action retourne un **`page_state`** en YAML qui liste les éléments interactables avec une référence stable du type `e1`, `e2`, etc. :

```yaml
url: https://example.com/login
title: Login
elements:
  - ref: e1
    role: textbox
    name: "Email"
  - ref: e2
    role: textbox
    name: "Password"
  - ref: e3
    role: button
    name: "Sign in"
```

Le Kin appelle ensuite `browser_click({ ref: "e3" })`. En interne, on tagge les éléments via un attribut `data-kbref="eN"` injecté côté navigateur, et on résout les références via le sélecteur `[data-kbref="eN"]`. Le pattern est inspiré de Playwright MCP (Microsoft) et browser-use, et donne des résultats beaucoup plus robustes qu'un sélecteur CSS hallucinable.

### Cookies — accès authentifié sans login

`browser_open_session` et `browser_set_cookies` acceptent au choix :

- Un **tableau JSON** de cookies (format Playwright/Puppeteer) : `[{ name, value, domain, path?, expires?, httpOnly?, secure?, sameSite? }, ...]`
- Une **header string** (`name1=v1; name2=v2; ...`) avec un `default_cookie_domain` requis

Pattern typique : l'utilisateur se logge dans son propre navigateur, exporte les cookies via une extension type "Cookie Editor", les colle dans le chat → le Kin ouvre une session pré-loadée et arrive directement authentifié.

### Lifecycle et garde-fous

- **1 session active max par Kin** par défaut, configurable via `BROWSER_MAX_SESSIONS_PER_KIN`
- **5 sessions actives globales** par défaut, configurable via `BROWSER_MAX_TOTAL_SESSIONS`
- **Idle GC** après 10 min sans appel
- **TTL absolu** de 1 h depuis l'ouverture
- **Auto-close** à la fin d'une task (`resolveTask`), à la suppression d'un Kin (`deleteKin`), au SIGTERM/SIGINT du serveur

Tous configurables via env vars (`BROWSER_SESSION_TTL_MS`, `BROWSER_SESSION_IDLE_TIMEOUT_MS`, etc.). Voir `config.md` pour la liste complète.

### Human-in-the-loop — `browser_request_human`

Quand un Kin se heurte à un captcha ou un blocage visuel qu'il ne peut pas résoudre programmatiquement, il appelle `browser_request_human({ session_id, reason })`. Le tool :

1. Capture un screenshot full-page
2. Sauve le PNG via le file storage (URL shareable)
3. Crée un human prompt avec le screenshot embarqué inline (markdown image dans la `description`)
4. La task passe en `awaiting_human_input` et l'UI affiche la carte avec deux boutons (continuer / annuler)

L'utilisateur résout le blocage externalement (par exemple en exportant ses cookies puis en les ré-injectant via `browser_set_cookies`), puis clique « C'est résolu ». La task reprend avec la réponse injectée dans l'historique du Kin.

L'implémentation **réutilise entièrement** l'infra `humanPrompts` existante : pas de nouveau type de prompt, pas de migration DB, pas de composant UI dédié. Le rendu est universel grâce au support du markdown image dans `HumanPromptCard`.

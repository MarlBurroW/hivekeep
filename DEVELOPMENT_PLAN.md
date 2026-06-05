# KinBot — Plan de développement

> ⚠️ **Document historique.** Ce plan a guidé le développement initial (Phases 0-9, architecture provider monolithique avec Vercel AI SDK). Depuis, plusieurs gros refactors ont eu lieu :
> - Suppression de Vercel AI SDK, primitives natives `LLMProvider`/`EmbeddingProvider`/`ImageProvider`
> - Système de plugins (`packages/sdk`, `plugins/`)
> - Consolidation "one row per provider account + `capabilities[]`" (l'ancien "one row per family" a été supprimé via les migrations 0072/0073)
> - Image generation multi-input + per-model `params` découverts via `describe_image_model`
> - **Suppression du Hub Kin** : tous les Kins sont égaux ; les channels se bindent directement sur n'importe quel Kin.
> - **Onboarding redesign** : `completed = hasAdmin` uniquement. L'onboarding ne demande plus que Identité + Préférences (2 écrans). La configuration des providers, modèles par défaut et premier Kin est gérée post-onboarding via une **setup checklist** capability-aware (7 items, skip persisté globalement). Bannières "missing capability" inline aux points d'usage (ChatPanel, KinToolsTab, MemoryList, AvatarPickerModal, wizard KinFormModal). Voir [`idea.md` section 1](./idea.md) pour le détail.
> - **Snapshot DB** : `bun run db:snapshot [label]` / `db:snapshot:list` / `db:snapshot:restore <name> --yes` — VACUUM INTO atomique, snapshots sous `data/snapshots/<timestamp>[__label]/`. Pratique pour boucler sur la validation onboarding avec une DB fraîche puis restaurer.
>
> Les noms de fichiers, structures de dossiers et certaines interfaces décrits ci-dessous ne reflètent plus la réalité. **Pour l'état actuel**, voir : [`structure.md`](./structure.md), [`packages/sdk/src/index.ts`](./packages/sdk/src/index.ts) (surface publique), [`src/server/llm/llm/registry.ts`](./src/server/llm/llm/registry.ts) (LLM providers), [`src/server/providers/index.ts`](./src/server/providers/index.ts) (dispatcher). Les sections ci-dessous restent utiles pour comprendre les décisions originales et le séquencement des phases ; suivre les checkboxes sans recouper avec le code actuel mènera à l'erreur.

Ce document sert de feuille de route pour le développement de KinBot. Chaque phase est conçue pour être autonome et testable. Les phases doivent être suivies dans l'ordre car chacune dépend des précédentes.

**Convention** : chaque tâche est marquée `[ ]` (à faire), `[~]` (en cours), ou `[x]` (terminé).

---

## Phase 0 — Initialisation du projet

Mise en place du monorepo, de la toolchain, et des fichiers de configuration.

- [x] **0.1** Initialiser le projet avec `bun init`
- [x] **0.2** Configurer `package.json` avec les scripts (`dev`, `build`, `start`, `db:migrate`, `db:push`)
- [x] **0.3** Configurer `tsconfig.json` (strict, paths aliases `@/server/*`, `@/client/*`, `@/shared/*`)
- [x] **0.4** Installer et configurer Vite (`vite.config.ts`) avec proxy API vers le backend en dev
- [x] **0.5** Installer et configurer Tailwind CSS (`tailwind.config.ts`) avec design tokens
- [x] **0.6** Installer et configurer shadcn/ui (`components.json`) — ajouter les composants de base (Button, Input, Card, Dialog, etc.)
- [x] **0.7** Installer et configurer Drizzle (`drizzle.config.ts`) pour SQLite via `bun:sqlite`
- [x] **0.8** Créer l'arborescence de dossiers conforme à `structure.md`
- [x] **0.9** Créer `src/shared/types.ts` et `src/shared/constants.ts` avec les types et constantes partagés
- [x] **0.10** Créer `src/server/config.ts` avec la configuration centralisée (tel que décrit dans `config.md`)
- [x] **0.11** Configurer le Docker (`docker/Dockerfile`, `docker/docker-compose.yml`)
- [x] **0.12** Installer i18next + react-i18next, créer `src/client/locales/en.json` et `fr.json` (squelettes vides)
- [x] **0.13** Créer `src/client/styles/globals.css` avec les design tokens (palette, typographie, spacing) et le dark mode

**Critère de validation** : `bun run dev` démarre le frontend (Vite) et le backend (Hono) sans erreur. La page par défaut s'affiche.

---

## Phase 0.5 — Design system et validation visuelle

> **BLOQUANT** : aucun développement frontend réel (pages, composants métier) ne démarre avant que cette phase soit **validée par le porteur du projet**. Le backend (phases 1-6) peut avancer en parallèle.

Création d'une page showcase présentant tous les éléments visuels de base. L'objectif est de valider la direction graphique (palette, typographie, composants, dark mode) avant de construire les vrais écrans.

- [x] **0.5.1** Créer `src/client/pages/design-system/DesignSystemPage.tsx` — page showcase accessible en dev à `/design-system`, avec les sections suivantes :

  **Palette de couleurs**
  - [x] **0.5.2** Afficher les couleurs primaires, secondaires, accent, success, warning, error, info
  - [x] **0.5.3** Afficher les couleurs de background et surface (light + dark)
  - [x] **0.5.4** Afficher les couleurs de texte (primary, secondary, muted, disabled)

  **Typographie**
  - [x] **0.5.5** Afficher la hiérarchie des titres (h1 → h6) avec la police choisie (Inter ou Plus Jakarta Sans)
  - [x] **0.5.6** Afficher les tailles de texte (body, small, caption, label)
  - [x] **0.5.7** Afficher les poids de police (regular, medium, semibold, bold)

  **Composants de base**
  - [x] **0.5.8** Buttons : toutes les variantes (primary, secondary, outline, ghost, destructive) × tailles (sm, md, lg) + états (default, hover, disabled, loading)
  - [x] **0.5.9** Inputs : text input, textarea, select, avec labels, placeholders, messages d'erreur, états (default, focus, error, disabled)
  - [x] **0.5.10** Cards : card basique, card avec header/footer, card interactive (hover), card avec image
  - [x] **0.5.11** Badges : variantes (default, success, warning, error, info) + tailles
  - [x] **0.5.12** Alerts : success, warning, error, info — avec et sans icône
  - [x] **0.5.13** Checkboxes, Radio buttons, Switch/Toggle
  - [x] **0.5.14** Dialog/Modal : exemple avec formulaire à l'intérieur
  - [x] **0.5.15** Tabs, Dropdown menu, Tooltip
  - [x] **0.5.16** Avatar : différentes tailles, avec image, avec initiales, avec indicateur de statut (online/offline/busy)

  **Patterns spécifiques KinBot**
  - [x] **0.5.17** Bulle de message : variante utilisateur (alignée à droite, couleur A), variante Kin (alignée à gauche, couleur B), variante système/tâche/cron (neutre) — avec avatar, nom, timestamp
  - [x] **0.5.18** Carte de Kin : aperçu d'un Kin dans la sidebar (avatar, nom, rôle, badge queue)
  - [x] **0.5.19** Indicateur de typing / streaming en cours
  - [x] **0.5.20** Indicateur d'état de tâche (pending, in_progress, completed, failed)

  **Spacing et layout**
  - [x] **0.5.21** Afficher l'échelle de spacing (4px, 8px, 12px, 16px, 24px, 32px, 48px, 64px)
  - [x] **0.5.22** Afficher les border-radius utilisés (coins arrondis généreux)
  - [x] **0.5.23** Afficher les ombres (shadows) sur les cards et éléments interactifs

  **Dark mode**
  - [x] **0.5.24** Toggle dark/light sur la page showcase — tous les éléments ci-dessus doivent fonctionner dans les deux thèmes (tons sombres chauds, pas de noir pur)

- [x] **0.5.25** Route `/design-system` accessible uniquement en mode développement (pas en production)

**Critère de validation** : le porteur du projet ouvre `/design-system`, passe en revue chaque section en light et dark mode, et **approuve** la direction visuelle. Les ajustements demandés sont appliqués avant de continuer.

> **Une fois validé** : les phases frontend (3, 7, 8, 9.6-9.10, etc.) peuvent démarrer en s'appuyant sur les composants et tokens approuvés. La page `/design-system` reste disponible en dev comme référence.

---

## Phase 1 — Base de données et schéma

Définition complète du schéma Drizzle et création de la base SQLite.

- [x] **1.1** Créer `src/server/db/index.ts` — connexion SQLite via `bun:sqlite` avec chargement des extensions (sqlite-vec, FTS5)
- [x] **1.2** Créer `src/server/db/schema.ts` — définir **toutes** les tables Drizzle conformes à `schema.md` :
  - Tables Better Auth : `user`, `session`, `account`, `verification`
  - Tables custom : `user_profiles`, `providers`, `kins`, `mcp_servers`, `kin_mcp_servers`, `messages`, `compacting_snapshots`, `memories`, `contacts`, `custom_tools`, `tasks`, `crons`, `vault_secrets`, `queue_items`, `files`
- [x] **1.3** Créer les index conformes au schéma (tous les `idx_*` documentés)
- [x] **1.4** Créer les tables virtuelles FTS5 (`memories_fts`, `messages_fts`) avec triggers de synchronisation
- [x] **1.5** Créer la table virtuelle sqlite-vec (`memories_vec`)
- [x] **1.6** Générer et exécuter la première migration Drizzle
- [ ] **1.7** (Optionnel) Créer `src/server/db/seed.ts` pour le développement

**Critère de validation** : `bun run db:push` crée la base avec toutes les tables. Vérifiable via `sqlite3 data/kinbot.db ".tables"`.

---

## Phase 2 — Authentification et gestion des utilisateurs

- [x] **2.1** Installer Better Auth et configurer `src/server/auth/index.ts` (adapter pour SQLite + Drizzle)
- [x] **2.2** Créer `src/server/auth/middleware.ts` — middleware Hono vérifiant la session (cookie HTTP-only) sur `/api/*` sauf `/api/auth/*` et `/api/onboarding/*`
- [x] **2.3** Créer `src/server/app.ts` — configuration Hono (CORS, middleware auth, montage des routes)
- [x] **2.4** Créer `src/server/index.ts` — point d'entrée (Hono app + serve static en prod)
- [x] **2.5** Créer les routes auth :
  - `src/server/routes/auth.ts` — `POST /api/auth/register`, `POST /api/auth/login`, `POST /api/auth/logout`
- [x] **2.6** Créer les routes profil :
  - `src/server/routes/me.ts` — `GET /api/me`, `PATCH /api/me`, `POST /api/me/avatar`
- [x] **2.7** Créer la route onboarding :
  - `src/server/routes/onboarding.ts` — `GET /api/onboarding/status`
- [x] **2.8** Frontend : créer `src/client/lib/api.ts` — client API (fetch wrapper avec credentials: 'include')
- [x] **2.9** Frontend : créer le hook `src/client/hooks/useAuth.ts`
- [x] **2.10** Frontend : créer `src/client/pages/login/LoginPage.tsx`
- [x] **2.11** Frontend : créer `src/client/App.tsx` — router avec redirection vers login ou onboarding si nécessaire

**Critère de validation** : un utilisateur peut s'inscrire, se connecter, se déconnecter. Le middleware bloque les requêtes non authentifiées. La page de login fonctionne.

---

## Phase 3 — Onboarding

- [x] **3.1** Frontend : créer `src/client/pages/onboarding/OnboardingPage.tsx` — wizard avec navigation entre étapes
- [x] **3.2** Frontend : créer `src/client/pages/onboarding/StepIdentity.tsx` — formulaire (photo, prénom, nom, email, pseudonyme, langue, mot de passe)
- [x] **3.3** Frontend : créer `src/client/pages/onboarding/StepProviders.tsx` — configuration des AI providers avec test de connexion en temps réel
- [x] **3.3b** Frontend : créer `src/client/pages/onboarding/StepSearchProviders.tsx` — configuration des search providers (step optionnel, même UX que StepProviders)
- [x] **3.4** Backend : logique de validation de l'onboarding (vérifier que les capacités `llm` et `embedding` sont couvertes)
- [x] **3.5** Backend : créer le premier `user_profiles` avec rôle `admin` à l'issue de l'onboarding
- [x] **3.6** Après onboarding réussi, redirection vers l'interface principale avec ouverture automatique de la modale de création du premier Kin

**Critère de validation** : un utilisateur neuf arrive sur le wizard, configure son profil et au moins un provider, et atterrit sur l'interface principale.

---

## Phase 4 — Providers IA

Gestion des providers et abstraction des capacités.

- [x] **4.1** Créer `src/server/providers/types.ts` — interfaces `ProviderConfig`, `LLMCapability`, `EmbeddingCapability`, `ImageCapability`
- [x] **4.2** Créer `src/server/providers/index.ts` — registry des providers, résolution par capacité
- [x] **4.3** Implémenter `src/server/providers/anthropic.ts` (LLM via Vercel AI SDK)
- [x] **4.4** Implémenter `src/server/providers/openai.ts` (LLM + Embedding + Image via Vercel AI SDK)
- [x] **4.5** Implémenter `src/server/providers/gemini.ts` (LLM + Image via Vercel AI SDK)
- [x] **4.6** Implémenter `src/server/providers/voyage.ts` (Embedding via Vercel AI SDK)
- [x] **4.6b** Implémenter `src/server/providers/brave-search.ts` (Search — Brave Web Search API)
- [x] **4.7** Créer `src/server/services/embeddings.ts` — service d'embedding (résolution du provider, génération de vecteurs)
- [x] **4.7b** Créer `src/server/services/search.ts` — service de recherche web (résolution du provider search, exécution des requêtes)
- [x] **4.8** Créer les routes :
  - `src/server/routes/providers.ts` — `GET /api/providers`, `POST /api/providers`, `PATCH /api/providers/:id`, `DELETE /api/providers/:id`, `POST /api/providers/:id/test`, `GET /api/providers/models`
- [x] **4.9** Implémenter le chiffrement des configs provider (`config_encrypted`) avec la clé `ENCRYPTION_KEY`

**Critère de validation** : on peut créer un provider (ex: OpenAI), tester la connexion, et lister les modèles disponibles via l'API.

---

## Phase 5 — Event bus et hooks

Infrastructure transversale utilisée par toutes les couches suivantes.

- [x] **5.1** Créer `src/server/services/events.ts` — event bus in-memory (`emit`, `on`, `off`)
- [x] **5.2** Créer `src/server/hooks/types.ts` — types des hooks (`HookContext`, `HookHandler`)
- [x] **5.3** Créer `src/server/hooks/index.ts` — registry des hooks + exécution chainée (`beforeChat`, `afterChat`, `beforeToolCall`, `afterToolCall`, `beforeCompacting`, `afterCompacting`, `onTaskSpawn`, `onCronTrigger`)

**Critère de validation** : on peut émettre un événement et le recevoir dans un listener. Les hooks peuvent être enregistrés et exécutés.

---

## Phase 6 — SSE (Server-Sent Events)

Communication temps réel du serveur vers le client.

- [x] **6.1** Créer `src/server/sse/types.ts` — types des événements SSE (`chat:token`, `chat:done`, `chat:message`, `task:status`, `task:done`, `cron:triggered`, `queue:update`, `kin:error`)
- [x] **6.2** Créer `src/server/sse/index.ts` — gestionnaire SSE (gestion des connexions, broadcast par kinId, cleanup)
- [x] **6.3** Créer `src/server/routes/sse.ts` — `GET /api/sse` (connexion SSE globale, une par client)
- [x] **6.4** Frontend : créer `src/client/hooks/useSSE.ts` — connexion SSE persistante, dispatch des événements par kinId, reconnexion automatique

**Critère de validation** : le frontend se connecte en SSE et reçoit un événement de test envoyé depuis le backend.

---

## Phase 7 — CRUD Kins (sans moteur LLM)

Gestion des Kins : création, édition, suppression, avatar.

- [x] **7.1** Créer les routes :
  - `src/server/routes/kins.ts` — `GET /api/kins`, `GET /api/kins/:id`, `POST /api/kins`, `PATCH /api/kins/:id`, `DELETE /api/kins/:id`, `POST /api/kins/:id/avatar`
- [x] **7.2** Logique de création du workspace du Kin (`{dataDir}/workspaces/{kinId}/`)
- [x] **7.3** Gestion des avatars (upload, génération automatique si provider image disponible, prompt personnalisé)
- [x] **7.4** Frontend : créer le hook `src/client/hooks/useKins.ts`
- [x] **7.5** Frontend : créer `src/client/components/kin/KinCreateModal.tsx`
- [x] **7.6** Frontend : créer `src/client/components/kin/KinCard.tsx`
- [x] **7.7** Frontend : créer `src/client/components/kin/KinSettingsModal.tsx`

**Critère de validation** : on peut créer, modifier et supprimer un Kin via l'interface. Le workspace est créé sur le disque.

---

## Phase 8 — Interface principale (layout)

Layout global de l'application : sidebar + panel de chat.

- [x] **8.1** Frontend : créer `src/client/components/sidebar/AppSidebar.tsx` — layout avec sections Kins, Tâches, liens vers Mon compte et Settings
- [x] **8.2** Frontend : créer `src/client/components/sidebar/KinList.tsx` — liste des Kins avec badges (queue, statut)
- [x] **8.3** Frontend : créer `src/client/components/sidebar/TaskList.tsx` — liste des tâches en cours
- [x] **8.4** Frontend : créer `src/client/pages/chat/ChatPage.tsx` — layout sidebar + panel principal
- [x] **8.5** Utilisation des composants Avatar et Badge existants de shadcn/ui
- [x] **8.6** Frontend : créer les pages settings :
  - `src/client/pages/settings/SettingsPage.tsx`
  - `src/client/pages/settings/ProvidersSettings.tsx` (AI providers)
  - [x] `src/client/pages/settings/SearchProvidersSettings.tsx` (search providers — même pattern que ProvidersSettings, composants partagés)
  - McpSettings et VaultSettings en stub dans les tabs
- [x] **8.7** Frontend : créer `src/client/pages/account/AccountPage.tsx`

**Critère de validation** : le layout complet est visible. On peut naviguer entre les Kins dans la sidebar et accéder aux pages settings/compte.

---

## Phase 9 — Queue FIFO et moteur Kin (coeur du système)

Orchestration LLM, queue de messages, construction du prompt, streaming.

- [x] **9.1** Créer `src/server/services/queue.ts` — queue FIFO par Kin (enqueue, dequeue, priorité user > auto, poll)
- [x] **9.2** Créer `src/server/services/prompt-builder.ts` — construction du prompt système conforme à `prompt-system.md` (blocs 1-8)
- [x] **9.3** Créer `src/server/services/kin-engine.ts` — orchestration LLM :
  - Récupération du message de la queue
  - Construction du contexte (prompt système + compacting summary + messages récents)
  - Appel LLM via Vercel AI SDK avec streaming
  - Émission SSE des tokens (`chat:token`) et fin (`chat:done`)
  - Sauvegarde du message assistant en DB
  - Émission d'événements sur l'event bus
  - Exécution des hooks `beforeChat` / `afterChat`
- [x] **9.4** Créer la route messages :
  - `src/server/routes/messages.ts` — `POST /api/kins/:id/messages` (enqueue + réponse 202), `GET /api/kins/:id/messages` (historique paginé)
- [x] **9.5** Intégrer le worker de queue : boucle de traitement qui poll les queues de tous les Kins actifs
- [x] **9.6** Frontend : créer `src/client/hooks/useChat.ts` — gestion du streaming SSE, optimistic updates
- [x] **9.7** Frontend : créer `src/client/components/chat/ChatPanel.tsx` — affichage des messages + streaming
- [x] **9.8** Frontend : créer `src/client/components/chat/MessageBubble.tsx` — bulle de message avec distinction visuelle par source (user, kin, task, cron)
- [x] **9.9** Frontend : créer `src/client/components/chat/MessageInput.tsx` — input avec envoi de message
- [x] **9.10** Frontend : créer `src/client/components/chat/TypingIndicator.tsx`
- [x] **9.11** Émettre `queue:update` en SSE à chaque changement de la queue (taille, isProcessing)

**Critère de validation** : on peut envoyer un message à un Kin et recevoir une réponse streamée en temps réel. Le message est sauvegardé en DB et visible dans l'historique.

---

## Phase 10 — Outils natifs de base (Tool calling)

Intégration du tool calling Vercel AI SDK et outils fondamentaux.

- [x] **10.1** Créer `src/server/tools/types.ts` — types `ToolDefinition`, `ToolResult`
- [x] **10.2** Créer `src/server/tools/index.ts` — registry de tous les outils, résolution par contexte (main agent vs sub-Kin)
- [x] **10.3** Intégrer le tool calling dans `kin-engine.ts` — passage des tools au LLM, exécution des appels, boucle outil-réponse
- [x] **10.4** Implémenter les hooks `beforeToolCall` / `afterToolCall`
- [x] **10.5** Créer `src/server/tools/search-tools.ts` — `web_search(query, count?, freshness?)` (via search provider, conditionné à la présence d'un provider avec capacité `search`)

**Critère de validation** : le Kin peut appeler un outil natif et utiliser le résultat dans sa réponse. Si un search provider est configuré, le Kin peut rechercher sur le web.

---

## Phase 11 — Contacts

Registre de contacts par Kin.

- [x] **11.1** Créer `src/server/services/contacts.ts` — CRUD contacts, injection du résumé compact dans le prompt
- [x] **11.2** Créer `src/server/tools/contact-tools.ts` — `get_contact`, `search_contacts`, `create_contact`, `update_contact`
- [x] **11.3** Intégrer l'injection du bloc [4] (contacts) dans `prompt-builder.ts`

**Critère de validation** : le Kin peut créer et consulter des contacts via ses outils. Le résumé compact apparaît dans le prompt système.

---

## Phase 12 — Mémoire long terme

Pipeline d'extraction, recall, memorize, recherche hybride.

- [x] **12.1** Créer `src/server/services/memory.ts` — CRUD mémoires, génération d'embeddings, recherche hybride (sqlite-vec KNN + FTS5 rank fusion)
- [x] **12.2** Créer `src/server/tools/memory-tools.ts` — `recall`, `memorize`, `update_memory`, `forget`, `list_memories`
- [x] **12.3** Intégrer l'injection du bloc [5] (mémoires pertinentes) dans `prompt-builder.ts` — recherche sémantique à partir du message entrant
- [x] **12.4** Créer `src/server/tools/history-tools.ts` — `search_history` (recherche hybride sur les messages)

**Critère de validation** : le Kin peut mémoriser et rappeler des informations. La recherche hybride retourne des résultats pertinents. Les mémoires sont injectées dans le prompt.

---

## Phase 13 — Compacting

Résumé automatique des sessions et extraction de mémoires.

- [x] **13.1** Créer `src/server/services/compacting.ts` conforme à `compacting.md` :
  - Évaluation du seuil (messages + tokens)
  - Sélection des messages à compacter (exclusion `redact_pending`)
  - Appel LLM pour générer le résumé
  - Sauvegarde du snapshot (activer/désactiver)
  - Nettoyage des anciens snapshots
  - Déclenchement du pipeline d'extraction de mémoires
- [x] **13.2** Intégrer l'injection du bloc [9] (compacted summary) dans la construction des messages du contexte
- [x] **13.3** Déclencher le compacting après chaque tour LLM dans `kin-engine.ts`
- [x] **13.4** Créer les routes compacting :
  - Routes dans `src/server/routes/kins.ts` : `POST /api/kins/:id/compacting/purge`, `GET /api/kins/:id/compacting/snapshots`, `POST /api/kins/:id/compacting/rollback`
- [x] **13.5** Créer les routes memories (gestion via UI) :
  - `GET /api/kins/:id/memories`, `DELETE /api/kins/:id/memories/:memoryId`

**Critère de validation** : après ~50 messages, le compacting se déclenche automatiquement. Le résumé apparaît en contexte. Les mémoires sont extraites. La purge et le rollback fonctionnent.

---

## Phase 14 — Vault (secrets)

Gestion des secrets chiffrés et caviardage.

- [x] **14.1** Créer `src/server/services/vault.ts` — CRUD secrets, chiffrement/déchiffrement AES-256-GCM, `redact_message`
- [x] **14.2** Créer `src/server/tools/vault-tools.ts` — `get_secret`, `redact_message`
- [x] **14.3** Créer les routes :
  - `src/server/routes/vault.ts` — `GET /api/vault`, `POST /api/vault`, `PATCH /api/vault/:id`, `DELETE /api/vault/:id`
- [x] **14.4** Implémenter la priorité du caviardage sur le compacting (bloquer le compacting si `redact_pending = 1`)

**Critère de validation** : on peut créer un secret, le Kin peut le lire via `get_secret`, et le caviardage fonctionne (le message est masqué et bloque le compacting).

---

## Phase 15 — Tâches (sous-Kins)

Spawning, cycle de vie, request_input, résolution.

- [x] **15.1** Créer `src/server/services/tasks.ts` — cycle de vie complet :
  - Spawn (clone de soi-même ou d'un autre Kin)
  - Modes `await` et `async`
  - Gestion de la profondeur (`depth`, max configurable)
  - Résolution : `completed`, `failed`, `cancelled`
  - Restitution dans la session parente (via queue pour `await`, informatif pour `async`)
- [x] **15.2** Créer `src/server/tools/task-tools.ts` — outils parent : `spawn_self`, `spawn_kin`, `respond_to_task`, `cancel_task`, `list_tasks`
- [x] **15.3** Créer `src/server/tools/subtask-tools.ts` — outils sous-Kin : `report_to_parent`, `update_task_status`, `request_input` (max 3 appels)
- [x] **15.4** Adapter `kin-engine.ts` pour exécuter un sous-Kin (prompt adapté, outils limités, contexte de tâche)
- [x] **15.5** Créer les routes :
  - `src/server/routes/tasks.ts` — `GET /api/tasks`, `GET /api/tasks/:id`, `POST /api/tasks/:id/cancel`
- [x] **15.6** Émettre les événements SSE : `task:status`, `task:done`
- [ ] **15.7** Frontend : mettre à jour `TaskList.tsx` dans la sidebar avec les tâches en cours et leur statut

**Critère de validation** : un Kin peut spawner un sous-Kin, le sous-Kin exécute sa tâche, le résultat revient dans la session parente. Le mode `await` et `async` fonctionnent. `request_input` est limité à 3.

---

## Phase 16 — Communication inter-Kins

Messagerie directe entre Kins avec garde-fous.

- [x] **16.1** Créer `src/server/services/inter-kin.ts` — `send_message`, `reply`, corrélation request_id, rate limiting, compteur de profondeur
- [x] **16.2** Créer `src/server/tools/inter-kin-tools.ts` — `send_message`, `reply`, `list_kins`
- [x] **16.3** Intégrer les messages inter-Kins dans la queue FIFO (type `kin_request`, `kin_inform`, `kin_reply`)
- [x] **16.4** Garantir que les `reply` sont toujours de type `inform` (pas de ping-pong)

**Critère de validation** : un Kin peut envoyer un `request` à un autre Kin, celui-ci répond via `reply`, et la réponse est corrélée au request original. Le rate limiting bloque les abus.

---

## Phase 17 — Crons (tâches planifiées)

Scheduler in-process avec croner.

- [x] **17.1** Créer `src/server/services/crons.ts` — scheduler croner, spawn de sous-Kin à chaque déclenchement, respect des limites (`maxActive`, `maxConcurrentExecutions`)
- [x] **17.2** Créer `src/server/tools/cron-tools.ts` — `create_cron`, `update_cron`, `delete_cron`, `list_crons`
- [x] **17.3** Créer les routes :
  - `src/server/routes/crons.ts` — `GET /api/crons`, `POST /api/crons`, `PATCH /api/crons/:id`, `DELETE /api/crons/:id`, `POST /api/crons/:id/approve`
- [x] **17.4** Logique d'approbation : un cron créé par un Kin nécessite une validation utilisateur (`requires_approval`)
- [x] **17.5** Restitution du résultat : déposé dans la session comme message informatif (pas de tour LLM)
- [x] **17.6** Émettre l'événement SSE `cron:triggered`

**Critère de validation** : un cron s'exécute à l'heure prévue, spawn un sous-Kin, et le résultat apparaît dans le chat. Un cron créé par un Kin attend l'approbation.

---

## Phase 18 — MCP Servers

Gestion des serveurs MCP et exposition des outils aux Kins.

- [x] **18.1** Créer les routes :
  - `src/server/routes/mcp-servers.ts` — `GET /api/mcp-servers`, `POST /api/mcp-servers`, `DELETE /api/mcp-servers/:id`
- [x] **18.2** Implémenter le lancement des processus MCP, la découverte des outils exposés, et leur injection dans le tool calling du Kin
- [x] **18.3** Gérer la liaison Kin ↔ MCP servers (table `kin_mcp_servers`)

**Critère de validation** : on peut configurer un serveur MCP, l'assigner à un Kin, et le Kin peut utiliser les outils exposés par le serveur.

---

## Phase 19 — Outils custom (auto-générés)

Permettre aux Kins de créer et gérer leurs propres outils.

- [x] **19.1** Créer `src/server/tools/custom-tool-tools.ts` — `register_tool`, `run_custom_tool`, `list_custom_tools`
- [x] **19.2** Implémenter l'exécution confinée au workspace du Kin (validation du path)
- [x] **19.3** Injecter les outils custom dans les tool definitions du Kin

**Critère de validation** : un Kin peut créer un script dans son workspace, l'enregistrer comme outil, et l'exécuter via `run_custom_tool`.

---

## Phase 20 — Upload de fichiers

- [x] **20.1** Créer `src/server/services/files.ts` — upload, stockage local, référencement en DB
- [x] **20.2** Créer les routes :
  - `src/server/routes/files.ts` — `POST /api/files/upload`
- [x] **20.3** Intégrer les fichiers dans les messages (référencement dans la table `files`, inclusion dans le contexte LLM)
- [ ] **20.4** Frontend : intégrer l'upload dans `MessageInput.tsx` (drag & drop, bouton d'ajout)

**Critère de validation** : un utilisateur peut envoyer un fichier avec son message. Le fichier est stocké et visible dans l'historique.

---

## Phase 21 — Génération d'images

- [x] **21.1** Créer `src/server/tools/image-tools.ts` — `generate_image` (via provider image)
- [x] **21.2** Conditionner la disponibilité de l'outil à la présence d'un provider avec capacité `image`

**Critère de validation** : si un provider image est configuré, le Kin peut générer des images. Sinon, l'outil n'est pas disponible.

---

## Phase 22 — Internationalisation

- [x] **22.1** Compléter `src/client/locales/en.json` et `fr.json` avec toutes les clés de l'interface
- [x] **22.2** Configurer `src/client/lib/i18n.ts` — détection de la langue à partir de `user_profiles.language`
- [x] **22.3** Remplacer tous les textes en dur dans les composants React par des appels `t('key')`

**Critère de validation** : l'interface affiche correctement en français et en anglais selon la préférence utilisateur. Le changement de langue est immédiat.

---

## Phase 23 — Dark mode

- [x] **23.1** Implémenter le thème sombre dans `globals.css` (custom properties CSS)
- [x] **23.2** S'assurer que tous les composants shadcn/ui et custom respectent les variables de thème
- [x] **23.3** Ajouter un toggle dark mode (ou suivre la préférence système)

**Critère de validation** : le dark mode fonctionne sur toute l'interface avec des tons sombres chauds.

---

## Phase 24 — Polissage et tests

- [x] **24.1** Gestion des erreurs LLM : retry sur rate limit, messages d'erreur dans le chat, warning dans la sidebar
- [x] **24.2** Limites de concurrence : vérifier `tasks.maxConcurrent` et `crons.maxConcurrentExecutions`
- [x] **24.3** Vérifier que la suppression d'un provider bloquée si c'est le dernier couvrant une capacité requise (`PROVIDER_REQUIRED`)
- [x] **24.4** Vérifier les garde-fous inter-Kins (rate limiting, profondeur max)
- [x] **24.5** Vérifier que la profondeur de spawning est respectée
- [x] **24.6** Responsive : s'assurer que la sidebar est utilisable sur tablette
- [x] **24.7** Performance : vérifier que le compacting et les embeddings ne bloquent pas le thread principal
- [x] **24.8** Sécurité : auditer les routes (injection SQL via Drizzle, XSS dans les messages, path traversal dans les workspaces)

**Critère de validation** : l'application est stable, les cas limites sont gérés, les performances sont acceptables.

---

## Phase 25 — Docker et déploiement

- [x] **25.1** Finaliser le `Dockerfile` (build multi-stage : Vite build + Bun runtime)
- [x] **25.2** Finaliser le `docker-compose.yml` (volume pour `data/`, env vars)
- [x] **25.3** Tester le déploiement complet via `docker run`
- [x] **25.4** Vérifier que les extensions SQLite (sqlite-vec, FTS5) fonctionnent dans le conteneur
- [x] **25.5** Générer automatiquement `ENCRYPTION_KEY` si absente au premier lancement

**Critère de validation** : `docker run -v ./data:/app/data -p 3000:3000 kinbot` lance l'application complète, fonctionnelle et persistante.

---

## Phase 26 — Projets & tickets

Système de projets avec tickets organisés en kanban. Permet à n'importe quel Kin de la plateforme de travailler sur n'importe quel projet via un état `active_project_id` injecté dans son prompt, et d'exécuter des tickets via le mécanisme de tasks (sub-Kins) existant. Spec complète : `projects.md`.

> **Préalable bloquant** : lift + rename du side panel existant (§ 26.0). Sans ce refactor, l'autre mode (Projets) ne peut pas accéder au panneau de détail task.

### 26.0 — Pré-requis : lift + rename du side panel

Le panneau latéral actuel ([`MiniAppContext`](../src/client/contexts/MiniAppContext.tsx) + [`MiniAppViewer`](../src/client/components/mini-app/MiniAppViewer.tsx)) héberge mini-apps et détail task via un système de tabs. Il vit dans `ChatPage` → `ChatPanel`, donc lié à la page Kins. On le lift au root et on le renomme pour refléter sa généralisation (mini-app + task + future ticket).

**On ne crée pas un système Inspector parallèle** : on réutilise toute la mécanique existante (tabs, streaming SSE de `useTaskDetail`, panel rendering, etc.). Cf. `projects.md` § 11.1.

- [ ] **26.0.1** Renommer le fichier `src/client/contexts/MiniAppContext.tsx` → `src/client/contexts/SidePanelContext.tsx`. Renommer dans le fichier : `MiniAppContext` → `SidePanelContext`, `MiniAppProvider` → `SidePanelProvider`, `useMiniAppPanel` → `useSidePanel`, `MiniAppContextValue` → `SidePanelContextValue`. Garder `TaskPanelInfo` tel quel (déjà bien nommé).
- [ ] **26.0.2** Mettre à jour tous les imports : `ChatPage.tsx`, `ChatPanel.tsx`, `MiniAppViewer.tsx`, `TaskList.tsx`, `MessageBubble.tsx`, `CronDetailModal.tsx`, `TaskPanelContent.tsx` (et tout autre fichier qui apparaît au grep). Vérifier `bun run build` sans erreur TypeScript.
- [ ] **26.0.3** Lifter `<SidePanelProvider>` de [`ChatPage.tsx:207`](../src/client/pages/chat/ChatPage.tsx#L207) vers [`App.tsx`](../src/client/App.tsx) (englober `<AppRoot />` ou les routes auth). Le provider doit englober TOUT ce qui est authentifié — login/onboarding/invite peuvent rester hors provider.
- [ ] **26.0.4** **Lift partiel du Viewer** : `<MiniAppViewer />` reste rendu dans `ChatPanel.tsx`. ProjectsPage (Phase 26.6) le rendra aussi dans son propre layout. Justification : lifter au root nécessite de restructurer le layout shadcn `SidebarInset`/`h-svh` de ChatPage avec un risque de régression supérieur au gain (le polling fallback de `useTaskDetail` à 1Hz couvre les transitions de mode). Aucune action de code requise dans cette sous-tâche — c'est une décision documentée.
- [ ] **26.0.5** Étendre `ActiveTab` dans `SidePanelContext` pour préparer le type `'ticket'` : `type ActiveTab = 'mini-app' | 'task' | 'ticket'`. Ajouter une signature `openTicket(info: TicketPanelInfo): void` au type, mais juste un stub qui no-op pour l'instant (le rendu et la logique viendront en Phase 26.7).
- [ ] **26.0.6** Vérifier que les events SSE existants (`task:status`, `task:done`, `chat:token`, `chat:done`, etc.) continuent à mettre à jour le panel task. Le hook `useTaskDetail` reste inchangé, seul son hôte (le panel) change de position dans l'arbre.
- [ ] **26.0.7** Vérifier que `openApp` reste invocable depuis la page Kins exclusivement (les boutons mini-apps ne sont rendus que dans `ChatPage`). Pas d'effort UX nécessaire — c'est juste une convention que la page ProjectsPage n'a pas de bouton `openApp`.
- [ ] **26.0.8** Tests manuels : (a) ouvrir une task depuis un thread → side panel apparaît à droite, (b) fermer → disparaît, (c) ouvrir mini-app puis task → tabs fonctionnent, (d) ouvrir task et naviguer (route change vers settings ou autre) → panel survit, (e) vérifier que SSE streaming d'une task en cours met toujours à jour le panel.

**Critère 26.0** : le side panel est invocable et survit aux changements de route. Le renommage est complet (zéro reference à `MiniAppContext`/`useMiniAppPanel` ailleurs que dans le fichier renommé). `bun run build` passe.

### 26.1 — Schéma DB

- [ ] **26.1.1** Ajouter dans `src/server/db/schema.ts` : tables `projects`, `project_tags`, `tickets`, `ticket_tags` conformes à `schema.md`
- [ ] **26.1.2** Ajouter la colonne `active_project_id` (FK projects, ON DELETE SET NULL) à `kins`
- [ ] **26.1.3** Ajouter la colonne `ticket_id` (FK tickets, ON DELETE SET NULL) à `tasks`
- [ ] **26.1.4** Créer les index conformes à `schema.md` (`idx_projects_*`, `idx_project_tags_*`, `idx_tickets_*`, `idx_ticket_tags_*`, `idx_tasks_ticket`)
- [ ] **26.1.5** Générer la migration Drizzle (`bun run db:generate`) et l'appliquer (`bun run db:migrate`)
- [ ] **26.1.6** Ajouter `DEFAULT_PROJECT_TAGS` dans `src/shared/constants.ts` : `[{ label: 'bug', color: '#ef4444' }, { label: 'feature', color: '#3b82f6' }, { label: 'chore', color: '#6b7280' }, { label: 'doc', color: '#f59e0b' }]`
- [ ] **26.1.7** Ajouter types `Project`, `ProjectTag`, `Ticket`, `TicketStatus` dans `src/shared/types.ts`
- [ ] **26.1.8** Ajouter `projects.maxDescriptionPromptTokens` (8000), `projects.maxTicketsInPrompt` (50), `projects.kanbanPositionStep` (1024) dans `src/server/config.ts` et documenter dans `config.md`

### 26.2 — Services backend

- [ ] **26.2.1** Créer `src/server/services/projects.ts` — CRUD projets, application du seed `DEFAULT_PROJECT_TAGS` à la création, cap d'injection de description
- [ ] **26.2.2** Créer `src/server/services/project-tags.ts` — CRUD tags (avec contrainte d'unicité `(project_id, label)`)
- [ ] **26.2.3** Créer `src/server/services/tickets.ts` — CRUD tickets, calcul de `position` (max + 1024 sur changement de status), réordonnancement explicite
- [ ] **26.2.4** Étendre `src/server/services/tasks.ts` :
  - `start_ticket_task(ticket_id, kin_id)` qui spawn un sub-Kin avec `ticket_id` set et `mode = 'await'` hardcodé
  - Validation : refuser explicitement toute tentative de spawn `async` quand `ticket_id !== null` (code d'erreur `TICKET_TASK_REQUIRES_AWAIT`)
  - Sur task completion : (a) détecter `task.ticket_id !== null`, (b) calculer le `projectOverride` à passer au turn parent, (c) enrichir le contenu du `task_result` enqueué avec le rappel ticket-linked conforme à `prompt-system.md` [10] (préfixe historique + bloc `---` avec ticket info et instruction `update_ticket()`)
  - Si le projet du ticket a été supprimé entre spawn et completion : pas de `projectOverride`, pas de rappel enrichi — message au format historique uniquement
  - **Aucun side-effect sur le ticket** au spawn ni à la completion : le Kin gère manuellement le statut via `update_ticket` (cf. `prompt-system.md` bloc [6])
- [ ] **26.2.5** Étendre `src/server/services/prompt-builder.ts` :
  - Bloc `[7.8] Active project` injecté dans `volatileBlocks` quand `kins.active_project_id` ou `projectOverride` est résolu
  - Bloc `## Ticket assignment` injecté dans `stableBlocks` du sub-Kin quand `task.ticket_id !== null`
  - Cap 8000 tokens sur la description, avec mention `[Description truncated — call get_project()...]`
  - Cap 50 tickets max dans la liste injectée, avec mention `... and N more`
- [ ] **26.2.6** Étendre `buildSystemPrompt()` pour accepter `projectOverride?: { projectId: string }` (cas turn task-completed)
- [ ] **26.2.7** Tests : compacting/cache ne devrait pas exploser quand un projet avec grosse description est actif (vérifier l'invalidation cache limitée au segment volatile)

### 26.3 — Outils natifs Kin

- [ ] **26.3.1** Créer `src/server/tools/project-tools.ts` avec tous les outils listés dans `projects.md` § 3
- [ ] **26.3.2** Outils projet : `list_projects` (readOnly, concurrencySafe), `get_project` (readOnly, concurrencySafe), `create_project`, `update_project`, `delete_project` (destructive)
- [ ] **26.3.3** Outils description : `update_project_description`, `append_project_description`, `patch_project_description` (avec erreur si `find` ambigu)
- [ ] **26.3.4** Outils tags : `create_tag`, `update_tag`, `delete_tag` (destructive)
- [ ] **26.3.5** Outils tickets : `list_tickets` (readOnly, concurrencySafe), `get_ticket` (readOnly, concurrencySafe), `create_ticket`, `update_ticket`, `add_ticket_tag`, `remove_ticket_tag`, `delete_ticket` (destructive)
- [ ] **26.3.6** Outil `set_active_project(project_id | null)` qui modifie `kins.active_project_id` du Kin appelant et émet `kin:active-project` en SSE
- [ ] **26.3.7** Outil `start_ticket_task(ticket_id)` (pas de param `mode` exposé, await hardcodé) qui s'appuie sur le service tasks étendu (§ 26.2.4)
- [ ] **26.3.8** Enregistrer tous les outils dans `src/server/tools/register.ts` et `src/server/tools/index.ts`
- [ ] **26.3.9** Implémenter la **conditionnalité sub-Kin** : quand `task.ticket_id !== null`, étendre le toolset du sub-Kin avec le sous-ensemble projet/ticket (sans `delete_*`, `create_project`, `create_ticket`, `set_active_project`), conformément à `prompt-system.md` [12]

### 26.4 — Routes API

- [ ] **26.4.1** Créer `src/server/routes/projects.ts` : `GET /api/projects`, `GET /api/projects/:id`, `POST /api/projects`, `PATCH /api/projects/:id`, `DELETE /api/projects/:id`
- [ ] **26.4.2** Routes tags : `GET /api/projects/:projectId/tags`, `POST /api/projects/:projectId/tags`, `PATCH /api/tags/:id`, `DELETE /api/tags/:id` (mêmes fichiers ou un fichier dédié `project-tags.ts`)
- [ ] **26.4.3** Créer `src/server/routes/tickets.ts` : `GET /api/projects/:projectId/tickets`, `GET /api/tickets/:id`, `POST /api/projects/:projectId/tickets`, `PATCH /api/tickets/:id`, `DELETE /api/tickets/:id`, `POST /api/tickets/:id/start-task`
- [ ] **26.4.4** Ajouter `PATCH /api/kins/:id/active-project` dans `src/server/routes/kins.ts`
- [ ] **26.4.5** Émettre les events SSE conformes à `api.md` : `kin:active-project`, `project:created/updated/deleted`, `ticket:created/updated/deleted`, `project-tag:created/updated/deleted`
- [ ] **26.4.6** Étendre les payloads SSE `task:*` pour exposer `ticketId` (utilisé par le frontend pour filtrer les tasks liées aux tickets)
- [ ] **26.4.7** Vérifier le hard delete avec cascade : suppression projet → tickets / tags supprimés, `kins.active_project_id` mis à NULL, `tasks.ticket_id` mis à NULL

### 26.5 — Activity bar et navigation globale

- [ ] **26.5.1** Créer `src/client/components/layout/ActivityBar.tsx` — bande verticale à l'extrême gauche (~48-56 px), 2 icônes : Kins, Projets
- [ ] **26.5.2** Créer `src/client/hooks/useActivityBar.ts` — store global de l'onglet actif
- [ ] **26.5.3** Refactor du layout racine pour intégrer ActivityBar à gauche, sidebar contextuelle au milieu, vue principale, et le side panel global (`<MiniAppViewer />` déjà lifté en § 26.0) à droite — tous au plus haut niveau du layout
- [ ] **26.5.4** Router : ajouter `/projects` (liste / pas-de-projet-sélectionné) et `/projects/:id` (kanban d'un projet)
- [ ] **26.5.5** Badges de notification sur les icônes inactives de l'activity bar (compteur d'événements non lus côté Kin ou Projets)

### 26.6 — Page Projets et kanban

- [ ] **26.6.1** Créer `src/client/pages/projects/ProjectsPage.tsx` — layout sidebar projets + vue principale (kanban si un projet est sélectionné)
- [ ] **26.6.2** Créer `src/client/components/sidebar/ProjectsSidebar.tsx` — liste projets triée par `updated_at DESC`, compteur tickets ouverts, pastille pour les Kins ayant ce projet en actif, bouton "+ Nouveau projet"
- [ ] **26.6.3** Choisir et installer la lib drag-drop (recommandé : `dnd-kit`)
- [ ] **26.6.4** Créer `src/client/components/project/ProjectKanban.tsx` — 5 colonnes (Backlog / À faire / En cours / Bloqué / Terminé) avec drag-drop entre colonnes
- [ ] **26.6.5** Créer `src/client/components/project/TicketColumn.tsx` et `src/client/components/project/TicketCard.tsx`
- [ ] **26.6.6** Créer `src/client/components/project/CreateProjectModal.tsx`
- [ ] **26.6.7** Créer `src/client/components/project/CreateTicketModal.tsx`
- [ ] **26.6.8** Créer `src/client/components/project/TagPicker.tsx` — multi-select avec création inline d'un nouveau tag (label + color picker)
- [ ] **26.6.9** Créer `src/client/components/project/StartTaskDialog.tsx` — dropdown Kins avec pré-sélection du premier Kin ayant `active_project_id` matchant
- [ ] **26.6.10** Hooks `useProjects.ts` et `useTickets.ts` avec invalidation par SSE
- [ ] **26.6.11** Optimistic updates sur drag-drop (rollback en cas d'erreur réseau)

### 26.7 — Side panel tab `'ticket'`

- [ ] **26.7.1** Créer `src/client/components/sidebar/TicketPanelContent.tsx` — symétrique à `TaskPanelContent.tsx`, rendu quand `activeTab === 'ticket'` dans le side panel
- [ ] **26.7.2** Étendre `MiniAppViewer.tsx` pour router vers `<TicketPanelContent />` quand `activeTab === 'ticket'`
- [ ] **26.7.3** Implémenter l'API `openTicket(info: { ticketId: string, parent?: { type: 'task' | 'ticket', id: string } })` dans `SidePanelContext` (stub posé en § 26.0.5 à compléter)
- [ ] **26.7.4** Pattern single-slot avec retour parent : si `info.parent` est posé, le header du panel affiche un bouton `← Retour au {parent.type} #{parent.id}`. Le clic fait `openTask({ ..., parent: undefined })` ou `openTicket({ ..., parent: undefined })` selon le type. Profondeur 1 max.
- [ ] **26.7.5** Édition inline du ticket dans `TicketPanelContent` (titre, description, tags) avec sauvegarde via PATCH
- [ ] **26.7.6** Liste des tasks liées au ticket avec badge Kin parent + status + lien `→ Voir thread Kin Alpha` (bascule mode Kins) ou clic carte → `openTask({ taskId, parent: { type: 'ticket', id: ticketId } })`
- [ ] **26.7.7** Bouton "▶ Démarrer une task" dans le header `TicketPanelContent` qui ouvre `StartTaskDialog`

### 26.8 — Cross-linking entre modes

- [ ] **26.8.1** Chip "Projet actif: ✦ {title}" dans le header du thread Kin (mode Kins) — clic = bascule mode Projets sur ce projet
- [ ] **26.8.2** Chip "Kins actifs ici: Alpha, Beta" dans le header du kanban — clic = bascule mode Kins sur le Kin sélectionné
- [ ] **26.8.3** SSE : mise à jour des chips quand `kin:active-project` arrive
- [ ] **26.8.4** **(Optionnel, peut être différé)** Auto-link `[#abc12]` dans `MarkdownContent.tsx` qui ouvre le side panel sur le ticket correspondant (`openTicket({ ticketId })`)

### 26.9 — i18n

- [ ] **26.9.1** Ajouter le namespace `projects.*` dans `src/client/locales/en.json`
- [ ] **26.9.2** Ajouter les traductions correspondantes dans `src/client/locales/fr.json`
- [ ] **26.9.3** Vérifier que toute la nouvelle UI passe par `t(...)` (aucun texte en dur)

**Critère de validation Phase 26** :
1. Création / suppression d'un projet via UI fonctionne ; le seed de tags par défaut est appliqué
2. Création / modification / drag-drop d'un ticket dans le kanban fonctionne et émet les events SSE
3. Un Kin qui appelle `set_active_project(id)` voit son contexte de prompt enrichi au prochain tour ; l'UI synchronise les chips
4. `start_ticket_task` spawn un sub-Kin dont le prompt système contient le bloc `## Ticket assignment` à jour
5. À la fin d'une task liée à un ticket, le turn de réaction chez le Kin parent voit le bloc `[7.8] Active project` injecté en `projectOverride` même si le projet actif persistant a changé entre-temps
6. Suppression d'un projet → confirmation modal → cascade tickets/tags ; les Kins concernés voient `active_project_id` mis à NULL ; les tasks historiques conservent leur ID mais avec `ticket_id` = NULL
7. Le mode Projets et le mode Kins coexistent avec navigation fluide via l'activity bar et le side panel global ; clic sur une task depuis le kanban ouvre le side panel sans basculer de mode

---

## Phase 27 — Onboarding conversationnel (Kin configurateur « Sherpa »)

Remplace le wizard de configuration par une conversation avec un Kin configurateur (`Sherpa`) ouvert dans une modale au premier lancement. Spec complète : **`sherpa.md`** (source de vérité — la lire avant de commencer).

> **Pré-requis bloquant** : §27.1 (centralisation des secrets dans le vault) avant §27.2 (secure input) et §27.3 (tools providers). Le `describe_provider_config` (§27.3) est requis par le secure input (§27.2).
>
> **État d'implémentation** (branche `feat/sherpa-onboarding`) : **backend complet + testé** (27.0 schéma, 27.1 vault refactor vérifié par workflow adversarial + tests, 27.2 secure-input provider/vault/channel, 27.3 tools config dont `set_default_model`/`get_default_models`, 27.4 avatar style, 27.5 Sherpa seed/prompt/knowledge/toolbox). **Frontend** : écran bootstrap (1 LLM natif) + atterrissage dans le chat de Sherpa. Tout en vert (typecheck + ~3400 tests + build + smoke runtime : 248 outils, toolbox `configurator` 36 outils résolus). **Déviation** : la « modale distraction-less enveloppant ChatPanel » a été simplifiée en *atterrissage direct dans le chat de Sherpa* (évite de re-plomber ChatPanel sans test navigateur). **Reste** : validation E2E manuelle navigateur (27.7).

### 27.0 — Schéma & fondation
- [ ] **27.0.1** Migration : `kins.kind TEXT NOT NULL DEFAULT 'regular'` (`'regular'`|`'configurator'`) + `user_profiles.onboarding_modal_dismissed INTEGER NOT NULL DEFAULT 0` (`db:generate` + `db:migrate`)
- [ ] **27.0.2** Type `KinKind` dans `src/shared/types.ts` ; exposer `kind` dans les payloads Kin (API + SSE)
- [ ] **27.0.3** Asset `src/server/assets/sherpa-avatar.png` (placeholder en attendant l'image finale du porteur)
- [ ] **27.0.4** Map `RECOMMENDED_CONFIGURATOR_MODELS` (par type natif) dans `src/shared/constants.ts` + `resolveConfiguratorModel(providerId)` (recommandé → fallback `listModels`)

### 27.1 — Centralisation des secrets dans le vault (refactor)
- [ ] **27.1.1** Helper `getSecretFieldKeys(type)` (extrait les `ConfigField.type === 'secret'` via `readConfigSchema`)
- [ ] **27.1.2** Helpers partagés : `vaultifyProviderConfig(type, providerId, rawConfig)` (écrit `provider_<type>_<id>_<field>` + remplace par `"$vault:<key>"`) et `hydrateProviderConfig(parsed)` (substitue `getSecretValue`)
- [ ] **27.1.3** Factoriser `loadProviderConfig(row)` = `decrypt` + `JSON.parse` + `hydrate` ; **router les ~27 sites de déchiffrement** dessus (`resolve.ts`, `embeddings.ts`, `search/tts/stt-resolver.ts`, `image-generation.ts`, `routes/providers.ts`, `tools/{provider,image,voice}-tools.ts`) — cf. `sherpa.md` §6.4
- [ ] **27.1.4** Écriture : `POST/PATCH /api/providers` vaultifie les champs secrets ; suppression provider nettoie les refs `$vault:`
- [ ] **27.1.5** Migration boot idempotente `src/server/services/migrate-provider-vaulting.ts` (appelée dans `index.ts` après Drizzle) — vaultifie les providers existants
- [ ] **27.1.6** Tests : auth provider OK après vaultification ; rotation = `update_secret` sans réécriture provider ; migration idempotente

### 27.2 — Saisie sécurisée (secure input)
- [ ] **27.2.1** Table `secret_prompts` (cf. `sherpa.md` §7.3 — aucune valeur de secret stockée)
- [ ] **27.2.2** Service `secret-prompts.ts` : create + `respondToSecretPrompt` (vault → créa+test provider/channel → claim atomique → reprise tour → message non sensible) calqué sur `human-prompts.ts`
- [ ] **27.2.3** Events SSE `prompt:secret-request` / `prompt:secret-resolved` (`sse/types.ts`, `sse.md`, `api.md`)
- [ ] **27.2.4** Route `POST /api/secret-prompts/:id/respond` (ne jamais logger `values`)
- [ ] **27.2.5** Tools `request_provider_setup`, `request_channel_setup`, `prompt_secret`
- [ ] **27.2.6** Frontend : modale de saisie (input password) sur `prompt:secret-request` + hook `useSSEResync`
- [ ] **27.2.7** Tests : le secret n'atteint jamais le LLM (confirmation non sensible) ; secret bien chiffré dans le vault

### 27.3 — Outils de configuration
- [ ] **27.3.1** `describe_provider_config(type)`, `list_provider_types` (read) — wrappe `readConfigSchema` / `GET /providers/types`
- [ ] **27.3.2** `test_provider`, `enable_provider_capability(providerId, capability)`, `set_default_provider(capability, providerId)`
- [ ] **27.3.3** `get_global_prompt` / `set_global_prompt` (wrappe `getGlobalPrompt`/`setGlobalPrompt` ; lecture-modification-écriture pour ne pas écraser les directives existantes)
- [ ] **27.3.4** `test_channel` (les channels vaultifient déjà)
- [ ] **27.3.5** Garde-fou « config globale = admin only » sur ces tools (rôle de l'utilisateur du tour)
- [ ] **27.3.6** Enregistrement dans `register.ts` + flags (`readOnly`/`concurrencySafe`)

### 27.4 — Personnalisation du prompt d'avatar
- [ ] **27.4.1** Clé `app_settings.avatar_style_prompt` (getter/setter dans `app-settings.ts`)
- [ ] **27.4.2** Injecter la directive de style dans `buildAvatarPrompt()` (modes `edit` + `generate`) ; vide = comportement actuel
- [ ] **27.4.3** Tool `set_avatar_style(style)` + champ d'édition Settings (UI)
- [ ] **27.4.4** Accord empirique : `generate_image` dans la toolbox configurator (exemples d'avatar itératifs, cf. `sherpa.md` §9)

### 27.5 — Sherpa (seed, prompt, toolbox)
- [ ] **27.5.1** Toolbox builtin `configurator` dans `toolboxes.ts` (liste : `sherpa.md` §4.3)
- [ ] **27.5.2** Câbler `kinKind` dans `PromptParams` + bloc STABLE `[Configurator mission]` conditionnel (`kind==='configurator' && !isSubKin`), data-driven (état plateforme lu chaque tour) — `prompt-builder.ts`
- [ ] **27.5.3** Service `seedConfiguratorKin(adminUserId, providerId)` (idempotent) : créa Kin + copie avatar + toolbox + modèle résolu + message d'amorce (`enqueueMessage` `sourceType:'system'`)
- [ ] **27.5.4** Vérifier le rendu client des messages `sourceType:'system'` (pas de bulle utilisateur, mais déclenche le tour)
- [ ] **27.5.5** Endpoint `POST /api/onboarding/configurator { providerId }` (idempotent, admin-first-run)
- [ ] **27.5.6** Rédiger `src/server/assets/sherpa-knowledge.md` (catalogue features + architecture + méta-projet + limites — distillé de `idea.md`/`CLAUDE.md`/`schema.md`, méta-projet fourni par le porteur) ; le charger au démarrage et l'injecter dans le bloc STABLE `[Configurator knowledge]` (Sherpa only). Note de maintenance en tête

### 27.6 — Flow onboarding & modale (frontend)
- [ ] **27.6.1** Réduire le wizard : écran Compte+langue → écran « connecter 1 provider LLM natif » (types natifs `llm` only, lien `apiKeyUrl`, bouton Tester) ; **supprimer** l'étape Préférences séparée
- [ ] **27.6.2** Après créa du 1er provider : appel seed configurateur + set `default_llm_provider_id`
- [ ] **27.6.3** `OnboardingChatModal` = `Dialog` autour de `ChatPanel` (thread principal de Sherpa, chrome masqué)
- [ ] **27.6.4** Warning de fermeture/skip + flag `onboarding_modal_dismissed`
- [ ] **27.6.5** Gérer `kin:error` dans la modale (action « reconfigurer le provider »)
- [ ] **27.6.6** `onboardingComplete` ignore le configurateur (`kins.some(k => k.kind !== 'configurator')`) ; retirer la grosse carte SetupChecklist, **garder** les bannières capability inline

### 27.7 — i18n & polish
- [ ] **27.7.1** Namespace `sherpa.*` + clés des écrans d'onboarding et modale secret (`en.json` / `fr.json`)
- [ ] **27.7.2** `bun run typecheck` + `bun run test` verts
- [ ] **27.7.3** Validation manuelle bout-en-bout sur DB fraîche (`db:snapshot` puis restore)

**Critère de validation Phase 27** :
1. Compte + 1 clé LLM native → Sherpa apparaît, salue l'utilisateur dans une modale (thread persistant)
2. Sherpa configure embedding/image/search/channels via chat ; les secrets passent par le popup et atterrissent **dans le vault** (jamais chez le LLM) ; les providers stockent des refs `$vault:`
3. Réutilisation de clé : OpenAI LLM → activation embedding sans nouveau secret
4. Accord empirique sur le style d'avatar (génération d'exemples) puis `set_avatar_style` ; les nouveaux Kins héritent du style
5. Skip → warning → reprise via Sherpa dans la liste avec tout l'historique
6. Rotation de clé via le vault sans toucher au provider
7. Les invités n'ont pas d'onboarding ; ils voient Sherpa + la conversation de l'admin

---

## Résumé des dépendances entre phases

```
Phase 0 (Init)
  ├── Phase 0.5 (Design system) ← VALIDATION VISUELLE REQUISE
  │     │                          Le backend peut avancer en parallèle,
  │     │                          mais le frontend réel est bloqué.
  │     │
  └── Phase 1 (DB)
        └── Phase 2 (Auth)
              ├── Phase 3 (Onboarding) ← nécessite Phase 0.5 validée
              └── Phase 4 (Providers)
                    └── Phase 5 (Event bus)
                    └── Phase 6 (SSE)
                          └── Phase 7 (CRUD Kins) ← nécessite Phase 0.5 validée
                                └── Phase 8 (Layout) ← nécessite Phase 0.5 validée
                                └── Phase 9 (Queue + Engine) ← COEUR
                                      └── Phase 10 (Tool calling)
                                            ├── Phase 11 (Contacts)
                                            ├── Phase 12 (Mémoire)
                                            │     └── Phase 13 (Compacting)
                                            ├── Phase 14 (Vault)
                                            ├── Phase 15 (Tâches)
                                            │     └── Phase 16 (Inter-Kins)
                                            │     └── Phase 17 (Crons)
                                            ├── Phase 18 (MCP)
                                            ├── Phase 19 (Custom tools)
                                            ├── Phase 20 (Files)
                                            ├── Phase 21 (Images)
                                            └── (Search tools — Phase 10.5, requires Phase 4.6b)
Phase 22 (i18n) — peut commencer dès Phase 8
Phase 23 (Dark mode) — déjà couvert par Phase 0.5 (tokens + toggle), compléter si besoin
Phase 24 (Polish) — après toutes les phases fonctionnelles
Phase 25 (Docker) — en parallèle dès Phase 9
Phase 26 (Projets & tickets) — après Phase 15 (Tasks) ; nécessite lift + rename du side panel (§ 26.0) comme pré-requis bloquant pour tout code projet
```

---

## Notes pour l'agent développeur

1. **Lire la documentation** : avant de commencer chaque phase, relire le fichier de spec correspondant (`idea.md`, `schema.md`, `api.md`, `config.md`, `structure.md`, `prompt-system.md`, `compacting.md`)
2. **Conventions** : respecter strictement les conventions de nommage et d'imports décrites dans `structure.md`
3. **Tests manuels** : à la fin de chaque phase, valider le critère de validation avant de passer à la suivante
4. **Commits** : un commit par sous-tâche terminée, avec un message clair
5. **Ne pas anticiper** : ne pas implémenter de fonctionnalités des phases futures. Chaque phase doit être minimale et suffisante
6. **Erreurs** : suivre le format standard `{ "error": { "code": "...", "message": "..." } }` pour toutes les routes API
7. **Types partagés** : tout type utilisé à la fois côté client et serveur doit être dans `src/shared/types.ts`

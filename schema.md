# Hivekeep — Schéma de base de données

Schéma SQLite détaillé, conçu pour Drizzle ORM. Toutes les tables utilisent des UUID (text) comme clés primaires et des timestamps Unix (integer) pour les dates.

> **Convention** : les types SQLite natifs sont utilisés (`text`, `integer`, `real`, `blob`). Les booléens sont stockés en `integer` (0/1). Les objets complexes en `text` (JSON sérialisé).

---

## Tables gérées par Better Auth

Better Auth crée et gère ses propres tables. Elles ne doivent pas être modifiées manuellement.

### `user`

| Colonne | Type | Description |
|---|---|---|
| `id` | text PK | UUID généré par Better Auth |
| `name` | text | Nom complet |
| `email` | text UNIQUE | Email |
| `email_verified` | integer | Booléen |
| `image` | text | URL/path de l'avatar |
| `created_at` | integer | Timestamp |
| `updated_at` | integer | Timestamp |

### `session`

| Colonne | Type | Description |
|---|---|---|
| `id` | text PK | UUID |
| `user_id` | text FK → user.id | |
| `token` | text UNIQUE | Token de session |
| `expires_at` | integer | Expiration |
| `ip_address` | text | IP du client |
| `user_agent` | text | User-Agent |
| `created_at` | integer | |
| `updated_at` | integer | |

### `account`

| Colonne | Type | Description |
|---|---|---|
| `id` | text PK | |
| `user_id` | text FK → user.id | |
| `account_id` | text | |
| `provider_id` | text | Provider d'auth (credential) |
| `password` | text | Hash du mot de passe |
| `created_at` | integer | |
| `updated_at` | integer | |

### `verification`

Table interne Better Auth pour les tokens de vérification email, reset password, etc.

---

## Tables custom Hivekeep

### `user_profiles`

Extension du `user` Better Auth avec les champs spécifiques Hivekeep.

| Colonne | Type | Contraintes | Description |
|---|---|---|---|
| `user_id` | text PK | FK → user.id | Lié 1:1 au user Better Auth |
| `first_name` | text | NOT NULL | Prénom |
| `last_name` | text | NOT NULL | Nom |
| `pseudonym` | text | NOT NULL | Pseudonyme affiché dans le chat |
| `language` | text | NOT NULL, DEFAULT 'fr' | Langue de l'UI (code de `SUPPORTED_LANGUAGES`) |
| `agent_language` | text | | Langue parlée par les Agents (code de `AGENT_LANGUAGES`, plus large que l'UI) ; NULL = suit `language` |
| `role` | text | NOT NULL, DEFAULT 'member' | 'admin' ou 'member' |
| `agent_order` | text | | JSON array des IDs de Agents (ordre d'affichage) |
| `cron_order` | text | | JSON array des IDs de crons (ordre d'affichage) |

---

### `providers`

Configuration des providers IA (LLM, embeddings, images).

| Colonne | Type | Contraintes | Description |
|---|---|---|---|
| `id` | text PK | UUID | |
| `name` | text | NOT NULL | Nom d'affichage (ex: "Mon OpenAI") |
| `type` | text | NOT NULL | 'anthropic', 'openai', 'gemini', 'voyage_ai' |
| `config_encrypted` | text | NOT NULL | Configuration chiffrée (API key, base URL, etc.) |
| `capabilities` | text | NOT NULL | JSON array : `["llm", "embedding", "image"]` |
| `is_valid` | integer | NOT NULL, DEFAULT 1 | Dernier résultat du test de connexion |
| `last_error` | text | | Message d'erreur du dernier test échoué |
| `created_at` | integer | NOT NULL | |
| `updated_at` | integer | NOT NULL | |

---

### `agents`

Agents IA de la plateforme.

| Colonne | Type | Contraintes | Description |
|---|---|---|---|
| `id` | text PK | UUID | |
| `slug` | text | UNIQUE | Identifiant URL-friendly (ex: 'my-assistant') |
| `name` | text | NOT NULL | Nom du Agent |
| `role` | text | NOT NULL | Description courte de sa fonction |
| `avatar_path` | text | | Chemin vers l'image avatar |
| `character` | text | NOT NULL | Personnalité / SOUL |
| `expertise` | text | NOT NULL | Connaissances et objectif |
| `model` | text | NOT NULL | Identifiant du modèle LLM (ex: 'claude-sonnet-4-20250514') |
| `provider_id` | text | FK → providers.id, ON DELETE SET NULL | Provider explicite pour le modèle du Agent |
| `workspace_path` | text | NOT NULL | Chemin du dossier de travail |
| `tool_config` | text | | JSON : AgentToolConfig (outils désactivés, accès MCP, opt-in, search provider) |
| `compacting_config` | text | | JSON : AgentCompactingConfig (seuil de tours, modèle de compacting, provider) |
| `active_project_id` | text | FK → projects.id, ON DELETE SET NULL | Projet actif du Agent. NULL si aucun. Injecté dans le bloc volatile du prompt système. Voir `projects.md` |
| `created_by` | text | FK → user.id | Utilisateur qui a créé le Agent |
| `created_at` | integer | NOT NULL | |
| `updated_at` | integer | NOT NULL | |

---

### `mcp_servers`

Serveurs MCP configurés au niveau de la plateforme.

| Colonne | Type | Contraintes | Description |
|---|---|---|---|
| `id` | text PK | UUID | |
| `name` | text | NOT NULL | Nom d'affichage |
| `command` | text | NOT NULL | Commande de lancement |
| `args` | text | | JSON array des arguments |
| `env` | text | | JSON object des variables d'environnement |
| `status` | text | NOT NULL, DEFAULT 'active' | 'active' ou 'pending_approval' |
| `created_by_agent_id` | text | FK → agents.id, ON DELETE SET NULL | Agent qui a créé le serveur (si auto-géré) |
| `created_at` | integer | NOT NULL | |
| `updated_at` | integer | NOT NULL | |

---

### `agent_mcp_servers`

Table de liaison Agents ↔ Serveurs MCP (many-to-many).

| Colonne | Type | Contraintes | Description |
|---|---|---|---|
| `agent_id` | text | FK → agents.id, ON DELETE CASCADE | |
| `mcp_server_id` | text | FK → mcp_servers.id, ON DELETE CASCADE | |

**PK composite** : (`agent_id`, `mcp_server_id`)

---

### `messages`

Tous les messages de toutes les sessions (principales et tâches).

| Colonne | Type | Contraintes | Description |
|---|---|---|---|
| `id` | text PK | UUID | |
| `agent_id` | text | FK → agents.id, NOT NULL | Agent propriétaire de la session |
| `task_id` | text | FK → tasks.id | NULL = session principale, sinon session de tâche |
| `session_id` | text | FK → quick_sessions.id, ON DELETE CASCADE | NULL = main conversation, sinon quick session |
| `role` | text | NOT NULL | 'user', 'assistant', 'system', 'tool' |
| `content` | text | | Contenu textuel du message |
| `source_type` | text | NOT NULL | 'user', 'agent', 'task', 'cron', 'system' |
| `source_id` | text | | ID de la source (user_id, agent_id, task_id, cron_id) |
| `tool_calls` | text | | JSON array des appels d'outils (messages assistant) |
| `tool_call_id` | text | | ID de l'appel d'outil (messages tool) |
| `request_id` | text | | Pour corrélation inter-Agents (request/reply) |
| `in_reply_to` | text | | request_id auquel ce message répond |
| `channel_origin_id` | text | | ID de la chaîne causale canal — propage l'origine pour auto-delivery |
| `is_redacted` | integer | NOT NULL, DEFAULT 0 | Message caviardé (secret retiré) |
| `redact_pending` | integer | NOT NULL, DEFAULT 0 | Caviardage en attente — bloque le compacting |
| `metadata` | text | | JSON pour données additionnelles |
| `created_at` | integer | NOT NULL | |

**Index** :
- `idx_messages_agent_id` sur `agent_id`
- `idx_messages_task_id` sur `task_id`
- `idx_messages_agent_created` sur (`agent_id`, `created_at`)
- `idx_messages_source` sur (`source_type`, `source_id`)
- `idx_messages_session_id` sur `session_id`

---

### `compacting_snapshots`

> **Legacy** : table de l'ancien système de compacting (snapshot unique). Conservée pour rétro-compatibilité. Le nouveau système utilise `compacting_summaries`.

| Colonne | Type | Contraintes | Description |
|---|---|---|---|
| `id` | text PK | UUID | |
| `agent_id` | text | FK → agents.id, NOT NULL | |
| `summary` | text | NOT NULL | Résumé compacté des échanges |
| `messages_up_to_id` | text | FK → messages.id, NOT NULL | Dernier message couvert par ce snapshot |
| `is_active` | integer | NOT NULL, DEFAULT 1 | Snapshot actuellement utilisé (un seul actif par Agent) |
| `created_at` | integer | NOT NULL | |

**Index** :
- `idx_compacting_agent_active` sur (`agent_id`, `is_active`)

---

### `compacting_summaries`

Résumés de compacting avec accumulation multi-summary et merge télescopique.

| Colonne | Type | Contraintes | Description |
|---|---|---|---|
| `id` | text PK | UUID | |
| `agent_id` | text | FK → agents.id, NOT NULL | |
| `summary` | text | NOT NULL | Résumé structuré des échanges |
| `first_message_at` | integer | NOT NULL | Timestamp du premier message couvert |
| `last_message_at` | integer | NOT NULL | Timestamp du dernier message couvert |
| `first_message_id` | text | FK → messages.id | Premier message couvert |
| `last_message_id` | text | FK → messages.id, NOT NULL | Dernier message couvert |
| `message_count` | integer | NOT NULL, DEFAULT 0 | Nombre de messages résumés |
| `token_estimate` | integer | NOT NULL, DEFAULT 0 | Estimation en tokens du résumé |
| `is_in_context` | integer | NOT NULL, DEFAULT 1 | true = injecté dans le prompt système, false = archivé |
| `depth` | integer | NOT NULL, DEFAULT 0 | 0 = résumé direct, 1+ = merge télescopique |
| `source_summary_ids` | text | | JSON array des IDs de résumés fusionnés (null pour depth 0) |
| `created_at` | integer | NOT NULL | |

**Index** :
- `idx_compacting_summaries_agent` sur (`agent_id`, `is_in_context`)

---

### `memories`

Mémoire long terme des Agents (faits, préférences, décisions, connaissances).

| Colonne | Type | Contraintes | Description |
|---|---|---|---|
| `id` | text PK | UUID | |
| `agent_id` | text | FK → agents.id, NOT NULL | |
| `content` | text | NOT NULL | Le fait ou la connaissance |
| `embedding` | blob | | Vecteur float32 pour sqlite-vec |
| `category` | text | NOT NULL | 'fact', 'preference', 'decision', 'knowledge' |
| `subject` | text | | Contact ou contexte concerné |
| `source_message_id` | text | FK → messages.id | Message d'origine |
| `source_channel` | text | NOT NULL, DEFAULT 'automatic' | 'automatic' (pipeline) ou 'explicit' (outil memorize) |
| `source_context` | text | | Bref contexte conversationnel autour de la mémoire extraite |
| `importance` | real | | Score de 1 à 10, null = non scoré (traité comme 5) |
| `retrieval_count` | integer | NOT NULL, DEFAULT 0 | Nombre de fois que cette mémoire a été récupérée |
| `last_retrieved_at` | integer | | Dernière récupération |
| `consolidation_generation` | integer | NOT NULL, DEFAULT 0 | 0 = originale, 1+ = consolidée |
| `consolidated_from_ids` | text | | JSON array des IDs source (null pour les originales) |
| `scope` | text | NOT NULL, DEFAULT 'private' | 'private' (Agent seul) ou 'shared' (visible par tous les Agents) |
| `created_at` | integer | NOT NULL | |
| `updated_at` | integer | NOT NULL | |

**Index** :
- `idx_memories_agent_id` sur `agent_id`
- `idx_memories_agent_category` sur (`agent_id`, `category`)
- `idx_memories_agent_subject` sur (`agent_id`, `subject`)
- `idx_memories_scope` sur `scope`
- `idx_memories_scope_category` sur (`scope`, `category`)

---

### `contacts`

Registre de contacts partagé entre tous les Agents. Le nom affiché est calculé : `firstName lastName`, ou à défaut le premier pseudo, ou « Unnamed contact ».

| Colonne | Type | Contraintes | Description |
|---|---|---|---|
| `id` | text PK | UUID | |
| `first_name` | text | nullable | Prénom |
| `last_name` | text | nullable | Nom de famille |
| `linked_user_id` | text | FK → user.id | Si c'est un utilisateur de la plateforme |
| `created_at` | integer | NOT NULL | |
| `updated_at` | integer | NOT NULL | |

Au moins un de `first_name`, `last_name` ou un pseudo (table `contact_nicknames`) doit être renseigné — la couche API rejette une création sans aucun de ces champs.

---

### `contact_nicknames`

Pseudos / alias d'un contact (plusieurs possibles).

| Colonne | Type | Contraintes | Description |
|---|---|---|---|
| `id` | text PK | UUID | |
| `contact_id` | text | FK → contacts.id, ON DELETE CASCADE, NOT NULL | |
| `nickname` | text | NOT NULL | Pseudo, handle, surnom |
| `created_at` | integer | NOT NULL | |
| `updated_at` | integer | NOT NULL | |

**Index** :
- `idx_contact_nicknames_contact` sur `contact_id`

---

### `contact_identifiers`

Champs personnalisés d'un contact (email, mobile, Twitter, LinkedIn, Discord, etc.).

| Colonne | Type | Contraintes | Description |
|---|---|---|---|
| `id` | text PK | UUID | |
| `contact_id` | text | FK → contacts.id, ON DELETE CASCADE, NOT NULL | |
| `label` | text | NOT NULL | Type d'identifiant (ex: "email", "phone pro", "WhatsApp") |
| `value` | text | NOT NULL | Valeur de l'identifiant |
| `created_at` | integer | NOT NULL | |
| `updated_at` | integer | NOT NULL | |

**Index** :
- `idx_contact_identifiers_contact_id` sur `contact_id`

---

### `contact_platform_ids`

IDs de plateforme de messagerie pour auto-identification des contacts.

| Colonne | Type | Contraintes | Description |
|---|---|---|---|
| `id` | text PK | UUID | |
| `contact_id` | text | FK → contacts.id, ON DELETE CASCADE, NOT NULL | |
| `platform` | text | NOT NULL | 'telegram', 'discord', etc. |
| `platform_id` | text | NOT NULL | ID sur la plateforme |
| `created_at` | integer | NOT NULL | |
| `updated_at` | integer | NOT NULL | |

**Contrainte UNIQUE** : (`platform`, `platform_id`)

**Index** :
- `idx_contact_platform_ids_contact` sur `contact_id`

---

### `contact_notes`

Notes des Agents sur les contacts (privées ou globales).

| Colonne | Type | Contraintes | Description |
|---|---|---|---|
| `id` | text PK | UUID | |
| `contact_id` | text | FK → contacts.id, ON DELETE CASCADE, NOT NULL | |
| `agent_id` | text | FK → agents.id, NOT NULL | Agent auteur de la note |
| `scope` | text | NOT NULL | 'private' (ce Agent seul) ou 'global' (tous les Agents) |
| `content` | text | NOT NULL | Contenu de la note |
| `created_at` | integer | NOT NULL | |
| `updated_at` | integer | NOT NULL | |

**Contrainte UNIQUE** : (`contact_id`, `agent_id`, `scope`)

**Index** :
- `idx_contact_notes_contact_id` sur `contact_id`
- `idx_contact_notes_agent_id` sur `agent_id`

---

### `custom_tools`

Outils custom **globaux** (platform-wide, plus de scope per-Agent). L'accès est filtré par les toolboxes (une toolbox liste `custom_<slug>` par son nom), exactement comme les outils MCP. Le script exécutable + ses dépendances vivent sur disque sous `config.customTools.baseDir/<slug>/` ; cette table ne stocke que les métadonnées.

| Colonne | Type | Contraintes | Description |
|---|---|---|---|
| `id` | text PK | UUID | |
| `slug` | text | NOT NULL, UNIQUE | → nom d'outil `custom_<slug>`. Immuable |
| `name` | text | NOT NULL | Nom lisible |
| `description` | text | NOT NULL | Description pour le LLM |
| `parameters` | text | NOT NULL | JSON Schema des paramètres |
| `entrypoint` | text | NOT NULL | Chemin relatif du script dans le dir géré |
| `translations` | text | | **UI-only** : overrides localisés (JSON keyé par locale : `{ "<locale>": { name?, description?, parameters?: { "<param>": { label?, description? } } } }`). N'altère JAMAIS la définition d'outil vue par le LLM (le `name`/`description` de base + le JSON-Schema brut restent verbatim) — voir `resolveCustomToolDisplay()` |
| `language` | text | | Interpréteur explicite (`python`/`node`/`bun`/`bash`/…) ; sinon déduit du shebang/extension |
| `domain_slug` | text | NOT NULL, défaut `'custom'`, FK → tool_domains.slug | Domaine de regroupement |
| `timeout_ms` | integer | | Timeout d'exécution par outil (plafonné) |
| `enabled` | integer (bool) | NOT NULL, défaut 1 | Désactivé → listé mais jamais résolu dans un toolset |
| `created_by` | text | NOT NULL, défaut `'user'` | `'user'` (UI) ou `'agent'` |
| `created_at` | integer | NOT NULL | |
| `updated_at` | integer | NOT NULL | |

**Contrainte UNIQUE** : (`slug`)

---

### `tool_domains`

Domaines d'outils dynamiques (catégories icône + couleur + label pour regrouper les outils dans l'UI). Les 26 domaines built-in sont seedés idempotemment au boot depuis `TOOL_DOMAIN_META` (`builtin=1`, read-only) ; l'utilisateur/les Agents peuvent créer des domaines custom. Le `slug` est référencé par `custom_tools.domain_slug` et par la map name→domain du registry.

| Colonne | Type | Contraintes | Description |
|---|---|---|---|
| `slug` | text PK | | Identifiant stable (`^[a-z][a-z0-9-]*$`) |
| `label` | text | | Label littéral (domaines custom) |
| `label_key` | text | | Clé i18n `tools.domains.*` (domaines built-in) |
| `icon` | text | NOT NULL | Nom d'icône Lucide |
| `color` | text | | Token de couleur curé (domaines custom ; voir `DOMAIN_COLOR_TOKENS`) |
| `description` | text | | |
| `builtin` | integer (bool) | NOT NULL, défaut 0 | Built-in → read-only, suppression interdite si utilisé |
| `created_at` | integer | NOT NULL | |
| `updated_at` | integer | NOT NULL | |

Rendu visuel : built-in → triple Tailwind `{bg,text,border}` + `labelKey` depuis `TOOL_DOMAIN_META` ; custom → triple depuis le token `color`, label littéral.

---

### `quick_sessions`

Sessions éphémères pour interactions rapides.

| Colonne | Type | Contraintes | Description |
|---|---|---|---|
| `id` | text PK | UUID | |
| `agent_id` | text | FK → agents.id, ON DELETE CASCADE, NOT NULL | |
| `created_by` | text | FK → user.id, ON DELETE CASCADE, NOT NULL | |
| `title` | text | | Titre de la session |
| `status` | text | NOT NULL, DEFAULT 'active' | 'active' ou 'closed' |
| `created_at` | integer | NOT NULL | |
| `closed_at` | integer | | |
| `expires_at` | integer | | |

**Index** :
- `idx_quick_sessions_agent_status` sur (`agent_id`, `status`)
- `idx_quick_sessions_user` sur `created_by`

---

### `terminal_sessions`

Sessions du terminal web admin, persistées pour survivre à un redémarrage (la sidebar et le scrollback reviennent). Les sessions adossées à tmux (`backend = 'tmux'`) se reconnectent au shell vivant ; les sessions `pty` relancent un shell neuf dans `last_cwd`. Une ligne ici signifie "restaurable" : elle est supprimée quand la session est fermée ou que le shell se termine.

| Colonne | Type | Contraintes | Description |
|---|---|---|---|
| `id` | text PK | UUID | |
| `user_id` | text | FK → user.id, ON DELETE CASCADE, NOT NULL | Propriétaire |
| `name` | text | NOT NULL | Nom affiché (éditable) |
| `backend` | text | NOT NULL, DEFAULT 'pty' | 'pty' (shell direct) ou 'tmux' |
| `tmux_name` | text | | Nom de session tmux (`hk-<id>`) si backend = 'tmux' |
| `last_cwd` | text | | Dernier répertoire courant, restauré comme cwd au réveil |
| `scrollback` | text | NOT NULL, DEFAULT '' | Fin de scrollback rejouée au réveil (cappée) |
| `created_at` | integer | NOT NULL | Unix ms |
| `last_active_at` | integer | NOT NULL | Unix ms |

**Index** :
- `idx_terminal_sessions_user` sur `user_id`

---

### `terminal_presets`

Presets de session du terminal (par user) : dossier de départ + script d'init lancé une fois à la création d'une session depuis le preset.

| Colonne | Type | Contraintes | Description |
|---|---|---|---|
| `id` | text PK | UUID | |
| `user_id` | text | FK → user.id, ON DELETE CASCADE, NOT NULL | Propriétaire |
| `name` | text | NOT NULL | Nom du preset |
| `cwd` | text | | Dossier de départ (`~` étendu côté serveur) ; NULL = home |
| `init_script` | text | | Script multi-ligne tapé dans le shell au démarrage ; NULL = aucun |
| `created_at` | integer | NOT NULL | Unix ms |
| `updated_at` | integer | NOT NULL | Unix ms |

**Index** :
- `idx_terminal_presets_user` sur `user_id`

---

### `tasks`

Sous-Agents éphémères (tâches déléguées).

| Colonne | Type | Contraintes | Description |
|---|---|---|---|
| `id` | text PK | UUID | |
| `parent_agent_id` | text | FK → agents.id, NOT NULL | Agent qui a spawné la tâche |
| `source_agent_id` | text | FK → agents.id | Agent dont la tâche est une instance (si spawn_type = 'other') |
| `spawn_type` | text | NOT NULL | 'self' ou 'other' |
| `mode` | text | NOT NULL, DEFAULT 'await' | 'await' ou 'async' |
| `model` | text | | Override du modèle LLM (NULL = héritage) |
| `provider_id` | text | | Override du provider pour le modèle |
| `title` | text | | Titre optionnel de la tâche |
| `description` | text | NOT NULL | Instructions de la tâche |
| `status` | text | NOT NULL, DEFAULT 'pending' | 'queued', 'pending', 'in_progress', 'paused', 'awaiting_human_input', 'awaiting_agent_response', 'completed', 'failed', 'cancelled' |
| `result` | text | | Résultat final de la tâche |
| `error` | text | | Détail de l'erreur si failed |
| `depth` | integer | NOT NULL, DEFAULT 1 | Profondeur de nesting |
| `parent_task_id` | text | FK → tasks.id | Tâche parente (si sous-tâche d'une tâche) |
| `cron_id` | text | FK → crons.id | Si spawné par un cron |
| `request_input_count` | integer | NOT NULL, DEFAULT 0 | Nombre d'appels request_input (max 3) |
| `inter_agent_request_count` | integer | NOT NULL, DEFAULT 0 | Nombre d'appels send_message(request) depuis cette tâche |
| `pending_request_id` | text | | request_id en attente de réponse inter-Agent |
| `channel_origin_id` | text | | ID de la chaîne causale canal pour auto-delivery |
| `webhook_id` | text | FK → webhooks.id, ON DELETE SET NULL | Webhook qui a spawné cette tâche (mode dispatch "task") |
| `ticket_id` | text | FK → tickets.id, ON DELETE SET NULL | Ticket auquel la tâche est liée. NULL si task non-projet. Voir `projects.md` |
| `allow_human_prompt` | integer | NOT NULL, DEFAULT 1 | Si la tâche peut utiliser prompt_human |
| `concurrency_group` | text | | Nom du groupe de concurrence (ex: "batch-issues") |
| `concurrency_max` | integer | | Nombre max de tâches concurrentes dans ce groupe |
| `queued_at` | integer | | Timestamp de mise en queue (pour FIFO) |
| `created_at` | integer | NOT NULL | |
| `updated_at` | integer | NOT NULL | |

**Index** :
- `idx_tasks_parent_agent` sur `parent_agent_id`
- `idx_tasks_status` sur `status`
- `idx_tasks_cron` sur `cron_id`
- `idx_tasks_concurrency` sur (`concurrency_group`, `status`, `queued_at`)
- `idx_tasks_webhook` sur `webhook_id`
- `idx_tasks_ticket` sur `ticket_id`

---

### `crons`

Tâches planifiées récurrentes.

| Colonne | Type | Contraintes | Description |
|---|---|---|---|
| `id` | text PK | UUID | |
| `agent_id` | text | FK → agents.id, NOT NULL | Agent propriétaire |
| `name` | text | NOT NULL | Libellé de la tâche planifiée |
| `schedule` | text | NOT NULL | Expression cron (ex: '0 9 * * *') |
| `task_description` | text | NOT NULL | Instructions données au sous-Agent |
| `target_agent_id` | text | FK → agents.id | Agent cible (NULL = soi-même) |
| `model` | text | | Override du modèle LLM |
| `provider_id` | text | | Override du provider pour le modèle |
| `toolbox_ids` | text | | JSON `string[]` d'IDs de toolboxes — toolset natif des tâches spawnées par ce cron (figé sur la task au spawn). NULL → défaut `'all'` (surface native complète) |
| `is_active` | integer | NOT NULL, DEFAULT 1 | Actif / Inactif |
| `requires_approval` | integer | NOT NULL, DEFAULT 0 | Si créé par le Agent, nécessite validation utilisateur |
| `run_once` | integer | NOT NULL, DEFAULT 0 | Si activé, le cron se désactive automatiquement après la première exécution |
| `last_triggered_at` | integer | | Dernier déclenchement |
| `created_by` | text | | 'user' ou 'agent' — qui a créé le cron |
| `created_at` | integer | NOT NULL | |
| `updated_at` | integer | NOT NULL | |

---

### `cron_learnings`

Apprentissages persistants enregistrés par les agents lors de l'exécution de tâches cron. Chaque cron peut stocker jusqu'à 20 learnings (FIFO avec éviction automatique des plus anciens).

| Colonne | Type | Contraintes | Description |
|---|---|---|---|
| `id` | text PK | UUID | |
| `cron_id` | text | FK → crons.id, ON DELETE CASCADE, NOT NULL | Cron associé |
| `content` | text | NOT NULL | Contenu de l'apprentissage (texte libre) |
| `category` | text | | 'error_recovery', 'optimization', 'environment', 'general' |
| `task_id` | text | FK → tasks.id, ON DELETE SET NULL | Tâche qui a enregistré ce learning |
| `created_at` | integer | NOT NULL | |

**Index** :
- `idx_cron_learnings_cron` sur `cron_id`

---

### `webhooks`

Webhooks entrants pour recevoir des événements externes.

| Colonne | Type | Contraintes | Description |
|---|---|---|---|
| `id` | text PK | UUID | |
| `agent_id` | text | FK → agents.id, NOT NULL | Agent destinataire |
| `name` | text | NOT NULL | Nom d'affichage |
| `token` | text | UNIQUE, NOT NULL | Token secret pour l'URL |
| `description` | text | | Description du webhook |
| `is_active` | integer | NOT NULL, DEFAULT 1 | Actif / Inactif |
| `last_triggered_at` | integer | | Dernier déclenchement |
| `trigger_count` | integer | NOT NULL, DEFAULT 0 | Nombre de déclenchements |
| `filter_mode` | text | | Mode de filtrage : NULL (désactivé), 'simple', ou 'advanced' |
| `filter_field` | text | | Chemin dot-notation dans le payload JSON (mode simple) |
| `filter_allowed_values` | text | | JSON array de valeurs autorisées (mode simple, case-insensitive) |
| `filter_expression` | text | | Expression régulière appliquée au body brut (mode advanced) |
| `dispatch_mode` | text | NOT NULL, DEFAULT 'conversation' | 'conversation' (message injecté dans la session) ou 'task' (spawn une sous-tâche) |
| `task_title_template` | text | | Template pour le titre de tâche (mode task). Supporte `{{field.path}}` comme placeholders |
| `task_prompt_template` | text | | Template pour la description/prompt de tâche (mode task). Supporte `{{field.path}}` et `{{__payload__}}` |
| `max_concurrent_tasks` | integer | NOT NULL, DEFAULT 1 | Nombre max de tâches concurrentes (mode task). 0 = illimité |
| `created_by` | text | | 'user' ou 'agent' |
| `created_at` | integer | NOT NULL | |
| `updated_at` | integer | NOT NULL | |

**Index** :
- `idx_webhooks_agent_id` sur `agent_id`

---

### `webhook_logs`

Journal des appels webhook reçus.

| Colonne | Type | Contraintes | Description |
|---|---|---|---|
| `id` | text PK | UUID | |
| `webhook_id` | text | FK → webhooks.id, ON DELETE CASCADE | |
| `payload` | text | | Payload reçu (JSON sérialisé) |
| `source_ip` | text | | IP de l'appelant |
| `filtered` | integer | NOT NULL, DEFAULT 0 | 1 si le payload a été filtré (non transmis au Agent) |
| `created_at` | integer | NOT NULL | |

**Index** :
- `idx_webhook_logs_webhook_created` sur (`webhook_id`, `created_at`)

---

### `account_triggers`

Déclencheurs par compte email connecté : quand un nouvel email correspond à l'arbre de conditions, l'Agent cible est sollicité (conversation ou tâche). Polling (aucun provider ne fait de push simple en mono-conteneur).

| Colonne | Type | Contraintes | Description |
|---|---|---|---|
| `id` | text PK | UUID | |
| `account_id` | text | FK → providers.id, ON DELETE CASCADE, NOT NULL | Compte email connecté (capability `email`) |
| `name` | text | NOT NULL | Nom d'affichage |
| `is_active` | integer | NOT NULL, DEFAULT 1 | Actif / Inactif |
| `folder` | text | NOT NULL, DEFAULT 'INBOX' | Dossier/label surveillé |
| `conditions` | text | NOT NULL | Arbre de conditions (JSON : nœud `{type:'group', op:'and'\|'or', children[]}` ou `{type:'leaf', field, op, value, negate?}`) |
| `prompt` | text | NOT NULL | Instruction transmise à l'Agent cible |
| `target_agent_id` | text | FK → agents.id, NOT NULL | Agent sollicité |
| `dispatch_mode` | text | NOT NULL, DEFAULT 'conversation' | 'conversation' (injecté dans la session principale, avec contexte) ou 'task' (sous-tâche isolée, sans historique) |
| `max_concurrent_tasks` | integer | NOT NULL, DEFAULT 1 | Max tâches concurrentes (mode task). 0 = illimité |
| `needs_body` | integer | NOT NULL, DEFAULT 0 | 1 si une condition vise le corps/pièces jointes (fetch du message complet requis au polling) |
| `disable_after_fire` | integer | NOT NULL, DEFAULT 0 | 1 = one-shot : la ligne est supprimée après le premier match (sa condition vise un seul thread/Message-ID, elle ne peut plus rematcher, et les lignes consommées saturaient le quota par compte). Utilisé par l'option `watch_reply` de `send_email`. Les one-shots jamais déclenchés sont purgés après `EMAIL_TRIGGER_ONE_SHOT_TTL_DAYS` |
| `last_triggered_at` | integer | | Dernier déclenchement |
| `trigger_count` | integer | NOT NULL, DEFAULT 0 | Nombre de déclenchements |
| `created_by` | text | NOT NULL, DEFAULT 'user' | 'user' ou 'agent' |
| `requires_approval` | integer | NOT NULL, DEFAULT 0 | 1 si en attente d'approbation (trigger créé par un Agent, réglage global `agent_triggers_require_approval` activé) |
| `created_at` | integer | NOT NULL | |
| `updated_at` | integer | NOT NULL | |

**Index** :
- `idx_account_triggers_account` sur `account_id`
- `idx_account_triggers_target_agent` sur `target_agent_id`

---

### `account_sync_state`

Curseur de polling + déduplication, **par (compte, dossier)** — chaque dossier est un flux distinct.

| Colonne | Type | Contraintes | Description |
|---|---|---|---|
| `account_id` | text | FK → providers.id, ON DELETE CASCADE | |
| `folder` | text | NOT NULL | |
| `last_seen_date` | integer | NOT NULL | Watermark (Unix ms). Initialisé à NOW à la création du 1er trigger sur ce flux (cold-start : jamais de rejeu de l'historique) |
| `seen_ids` | text | NOT NULL, DEFAULT '[]' | Anneau JSON des derniers provider-message-ids traités (anti-doublon de bord, le filtre `after` étant à la seconde / inclusif) |
| `last_polled_at` | integer | | |
| `last_error` | text | | Dernière erreur de polling |

**PK** : (`account_id`, `folder`)

---

### `trigger_logs`

Journal d'évaluation/déclenchement des triggers.

| Colonne | Type | Contraintes | Description |
|---|---|---|---|
| `id` | text PK | UUID | |
| `trigger_id` | text | FK → account_triggers.id, ON DELETE CASCADE, NOT NULL | |
| `summary` | text | | Résumé du mail (« from · subject ») |
| `matched` | integer | NOT NULL | 1 si le trigger a matché |
| `action` | text | | 'conversation' \| 'task' (null si non matché) |
| `created_at` | integer | NOT NULL | |

**Index** :
- `idx_trigger_logs_trigger_created` sur (`trigger_id`, `created_at`)

---

### `vault_secrets`

Coffre-fort de secrets chiffrés.

| Colonne | Type | Contraintes | Description |
|---|---|---|---|
| `id` | text PK | UUID | |
| `key` | text | UNIQUE, NOT NULL | Nom du secret (ex: 'GITHUB_TOKEN') |
| `encrypted_value` | text | NOT NULL | Valeur chiffrée (encryption at rest) |
| `description` | text | | Description du secret |
| `entry_type` | text | NOT NULL, DEFAULT 'text' | Type de l'entrée : 'text', 'credential', 'card', 'note', 'identity', ou slug custom |
| `vault_type_id` | text | FK → vault_types.id, ON DELETE SET NULL | Type custom associé |
| `is_favorite` | integer | NOT NULL, DEFAULT 0 | Marqué comme favori |
| `created_by_agent_id` | text | FK → agents.id | Agent qui a créé le secret |
| `created_at` | integer | NOT NULL | |
| `updated_at` | integer | NOT NULL | |

**Index** :
- `idx_vault_secrets_entry_type` sur `entry_type`

---

### `vault_types`

Types personnalisés pour les entrées du coffre-fort.

| Colonne | Type | Contraintes | Description |
|---|---|---|---|
| `id` | text PK | UUID | |
| `slug` | text | UNIQUE, NOT NULL | Identifiant machine |
| `name` | text | NOT NULL | Nom d'affichage |
| `icon` | text | | Nom d'icône Lucide |
| `fields` | text | NOT NULL | JSON : VaultTypeField[] |
| `is_built_in` | integer | NOT NULL, DEFAULT 0 | Type intégré (non supprimable) |
| `created_by_agent_id` | text | FK → agents.id, ON DELETE SET NULL | |
| `created_at` | integer | NOT NULL | |
| `updated_at` | integer | NOT NULL | |

---

### `vault_attachments`

Pièces jointes aux entrées du coffre-fort.

| Colonne | Type | Contraintes | Description |
|---|---|---|---|
| `id` | text PK | UUID | |
| `entry_id` | text | FK → vault_secrets.id, ON DELETE CASCADE, NOT NULL | |
| `original_name` | text | NOT NULL | Nom d'origine du fichier |
| `stored_path` | text | NOT NULL | Chemin de stockage |
| `mime_type` | text | NOT NULL | Type MIME |
| `size` | integer | NOT NULL | Taille en octets |
| `created_at` | integer | NOT NULL | |

**Index** :
- `idx_vault_attachments_entry` sur `entry_id`

---

### `queue_items`

Queue FIFO par Agent pour sérialiser le traitement des messages.

| Colonne | Type | Contraintes | Description |
|---|---|---|---|
| `id` | text PK | UUID | |
| `agent_id` | text | FK → agents.id, NOT NULL | Agent destinataire |
| `message_type` | text | NOT NULL | 'user', 'agent_request', 'agent_inform', 'agent_reply', 'task_result', 'task_input' |
| `content` | text | NOT NULL | Contenu du message |
| `source_type` | text | NOT NULL | 'user', 'agent', 'task' |
| `source_id` | text | | ID de la source |
| `priority` | integer | NOT NULL, DEFAULT 0 | Plus élevé = traité en premier (user > automatique) |
| `request_id` | text | | Pour corrélation inter-Agents |
| `in_reply_to` | text | | Pour réponses inter-Agents |
| `task_id` | text | FK → tasks.id | Pour messages liés à une tâche |
| `session_id` | text | | ID de quick session (si applicable) |
| `channel_origin_id` | text | | ID de la chaîne causale canal pour auto-delivery |
| `status` | text | NOT NULL, DEFAULT 'pending' | 'pending', 'processing', 'done' |
| `created_message_id` | text | | ID du message utilisateur déjà inséré (idempotence en cas de recovery) |
| `created_at` | integer | NOT NULL | |
| `processed_at` | integer | | |

**Index** :
- `idx_queue_agent_status_priority` sur (`agent_id`, `status`, `priority` DESC, `created_at` ASC)

---

### `files`

Fichiers uploadés par les utilisateurs ou générés par les Agents.

| Colonne | Type | Contraintes | Description |
|---|---|---|---|
| `id` | text PK | UUID | |
| `agent_id` | text | FK → agents.id, NOT NULL | |
| `message_id` | text | FK → messages.id | Message auquel le fichier est attaché |
| `uploaded_by` | text | FK → user.id | NULL si généré par un Agent |
| `original_name` | text | NOT NULL | Nom d'origine du fichier |
| `stored_path` | text | NOT NULL | Chemin de stockage local |
| `mime_type` | text | NOT NULL | Type MIME |
| `size` | integer | NOT NULL | Taille en octets |
| `created_at` | integer | NOT NULL | |

---

### `llm_usage`

Suivi des consommations de tokens LLM pour toutes les invocations AI (chat, tâches, quick sessions, compacting, mémoire, embeddings, génération d'images).

| Colonne | Type | Contraintes | Description |
|---|---|---|---|
| `id` | text PK | UUID | |
| `created_at` | integer | NOT NULL | Timestamp de l'appel |
| `call_site` | text | NOT NULL | Point d'appel : 'chat', 'quick-session', 'task', 'compacting', 'consolidation', 'memory-review', 'embedding', 'image-gen', etc. |
| `call_type` | text | NOT NULL | Type d'appel : 'stream-text', 'generate-text', 'embed', 'generate-image' |
| `provider_type` | text | | Type de provider : 'anthropic', 'openai', 'gemini', etc. |
| `provider_id` | text | | UUID du provider (nullable — le provider peut être supprimé) |
| `model_id` | text | | Ex: 'claude-sonnet-4-20250514' |
| `agent_id` | text | | ID du Agent (nullable pour les appels hors Agent) |
| `task_id` | text | | ID de la tâche (nullable) |
| `cron_id` | text | | ID du cron (nullable) |
| `session_id` | text | | ID de quick session (nullable) |
| `input_tokens` | integer | | Tokens d'entrée |
| `output_tokens` | integer | | Tokens de sortie |
| `total_tokens` | integer | | Total des tokens |
| `cache_read_tokens` | integer | | Tokens lus depuis le cache |
| `cache_write_tokens` | integer | | Tokens écrits dans le cache |
| `reasoning_tokens` | integer | | Tokens de raisonnement (sortie) |
| `embedding_tokens` | integer | | Tokens d'embedding |
| `step_count` | integer | NOT NULL, DEFAULT 1 | Nombre d'étapes (pour les boucles multi-step streamText) |

**Index** :
- `idx_llm_usage_created` sur (`created_at`)
- `idx_llm_usage_agent` sur (`agent_id`, `created_at`)
- `idx_llm_usage_provider_type` sur (`provider_type`, `created_at`)
- `idx_llm_usage_model` sur (`model_id`, `created_at`)
- `idx_llm_usage_task` sur (`task_id`)
- `idx_llm_usage_cron` sur (`cron_id`)

---

### `projects`

Projets de la plateforme. Entités indépendantes des Agents (partagées entre tous les utilisateurs, n'importe quel Agent peut sélectionner n'importe quel projet). Voir `projects.md` pour la spec complète.

| Colonne | Type | Contraintes | Description |
|---|---|---|---|
| `id` | text PK | UUID | |
| `title` | text | NOT NULL | Titre du projet |
| `description` | text | NOT NULL, DEFAULT '' | Description complète injectée dans le bloc volatile du prompt système des Agents quand le projet est actif. Pas de cap dur en DB (cap pratique à l'injection : 8000 tokens, cf. `config.md`) |
| `github_url` | text | | URL externe (metadata uniquement, pas d'intégration tool au MVP) |
| `created_at` | integer | NOT NULL | |
| `updated_at` | integer | NOT NULL | |

**Index** :
- `idx_projects_created` sur `created_at`

---

### `project_tags`

Tags propres à chaque projet. Bibliothèque non partagée entre projets — un tag "bug" dans le projet A est distinct d'un tag "bug" dans le projet B.

| Colonne | Type | Contraintes | Description |
|---|---|---|---|
| `id` | text PK | UUID | |
| `project_id` | text | FK → projects.id, ON DELETE CASCADE, NOT NULL | |
| `label` | text | NOT NULL | Libellé du tag (ex: 'bug', 'feature') |
| `color` | text | NOT NULL | Couleur hex (ex: '#ef4444') |
| `created_at` | integer | NOT NULL | |
| `updated_at` | integer | NOT NULL | |

**Contrainte UNIQUE** : (`project_id`, `label`)

**Index** :
- `idx_project_tags_project` sur `project_id`

> À la création d'un projet, un seed `DEFAULT_PROJECT_TAGS` (défini dans `src/shared/constants.ts`) est appliqué : `bug`, `feature`, `chore`, `doc` avec couleurs par défaut. Les tags restent ensuite librement éditables.

---

### `tickets`

Unités de travail au sein d'un projet. Visualisées dans un kanban à 5 colonnes.

| Colonne | Type | Contraintes | Description |
|---|---|---|---|
| `id` | text PK | UUID | |
| `project_id` | text | FK → projects.id, ON DELETE CASCADE, NOT NULL | |
| `title` | text | NOT NULL | Titre du ticket |
| `description` | text | NOT NULL, DEFAULT '' | Détails du ticket |
| `status` | text | NOT NULL, DEFAULT 'backlog' | `'backlog' \| 'todo' \| 'in_progress' \| 'blocked' \| 'done'` |
| `position` | integer | NOT NULL, DEFAULT 0 | Ordre dans la colonne kanban. Inséré à `max(position) + 1024` dans la colonne cible. |
| `created_at` | integer | NOT NULL | |
| `updated_at` | integer | NOT NULL | |

**Index** :
- `idx_tickets_project_status_position` sur (`project_id`, `status`, `position` ASC) — rendu kanban
- `idx_tickets_project_updated` sur (`project_id`, `updated_at` DESC) — vues "récents"

> Pas de champ `priority` au MVP. Si le besoin émerge, le modéliser comme tag plutôt qu'enum figée.

---

### `ticket_tags`

Table de liaison N-N tickets ↔ project_tags.

| Colonne | Type | Contraintes | Description |
|---|---|---|---|
| `ticket_id` | text | FK → tickets.id, ON DELETE CASCADE, NOT NULL | |
| `tag_id` | text | FK → project_tags.id, ON DELETE CASCADE, NOT NULL | |

**PK composite** : (`ticket_id`, `tag_id`)

**Index** :
- `idx_ticket_tags_ticket` sur `ticket_id`
- `idx_ticket_tags_tag` sur `tag_id`

---

### `mini_apps`

Mini-applications web (UI iframe + backend `_server.js` optionnel) construites par les Agents. Les fichiers vivent sur disque dans `{MINI_APPS_DIR}/<agent_id>/<app_id>/` ; cette table porte les métadonnées. Le manifest `app.json` (sur disque, pas en DB) déclare les dépendances (import map), `background: true` (backend chargé au boot, redémarré à chaque édition) et `permissions` (capacités demandées).

| Colonne | Type | Contraintes | Description |
|---|---|---|---|
| `id` | text PK | UUID | |
| `agent_id` | text | FK → agents.id, ON DELETE CASCADE, NOT NULL | Agent **mainteneur** (réassignable — n'importe quel Agent peut éditer n'importe quelle app) |
| `name` | text | NOT NULL | Nom affiché |
| `slug` | text | NOT NULL | Identifiant kebab-case, unique par Agent |
| `description` | text | | |
| `icon` | text | | Emoji ou nom d'icône Lucide |
| `icon_url` | text | | Chemin du logo généré (image) |
| `entry_file` | text | NOT NULL, DEFAULT 'index.html' | Fichier d'entrée servi dans l'iframe |
| `has_backend` | integer (bool) | NOT NULL, DEFAULT 0 | Vrai si `_server.js`/`_server.ts` existe |
| `is_active` | integer (bool) | NOT NULL, DEFAULT 1 | |
| `version` | integer | NOT NULL, DEFAULT 1 | Incrémenté à chaque écriture de fichier (cache-busting + invalidation du backend) |
| `granted_permissions` | text | | JSON `string[]` des permissions de capacités approuvées par l'utilisateur (sous-ensemble des `permissions` du manifest, ex. `"llm"`, `"secrets:<NAME>"`, `"agent:inform"`, `"agent:task"`). Additif uniquement. |
| `created_at` | integer | NOT NULL | |
| `updated_at` | integer | NOT NULL | |

**Index** :
- `idx_mini_apps_agent_slug` UNIQUE sur (`agent_id`, `slug`)
- `idx_mini_apps_agent_id` sur (`agent_id`)

---

### `mini_app_storage`

Stockage clé-valeur par app, partagé entre le frontend (SDK `Hivekeep.storage`) et le backend (`ctx.storage`). Limites : 500 clés/app, 64 KB/valeur, clés ≤ 256 caractères.

| Colonne | Type | Contraintes | Description |
|---|---|---|---|
| `id` | integer PK | AUTOINCREMENT | |
| `app_id` | text | FK → mini_apps.id, ON DELETE CASCADE, NOT NULL | |
| `key` | text | NOT NULL | |
| `value` | text | NOT NULL | JSON sérialisé |
| `updated_at` | integer | NOT NULL | |

---

### `mini_app_snapshots`

Snapshots de version des fichiers d'une app (max 20, auto-élagués). Les fichiers snapshotés vivent dans `.snapshots/<version>/` du répertoire de l'app ; le répertoire runtime `_data/` (ctx.files) est exclu des snapshots et des rollbacks.

| Colonne | Type | Contraintes | Description |
|---|---|---|---|
| `id` | integer PK | AUTOINCREMENT | |
| `app_id` | text | FK → mini_apps.id, ON DELETE CASCADE, NOT NULL | |
| `version` | integer | NOT NULL | Version de l'app au moment du snapshot |
| `label` | text | | Libellé optionnel (ex. auto-backup avant rollback) |
| `file_manifest` | text | NOT NULL | JSON `[{path, size}]` |
| `created_at` | integer | NOT NULL | |

---

### `workspace_folders`

Dossiers FS arbitraires ajoutés par l'utilisateur, affichés dans le sélecteur de la section Files à côté des workspaces d'agents et des repos de projet. Le chemin est canonicalisé (realpath) à la création et re-validé à chaque navigation. Visible et éditable par tous les utilisateurs authentifiés (décision fondateur).

| Colonne | Type | Contraintes | Description |
|---|---|---|---|
| `id` | text PK | UUID | |
| `label` | text | NOT NULL | Nom affiché dans le sélecteur |
| `path` | text | NOT NULL | Dossier absolu, canonicalisé (realpath) |
| `created_by` | text | | Utilisateur ayant ajouté le dossier (audit) |
| `created_at` | integer | NOT NULL | Unix ms |

---

## Tables virtuelles (FTS5 + sqlite-vec)

### `memories_fts` (FTS5)

Full-text search sur le contenu des mémoires.

```sql
CREATE VIRTUAL TABLE memories_fts USING fts5(
  content,
  content_rowid='rowid',
  tokenize='unicode61'
);
```

Synchronisée avec la table `memories` via triggers INSERT/UPDATE/DELETE.

### `messages_fts` (FTS5)

Full-text search sur le contenu des messages (pour `search_history`).

```sql
CREATE VIRTUAL TABLE messages_fts USING fts5(
  content,
  content_rowid='rowid',
  tokenize='unicode61'
);
```

Synchronisée avec la table `messages` via triggers.

### `memories_vec` (sqlite-vec)

Recherche vectorielle KNN sur les embeddings des mémoires.

```sql
CREATE VIRTUAL TABLE memories_vec USING vec0(
  memory_id text PRIMARY KEY,
  embedding float[1536]
);
```

> **Note** : la dimension du vecteur (1536) correspond a `text-embedding-3-small` d'OpenAI. Si un autre modèle d'embedding est utilisé avec une dimension différente, cette valeur doit être ajustée. La dimension est fixée a la création de la table et ne peut pas être changée dynamiquement.

---

## Diagramme des relations

```
user (Better Auth)
 ├── 1:1  user_profiles
 ├── 1:N  session (Better Auth)
 └── 1:N  account (Better Auth)

providers (standalone)

agents
 ├── N:M  mcp_servers        (via agent_mcp_servers)
 ├── 1:N  messages            (session principale: task_id = NULL)
 ├── 1:N  compacting_snapshots  (legacy)
 ├── 1:N  compacting_summaries  (multi-summary accumulation)
 ├── 1:N  memories
 ├── 1:N  custom_tools
 ├── 1:N  tasks               (en tant que parent_agent_id)
 ├── 1:N  crons
 │         └── 1:N  cron_learnings  (FIFO cap 20, ON DELETE CASCADE)
 ├── 1:N  webhooks
 ├── 1:N  queue_items
 ├── 1:N  files
 └── N:1  projects            (via agents.active_project_id, ON DELETE SET NULL)

projects (entités indépendantes, partagées)
 ├── 1:N  project_tags        (ON DELETE CASCADE)
 ├── 1:N  tickets             (ON DELETE CASCADE)
 │         └── N:M  project_tags  (via ticket_tags, ON DELETE CASCADE des deux côtés)
 └── 1:N  tasks               (via tasks.ticket_id, ON DELETE SET NULL — historique préservé)

contacts (registre partagé)
 ├── 1:N  contact_identifiers
 ├── 1:N  contact_platform_ids
 └── 1:N  contact_notes        (par Agent, privées ou globales)

tasks
 ├── 1:N  messages            (session de tâche: task_id = tasks.id)
 ├── 1:N  tasks               (sous-tâches: parent_task_id)
 ├── N:1  crons               (si spawné par un cron)
 ├── N:1  webhooks            (si spawné par un webhook en mode task)
 └── N:1  tickets             (si spawné depuis un ticket, via tasks.ticket_id)

webhooks
 ├── 1:N  webhook_logs
 └── 1:N  tasks               (via tasks.webhook_id, mode dispatch "task")

vault_secrets
 ├── N:1  vault_types
 └── 1:N  vault_attachments

llm_usage (standalone, indexes sur agent_id, provider_type, model_id, task_id, cron_id)
```

---

## External API (machine-to-machine)

Voir `external-api.md`. Un client externe déclaré tient des conversations avec un Agent via `/api/v1/*`, authentifié par une clé bearer. Les réponses sont corrélées par `requestId`.

### `api_clients`

Appelant externe déclaré (admin uniquement). Représenté comme l'auteur du message ; ses tool calls agissent comme `owner_user_id`.

| Colonne | Type | Contraintes | Description |
|---|---|---|---|
| `id` | text PK | UUID | |
| `name` | text | NOT NULL | Affiché en préfixe d'attribution `[name]` |
| `description` | text | | |
| `owner_user_id` | text | FK → user.id, ON DELETE CASCADE, NOT NULL | Acteur des tool calls |
| `agent_id` | text | FK → agents.id, ON DELETE CASCADE | NULL = tout Agent ; sinon verrouillé sur un seul |
| `allowed_modes` | text | NOT NULL, DEFAULT `'["main","isolated"]'` | JSON, sous-ensemble de `['main','isolated']` |
| `rate_limit_per_min` | integer | | NULL = `externalApi.defaultRateLimitPerMinute` |
| `status` | text | NOT NULL, DEFAULT 'active' | 'active' \| 'disabled' |
| `created_at` | integer | NOT NULL | |
| `updated_at` | integer | NOT NULL | |

**Index** : `idx_api_clients_owner` sur `owner_user_id`

### `api_keys`

Credential rotatable sous un client. Seul le hash est stocké ; la clé complète `hk_<id>.<secret>` n'est montrée qu'une fois.

| Colonne | Type | Contraintes | Description |
|---|---|---|---|
| `id` | text PK | UUID | Le `<keyId>` du token |
| `client_id` | text | FK → api_clients.id, ON DELETE CASCADE, NOT NULL | |
| `label` | text | NOT NULL | |
| `key_hash` | text | NOT NULL | sha256(secret) |
| `key_prefix` | text | NOT NULL | Affichage seul, ex. `hk_a1b2c3…` |
| `last_used_at` | integer | | Écriture throttlée |
| `revoked_at` | integer | | Révocation soft (jamais supprimée) |
| `created_at` | integer | NOT NULL | |

**Index** : `idx_api_keys_client` sur `client_id`

### `api_conversations`

Fil isolé : un couloir de contexte privé pour un client, adossé à une `quick_sessions` (`kind='api'`). Possède le cycle de vie (TTL glissant).

| Colonne | Type | Contraintes | Description |
|---|---|---|---|
| `id` | text PK | UUID | Le `conversationId` public |
| `client_id` | text | FK → api_clients.id, ON DELETE CASCADE, NOT NULL | |
| `agent_id` | text | FK → agents.id, ON DELETE CASCADE, NOT NULL | |
| `session_id` | text | FK → quick_sessions.id, ON DELETE CASCADE, NOT NULL | Session backing |
| `title` | text | | |
| `status` | text | NOT NULL, DEFAULT 'active' | 'active' \| 'closed' |
| `created_at` | integer | NOT NULL | |
| `last_message_at` | integer | | Pilote le TTL glissant |
| `expires_at` | integer | | Glissant, rafraîchi à chaque message |

**Index** : `idx_api_conversations_client` sur `client_id`, `idx_api_conversations_session` sur `session_id`

### `api_requests`

Corrélation entre un message envoyé et sa réponse. `id` = `requestId`, posé aussi sur `queue_items.request_id`. GC après `externalApi.replyRetentionHours`.

| Colonne | Type | Contraintes | Description |
|---|---|---|---|
| `id` | text PK | UUID | Le `requestId` |
| `client_id` | text | FK → api_clients.id, ON DELETE CASCADE, NOT NULL | |
| `agent_id` | text | FK → agents.id, ON DELETE CASCADE, NOT NULL | |
| `conversation_id` | text | | NULL = timeline principale |
| `queue_item_id` | text | | Item enfilé |
| `request_message_id` | text | FK → messages.id, ON DELETE SET NULL | |
| `status` | text | NOT NULL, DEFAULT 'pending' | 'pending' \| 'done' \| 'error' \| 'cancelled' |
| `reply_message_id` | text | FK → messages.id, ON DELETE SET NULL | |
| `reply_content` | text | | Dénormalisé pour des lectures poll/wait économiques |
| `error_code` | text | | |
| `error_message` | text | | |
| `created_at` | integer | NOT NULL | |
| `completed_at` | integer | | |

**Index** : `idx_api_requests_client` sur `client_id`, `idx_api_requests_status` sur `status`

> **`quick_sessions.kind`** : colonne ajoutée (`'quick'` par défaut, `'api'` pour les fils isolés). Les sessions `kind='api'` tournent à pleine puissance (prompt + outils complets), ont `expires_at = null` (exemptées du GC des quick sessions), et sont exclues de la liste/quota des quick sessions humaines.

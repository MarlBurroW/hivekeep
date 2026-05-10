# KinBot — Schéma de base de données

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

## Tables custom KinBot

### `user_profiles`

Extension du `user` Better Auth avec les champs spécifiques KinBot.

| Colonne | Type | Contraintes | Description |
|---|---|---|---|
| `user_id` | text PK | FK → user.id | Lié 1:1 au user Better Auth |
| `first_name` | text | NOT NULL | Prénom |
| `last_name` | text | NOT NULL | Nom |
| `pseudonym` | text | NOT NULL | Pseudonyme affiché dans le chat |
| `language` | text | NOT NULL, DEFAULT 'fr' | 'fr' ou 'en' |
| `role` | text | NOT NULL, DEFAULT 'member' | 'admin' ou 'member' |
| `kin_order` | text | | JSON array des IDs de Kins (ordre d'affichage) |
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

### `kins`

Agents IA de la plateforme.

| Colonne | Type | Contraintes | Description |
|---|---|---|---|
| `id` | text PK | UUID | |
| `slug` | text | UNIQUE | Identifiant URL-friendly (ex: 'my-assistant') |
| `name` | text | NOT NULL | Nom du Kin |
| `role` | text | NOT NULL | Description courte de sa fonction |
| `avatar_path` | text | | Chemin vers l'image avatar |
| `character` | text | NOT NULL | Personnalité / SOUL |
| `expertise` | text | NOT NULL | Connaissances et objectif |
| `model` | text | NOT NULL | Identifiant du modèle LLM (ex: 'claude-sonnet-4-20250514') |
| `provider_id` | text | FK → providers.id, ON DELETE SET NULL | Provider explicite pour le modèle du Kin |
| `workspace_path` | text | NOT NULL | Chemin du dossier de travail |
| `tool_config` | text | | JSON : KinToolConfig (outils désactivés, accès MCP, opt-in, search provider) |
| `compacting_config` | text | | JSON : KinCompactingConfig (seuil de tours, modèle de compacting, provider) |
| `created_by` | text | FK → user.id | Utilisateur qui a créé le Kin |
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
| `created_by_kin_id` | text | FK → kins.id, ON DELETE SET NULL | Kin qui a créé le serveur (si auto-géré) |
| `created_at` | integer | NOT NULL | |
| `updated_at` | integer | NOT NULL | |

---

### `kin_mcp_servers`

Table de liaison Kins ↔ Serveurs MCP (many-to-many).

| Colonne | Type | Contraintes | Description |
|---|---|---|---|
| `kin_id` | text | FK → kins.id, ON DELETE CASCADE | |
| `mcp_server_id` | text | FK → mcp_servers.id, ON DELETE CASCADE | |

**PK composite** : (`kin_id`, `mcp_server_id`)

---

### `messages`

Tous les messages de toutes les sessions (principales et tâches).

| Colonne | Type | Contraintes | Description |
|---|---|---|---|
| `id` | text PK | UUID | |
| `kin_id` | text | FK → kins.id, NOT NULL | Kin propriétaire de la session |
| `task_id` | text | FK → tasks.id | NULL = session principale, sinon session de tâche |
| `session_id` | text | FK → quick_sessions.id, ON DELETE CASCADE | NULL = main conversation, sinon quick session |
| `role` | text | NOT NULL | 'user', 'assistant', 'system', 'tool' |
| `content` | text | | Contenu textuel du message |
| `source_type` | text | NOT NULL | 'user', 'kin', 'task', 'cron', 'system' |
| `source_id` | text | | ID de la source (user_id, kin_id, task_id, cron_id) |
| `tool_calls` | text | | JSON array des appels d'outils (messages assistant) |
| `tool_call_id` | text | | ID de l'appel d'outil (messages tool) |
| `request_id` | text | | Pour corrélation inter-Kins (request/reply) |
| `in_reply_to` | text | | request_id auquel ce message répond |
| `channel_origin_id` | text | | ID de la chaîne causale canal — propage l'origine pour auto-delivery |
| `is_redacted` | integer | NOT NULL, DEFAULT 0 | Message caviardé (secret retiré) |
| `redact_pending` | integer | NOT NULL, DEFAULT 0 | Caviardage en attente — bloque le compacting |
| `metadata` | text | | JSON pour données additionnelles |
| `created_at` | integer | NOT NULL | |

**Index** :
- `idx_messages_kin_id` sur `kin_id`
- `idx_messages_task_id` sur `task_id`
- `idx_messages_kin_created` sur (`kin_id`, `created_at`)
- `idx_messages_source` sur (`source_type`, `source_id`)
- `idx_messages_session_id` sur `session_id`

---

### `compacting_snapshots`

> **Legacy** : table de l'ancien système de compacting (snapshot unique). Conservée pour rétro-compatibilité. Le nouveau système utilise `compacting_summaries`.

| Colonne | Type | Contraintes | Description |
|---|---|---|---|
| `id` | text PK | UUID | |
| `kin_id` | text | FK → kins.id, NOT NULL | |
| `summary` | text | NOT NULL | Résumé compacté des échanges |
| `messages_up_to_id` | text | FK → messages.id, NOT NULL | Dernier message couvert par ce snapshot |
| `is_active` | integer | NOT NULL, DEFAULT 1 | Snapshot actuellement utilisé (un seul actif par Kin) |
| `created_at` | integer | NOT NULL | |

**Index** :
- `idx_compacting_kin_active` sur (`kin_id`, `is_active`)

---

### `compacting_summaries`

Résumés de compacting avec accumulation multi-summary et merge télescopique.

| Colonne | Type | Contraintes | Description |
|---|---|---|---|
| `id` | text PK | UUID | |
| `kin_id` | text | FK → kins.id, NOT NULL | |
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
- `idx_compacting_summaries_kin` sur (`kin_id`, `is_in_context`)

---

### `memories`

Mémoire long terme des Kins (faits, préférences, décisions, connaissances).

| Colonne | Type | Contraintes | Description |
|---|---|---|---|
| `id` | text PK | UUID | |
| `kin_id` | text | FK → kins.id, NOT NULL | |
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
| `scope` | text | NOT NULL, DEFAULT 'private' | 'private' (Kin seul) ou 'shared' (visible par tous les Kins) |
| `created_at` | integer | NOT NULL | |
| `updated_at` | integer | NOT NULL | |

**Index** :
- `idx_memories_kin_id` sur `kin_id`
- `idx_memories_kin_category` sur (`kin_id`, `category`)
- `idx_memories_kin_subject` sur (`kin_id`, `subject`)
- `idx_memories_scope` sur `scope`
- `idx_memories_scope_category` sur (`scope`, `category`)

---

### `contacts`

Registre de contacts partagé entre tous les Kins. Le nom affiché est calculé : `firstName lastName`, ou à défaut le premier pseudo, ou « Unnamed contact ».

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

Notes des Kins sur les contacts (privées ou globales).

| Colonne | Type | Contraintes | Description |
|---|---|---|---|
| `id` | text PK | UUID | |
| `contact_id` | text | FK → contacts.id, ON DELETE CASCADE, NOT NULL | |
| `kin_id` | text | FK → kins.id, NOT NULL | Kin auteur de la note |
| `scope` | text | NOT NULL | 'private' (ce Kin seul) ou 'global' (tous les Kins) |
| `content` | text | NOT NULL | Contenu de la note |
| `created_at` | integer | NOT NULL | |
| `updated_at` | integer | NOT NULL | |

**Contrainte UNIQUE** : (`contact_id`, `kin_id`, `scope`)

**Index** :
- `idx_contact_notes_contact_id` sur `contact_id`
- `idx_contact_notes_kin_id` sur `kin_id`

---

### `custom_tools`

Outils auto-générés par les Kins.

| Colonne | Type | Contraintes | Description |
|---|---|---|---|
| `id` | text PK | UUID | |
| `kin_id` | text | FK → kins.id, NOT NULL | |
| `name` | text | NOT NULL | Nom de l'outil |
| `description` | text | NOT NULL | Description pour le LLM |
| `parameters` | text | NOT NULL | JSON Schema des paramètres |
| `script_path` | text | NOT NULL | Chemin relatif dans le workspace |
| `created_at` | integer | NOT NULL | |
| `updated_at` | integer | NOT NULL | |

**Contrainte UNIQUE** : (`kin_id`, `name`)

---

### `quick_sessions`

Sessions éphémères pour interactions rapides.

| Colonne | Type | Contraintes | Description |
|---|---|---|---|
| `id` | text PK | UUID | |
| `kin_id` | text | FK → kins.id, ON DELETE CASCADE, NOT NULL | |
| `created_by` | text | FK → user.id, ON DELETE CASCADE, NOT NULL | |
| `title` | text | | Titre de la session |
| `status` | text | NOT NULL, DEFAULT 'active' | 'active' ou 'closed' |
| `created_at` | integer | NOT NULL | |
| `closed_at` | integer | | |
| `expires_at` | integer | | |

**Index** :
- `idx_quick_sessions_kin_status` sur (`kin_id`, `status`)
- `idx_quick_sessions_user` sur `created_by`

---

### `tasks`

Sous-Kins éphémères (tâches déléguées).

| Colonne | Type | Contraintes | Description |
|---|---|---|---|
| `id` | text PK | UUID | |
| `parent_kin_id` | text | FK → kins.id, NOT NULL | Kin qui a spawné la tâche |
| `source_kin_id` | text | FK → kins.id | Kin dont la tâche est une instance (si spawn_type = 'other') |
| `spawn_type` | text | NOT NULL | 'self' ou 'other' |
| `mode` | text | NOT NULL, DEFAULT 'await' | 'await' ou 'async' |
| `model` | text | | Override du modèle LLM (NULL = héritage) |
| `provider_id` | text | | Override du provider pour le modèle |
| `title` | text | | Titre optionnel de la tâche |
| `description` | text | NOT NULL | Instructions de la tâche |
| `status` | text | NOT NULL, DEFAULT 'pending' | 'queued', 'pending', 'in_progress', 'paused', 'awaiting_human_input', 'awaiting_kin_response', 'completed', 'failed', 'cancelled' |
| `result` | text | | Résultat final de la tâche |
| `error` | text | | Détail de l'erreur si failed |
| `depth` | integer | NOT NULL, DEFAULT 1 | Profondeur de nesting |
| `parent_task_id` | text | FK → tasks.id | Tâche parente (si sous-tâche d'une tâche) |
| `cron_id` | text | FK → crons.id | Si spawné par un cron |
| `request_input_count` | integer | NOT NULL, DEFAULT 0 | Nombre d'appels request_input (max 3) |
| `inter_kin_request_count` | integer | NOT NULL, DEFAULT 0 | Nombre d'appels send_message(request) depuis cette tâche |
| `pending_request_id` | text | | request_id en attente de réponse inter-Kin |
| `channel_origin_id` | text | | ID de la chaîne causale canal pour auto-delivery |
| `webhook_id` | text | FK → webhooks.id, ON DELETE SET NULL | Webhook qui a spawné cette tâche (mode dispatch "task") |
| `allow_human_prompt` | integer | NOT NULL, DEFAULT 1 | Si la tâche peut utiliser prompt_human |
| `concurrency_group` | text | | Nom du groupe de concurrence (ex: "batch-issues") |
| `concurrency_max` | integer | | Nombre max de tâches concurrentes dans ce groupe |
| `queued_at` | integer | | Timestamp de mise en queue (pour FIFO) |
| `created_at` | integer | NOT NULL | |
| `updated_at` | integer | NOT NULL | |

**Index** :
- `idx_tasks_parent_kin` sur `parent_kin_id`
- `idx_tasks_status` sur `status`
- `idx_tasks_cron` sur `cron_id`
- `idx_tasks_concurrency` sur (`concurrency_group`, `status`, `queued_at`)
- `idx_tasks_webhook` sur `webhook_id`

---

### `crons`

Tâches planifiées récurrentes.

| Colonne | Type | Contraintes | Description |
|---|---|---|---|
| `id` | text PK | UUID | |
| `kin_id` | text | FK → kins.id, NOT NULL | Kin propriétaire |
| `name` | text | NOT NULL | Libellé de la tâche planifiée |
| `schedule` | text | NOT NULL | Expression cron (ex: '0 9 * * *') |
| `task_description` | text | NOT NULL | Instructions données au sous-Kin |
| `target_kin_id` | text | FK → kins.id | Kin cible (NULL = soi-même) |
| `model` | text | | Override du modèle LLM |
| `provider_id` | text | | Override du provider pour le modèle |
| `is_active` | integer | NOT NULL, DEFAULT 1 | Actif / Inactif |
| `requires_approval` | integer | NOT NULL, DEFAULT 0 | Si créé par le Kin, nécessite validation utilisateur |
| `run_once` | integer | NOT NULL, DEFAULT 0 | Si activé, le cron se désactive automatiquement après la première exécution |
| `last_triggered_at` | integer | | Dernier déclenchement |
| `created_by` | text | | 'user' ou 'kin' — qui a créé le cron |
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
| `kin_id` | text | FK → kins.id, NOT NULL | Kin destinataire |
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
| `created_by` | text | | 'user' ou 'kin' |
| `created_at` | integer | NOT NULL | |
| `updated_at` | integer | NOT NULL | |

**Index** :
- `idx_webhooks_kin_id` sur `kin_id`

---

### `webhook_logs`

Journal des appels webhook reçus.

| Colonne | Type | Contraintes | Description |
|---|---|---|---|
| `id` | text PK | UUID | |
| `webhook_id` | text | FK → webhooks.id, ON DELETE CASCADE | |
| `payload` | text | | Payload reçu (JSON sérialisé) |
| `source_ip` | text | | IP de l'appelant |
| `filtered` | integer | NOT NULL, DEFAULT 0 | 1 si le payload a été filtré (non transmis au Kin) |
| `created_at` | integer | NOT NULL | |

**Index** :
- `idx_webhook_logs_webhook_created` sur (`webhook_id`, `created_at`)

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
| `created_by_kin_id` | text | FK → kins.id | Kin qui a créé le secret |
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
| `created_by_kin_id` | text | FK → kins.id, ON DELETE SET NULL | |
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

Queue FIFO par Kin pour sérialiser le traitement des messages.

| Colonne | Type | Contraintes | Description |
|---|---|---|---|
| `id` | text PK | UUID | |
| `kin_id` | text | FK → kins.id, NOT NULL | Kin destinataire |
| `message_type` | text | NOT NULL | 'user', 'kin_request', 'kin_inform', 'kin_reply', 'task_result', 'task_input' |
| `content` | text | NOT NULL | Contenu du message |
| `source_type` | text | NOT NULL | 'user', 'kin', 'task' |
| `source_id` | text | | ID de la source |
| `priority` | integer | NOT NULL, DEFAULT 0 | Plus élevé = traité en premier (user > automatique) |
| `request_id` | text | | Pour corrélation inter-Kins |
| `in_reply_to` | text | | Pour réponses inter-Kins |
| `task_id` | text | FK → tasks.id | Pour messages liés à une tâche |
| `session_id` | text | | ID de quick session (si applicable) |
| `channel_origin_id` | text | | ID de la chaîne causale canal pour auto-delivery |
| `status` | text | NOT NULL, DEFAULT 'pending' | 'pending', 'processing', 'done' |
| `created_message_id` | text | | ID du message utilisateur déjà inséré (idempotence en cas de recovery) |
| `created_at` | integer | NOT NULL | |
| `processed_at` | integer | | |

**Index** :
- `idx_queue_kin_status_priority` sur (`kin_id`, `status`, `priority` DESC, `created_at` ASC)

---

### `files`

Fichiers uploadés par les utilisateurs ou générés par les Kins.

| Colonne | Type | Contraintes | Description |
|---|---|---|---|
| `id` | text PK | UUID | |
| `kin_id` | text | FK → kins.id, NOT NULL | |
| `message_id` | text | FK → messages.id | Message auquel le fichier est attaché |
| `uploaded_by` | text | FK → user.id | NULL si généré par un Kin |
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
| `kin_id` | text | | ID du Kin (nullable pour les appels hors Kin) |
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
- `idx_llm_usage_kin` sur (`kin_id`, `created_at`)
- `idx_llm_usage_provider_type` sur (`provider_type`, `created_at`)
- `idx_llm_usage_model` sur (`model_id`, `created_at`)
- `idx_llm_usage_task` sur (`task_id`)
- `idx_llm_usage_cron` sur (`cron_id`)

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

kins
 ├── N:M  mcp_servers        (via kin_mcp_servers)
 ├── 1:N  messages            (session principale: task_id = NULL)
 ├── 1:N  compacting_snapshots  (legacy)
 ├── 1:N  compacting_summaries  (multi-summary accumulation)
 ├── 1:N  memories
 ├── 1:N  custom_tools
 ├── 1:N  tasks               (en tant que parent_kin_id)
 ├── 1:N  crons
 │         └── 1:N  cron_learnings  (FIFO cap 20, ON DELETE CASCADE)
 ├── 1:N  webhooks
 ├── 1:N  queue_items
 └── 1:N  files

contacts (registre partagé)
 ├── 1:N  contact_identifiers
 ├── 1:N  contact_platform_ids
 └── 1:N  contact_notes        (par Kin, privées ou globales)

tasks
 ├── 1:N  messages            (session de tâche: task_id = tasks.id)
 ├── 1:N  tasks               (sous-tâches: parent_task_id)
 ├── N:1  crons               (si spawné par un cron)
 └── N:1  webhooks            (si spawné par un webhook en mode task)

webhooks
 ├── 1:N  webhook_logs
 └── 1:N  tasks               (via tasks.webhook_id, mode dispatch "task")

vault_secrets
 ├── N:1  vault_types
 └── 1:N  vault_attachments

llm_usage (standalone, indexes sur kin_id, provider_type, model_id, task_id, cron_id)
```

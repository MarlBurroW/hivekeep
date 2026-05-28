# KinBot — Configuration centralisée

Toutes les valeurs configurables de la plateforme, regroupées par domaine. Ces valeurs sont définies dans `src/server/config.ts` et peuvent être surchargées via variables d'environnement.

---

## Général

| Clé | Env var | Default | Description |
|---|---|---|---|
| `port` | `PORT` | `3333` | Port du serveur HTTP |
| `maxRequestBodyBytes` | `MAX_REQUEST_BODY_MB` | `0` (illimité) | Taille max du corps d'une requête HTTP (Mo) acceptée par `Bun.serve`. Bun applique sinon un cap par défaut (~128 Mo) qui bloque silencieusement les gros uploads. `0` = illimité (`Number.MAX_SAFE_INTEGER`) |
| `dataDir` | `KINBOT_DATA_DIR` | `./data` | Répertoire des données persistantes (DB, uploads, workspaces) |
| `encryptionKey` | `ENCRYPTION_KEY` | auto-generated | Clé de chiffrement pour les secrets du Vault et les configs provider. Auto-générée et persistée dans le répertoire data si absente |
| `logLevel` | `LOG_LEVEL` | `info` | Niveau de log : 'debug', 'info', 'warn', 'error' |
| `appVersion` | `KINBOT_VERSION` | *(auto-detected)* | Version de l'application. Lue depuis `package.json` par défaut. Peut être explicitement définie pour surcharger la détection. En Docker, automatiquement extraite par l'entrypoint |
| — | `TRUSTED_ORIGINS` | *(aucun)* | Liste d'origines supplémentaires autorisées pour le CORS, séparées par des virgules (ex: `https://app.example.com`). Le `PUBLIC_URL` est toujours inclus automatiquement. Lu directement dans `app.ts` |

---

## Base de données

| Clé | Env var | Default | Description |
|---|---|---|---|
| `dbPath` | `DB_PATH` | `{dataDir}/kinbot.db` | Chemin du fichier SQLite |

---

## Compacting

| Clé | Env var | Default | Description |
|---|---|---|---|
| `compacting.model` | `COMPACTING_MODEL` | — | Modèle utilisé pour le compacting (format `providerId:modelId` supporté). Si non défini, utilise le modèle du Kin |
| `compacting.thresholdPercent` | `COMPACTING_THRESHOLD_PERCENT` | `75` | % d'utilisation du contexte avant déclenchement de la compaction |
| `compacting.keepPercent` | `COMPACTING_KEEP_PERCENT` | `40` | % de la fenêtre de contexte préservé en messages bruts (keep-window) |
| `compacting.summaryBudgetPercent` | `COMPACTING_SUMMARY_BUDGET_PERCENT` | `20` | % max de la fenêtre de contexte pour les résumés avant fusion télescopique |
| `compacting.maxSummaries` | `COMPACTING_MAX_SUMMARIES` | `10` | Nombre max de résumés actifs avant fusion télescopique |
| `compacting.maxSummariesPerKin` | `COMPACTING_MAX_SUMMARIES_PER_KIN` | `50` | Rétention totale de résumés par Kin (actifs + archivés) |

> **Per-Kin override** : chaque Kin peut surcharger les paramètres de compacting via son `compactingConfig` (stocké en JSON dans `kins.compacting_config`). L'interface de configuration se trouve dans l'onglet Compaction des paramètres du Kin. Les champs disponibles sont : `thresholdPercent`, `keepPercent`, `summaryBudgetPercent`, `maxSummaries`, `compactingModel`, et `compactingProviderId`.

---

## Pipeline de compaction progressive du contexte

| Clé | Env var | Default | Description |
|---|---|---|---|
| `historyTokenBudget` | `HISTORY_TOKEN_BUDGET` | `0` (désactivé) | Budget max de tokens estimés pour l'historique. Filet de sécurité d'urgence — le pipeline progressif gère normalement la taille du contexte |
| `toolResultMaskKeepLast` | `TOOL_RESULT_MASK_KEEP_LAST` | `2` | Nombre de groupes d'appels d'outils récents à garder intacts. Les plus anciens sont compactés en résumés d'une ligne |
| `observationCompactionWindow` | `OBSERVATION_COMPACTION_WINDOW` | `10` | Nombre de tours récents à garder en résolution complète. Les tours plus anciens voient leurs résultats d'outils tronqués. 0 = désactivé |
| `observationMaxChars` | `OBSERVATION_MAX_CHARS` | `200` | Nombre max de caractères pour les résultats d'outils tronqués dans la zone d'observation |

---

## Tool output spill (résultats d'outils volumineux)

| Clé | Env var | Default | Description |
|---|---|---|---|
| `toolOutputs.spillThreshold` | `TOOL_OUTPUT_SPILL_THRESHOLD` | `10000` | Seuil en octets au-delà duquel le résultat d'un outil est sauvegardé dans un fichier temporaire au lieu d'être inclus en intégralité dans le contexte |
| `toolOutputs.previewLines` | `TOOL_OUTPUT_PREVIEW_LINES` | `200` | Nombre de lignes d'aperçu incluses dans la référence compacte quand un résultat est "spillé" |
| `toolOutputs.ttlHours` | `TOOL_OUTPUT_TTL_HOURS` | `24` | Durée de rétention des fichiers temporaires (heures). Les fichiers plus anciens sont supprimés automatiquement |

---

## Tools

| Clé | Env var | Default | Description |
|---|---|---|---|
| `tools.maxSteps` | `TOOLS_MAX_STEPS` | `0` | Nombre max d'étapes de tool-calling par tour LLM. 0 = illimité (plafonné a 100 en interne) |
| `tools.concurrencyCap` | `TOOLS_CONCURRENCY_CAP` | `5` | Nombre max d'exécutions parallèles d'outils en lecture seule. Quand toutes les tool calls d'un step sont read-only, elles s'exécutent en parallèle (limité a cette valeur). Les batches mixtes avec au moins un outil mutant restent séquentiels |

---

## Custom tools

| Clé | Env var | Default | Description |
|---|---|---|---|
| — | `KINBOT_CUSTOM_TOOL_TIMEOUT` | `30000` | Timeout par défaut pour l'exécution d'un custom tool (ms) |
| — | `KINBOT_CUSTOM_TOOL_MAX_TIMEOUT` | `300000` | Timeout maximum autorisé pour un custom tool (ms). Les valeurs passées par le Kin sont plafonnées à cette limite |

---

## Mémoire long terme

| Clé | Env var | Default | Description |
|---|---|---|---|
| `memory.extractionModel` | `MEMORY_EXTRACTION_MODEL` | — | Modèle léger pour l'extraction de mémoires (ex: Haiku). Si non défini, utilise le modèle du Kin |
| `memory.maxRelevantMemories` | `MEMORY_MAX_RELEVANT` | `10` | Nombre max de mémoires injectées dans le prompt système |
| `memory.similarityThreshold` | `MEMORY_SIMILARITY_THRESHOLD` | `0.7` | Score minimum de similarité cosinus pour qu'une mémoire soit considérée pertinente |
| `memory.embeddingModel` | `MEMORY_EMBEDDING_MODEL` | `text-embedding-3-small` | Modèle d'embedding par défaut |
| `memory.embeddingDimension` | `MEMORY_EMBEDDING_DIMENSION` | `1536` | Dimension des vecteurs d'embedding |

---

## Queue

| Clé | Env var | Default | Description |
|---|---|---|---|
| `queue.userPriority` | — | `100` | Priorité des messages utilisateur |
| `queue.kinPriority` | — | `50` | Priorité des messages inter-Kins |
| `queue.taskPriority` | — | `50` | Priorité des messages de tâches |
| `queue.pollIntervalMs` | `QUEUE_POLL_INTERVAL` | `500` | Intervalle de vérification de la queue (ms) |

---

## Tâches (sous-Kins)

| Clé | Env var | Default | Description |
|---|---|---|---|
| `tasks.maxDepth` | `TASKS_MAX_DEPTH` | `3` | Profondeur maximale de nesting des sous-Kins |
| `tasks.maxRequestInput` | `TASKS_MAX_REQUEST_INPUT` | `3` | Nombre max d'appels request_input par sous-Kin |
| `tasks.maxConcurrent` | `TASKS_MAX_CONCURRENT` | `10` | Nombre max de tâches concurrentes (tous Kins confondus) |

---

## Crons

| Clé | Env var | Default | Description |
|---|---|---|---|
| `crons.maxActive` | `CRONS_MAX_ACTIVE` | `50` | Nombre max de crons actifs |
| `crons.maxConcurrentExecutions` | `CRONS_MAX_CONCURRENT_EXEC` | `5` | Nombre max d'exécutions de crons concurrentes |

---

## Communication inter-Kins

| Clé | Env var | Default | Description |
|---|---|---|---|
| `interKin.maxChainDepth` | `INTER_KIN_MAX_CHAIN_DEPTH` | `5` | Profondeur max d'une chaîne de messages inter-Kins |
| `interKin.rateLimitPerMinute` | `INTER_KIN_RATE_LIMIT` | `20` | Nombre max de messages qu'un Kin peut envoyer a un autre par minute |

---

## Vault

| Clé | Env var | Default | Description |
|---|---|---|---|
| `vault.algorithm` | — | `aes-256-gcm` | Algorithme de chiffrement des secrets |

---

## Workspace

| Clé | Env var | Default | Description |
|---|---|---|---|
| `workspace.baseDir` | `WORKSPACE_BASE_DIR` | `{dataDir}/workspaces` | Répertoire racine des workspaces des Kins |

---

## Upload

| Clé | Env var | Default | Description |
|---|---|---|---|
| `upload.dir` | `UPLOAD_DIR` | `{dataDir}/uploads` | Répertoire de stockage des fichiers (chat, attachments tickets) |
| `upload.maxFileSizeMb` | `UPLOAD_MAX_FILE_SIZE` | `50` | Taille max d'un fichier uploadé (Mo). Sert aussi de défaut pour les attachments tickets |
| — | `TICKET_ATTACHMENT_MAX_SIZE` | `UPLOAD_MAX_FILE_SIZE` | Override spécifique aux attachments tickets, en Mo. Les fichiers sont stockés sous `{upload.dir}/tickets/<projectId>/<ticketId>/<id>.<ext>` et supprimés en cascade quand le ticket est détruit |

---

## Navigation web (one-shot)

Configuration partagée par les tools `browse_url`, `extract_links`, `screenshot_url`. `browse_url` utilise `fetch` + cheerio par défaut ; le path Playwright est emprunté quand `wait_for_js: true` ou pour `screenshot_url`.

| Clé | Env var | Default | Description |
|---|---|---|---|
| `webBrowsing.pageTimeout` | `WEB_BROWSING_PAGE_TIMEOUT` | `30000` | Timeout de chargement d'une page (ms) |
| `webBrowsing.maxContentLength` | `WEB_BROWSING_MAX_CONTENT_LENGTH` | `100000` | Taille max du contenu extrait (caractères) |
| `webBrowsing.maxConcurrentFetches` | `WEB_BROWSING_MAX_CONCURRENT` | `5` | Nombre de fetch simultanés |
| `webBrowsing.userAgent` | `WEB_BROWSING_USER_AGENT` | `Mozilla/5.0 ... Chrome/131.0.0.0 Safari/537.36` | User-Agent envoyé pour les requêtes web |
| `webBrowsing.blockedDomains` | `WEB_BROWSING_BLOCKED_DOMAINS` | _(vide)_ | Liste de domaines bloqués (séparée par des virgules) |
| `webBrowsing.proxy` | `WEB_BROWSING_PROXY` | _(vide)_ | URL d'un proxy HTTP à utiliser |
| `webBrowsing.headless.enabled` | `WEB_BROWSING_HEADLESS_ENABLED` | `true` | Active le pool Playwright (Chromium). Mettre `false` pour désactiver — utile sur des systèmes sans libs Chromium |
| `webBrowsing.headless.executablePath` | `BROWSER_EXECUTABLE_PATH` (fallback : `PUPPETEER_EXECUTABLE_PATH`) | _(auto)_ | Chemin explicite vers le binaire Chromium. Si non défini, Playwright utilise son binaire bundled |
| `webBrowsing.headless.maxBrowsers` | `WEB_BROWSING_MAX_BROWSERS` | `2` | Max d'instances Chromium concurrentes dans le pool one-shot |
| `webBrowsing.headless.idleTimeoutMs` | `WEB_BROWSING_BROWSER_IDLE_TIMEOUT` | `60000` | Délai d'inactivité (ms) avant fermeture d'un browser one-shot |

> **Pré-requis système** : Chromium nécessite des libs partagées (`libnspr4`, `libnss3`, `libasound2t64`, `libatk1.0-0t64`, `libcups2t64`, `libdrm2`, `libxkbcommon0`, `libxcomposite1`, `libxdamage1`, `libxfixes3`, `libxrandr2`, `libgbm1`, `libpango-1.0-0`, `libcairo2`, `libatspi2.0-0t64`, `libwayland-client0` sur Ubuntu 24.04 ; les noms `t64` n'existent que depuis le passage `time_t64`). Sans ces libs, Chromium échoue avec `cannot open shared object file`. Sur WSL2, vérifier aussi que `bun` n'est PAS confiné dans un snap (les snaps sandboxent l'accès à `/usr/lib/`).

---

## Sessions navigateur stateful

Configuration des **sessions de navigateur persistantes par Kin**, utilisées par les tools `browser_open_session`, `browser_navigate`, `browser_click`, etc. (14 tools `browser_*`). Chaque session conserve son état (cookies, scroll, formulaires) entre plusieurs tours LLM.

| Clé | Env var | Default | Description |
|---|---|---|---|
| `browserSessions.enabled` | `BROWSER_SESSIONS_ENABLED` | `true` | Active la famille de tools stateful. Mettre `false` pour la désactiver globalement (les tools restent registered mais retournent une erreur). Les tools individuels restent quoi qu'il arrive opt-in par Kin via `tool_config.enabledOptInTools` |
| `browserSessions.ttlMs` | `BROWSER_SESSION_TTL_MS` | `3_600_000` (1 h) | TTL absolu d'une session, depuis sa création, sans considération d'activité |
| `browserSessions.idleTimeoutMs` | `BROWSER_SESSION_IDLE_TIMEOUT_MS` | `600_000` (10 min) | Délai d'inactivité avant fermeture automatique (GC) |
| `browserSessions.maxTotal` | `BROWSER_MAX_TOTAL_SESSIONS` | `5` | Plafond global de sessions actives, toutes Kins confondues |
| `browserSessions.maxPerKin` | `BROWSER_MAX_SESSIONS_PER_KIN` | `1` | Plafond par Kin |
| `browserSessions.defaultViewport.width` | `BROWSER_DEFAULT_VIEWPORT_WIDTH` | `1280` | Largeur par défaut du viewport |
| `browserSessions.defaultViewport.height` | `BROWSER_DEFAULT_VIEWPORT_HEIGHT` | `720` | Hauteur par défaut du viewport |
| `browserSessions.statesDir` | `BROWSER_STATES_DIR` | `{dataDir}/browser-states` | Répertoire des états sauvegardés (cookies + localStorage). Stockés HORS du workspace pour que les filesystem tools du Kin ne puissent pas y accéder accidentellement. Permission `0o600`. |
| `browserSessions.maxStatesPerKin` | `BROWSER_MAX_STATES_PER_KIN` | `20` | Nombre max d'états sauvegardés par Kin |
| `browserSessions.maxStateSizeBytes` | `BROWSER_MAX_STATE_SIZE_BYTES` | `5_242_880` (5 Mo) | Taille max d'un fichier d'état (limite localStorage gourmand) |

> **Hooks de fermeture automatique** : sessions auto-closed à la fin d'une task (`resolveTask`), à la suppression d'un Kin (`deleteKin` — qui supprime aussi les états sauvegardés), au SIGTERM/SIGINT du serveur, et par le GC d'inactivité toutes les 15 s.

---

# Tuning knobs (advanced)

Paramètres de réglage interne — la plupart des déploiements n'y touchent jamais, les défauts sont éprouvés en production. Cette annexe les liste pour les exploitants qui veulent ajuster la mémoire, le cache de contexte, les limites de ressources, etc. **Modifier uniquement si vous comprenez l'impact** sur la latence, le coût ou la consommation mémoire de votre déploiement.

## Context Capping & Trimming

| Env Var | Default | Description |
|---------|---------|-------------|
| `TOOL_RESULT_SIZE_CAP_TOKENS` | `30000` | Taille max d'un résultat d'outil dans le payload LLM ; au-delà, le contenu est remplacé par un placeholder (la DB reste intacte). |
| `TOOL_CALL_ARGS_SIZE_CAP_TOKENS` | `8000` | Taille max par champ string dans les anciens tool-call args (couvre les write_file/edit avec gros contenus). |
| `ASSISTANT_CONTENT_SIZE_CAP_TOKENS` | `12000` | Taille max du texte d'un message assistant ; tête + queue préservées, milieu remplacé par placeholder. |
| `USER_CONTENT_SIZE_CAP_TOKENS` | `16000` | Taille max du texte d'un message user ; plafond légèrement plus haut que l'assistant pour absorber les gros copier-coller. |
| `HISTORY_MAX_MESSAGES` | `1000` | Nombre max de messages bruts récupérés depuis la DB pour l'historique de conversation ; borne mémoire. |

## Memory (long-term)

| Env Var | Default | Description |
|---------|---------|-------------|
| `MEMORY_SIMILARITY_THRESHOLD` | `0.5` | Seuil de similarité cosinus pour les candidats vector search (baissé à 0.5 pour plus de diversité). |
| `MEMORY_TEMPORAL_DECAY_LAMBDA` | `0.01` | Vitesse de décroissance temporelle ; plus haut = décroît plus vite. |
| `MEMORY_TEMPORAL_DECAY_FLOOR` | `0.7` | Plancher de score pour les souvenirs anciens (évite que de très vieux atteignent zéro). |
| `MEMORY_CONSOLIDATION_SIMILARITY` | `0.85` | Seuil pour fusionner deux souvenirs lors de la consolidation. |
| `MEMORY_CONSOLIDATION_MAX_GEN` | `5` | Nombre max de générations de consolidation avant fusion forcée. |
| `MEMORY_ADAPTIVE_K` | `true` | Active l'heuristique K adaptatif pour élaguer les résultats à faible score. |
| `MEMORY_ADAPTIVE_K_MIN_SCORE_RATIO` | `0.15` | Ratio min vs le top pour éviter le winner-take-all. |
| `MEMORY_ADAPTIVE_K_LARGEST_GAP_RATIO` | `0.6` | Heuristique largest-gap : tronque uniquement si une chute >60% du delta top-current. |
| `MEMORY_RRF_K` | `60` | Paramètre Reciprocal Rank Fusion pour la recherche hybride (vector + FTS). |
| `MEMORY_FTS_BOOST` | `0.5` | Multiplicateur de score FTS dans le ranking hybride. |
| `MEMORY_SUBJECT_BOOST` | `1.3` | Multiplicateur de pertinence du champ subject. |
| `MEMORY_CATEGORY_BOOST` | `1.25` | Multiplicateur de pertinence du champ category. |
| `MEMORY_CONTEXTUAL_REWRITE_THRESHOLD` | `80` | Seuil de tokens déclenchant la réécriture contextuelle des requêtes. |
| `MEMORY_TOKEN_BUDGET` | `0` | Budget tokens max pour l'injection mémoire ; 0 = illimité. |
| `MEMORY_RECENCY_BOOST` | `true` | Booste les souvenirs très récents dans le ranking. |
| `MEMORY_CONSOLIDATION_MODEL` | — | Modèle pour la consolidation (format `providerId:modelId`) ; fallback sur celui du Kin. |
| `MEMORY_MULTI_QUERY_MODEL` | — | Modèle pour l'expansion multi-query. |
| `MEMORY_HYDE_MODEL` | — | Modèle pour le reranking HyDE. |
| `MEMORY_RERANK_MODEL` | — | Modèle pour le reranking secondaire. |
| `MEMORY_CONTEXTUAL_REWRITE_MODEL` | — | Modèle pour la réécriture contextuelle des requêtes longues. |

## Browser sessions

| Env Var | Default | Description |
|---------|---------|-------------|
| `BROWSER_SESSION_TTL_MS` | `3_600_000` (1 h) | TTL dur d'une session navigateur, peu importe l'activité. |
| `BROWSER_SESSION_IDLE_TIMEOUT_MS` | `600_000` (10 min) | Fermeture automatique après inactivité. |

(Voir aussi les `browserSessions.*` documentés en haut pour `BROWSER_MAX_*` et `BROWSER_DEFAULT_VIEWPORT_*`.)

## File storage & uploads

| Env Var | Default | Description |
|---------|---------|-------------|
| `FILE_STORAGE_DIR` | `{dataDir}/storage` | Répertoire du stockage de fichiers persistant. |
| `FILE_STORAGE_MAX_SIZE` | `0` (illimité) | Taille max d'un fichier individuel (Mo). `0` ou négatif = aucune limite. |
| `FILE_STORAGE_CLEANUP_INTERVAL` | `60` (min) | Intervalle du job de nettoyage des fichiers expirés. |
| `UPLOAD_CHANNEL_RETENTION_DAYS` | `30` | Rétention des fichiers téléchargés par les channels ; 0 = jamais purger. |
| `UPLOAD_CHANNEL_CLEANUP_INTERVAL` | `60` (min) | Intervalle du job de purge des fichiers channel. |

## Vault

| Env Var | Default | Description |
|---------|---------|-------------|
| `VAULT_ATTACHMENT_DIR` | `{dataDir}/vault` | Répertoire des pièces jointes vault. |
| `VAULT_MAX_ATTACHMENT_SIZE` | `50` (Mo) | Taille max par pièce jointe. |
| `VAULT_MAX_ATTACHMENTS_PER_ENTRY` | `10` | Nombre max de pièces jointes par entrée vault. |

## Webhooks

| Env Var | Default | Description |
|---------|---------|-------------|
| `WEBHOOKS_MAX_PER_KIN` | `20` | Nombre max de webhooks par Kin. |
| `WEBHOOKS_MAX_PAYLOAD_BYTES` | `1_048_576` (1 Mo) | Payload max pour la livraison. |
| `WEBHOOKS_LOG_RETENTION_DAYS` | `30` | Rétention des logs d'exécution. |
| `WEBHOOKS_MAX_LOGS_PER_WEBHOOK` | `500` | Nombre max d'entrées de log retenues par webhook. |
| `WEBHOOKS_RATE_LIMIT_PER_MINUTE` | `60` | Limite de débit de livraison. |

## Channels

| Env Var | Default | Description |
|---------|---------|-------------|
| `CHANNELS_MAX_PER_KIN` | `5` | Nombre max de channels connectés par Kin. |
| `CHANNEL_PENDING_ORIGIN_TTL` | `300_000` (5 min) | TTL de la vérification d'origine en attente lors du setup. |

## Tasks (sub-Kins)

| Env Var | Default | Description |
|---------|---------|-------------|
| `TASKS_MAX_REQUEST_INPUT` | `3` | Nombre max d'appels `request_input` par sub-Kin task. |
| `TASKS_MAX_INTER_KIN_REQUESTS` | `3` | Nombre max d'appels inter-Kin par sub-Kin task. |
| `TASKS_INTER_KIN_RESPONSE_TIMEOUT_MS` | `300_000` (5 min) | Timeout pour les réponses inter-Kin. |

## Crons & scheduling

| Env Var | Default | Description |
|---------|---------|-------------|
| `MODEL_INFO_REFRESH_CRON` | `0 */6 * * *` | Cron de rafraîchissement du cache model-info (capte les changements de spec côté provider sans redémarrer). |

## Invitations & sessions

| Env Var | Default | Description |
|---------|---------|-------------|
| `INVITATION_DEFAULT_EXPIRY_DAYS` | `7` | Expiration par défaut d'une invitation. |
| `INVITATION_MAX_ACTIVE` | `50` | Nombre max d'invitations actives sur le serveur. |
| `QUICK_SESSION_EXPIRATION_HOURS` | `24` | Durée de vie d'une quick session. |
| `QUICK_SESSION_MAX_PER_USER_KIN` | `1` | Nombre max de quick-sessions par (user, Kin). |
| `QUICK_SESSION_RETENTION_DAYS` | `7` | Rétention de l'historique quick-session. |
| `QUICK_SESSION_CLEANUP_INTERVAL` | `60` (min) | Intervalle du job de purge. |

## Notifications

| Env Var | Default | Description |
|---------|---------|-------------|
| `NOTIFICATIONS_RETENTION_DAYS` | `30` | Rétention des notifications internes. |
| `NOTIFICATIONS_MAX_PER_USER` | `500` | Nombre max de notifications stockées par user. |
| `NOTIFICATIONS_EXT_MAX_PER_USER` | `5` | Nombre max d'intégrations de livraison externe par user. |
| `NOTIFICATIONS_EXT_RATE_LIMIT` | `5` | Limite de débit de livraison externe (par minute). |
| `NOTIFICATIONS_EXT_MAX_ERRORS` | `5` | Erreurs consécutives avant désactivation auto de l'intégration. |

## Wakeups & prompts humains

| Env Var | Default | Description |
|---------|---------|-------------|
| `WAKEUPS_MAX_PENDING_PER_KIN` | `20` | Nombre max de wakeups programmés par Kin. |
| `HUMAN_PROMPTS_MAX_PENDING` | `5` | Nombre max de prompts humains en attente par Kin. |

## Projects (Kanban & tickets)

| Env Var | Default | Description |
|---------|---------|-------------|
| `PROJECTS_MAX_DESCRIPTION_PROMPT_TOKENS` | `8000` | Plafond strict des tokens de description projet injectés dans le prompt. |
| `PROJECTS_MAX_TICKETS_IN_PROMPT` | `50` | Nombre max de tickets non-done injectés (triés par `updated_at` DESC). |
| `PROJECTS_KANBAN_POSITION_STEP` | `1024` | Pas entre positions consécutives lors d'insertion en tête de colonne. |

## Mini-apps

| Env Var | Default | Description |
|---------|---------|-------------|
| `MINI_APPS_DIR` | `{dataDir}/mini-apps` | Répertoire des bundles mini-apps. |
| `MINI_APPS_MAX_PER_KIN` | `20` | Nombre max de mini-apps déployables par Kin. |
| `MINI_APPS_MAX_FILE_SIZE` | `5` (Mo) | Taille max d'un fichier individuel dans un bundle. |
| `MINI_APPS_MAX_TOTAL_SIZE` | `50` (Mo) | Taille totale max d'un bundle mini-app. |
| `MINI_APPS_BACKEND_ENABLED` | `true` | Active/désactive le serveur backend des mini-apps. |

## Version checking

| Env Var | Default | Description |
|---------|---------|-------------|
| `VERSION_CHECK_ENABLED` | `true` | Active les vérifications périodiques de nouvelle version. |
| `VERSION_CHECK_REPO` | `MarlBurroW/kinbot` | Repo cible pour les vérifications. |
| `VERSION_CHECK_INTERVAL_HOURS` | `1` | Intervalle de vérification. |

## MCP

| Env Var | Default | Description |
|---------|---------|-------------|
| `MCP_REQUIRE_APPROVAL` | `true` | Demande approbation user avant d'exécuter un tool MCP. |

> **Note** : la plupart de ces défauts sont production-tested et rarement à modifier. Les variables `MEMORY_*_MODEL` suivent le format `providerId:modelId` et fallback sur le modèle principal du Kin si non définies.

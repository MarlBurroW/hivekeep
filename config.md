# KinBot — Configuration centralisée

Toutes les valeurs configurables de la plateforme, regroupées par domaine. Ces valeurs sont définies dans `src/server/config.ts` et peuvent être surchargées via variables d'environnement.

---

## Général

| Clé | Env var | Default | Description |
|---|---|---|---|
| `port` | `PORT` | `3333` | Port du serveur HTTP |
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
| `upload.dir` | `UPLOAD_DIR` | `{dataDir}/uploads` | Répertoire de stockage des fichiers |
| `upload.maxFileSizeMb` | `UPLOAD_MAX_FILE_SIZE` | `50` | Taille max d'un fichier uploadé (Mo) |

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

> **Hooks de fermeture automatique** : sessions auto-closed à la fin d'une task (`resolveTask`), à la suppression d'un Kin (`deleteKin`), au SIGTERM/SIGINT du serveur, et par le GC d'inactivité toutes les 15 s.

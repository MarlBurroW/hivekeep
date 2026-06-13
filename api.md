# Hivekeep — Contrats API

> ⚠️ **Partiellement obsolète.** Ce document décrit les contrats REST tels qu'imaginés avant le refactor providers/plugins/images. Routes qui ont changé depuis :
> - `POST/PATCH /api/providers` : payload `families[]` au lieu de `family`, capacité multiple par row (`capabilities[]`)
> - `GET /api/providers/:id` : nouveau (retourne `safeConfig` pour le pré-remplissage du formulaire d'édition)
> - `GET /api/providers/:id/models` : nouveau (browser modal)
> - `POST /api/providers/:id/test` : accepte maintenant un body `{ config: {...} }` optionnel pour tester une config partielle sans réencoder les secrets
> - Tools image (`generate_image`, `list_image_models`, nouveau `describe_image_model`) : payload différent (`imageUrls[]`, `params`, `maxImageInputs`)
>
> Le **code des routes** dans `src/server/routes/` fait foi. Quand un contrat ici contredit la route, c'est ce fichier qui est obsolète. À utiliser comme référence d'intention, pas comme spec stricte.

Toutes les routes retournent du JSON. Les erreurs suivent le format standard :

```json
{ "error": { "code": "ERROR_CODE", "message": "Description lisible" } }
```

Authentification : cookie HTTP-only géré par Better Auth, vérifié par middleware sur toutes les routes `/api/*` (sauf `/api/auth/*`).

---

## Auth

### `POST /api/auth/register`

Créé automatiquement par Better Auth.

```typescript
// Request
{ name: string, email: string, password: string }

// Response 200
{ user: { id: string, name: string, email: string }, session: { token: string } }
```

### `POST /api/auth/login`

```typescript
// Request
{ email: string, password: string }

// Response 200
{ user: { id: string, name: string, email: string }, session: { token: string } }
```

### `POST /api/auth/logout`

```typescript
// Response 200
{ success: true }
```

---

## Onboarding

### `GET /api/onboarding/status`

Vérifie si l'onboarding initial a été complété. **`completed` est strictement `hasAdmin`** — la redesign onboarding (Phase 1) a découplé `completed` de la configuration des providers. Les champs `hasLlm` / `hasEmbedding` restent renvoyés a titre informatif (utilisés par la setup checklist du dashboard) mais ne gatent plus l'accès a l'app.

```typescript
// Response 200
{ completed: boolean, hasAdmin: boolean, hasLlm: boolean, hasEmbedding: boolean }
```

---

## Compte

### `GET /api/me`

```typescript
// Response 200
{
  id: string
  email: string
  firstName: string
  lastName: string
  pseudonym: string
  language: string             // langue de l'UI — un code de SUPPORTED_LANGUAGES
  agentLanguage: string | null // langue parlée par les Agents (code AGENT_LANGUAGES) ; null = suit `language`
  role: 'admin' | 'user'
  avatarUrl: string | null
}
```

### `PATCH /api/me`

```typescript
// Request (tous les champs optionnels)
{
  firstName?: string
  lastName?: string
  pseudonym?: string
  language?: string             // un code de SUPPORTED_LANGUAGES
  agentLanguage?: string | null // un code de AGENT_LANGUAGES ; null = suivre la langue de l'UI
  password?: { current: string, new: string }
}

// Response 200
{ ...same as GET /api/me }
```

### `POST /api/me/avatar`

Upload multipart/form-data.

```typescript
// Request: FormData avec champ "file"

// Response 200
{ avatarUrl: string }
```

---

## Providers

### `GET /api/providers`

```typescript
// Response 200
{
  providers: Array<{
    id: string
    name: string
    type: 'anthropic' | 'openai' | 'gemini' | 'voyage_ai'
    capabilities: ('llm' | 'embedding' | 'image' | 'search')[]
    isValid: boolean
    createdAt: number
  }>
}
```

### `POST /api/providers`

```typescript
// Request
{
  name: string
  type: 'anthropic' | 'openai' | 'gemini' | 'voyage_ai'
  config: { apiKey: string, baseUrl?: string }
}

// Response 201
{ provider: { id: string, name: string, type: string, capabilities: string[], isValid: boolean } }
```

> Le serveur teste la connexion et détecte les capacités avant de retourner.

### `PATCH /api/providers/:id`

```typescript
// Request (tous optionnels)
{ name?: string, config?: { apiKey?: string, baseUrl?: string } }

// Response 200
{ provider: { ...same shape } }
```

### `DELETE /api/providers/:id`

```typescript
// Response 200
{ success: true }

// Error 409 si c'est le dernier provider couvrant une capacité requise (llm ou embedding)
{ error: { code: "PROVIDER_REQUIRED", message: "..." } }
```

### `POST /api/providers/:id/test`

Teste la connexion au provider.

```typescript
// Response 200
{ valid: boolean, capabilities: string[], error?: string }
```

### `GET /api/providers/models`

Liste tous les modèles disponibles a travers tous les providers configurés.

```typescript
// Response 200
{
  models: Array<{
    id: string              // ex: 'claude-sonnet-4-20250514'
    name: string            // ex: 'Claude Sonnet 4'
    providerId: string
    providerType: string
    capability: 'llm' | 'embedding' | 'image' | 'search'
    supportsImageInput?: boolean   // llm only — tri-state (absent = inconnu)
    supportsPdfInput?: boolean     // llm only — tri-state (absent = inconnu)
    maxImageInputs?: number        // image only
    contextWindow?: number
    maxOutput?: number
    // llm only — support reasoning après enrichissement registry.
    // Absent = pas un modèle de reasoning ; efforts: [] = toggle on/off
    // sans granularité. Pilote les sélecteurs d'effort côté client.
    thinking?: {
      efforts: Array<'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'>
      note?: string
    }
  }>
}
```

---

## Agents

### `GET /api/agents`

```typescript
// Response 200
{
  agents: Array<{
    id: string
    name: string
    role: string
    avatarUrl: string | null
    model: string
    createdAt: number
    // Pas de character/expertise ici (trop volumineux pour la liste)
  }>
}
```

### `GET /api/agents/:id`

```typescript
// Response 200
{
  id: string
  name: string
  role: string
  avatarUrl: string | null
  character: string
  expertise: string
  model: string
  workspacePath: string
  mcpServers: Array<{ id: string, name: string }>
  queueSize: number          // nombre de messages en attente
  isProcessing: boolean      // en train de traiter un message
  createdAt: number
}
```

### `POST /api/agents`

```typescript
// Request
{
  name: string
  role: string
  character: string
  expertise: string
  model: string
  mcpServerIds?: string[]
  avatar?: 'upload' | 'generate' | 'prompt'
  avatarPrompt?: string       // si avatar === 'prompt'
}

// Si avatar === 'upload', utiliser POST /api/agents/:id/avatar après création

// Response 201
{ agent: { ...same as GET /api/agents/:id } }
```

### `PATCH /api/agents/:id`

```typescript
// Request (tous optionnels)
{
  name?: string
  role?: string
  character?: string
  expertise?: string
  model?: string
  mcpServerIds?: string[]
  toolboxIds?: string[] | null
  // Grants individuels (en plus des toolboxes) : ajouts manuels + demandes
  // request_tool_access approuvées. [] ou null efface tout.
  extraToolNames?: string[] | null
}

// Response 200
{ agent: { ...same shape } }
```

### `DELETE /api/agents/:id`

```typescript
// Response 200
{ success: true }
```

### `POST /api/agents/:id/avatar`

Upload ou génération d'avatar.

```typescript
// Mode upload : FormData avec champ "file"
// Mode generate : { mode: 'generate' }
// Mode prompt : { mode: 'prompt', prompt: string }

// Response 200
{ avatarUrl: string }
```

### `GET /api/agents/:id/context-preview`

Reconstruit et retourne le contexte LLM complet tel qu'il serait envoyé au modèle.
Utile pour le debugging et la transparence. Accepte des query params optionnels pour les tâches et sessions rapides.

```typescript
// Query params optionnels :
// ?taskId={string}     — contexte d'une tâche spécifique
// ?sessionId={string}  — contexte d'une session rapide

// Response 200
{
  systemPrompt: string           // Prompt système complet (avec outils en annexe)
  compactingSummary: string | null // Résumé de compacting (null si pas de compacting)
  rawPayload: {
    system: string
    messages: Array<{
      role: string
      content: string | null
      hasToolCalls: boolean
      createdAt: number | null
    }>
    tools: Array<{
      name: string
      description: string
      parameters: Record<string, unknown> | null
    }>
  }
  tokenEstimate: {
    systemPrompt: number
    summary: number
    messages: number
    tools: number
    total: number
  }
  contextWindow: number          // Taille max du contexte du modèle (en tokens)
  messageCount: number
  generatedAt: number
}
```

### `PATCH /api/agents/:id/active-project`

Définit le projet actif du Agent. Le contexte du projet sera injecté dans le bloc volatile du prompt système aux tours suivants. Voir `projects.md` § 4.

```typescript
// Request
{ projectId: string | null }

// Response 200
{ activeProjectId: string | null }

// Errors
// 404 — { error: { code: 'PROJECT_NOT_FOUND', message: '...' } }
// 404 — { error: { code: 'KIN_NOT_FOUND', message: '...' } }
```

Un event SSE `agent:active-project` est émis à tous les clients connectés (utile pour synchroniser les chips "Projet actif" dans les autres onglets / vues).

---

## Messages / Chat

### `POST /api/agents/:id/messages`

Envoie un message a un Agent. Déclenche le traitement et le streaming SSE de la réponse.

```typescript
// Request
{
  content: string
  fileIds?: string[]        // IDs de fichiers déjà uploadés
  clientMessageId?: string  // Token de réconciliation optimiste (≤100 chars, PAS la PK).
                            // Ré-émis tel quel dans l'événement SSE chat:message du
                            // message utilisateur : le client émetteur réconcilie sa
                            // bulle optimiste, les autres appareils l'ajoutent.
}

// Response 202
{ messageId: string, queuePosition: number }   // messageId = id du queue item, ≠ PK du message
```

> La réponse du Agent arrive via SSE (pas dans cette response HTTP).
> Le message utilisateur lui-même est aussi diffusé en temps réel via `chat:message`
> (sync multi-appareils / multi-membres), avec `clientMessageId` pour la réconciliation.

### `GET /api/agents/:id/messages`

Historique paginé des messages.

```typescript
// Query params : ?before={messageId}&limit={number, default 50}

// Response 200
{
  messages: Array<{
    id: string
    role: 'user' | 'assistant' | 'system' | 'tool'
    content: string
    sourceType: 'user' | 'agent' | 'task' | 'cron' | 'system'
    sourceId: string | null
    sourceName: string | null   // pseudonym, agent name, task name, cron name
    isRedacted: boolean
    tokenUsage: { inputTokens: number, outputTokens: number, totalTokens: number, cacheReadTokens?: number, cacheWriteTokens?: number, reasoningTokens?: number, stepCount?: number } | null
    files: Array<{ id: string, name: string, mimeType: string, url: string }>
    createdAt: number
  }>
  hasMore: boolean
}
```

### `GET /api/agents/:id/tools`

Le toolset RÉSOLU de l'Agent — l'ensemble exact d'outils qu'un tour recevrait (natifs + plugins + MCP + customs, après filtrage par toolbox). `?quick=1` renvoie la variante quick-session (sans les outils exclus en session : tâches, crons, inter-agents…). Alimente le badge outils du composer et sa modal de listing (le client groupe par domaine via `/api/tools/domains`).

```typescript
// Response 200
{ tools: Array<{ name: string, description: string }> }  // triés par nom
```

### `POST /api/agents/:id/messages/inject`

Injecte un message dans la conversation en cours. Si le Agent est en train de streamer une réponse, le stream est interrompu (la réponse partielle est sauvegardée) et le message injecté est mis en file d'attente en priorité haute. Utilisé pour la commande `/btw` et la promotion de messages depuis la queue.

```typescript
// Request
{
  content: string
  queueItemId?: string    // Si promotion depuis la queue, supprime l'item original
}

// Response 202
{
  messageId: string
  queuePosition: number
  injected: boolean       // true si un stream actif a été interrompu
}
```

### `DELETE /api/agents/:id/messages/:messageId`

Supprime un seul message de la conversation principale (économie de contexte). La ligne porte son step complet (tool calls + résultats dans le JSON `toolCalls`), donc l'historique LLM reste bien formé. Refusé pendant qu'un tour est en cours (409 `AGENT_BUSY`). Nettoyage en cascade : fichiers joints supprimés, références `human_prompts`/`memories` nullifiées, bornes des résumés de compaction réparées (le cutoff temporel reste intact). Émet `chat:messages-deleted`.

```typescript
// Response 200
{ ok: true, deletedCount: 1 }
```

### `POST /api/agents/:id/messages/rewind`

Rewind : le message cible devient le plus récent — tout ce qui le suit (y compris les messages cachés de contexte) est supprimé, et les résumés de compaction couvrant la zone supprimée sont retirés. Refusé pendant un tour en cours (409). Émet `chat:messages-deleted` avec la liste des ids.

```typescript
// Request
{ messageId: string }

// Response 200
{ ok: true, deletedCount: number }
```

---

## Tâches

### `GET /api/tasks`

Liste toutes les tâches en cours.

```typescript
// Query params : ?status={pending|in_progress|paused|completed|failed|cancelled}&agentId={string}

// Response 200
{
  tasks: Array<{
    id: string
    parentAgentId: string
    parentAgentName: string
    description: string
    status: 'pending' | 'in_progress' | 'paused' | 'completed' | 'failed' | 'cancelled'
    mode: 'await' | 'async'
    depth: number
    createdAt: number
    updatedAt: number
  }>
}
```

### `GET /api/tasks/:id`

Détail d'une tâche avec ses messages.

```typescript
// Response 200
{
  task: { ...same as list item + result: string | null, error: string | null }
  messages: Array<{ ...same as message shape }>
}
```

### `POST /api/tasks/:id/cancel`

```typescript
// Response 200
{ success: true }
```

### `POST /api/tasks/:id/pause`

Met en pause une tâche en cours d'exécution. La tâche conserve son état et peut être reprise ultérieurement.

```typescript
// Response 200
{ success: true }

// Response 409 — tâche non en cours
{ error: { code: 'TASK_NOT_PAUSABLE', message: 'Task is not currently running' } }
```

### `POST /api/tasks/:id/resume`

Reprend une tâche en pause, avec un message optionnel injecté dans le contexte.

```typescript
// Request (optionnel)
{ message?: string }

// Response 200
{ success: true }

// Response 409 — tâche non en pause
{ error: { code: 'TASK_NOT_PAUSED', message: 'Task is not paused' } }
```

### `POST /api/tasks/:id/inject`

Injecte un message dans une tâche en cours d'exécution. Si la tâche est en train de streamer, le stream est interrompu et relancé avec le message additionnel.

```typescript
// Request
{ content: string }

// Response 202
{ success: true, injected: boolean }

// Response 400 — contenu vide
{ error: { code: 'EMPTY_CONTENT', message: 'Message content is required' } }

// Response 409 — injection échouée
{ error: { code: 'INJECT_FAILED', message: string } }
```

---

## Projets

Voir `projects.md` pour la spec complète.

### `GET /api/projects`

```typescript
// Response 200
{
  projects: Array<{
    id: string
    title: string
    githubUrl: string | null
    ticketCount: number
    openTicketCount: number      // status !== 'done'
    createdAt: number
    updatedAt: number
    // description omise pour la liste (peut être volumineuse)
  }>
}
```

### `GET /api/projects/:id`

```typescript
// Response 200
{
  project: {
    id: string
    title: string
    description: string
    githubUrl: string | null
    tags: Array<{ id: string, label: string, color: string }>
    ticketCounts: { backlog: number, todo: number, in_progress: number, blocked: number, done: number }
    createdAt: number
    updatedAt: number
  }
}
```

### `POST /api/projects`

```typescript
// Request
{
  title: string
  description?: string
  githubUrl?: string
}

// Response 201
{ project: { ...same as GET /api/projects/:id } }
```

> Le seed `DEFAULT_PROJECT_TAGS` (bug / feature / chore / doc) est appliqué côté serveur. L'utilisateur peut ensuite modifier librement via les routes tags.

### `PATCH /api/projects/:id`

```typescript
// Request (tous optionnels)
{
  title?: string
  description?: string     // remplace tout
  githubUrl?: string | null
}

// Response 200
{ project: { ...same shape } }
```

### `DELETE /api/projects/:id`

Hard delete avec cascade : tous les tickets et tags du projet sont supprimés. Les tasks historiques liées voient leur `ticketId` mis à NULL (historique préservé dans les threads des Agents). Les Agents qui avaient ce projet en `activeProjectId` voient leur valeur mise à NULL.

```typescript
// Response 200
{ success: true }
```

### `GET /api/projects/:projectId/tags`

```typescript
// Response 200
{
  tags: Array<{
    id: string
    label: string
    color: string
    createdAt: number
  }>
}
```

### `POST /api/projects/:projectId/tags`

```typescript
// Request
{ label: string, color: string }

// Response 201
{ tag: { id, label, color, createdAt } }

// Errors
// 409 — { error: { code: 'TAG_LABEL_TAKEN', message: 'A tag with this label already exists in this project' } }
```

### `PATCH /api/tags/:id`

```typescript
// Request (tous optionnels)
{ label?: string, color?: string }

// Response 200
{ tag: { id, label, color } }
```

### `DELETE /api/tags/:id`

```typescript
// Response 200
{ success: true }
```

---

## Tickets

### `GET /api/projects/:projectId/tickets`

```typescript
// Query params : ?status={...}&tagId={...}&limit={...}&offset={...}

// Response 200
{
  tickets: Array<{
    id: string
    projectId: string
    title: string
    description: string         // tronquée à 500 chars pour la liste
    status: 'backlog' | 'todo' | 'in_progress' | 'blocked' | 'done'
    position: number
    tags: Array<{ id: string, label: string, color: string }>
    taskCount: number           // nombre total de tasks liées au ticket
    runningTaskCount: number    // tasks status in_progress/pending/queued
    createdAt: number
    updatedAt: number
  }>
  hasMore: boolean
}
```

### `GET /api/tickets/:id`

```typescript
// Response 200
{
  ticket: {
    id: string
    projectId: string
    title: string
    description: string         // complète
    status: 'backlog' | 'todo' | 'in_progress' | 'blocked' | 'done'
    position: number
    tags: Array<{ id: string, label: string, color: string }>
    tasks: Array<{
      id: string
      parentAgentId: string
      parentAgentName: string
      status: string
      mode: 'await' | 'async'
      createdAt: number
      updatedAt: number
    }>
    createdAt: number
    updatedAt: number
  }
}
```

### `POST /api/projects/:projectId/tickets`

```typescript
// Request
{
  title: string
  description?: string
  status?: 'backlog' | 'todo' | 'in_progress' | 'blocked' | 'done'
  tagIds?: string[]
}

// Response 201
{ ticket: { ...same shape as GET /api/tickets/:id } }
```

### `PATCH /api/tickets/:id`

```typescript
// Request (tous optionnels)
{
  title?: string
  description?: string
  status?: 'backlog' | 'todo' | 'in_progress' | 'blocked' | 'done'
  position?: number          // si fourni : place à cette position. Sinon : max+1024 dans la colonne du nouveau status.
  tagIds?: string[]          // remplace l'ensemble (PUT-like)
}

// Response 200
{ ticket: { ...same shape } }
```

### `DELETE /api/tickets/:id`

```typescript
// Response 200
{ success: true }
```

> Les tasks historiques liées ne sont pas supprimées : leur `ticketId` est mis à NULL pour préserver l'audit trail dans les threads.

### `POST /api/tickets/:id/start-task`

Spawn un sub-Agent pour travailler sur le ticket. Le `agentId` du Agent parent doit être passé explicitement (pas de défaut implicite — cf. `projects.md` § 4). **Toujours en mode `await`** : le mode `async` n'est pas autorisé pour les tasks liées à un ticket (sinon le ticket resterait figé sans turn de cloture, cf. `projects.md` § 5).

```typescript
// Request
{
  agentId: string              // Agent qui spawn la task (= parent_agent_id)
}

// Response 201
{
  task: {
    id: string
    parentAgentId: string
    ticketId: string
    status: string
    mode: 'await'
    createdAt: number
  }
}

// Errors
// 404 — { error: { code: 'TICKET_NOT_FOUND', message: '...' } }
// 404 — { error: { code: 'KIN_NOT_FOUND', message: '...' } }
```

Effets de bord :
- **Aucun effet sur le ticket** (status / position / tags inchangés — c'est au Agent ou à l'utilisateur de gérer le statut manuellement)
- Un event SSE `task:status` est émis pour la nouvelle task

---

## Crons

### `GET /api/crons`

```typescript
// Query params : ?agentId={string}

// Response 200
{
  crons: Array<{
    id: string
    agentId: string
    agentName: string
    name: string
    schedule: string
    taskDescription: string
    targetAgentId: string | null
    model: string | null
    toolboxIds: string[]        // IDs de toolboxes; [] = surface native complète ('all')
    isActive: boolean
    requiresApproval: boolean
    lastTriggeredAt: number | null
    createdAt: number
  }>
}
```

### `POST /api/crons`

```typescript
// Request
{
  agentId: string
  name: string
  schedule: string
  taskDescription: string
  targetAgentId?: string
  model?: string
  toolboxIds?: string[]         // toolset natif des tâches spawnées; omis = 'all'
}

// Response 201
{ cron: { ...same shape } }
```

### `PATCH /api/crons/:id`

```typescript
// Request (tous optionnels)
{
  name?: string
  schedule?: string
  taskDescription?: string
  targetAgentId?: string
  model?: string
  isActive?: boolean
  toolboxIds?: string[] | null  // [] ou null efface la restriction (retour à 'all')
}

// Response 200
{ cron: { ...same shape } }
```

### `DELETE /api/crons/:id`

```typescript
// Response 200
{ success: true }
```

### `POST /api/crons/:id/approve`

Approuve un cron créé par un Agent (qui nécessite validation).

```typescript
// Response 200
{ cron: { ...same shape, requiresApproval: false, isActive: true } }
```

---

## MCP Servers

### `GET /api/mcp-servers`

```typescript
// Response 200
{
  servers: Array<{
    id: string
    name: string
    command: string
    args: string[]
    env: Record<string, string> | null
    createdAt: number
  }>
}
```

### `POST /api/mcp-servers`

```typescript
// Request
{ name: string, command: string, args?: string[], env?: Record<string, string> }

// Response 201
{ server: { ...same shape } }
```

### `DELETE /api/mcp-servers/:id`

```typescript
// Response 200
{ success: true }
```

---

## Custom Tools & Tool Domains

Outils custom **globaux** (scripts authored via l'UI ou les Agents) et domaines dynamiques. Voir `schema.md`.

### `GET /api/tools/catalog`
Catalogue agnostique de tous les outils grantables (native / plugin / mcp / custom). Les entrées custom sont globales (`custom_<slug>`, `domain` = leur `domain_slug`, `enabled`).

### `GET /api/tools/domains`
Map `name → domain` (registry + `custom_<slug> → domain_slug`), pour colorer les badges de tool-call.

### `GET /api/tools/domain-meta`
`{ domains: [{ slug, icon, bg, text, border, builtin, labelKey, label }] }` — métadonnées de rendu (built-in + custom) hydratées par le client.

### `GET /api/tools/custom-tool-names`
`{ "custom_<slug>": { "name": "<nom localisé>", "hasRenderer": <bool> } }` — par outil custom : nom d'affichage résolu pour la langue UI de l'utilisateur courant (`user_profiles.language`) + présence d'un renderer de résultat (fichier `renderer.tsx`/`.jsx`/`.js`, détecté sur disque). UI-only (best-effort) : le client l'hydrate au boot pour afficher un nom humain dans les tool-calls du chat au lieu du `custom_<slug>` brut, et pour décider de charger ou non le renderer.

### `GET|POST|PATCH|DELETE /api/tool-domains[/:slug]`
CRUD des domaines d'outils. Built-in read-only ; suppression bloquée si le domaine est utilisé (`TOOL_DOMAIN_IN_USE`).

### `GET|POST|PATCH|DELETE /api/custom-tools[/:slug]`
CRUD des outils custom globaux. Création via l'UI → `created_by='user'`, actif immédiatement. POST/PATCH acceptent `translations` (objet localisé `{ "<locale>": { name?, description?, parameters?: { "<param>": { label?, description? } } } }`) ; GET le renvoie (parsé). UI-only : les traductions n'affectent jamais la définition d'outil envoyée au LLM.

### `GET /api/custom-tools/:slug/file?path=…` · `PUT /api/custom-tools/:slug/files`
Lire / écrire un fichier dans le dossier géré de l'outil (`{ path, content }`).

### `GET /api/custom-tools/:slug/renderer.js`
Module ESM bundlé côté serveur du **renderer de résultat** optionnel de l'outil (export par défaut = composant React). Source : `renderer.tsx` (fallback `renderer.jsx`/`renderer.js`) dans le dossier de l'outil, bundlé via Bun (JSX classique, react/react-dom mappés sur l'instance React de l'hôte `window.__HIVEKEEP_REACT__`). Le client le charge à la volée (`React.lazy(import(url))`) dans la vue détaillée du tool-call. Cache mémoire côté serveur (clé slug + mtime) ; réponse avec `ETag` (revalidation `304`). `404 NO_RENDERER` si l'outil n'a pas de renderer ; `500` (module qui throw au chargement, avec le message de build) en cas d'échec de bundling — le client retombe alors sur l'affichage JSON via son ErrorBoundary. Authentifié comme toutes les routes `/api/*`. Contexte hôte (privilèges complets, pas d'isolation) : acceptable car les outils custom sont de confiance (self-hosted) et le renderer ne sert qu'à l'affichage.

### `POST /api/custom-tools/:slug/setup`
Installe les dépendances (`requirements.txt` → `.venv` + pip ; `package.json` → `bun install`).

### `POST /api/custom-tools/:slug/test`
Exécute l'outil avec des args de test (`{ args }`) → `{ success, output, error, exitCode, executionTime }`.

---

## Vault

Les agents n'accèdent aux secrets que par **placeholder** `{{secret:KEY}}` (substitué à l'exécution des tools — voir `vault-placeholders.md`). Les routes ci-dessous servent l'UI d'administration.

### `GET /api/vault`

Liste les secrets (clés uniquement, jamais les valeurs). `lastUsedAt` est stampé à chaque expansion de placeholder.

```typescript
// Response 200
{
  secrets: Array<{
    id: string
    key: string
    lastUsedAt: number | null
    createdAt: number
    updatedAt: number
  }>
}
```

### Scoping par secret (entries)

`POST /api/vault/entries` et `PATCH /api/vault/entries/:id` acceptent deux champs optionnels, retournés par `GET /api/vault/entries` :

```typescript
{
  allowedTools?: string[] | null  // tools autorisés à expandre ce secret (null = tous)
  allowedHosts?: string[] | null  // hôtes autorisés pour les tools porteurs d'URL, wildcard *.domaine supporté (null = tous)
}
```

Une expansion hors périmètre est refusée avant exécution (fail-closed) et émet `vault:secret-used` avec `violation: { type: 'tool-scope' | 'host-scope' }` sur le bus d'événements.

### `POST /api/vault`

```typescript
// Request
{ key: string, value: string }

// Response 201
{ secret: { id: string, key: string, createdAt: number } }
```

### `PATCH /api/vault/:id`

```typescript
// Request
{ key?: string, value?: string }

// Response 200
{ secret: { id: string, key: string, updatedAt: number } }
```

### `DELETE /api/vault/:id`

```typescript
// Response 200
{ success: true }
```

---

## Files

### `POST /api/files/upload`

Upload multipart/form-data.

```typescript
// Request: FormData avec champ "file" + "agentId"

// Response 201
{ file: { id: string, name: string, mimeType: string, size: number, url: string } }
```

---

## Workspace files (section Files)

Routes de la section **Files** (explorateur/éditeur de workspaces — voir `files.md`). Montées sous `/api/agents/:agentId/workspace` ; `:agentId` accepte un id ou un slug. Agent introuvable → `404 KIN_NOT_FOUND`. Tous les `path` sont **relatifs à la racine du workspace** et strictement confinés (pas de chemin absolu, pas de `..`, pas d'évasion par symlink — feuille comprise).

Codes d'erreur communs : `KIN_NOT_FOUND` (404), `PATH_FORBIDDEN` (400), `FILE_NOT_FOUND` (404), `IS_DIRECTORY` (400), `NOT_A_DIRECTORY` (400), `FILE_TOO_LARGE` (413), `INVALID_NAME` (400), `DEST_EXISTS` (409), `CONFLICT` (409), `COPY_TOO_LARGE` (413).

### `GET /api/agents/:agentId/workspace/ls`

Liste un dossier (lazy — jamais d'arbre récursif).

```typescript
// Query params : ?path=docs/reports        (défaut : racine "")

// Response 200
{
  path: string,
  entries: Array<{
    name: string,
    path: string,              // relatif à la racine
    type: 'file' | 'dir',
    size: number,              // 0 pour les dirs
    modifiedAt: number,        // Unix ms
    isSymlink: boolean
  }>
}
// Workspace pas encore créé → 200 { path: "", entries: [] } (création lazy)

// Error 404 FILE_NOT_FOUND (sous-dossier inexistant) · 400 NOT_A_DIRECTORY · 400 PATH_FORBIDDEN
```

> Tri serveur : dossiers d'abord, puis alphabétique insensible à la casse. Tout est listé, dotfiles compris (pas de filtre d'ignore).

### `GET /api/agents/:agentId/workspace/file`

Lecture d'un fichier : métadonnées + contenu texte.

```typescript
// Query params : ?path=docs/report.md

// Response 200
{
  path: string,
  name: string,
  size: number,
  modifiedAt: number,          // ← à renvoyer dans le PUT (concurrence optimiste)
  mimeType: string,            // deviné par extension
  kind: 'text' | 'image' | 'pdf' | 'binary' | 'too-large',
  content: string | null       // null sauf kind === 'text'
}

// Error 404 FILE_NOT_FOUND · 400 IS_DIRECTORY · 400 PATH_FORBIDDEN
```

> `kind: 'too-large'` = fichier texte au-delà de `workspaceFiles.maxEditableSizeMb` (téléchargement seulement). `binary` = null-byte détecté dans les 8 premiers Ko.

### `PUT /api/agents/:agentId/workspace/file`

Écriture d'un fichier texte (crée le fichier et ses dossiers parents si absents). Émet `workspace:changed`.

```typescript
// Request
{
  path: string,
  content: string,             // texte uniquement
  baseModifiedAt?: number,     // mtime lu par le client ; absent = écrasement forcé
  createOnly?: boolean         // true = création stricte (« Nouveau fichier »)
}

// Response 200
{ path: string, size: number, modifiedAt: number }

// Error 409 — concurrence optimiste : le mtime disque a changé depuis la lecture
// (typiquement : l'agent a écrit le même fichier entre temps)
{ error: { code: 'CONFLICT', message: '...' } }
// Error 409 — createOnly et le chemin existe déjà
{ error: { code: 'DEST_EXISTS', message: '...' } }
// Error 413 FILE_TOO_LARGE · 400 PATH_FORBIDDEN · 400 INVALID_NAME · 400 IS_DIRECTORY
```

### `GET /api/agents/:agentId/workspace/raw`

Stream des octets bruts (téléchargement / viewers image & PDF).

```typescript
// Query params : ?path=images/chart.png&inline=1

// Response 200 : stream binaire
//   Content-Type: <mime>                   (deviné par extension)
//   Content-Length: <size>
//   X-Content-Type-Options: nosniff        (toujours)
//   Content-Disposition: attachment (défaut) | inline (si inline=1 ET MIME dans l'allowlist)

// Error 404 FILE_NOT_FOUND · 400 IS_DIRECTORY · 400 PATH_FORBIDDEN
```

> **Allowlist inline** : `image/*` **sauf `image/svg+xml` et tout `image/*+xml`** (un SVG inline exécuterait ses scripts dans l'origine authentifiée), `application/pdf`, `text/plain`. Tout le reste — y compris SVG et `text/html` — est servi en `attachment`. Les réponses inline portent en plus `Content-Security-Policy: default-src 'none'; sandbox`.

### `POST /api/agents/:agentId/workspace/mkdir`

```typescript
// Request
{ path: string }

// Response 200
{ path: string }

// Error 409 DEST_EXISTS · 400 INVALID_NAME · 400 PATH_FORBIDDEN
```

### `POST /api/agents/:agentId/workspace/move`

Renommer / déplacer (renommer = move dans le même dossier). Inter-workspace via `fromAgentId`.

```typescript
// Request
{
  from: string,
  to: string,
  fromAgentId?: string         // id ou slug ≠ :agentId = déplacement inter-workspace (couper/coller).
                               // `from` est validé contre la racine de fromAgentId, `to` contre celle de :agentId
}

// Response 200
{ from: string, to: string }

// Error 409 DEST_EXISTS · 404 FILE_NOT_FOUND · 400 INVALID_NAME · 400 PATH_FORBIDDEN
```

### `POST /api/agents/:agentId/workspace/copy`

Même contrat que `move` ; collision résolue par suffixe automatique ` (copy)` / ` (copy 2)` …

```typescript
// Request
{ from: string, to: string, fromAgentId?: string }

// Response 200
{ from: string, to: string }   // to = chemin final, suffixé le cas échéant

// Error 413 — budget de copie récursive dépassé (octets workspaceFiles.maxCopySizeMb
// OU entrées workspaceFiles.maxCopyEntries) ; copie streamée, abort en cours, copie partielle nettoyée
{ error: { code: 'COPY_TOO_LARGE', message: '...' } }
// Error 404 FILE_NOT_FOUND · 400 INVALID_NAME · 400 PATH_FORBIDDEN
```

### `DELETE /api/agents/:agentId/workspace/file`

Supprime un fichier OU un dossier (récursif).

```typescript
// Query params : ?path=docs/old

// Response 200
{ deleted: true, path: string }

// Error 404 FILE_NOT_FOUND · 400 PATH_FORBIDDEN
```

### `POST /api/agents/:agentId/workspace/upload`

Upload multipart dans un dossier du workspace.

```typescript
// Request: multipart/form-data
//   file: File          (répétable — multi-upload)
//   path: string        (dossier destination, défaut racine "")

// Response 201 — échec partiel possible : les fichiers acceptés sont écrits,
// les refusés sont listés dans `errors`
{
  files: Array<{ path: string, size: number, modifiedAt: number }>,
  errors: Array<{ name: string, code: string }>    // ex. FILE_TOO_LARGE, INVALID_NAME
}

// Error 400 NOT_A_DIRECTORY · 400 PATH_FORBIDDEN · 400 VALIDATION_ERROR (aucun fichier)
```

> Le filename multipart est contrôlé par le client : seul son **basename** survit (tout chemin embarqué est strippé), et le nom est validé (`INVALID_NAME`). Collision : suffixe automatique ` (copy N)` — un upload n'écrase jamais silencieusement. Cap `workspaceFiles.maxUploadSizeMb` par fichier.

### `GET /api/agents/:agentId/workspace/search`

Recherche de fichiers par nom/chemin (substring insensible à la casse). Sert la palette `@` du chat et le quick-open (Ctrl+P).

```typescript
// Query params : ?q=rapport&limit=20      (limit défaut 20, cap workspaceFiles.searchMaxResults)

// Response 200
{ hits: Array<{ path: string, name: string, size: number, modifiedAt: number }> }
```

> Walk serveur borné par `workspaceFiles.searchMaxEntries` ; ne descend jamais dans un répertoire symlinké ; ignore les dossiers lourds (`node_modules`, `.git`, …).

### `POST /api/agents/:agentId/workspace/resolve-paths`

Vérification d'existence batchée — utilisée par les chips de chemins cliquables du chat.

```typescript
// Request
{ paths: string[] }            // ≤ 50 (tronqué au-delà)

// Response 200
{ existing: string[] }         // sous-ensemble qui existe (fichiers seulement)
```

> Les chemins invalides (traversal) sont silencieusement absents de `existing` — pas d'erreur, ce sont des candidats de regex.

### `POST /api/file-storage/from-workspace`

Partage : snapshot d'un fichier de workspace vers le file-storage (sémantique identique au tool `store_file` — copie figée, pas de lien vivant).

```typescript
// Request
{
  agentId: string,             // id ou slug
  path: string,                // relatif au workspace
  name?: string,               // défaut : basename
  description?: string,
  isPublic?: boolean,          // défaut true
  password?: string,
  expiresIn?: number,          // MINUTES — même unité que POST /api/file-storage et store_file
  readAndBurn?: boolean
}

// Response 201
{
  file: {
    id: string, name: string, originalName: string, mimeType: string, size: number,
    url: string,               // URL de partage {publicUrl}/s/{token}
    isPublic: boolean, hasPassword: boolean, readAndBurn: boolean,
    expiresAt: number | null
  }
}

// Error 404 KIN_NOT_FOUND · 404 FILE_NOT_FOUND · 400 PATH_FORBIDDEN
// Error 413 FILE_TOO_LARGE (limite file-storage FILE_STORAGE_MAX_SIZE)
```

---

## Memories (gestion via UI)

### `GET /api/agents/:id/memories`

```typescript
// Query params : ?category={fact|preference|decision|knowledge}&subject={string}&limit={number}

// Response 200
{
  memories: Array<{
    id: string
    content: string
    category: 'fact' | 'preference' | 'decision' | 'knowledge'
    subject: string | null
    sourceChannel: 'automatic' | 'explicit'
    createdAt: number
    updatedAt: number
  }>
}
```

### `DELETE /api/agents/:id/memories/:memoryId`

```typescript
// Response 200
{ success: true }
```

---

## Compacting (gestion via UI)

### `POST /api/agents/:id/compacting/purge`

Réinitialise le compacting (supprime le snapshot actif).

```typescript
// Response 200
{ success: true }
```

### `GET /api/agents/:id/compacting/snapshots`

Liste les snapshots pour le rollback.

```typescript
// Response 200
{
  snapshots: Array<{
    id: string
    messagesUpToId: string
    isActive: boolean
    createdAt: number
  }>
}
```

### `POST /api/agents/:id/compacting/rollback`

```typescript
// Request
{ snapshotId: string }

// Response 200
{ success: true }
```

---

## Settings

Routes d'administration pour les paramètres globaux de la plateforme (admin uniquement).

### `GET /api/settings/global-prompt`

```typescript
// Response 200
{ globalPrompt: string }
```

### `PUT /api/settings/global-prompt`

```typescript
// Request
{ globalPrompt: string }

// Response 200
{ globalPrompt: string }
```

### `GET /api/settings/models`

Endpoint legacy (extraction + embedding uniquement).

```typescript
// Response 200
{ extractionModel: string | null, embeddingModel: string | null, extractionProviderId: string | null, embeddingProviderId: string | null }
```

### `GET /api/settings/default-models`

Retourne tous les modèles/services par défaut en un seul payload.

```typescript
// Response 200
{
  defaultLlmModel: string | null
  defaultLlmProviderId: string | null
  defaultImageModel: string | null
  defaultImageProviderId: string | null
  defaultCompactingModel: string | null
  defaultCompactingProviderId: string | null
  extractionModel: string | null
  extractionProviderId: string | null
  embeddingModel: string | null
  embeddingProviderId: string | null
  defaultSearchProviderId: string | null
}
```

### `PUT /api/settings/default-llm`

```typescript
// Request
{ model: string | null, providerId?: string | null }

// Response 200
{ defaultLlmModel: string | null, defaultLlmProviderId: string | null }
```

### `PUT /api/settings/default-image`

```typescript
// Request
{ model: string | null, providerId?: string | null }

// Response 200
{ defaultImageModel: string | null, defaultImageProviderId: string | null }
```

### `PUT /api/settings/default-compacting`

```typescript
// Request
{ model: string | null, providerId?: string | null }

// Response 200
{ defaultCompactingModel: string | null, defaultCompactingProviderId: string | null }
```

### `PUT /api/settings/extraction-model`

```typescript
// Request
{ model: string | null, providerId?: string | null }

// Response 200
{ extractionModel: string | null, extractionProviderId: string | null }
```

### `PUT /api/settings/embedding-model`

```typescript
// Request
{ model: string, providerId?: string | null }

// Response 200
{ embeddingModel: string, embeddingProviderId: string | null }
```

### `PUT /api/settings/default-search`

Search providers have no companion "model" — body is provider-only.

```typescript
// Request
{ providerId: string | null }

// Response 200
{ defaultSearchProviderId: string | null }
```

The current default is read from `GET /api/settings/default-models` (see `defaultSearchProviderId` in that payload).

### `GET /api/settings/dismissed-setup-items`

Liste des item IDs de la setup checklist que l'utilisateur a explicitement skippés. Stockage **global** (pas per-user) sous `app_settings.dismissed_setup_items` — Hivekeep est un produit individuel ou petit groupe avec configuration partagée.

```typescript
// Response 200
{ items: string[] }
```

Item IDs reconnus côté UI : `add_llm_provider`, `set_default_llm`, `add_embedding_provider`, `set_default_embedding`, `add_image_provider`, `add_search_provider`, `create_first_agent`.

### `POST /api/settings/dismissed-setup-items/:itemId`

Marque un item comme skippé.

```typescript
// Response 200
{ items: string[] }   // liste mise a jour

// Errors
// 400 INVALID_ITEM_ID — itemId vide ou > 64 caractères
```

### `DELETE /api/settings/dismissed-setup-items/:itemId`

Restaure (un-skip) un item — utilisé par "Show setup checklist" dans Settings → General.

```typescript
// Response 200
{ items: string[] }
```

---

## Usage (admin uniquement)

Suivi de la consommation de tokens LLM. Toutes les routes nécessitent le rôle admin.

### `GET /api/usage`

Liste paginée des enregistrements de consommation LLM.

```typescript
// Query params (tous optionnels)
agentId?: string
providerId?: string
providerType?: string
modelId?: string
taskId?: string
cronId?: string
callSite?: string
from?: number        // timestamp ms
to?: number          // timestamp ms
limit?: number       // max 200, default 50
offset?: number      // default 0

// Response 200
{
  items: Array<{
    id: string
    createdAt: number
    callSite: string
    callType: string
    providerType: string | null
    providerId: string | null
    modelId: string | null
    agentId: string | null
    taskId: string | null
    cronId: string | null
    sessionId: string | null
    inputTokens: number | null
    outputTokens: number | null
    totalTokens: number | null
    cacheReadTokens: number | null
    cacheWriteTokens: number | null
    reasoningTokens: number | null
    embeddingTokens: number | null
    stepCount: number
  }>,
  total: number
}
```

### `GET /api/usage/summary`

Agrégation de la consommation groupée par une dimension.

```typescript
// Query params
groupBy: 'provider_type' | 'model_id' | 'agent_id' | 'call_site' | 'day'  // obligatoire
agentId?: string
providerType?: string
modelId?: string
from?: number
to?: number

// Response 200
{
  summary: Array<{
    group: string
    inputTokens: number
    outputTokens: number
    totalTokens: number
    count: number
  }>
}
```

---

## Account Triggers

Déclencheurs par compte email connecté (table `account_triggers`, voir `schema.md`). Quand un nouvel email d'un compte connecté correspond à l'arbre de conditions, l'Agent cible est sollicité — dans sa conversation principale (avec contexte) ou via une sous-tâche isolée (le prompt doit alors être auto-suffisant). Réutilise le moteur de dispatch des webhooks. Le polling ne fait aucun appel API quand aucun trigger n'est actif.

### `GET /api/account-triggers?accountId=`

Liste les triggers, optionnellement filtrés sur un compte. → `{ triggers: AccountTriggerSummary[] }`.

### `POST /api/account-triggers`

Crée un trigger (`created_by: 'user'`). Body : `{ accountId, name, folder?, conditions, prompt, targetAgentId, dispatchMode?, maxConcurrentTasks? }`. `conditions` = arbre `ConditionNode`, validé serveur (profondeur ≤ 4, ≤ 30 feuilles, groupe non vide, regex compilable). `201` → `{ trigger }`, sinon `400 VALIDATION_ERROR`.

### `PATCH /api/account-triggers/:id`

Met à jour (ou approuve via `isActive: true`). → `{ trigger }` ou `404`.

### `DELETE /api/account-triggers/:id`

Supprime le trigger.

### `GET /api/account-triggers/:id/logs?limit=`

Journal d'évaluation/déclenchement (`trigger_logs`). → `{ logs: TriggerLogEntry[] }`.

### `GET /api/account-triggers/settings/approval` · `PUT /api/account-triggers/settings/approval`

Réglage global : les triggers créés par un Agent doivent-ils être approuvés avant d'être actifs (défaut `false`). `GET` → `{ requireApproval }` ; `PUT { enabled: boolean }`.

### `GET /api/email-accounts/:id/folders`

Liste les dossiers/labels d'un compte connecté (pour le picker de dossier d'un trigger). → `{ folders: { id, name, type? }[] }`. Retombe sur `INBOX` si le provider n'expose pas `listFolders`.

## Secure input (secret prompts)

Popup de saisie sécurisée : un Agent (configurateur ou via `prompt_secret` / `request_provider_setup`) demande un secret (clé d'API, token). La valeur va **directement au coffre** ; elle ne transite jamais par le LLM, n'est ni journalisée ni stockée dans `secret_prompts`. Voir `secret-prompts.ts`. Émet `prompt:secret-request` / `prompt:secret-resolved` en SSE.

### Human prompts — type `tool_access`

`request_tool_access` (outil du floor, dispo pour tout Agent) crée un human prompt `promptType: 'tool_access'` : `description` = raison de l'Agent, `options[]` = un item par outil demandé. Réponse via le endpoint standard `POST /api/prompts/:id/respond` avec `{ response: string[] }` — la liste des outils **accordés** (tableau vide = tout refuser, valide contrairement à `multi_select`). À l'approbation le serveur fusionne les noms accordés dans `agents.extra_tool_names` (permanent, révocable via `PATCH /api/agents/:id`) puis relance l'Agent ; SSE `agent:tools-granted` `{ agentId, granted, extraToolNames }`.

### `GET /api/secret-prompts/pending?agentId=`

Prompts en attente pour l'Agent (hydratation au montage / reconnexion). Métadonnées des champs uniquement, **jamais** de valeur secrète. → `{ prompts: SecretPromptRequest[] }`.

### `POST /api/secret-prompts/:id/respond`

Soumet les valeurs : `{ values: Record<fieldKey, string> }`. Le serveur stocke dans le coffre et exécute l'effet de bord (créer+tester un provider, stocker un secret, créer un channel). Purpose `reveal` (tool `reveal_secret`) : aucune valeur saisie — la soumission vaut **approbation** ; la valeur brute est injectée dans le message de reprise UNIQUEMENT (jamais dans le `summary` SSE/HTTP), le message porteur est flaggé `redact_pending` + metadata `{ reveal: { key } }` et il est auto-redacté en fin de tour (sweep + scrub `tool_calls` ; sweep de récupération au boot). Le cancel vaut refus. Émet `vault:secret-revealed { agentId, secretKey, approved }` sur le bus d'événements. Pour le purpose `vault`, une clé déjà présente est **mise à jour** (upsert) au lieu d'échouer sur la contrainte `UNIQUE(key)`. Dans tous les cas, le prompt quitte l'état `pending` (succès **comme** échec) et l'Agent est relancé via un message de confirmation non sensible — un effet de bord qui throw ne laisse plus le prompt bloqué (sinon il se re-déclenchait à chaque rechargement). → `{ success: true, summary }` ou `400 SECRET_PROMPT_ERROR`.

### `POST /api/secret-prompts/:id/cancel`

Écarte définitivement un prompt en attente sans fournir la valeur : statut `cancelled`, l'Agent (ou la sous-tâche suspendue) est relancé avec une note « refusé ». Idempotent si déjà résolu. → `{ success: true }` ou `400 SECRET_PROMPT_ERROR`.

## Mises à jour de la plateforme (version-check)

Deux canaux : `stable` (releases GitHub) et `edge` (HEAD de `main`). Le canal est un réglage global (`app_settings.update_channel`, défaut `stable`).

### `GET /api/version-check`

Infos de version en cache (rafraîchies en arrière-plan si périmées). Accessible à tout utilisateur authentifié.

**Response 200**
```json
{
  "currentVersion": "1.2.0",
  "currentSha": "3492373",
  "channel": "stable",
  "installationType": "systemd-system",
  "latestVersion": "1.3.0",
  "isUpdateAvailable": true,
  "canSelfUpdate": true,
  "selfUpdateBlockedReason": null,
  "releaseUrl": "https://github.com/MarlBurroW/hivekeep/releases/tag/v1.3.0",
  "changelog": [
    { "version": "1.3.0", "title": "Hivekeep v1.3.0", "notes": "### Features\n- ...", "url": "...", "publishedAt": 1765000000000 }
  ],
  "publishedAt": 1765000000000,
  "lastCheckedAt": 1765000100000
}
```

- `installationType`: `docker` | `systemd-system` | `systemd-user` | `launchd` | `manual`.
- `canSelfUpdate` est `false` (avec `selfUpdateBlockedReason`: `docker` | `not-git` | `dev-mode`) quand l'update doit se faire hors UI (repull d'image docker, checkout dev…).
- `changelog` est **cumulatif** : toutes les releases entre la version courante et la dernière (stable), ou la liste des commits `HEAD..origin/main` (edge, `notes` = null).

### `POST /api/version-check/check`

Force un check immédiat contre GitHub (admin). Même réponse que `GET /`. **400 `DISABLED`** si `VERSION_CHECK_ENABLED=false`.

### `PUT /api/version-check/channel`

Change le canal (admin). Body : `{ "channel": "stable" | "edge" }`. Invalide le cache et relance un check ; renvoie les infos fraîches. **400 `INVALID_CHANNEL`** sinon.

### `POST /api/version-check/update`

Lance la mise à jour auto (admin, installs git non-docker uniquement). Répond immédiatement :

```json
{ "started": true, "runId": "a1b2c3d4" }
```

La progression arrive via SSE (`update:progress`), l'issue finale via `GET /api/version-check/last-update` (le serveur redémarre en cours de route, le client doit poller). Erreurs : **400 `SELF_UPDATE_UNAVAILABLE`** (docker/dev/non-git), **400 `NO_UPDATE`**, **409 `UPDATE_IN_PROGRESS`**.

Séquence serveur : preflight (worktree propre, disque) → snapshot DB (`VACUUM INTO`) → backup `dist/` + sha → download des assets client pré-buildés de la release (sha256 vérifié, fallback build local) → `git checkout` du tag (stable) / fast-forward `main` (edge) → `bun install` → restart. Si le nouveau code ne démarre pas, le boot-guard (`src/server/index.ts`) restaure automatiquement l'ancienne version (repo + dist + deps + snapshot DB) — statut `rolled-back`.

### `GET /api/version-check/last-update`

Dernière tentative de mise à jour (journal persistant `data/update/journal.json`, survit au restart).

**Response 200**
```json
{
  "run": {
    "id": "a1b2c3d4",
    "channel": "stable",
    "fromVersion": "1.2.0",
    "fromSha": "3492373",
    "toVersion": "1.3.0",
    "status": "success",
    "currentStep": null,
    "error": null,
    "startedAt": 1765000000000,
    "finishedAt": 1765000090000
  }
}
```

`status`: `running` | `restarting` | `success` | `failed` (rien n'a changé, l'ancienne version tourne toujours) | `rolled-back` (le nouveau code n'a pas booté, restauration automatique).

## Terminal (admin uniquement)

Terminal web sur la machine hôte (ou le conteneur sous Docker). Section `/terminal`, réservée aux admins. Modèle type tmux : chaque session est un shell (PTY, `bun-pty`) côté serveur, scopé à son propriétaire, qui **survit aux déconnexions WebSocket** — on peut fermer le navigateur et se rattacher depuis un autre appareil (le scrollback est rejoué). Une session ne meurt que quand son shell sort, quand l'utilisateur la ferme depuis la sidebar, ou (si `HIVEKEEP_TERMINAL_DETACHED_TTL_SEC` > 0, désactivé par défaut) après être restée détachée trop longtemps. Les sessions vivent en mémoire : un restart du serveur les tue. Désactivable globalement via `HIVEKEEP_TERMINAL_ENABLED=false`.

Tout changement de cycle de vie (création, attache/détache, renommage, mort) émet `terminal:sessions-changed` (SSE, scope user) avec la liste fraîche — c'est ce qui synchronise la sidebar entre appareils.

### `GET /api/terminal/status`

Sonde la disponibilité de la fonctionnalité (la page l'appelle avant d'ouvrir le WebSocket, car un refus d'upgrade ne porte pas de corps d'erreur).

**Response 200** : `{ "enabled": true, "shell": "/bin/bash" }`
**403 `TERMINAL_DISABLED`** si désactivé par env var. **403 `FORBIDDEN`** si non-admin.

### `GET /api/terminal/sessions`

Liste les sessions vivantes de l'utilisateur courant (triées par date de création).

**Response 200**
```json
{
  "sessions": [
    { "id": "…", "name": "Session 1", "createdAt": 1765000000000, "lastActiveAt": 1765000050000, "attached": true }
  ]
}
```

`attached` : un client (n'importe quel appareil) est actuellement connecté à cette session.

### `PATCH /api/terminal/sessions/:id`

Renomme une session. Body : `{ "name": "claude code prod" }` (trim, max 60 caractères). → `{ "session": { … } }`. **404 `NOT_FOUND`** si la session n'existe pas, n'appartient pas à l'appelant, ou si le nom est vide.

### `DELETE /api/terminal/sessions/:id`

Tue le shell et détruit la session (bouton « fermer » de la sidebar). Si un client y est attaché, il reçoit le message WS `exit`. → `{ "success": true }`. **404 `NOT_FOUND`** sinon.

### `GET /api/terminal/ws`

Upgrade WebSocket (cookie de session Better Auth requis, mêmes gardes que `/status`).

**Query params** : `cols`, `rows` (taille initiale), `sessionId` (optionnel — rattache une session encore vivante du même utilisateur ; sinon un nouveau shell est créé). Plusieurs clients (onglets/appareils) peuvent s'attacher **simultanément** à la même session : la sortie est miroir vers tous, l'entrée de chacun va au PTY.

**Messages client → serveur** (JSON) :

| Type | Payload | Effet |
|---|---|---|
| `input` | `{ "type": "input", "data": "ls\r" }` | Écrit sur le PTY |
| `resize` | `{ "type": "resize", "cols": 120, "rows": 32 }` | Déclare la taille de CE client ; le PTY est dimensionné au plus petit client attaché (façon tmux) |
| `kill` | `{ "type": "kill" }` | Tue le shell et détruit la session |
| `ping` | `{ "type": "ping" }` | Keepalive (ignoré côté serveur) |

**Messages serveur → client** (JSON) :

| Type | Payload | Sens |
|---|---|---|
| `ready` | `{ "type": "ready", "sessionId": "…", "resumed": false }` | Session attachée. Si `resumed: true`, le scrollback complet suit dans un message `output` |
| `output` | `{ "type": "output", "data": "…" }` | Sortie brute du PTY (séquences ANSI incluses) |
| `exit` | `{ "type": "exit" }` | Le shell s'est terminé (exit, kill ou TTL) ; la session n'existe plus |
| `error` | `{ "type": "error", "code": "TERMINAL_MAX_SESSIONS" }` | Création refusée (cap `HIVEKEEP_TERMINAL_MAX_SESSIONS` atteint), le serveur ferme ensuite le socket |

## Mini-Apps (backend runtime)

> Le CRUD complet des mini-apps (fichiers, storage, snapshots, console, icônes) est documenté côté `docs-site/` (section Mini-Apps). Cette section couvre les contrats du **runtime backend** (`_server.js`).

### `ALL /api/mini-apps/:id/api/*`

Proxy vers les routes Hono du `_server.js` de l'app (chargé paresseusement, ou au boot si `app.json` déclare `"background": true`). `404 NO_BACKEND` si l'app n'a pas de backend, `404 NO_HTTP_ROUTES` si le module n'exporte que des hooks de cycle de vie.

### `GET /api/mini-apps/:id/events`

Flux SSE **par app** (distinct du SSE global) : événements émis par `ctx.events.emit()` côté backend. Chaque abonné est taggé avec le user de session, ce qui permet l'émission ciblée `ctx.events.emit(event, data, { userId })`.

```
event: connected   data: { appId }
event: app-event   data: { event: string, data: unknown, timestamp: number }
: ping             (keep-alive toutes les 30s)
```

### `ALL /api/mini-apps/:id/platform/*`

Gateway permissionné vers l'API REST de la plateforme : permet à une mini-app (front) de gérer n'importe quelle ressource comme le font les pages de settings. Le sous-chemin est rejoué sur la vraie route `/api/<resource>` en portant la session de l'utilisateur, après vérification de la permission `platform:<resource>:<read|write>` accordée à l'app (GET/HEAD = read, le reste = write ; un grant `write` implique `read`).

```
GET  /api/mini-apps/:id/platform/contacts        -> proxy GET  /api/contacts        (platform:contacts:read)
POST /api/mini-apps/:id/platform/contacts        -> proxy POST /api/contacts        (platform:contacts:write)
```

Erreurs : `403 PERMISSION_REQUIRED` (permission non accordée), `403 RESOURCE_FORBIDDEN` (ressource interdite via le gateway : `auth`, `onboarding`, `vault`, `database`, `users`, `mini-apps`, `sse`, `health`, `uploads`), `400 INVALID_PATH`.

> Sécurité : l'iframe étant same-origin, une app pourrait aussi appeler `/api/<resource>` en direct avec le cookie de session (le gateway est le chemin béni/permissionné ; le rendre obligatoire via tokenisation de l'iframe est un durcissement prévu).

### `POST /api/mini-apps/:id/client-event`

Canal montant UI → backend (`Hivekeep.events.send()`). Délivré à l'export `onClientEvent(ctx, event, data, meta)` du `_server.js` (`meta = { userId, userName }`, exécution bornée à 10s).

```typescript
// Requête
{ event: string, data?: unknown }

// Réponse 200
{ handled: boolean, result: unknown | null }   // handled=false si pas d'export onClientEvent

// Erreurs : 404 NOT_FOUND / NO_BACKEND, 400 INVALID_BODY, 500 CLIENT_EVENT_ERROR
```

### `GET /api/mini-apps/:id/permissions`

État des permissions de capacités : demandées dans `app.json` (`"permissions": ["llm", "agent:inform", "agent:task", "channels:send", "secrets:<NAME>", "platform:<resource>:<read|write>", "events:<prefix>"]`) vs accordées par l'utilisateur.

```typescript
// Réponse 200
{ requested: string[], granted: string[], missing: string[] }
```

### `POST /api/mini-apps/:id/permissions`

Accorde des permissions (additif — jamais de révocation implicite). Seules des permissions présentes dans le manifest peuvent être accordées. Redémarre le backend et émet `miniapp:updated`.

```typescript
// Requête
{ grant: string[] }

// Réponse 200
{ requested: string[], granted: string[], invalid: string[] }
```

## SSE

### `GET /api/sse`

Connexion SSE **globale** (une seule par client). Le serveur multiplex les événements de tous les Agents.

#### Types d'événements

```typescript
// Tokens LLM en streaming
{ event: 'chat:token', data: { agentId: string, token: string } }

// Réponse LLM terminée
{ event: 'chat:done', data: { agentId: string, messageId: string, tokenUsage?: { inputTokens: number, outputTokens: number, totalTokens: number } } }

// Nouveau message entrant dans le chat — émis pour TOUTES les sources, y compris
// les messages utilisateur (sync temps-réel multi-appareils / multi-membres).
// Pour les messages utilisateur web, `clientMessageId` reprend le token envoyé au
// POST : le client émetteur réconcilie sa bulle optimiste, les autres l'ajoutent.
// (Le payload est aplati au niveau racine, pas imbriqué sous `message`.)
{ event: 'chat:message', data: { agentId: string, id: string, clientMessageId?: string | null, role: string, content: string, files: FileShape[], ... } }

// Messages supprimés (suppression unitaire ou rewind) — les clients retirent
// ces ids de leur liste (filtre idempotent, sync multi-appareils).
{ event: 'chat:messages-deleted', data: { agentId: string, messageIds: string[] } }

// Messages nettoyés en place par redact_secret_leak (la valeur d'un secret a été
// remplacée par son placeholder {{secret:KEY}} dans content/tool_calls) — les
// clients re-fetchent la conversation (le contenu a changé, pas disparu).
{ event: 'chat:messages-redacted', data: { agentId: string, messageIds: string[] } }

// Changement d'état d'une tâche
{ event: 'task:status', data: { taskId: string, agentId: string, status: string } }

// Tâche terminée
{ event: 'task:done', data: { taskId: string, agentId: string, result: string } }

// Exécution d'un cron
{ event: 'cron:triggered', data: { cronId: string, agentId: string, taskId: string } }

// Trigger email (compte connecté) : créé / modifié / supprimé / déclenché
{ event: 'trigger:created', data: { triggerId: string, accountId: string } }
{ event: 'trigger:updated', data: { triggerId: string, accountId: string } }
{ event: 'trigger:deleted', data: { triggerId: string, accountId: string } }
{ event: 'trigger:fired',   data: { triggerId: string, accountId: string } }

// Queue mise a jour
{ event: 'queue:update', data: { agentId: string, queueSize: number, isProcessing: boolean, processingStartedAt?: number } }

// Erreur sur un Agent
{ event: 'agent:error', data: { agentId: string, error: string } }

// Projet actif d'un Agent changé
{ event: 'agent:active-project', data: { agentId: string, activeProjectId: string | null } }

// Workspace muté (section Files) — émis par les routes /workspace/* ET par les
// tools natifs qui écrivent dans le workspace statique (write_file, edit_file,
// multi_edit, download_stored_file, download_email_attachment). Une opération
// récursive (delete/move/copy/upload de dossier) émet UN seul change grossier
// sur le dossier (isDirectory: true), jamais une entrée par descendant ; le
// tableau `changes` est borné (≤ 20 — au-delà, un seul change sur le parent commun).
// `modifiedAt` (mtime résultant) permet à l'appareil émetteur d'ignorer son propre écho.
{ event: 'workspace:changed', data: {
  agentId: string,
  changes: Array<{
    path: string,
    type: 'created' | 'modified' | 'deleted' | 'renamed',
    isDirectory: boolean,
    newPath?: string,         // pour renamed
    modifiedAt?: number
  }>
} }

// Projet créé / modifié / supprimé
{ event: 'project:created', data: { project: ProjectSummary } }
{ event: 'project:updated', data: { project: ProjectSummary } }
{ event: 'project:deleted', data: { projectId: string } }

// Ticket créé / modifié / supprimé
{ event: 'ticket:created', data: { ticket: TicketSummary } }
{ event: 'ticket:updated', data: { ticket: TicketSummary } }      // inclut changement de status / position
{ event: 'ticket:deleted', data: { ticketId: string, projectId: string } }

// Tag CRUD au sein d'un projet
{ event: 'project-tag:created', data: { tag: { id: string, label: string, color: string }, projectId: string } }
{ event: 'project-tag:updated', data: { tag: { id: string, label: string, color: string }, projectId: string } }
{ event: 'project-tag:deleted', data: { tagId: string, projectId: string } }

// Sessions du terminal admin changées (création / attache / détache / renommage /
// mort) — scope user (sendToUser) : seul le propriétaire reçoit. Le payload porte
// la liste fraîche complète (la sidebar remplace, pas de merge nécessaire).
{ event: 'terminal:sessions-changed', data: { sessions: TerminalSessionDTO[] } }

// Mini-apps : cycle de vie (CRUD + fichiers). `miniapp:notify` n'existe pas ici —
// les notifications d'apps passent par le canal notification:new standard
// (type 'miniapp:notify', relatedType 'miniapp', relatedId = appId).
{ event: 'miniapp:created', data: { app: MiniAppSummary } }
{ event: 'miniapp:updated', data: { app: MiniAppSummary } }       // inclut reassignation mainteneur + grant de permissions
{ event: 'miniapp:deleted', data: { appId: string } }
{ event: 'miniapp:file-updated', data: { appId: string, path: string, version: number } }
{ event: 'miniapp:reload', data: { appId: string } }              // demande de reload de l'iframe (tool reload_mini_app)

// Mises à jour de la plateforme
// Nouvelle version détectée par le cron de check (émis une seule fois par version)
{ event: 'version:update-available', data: { channel: 'stable' | 'edge', latestVersion: string, releaseUrl: string | null, publishedAt: number | null } }
// Progression d'une self-update en cours (steps: preflight, snapshot, backup,
// download, apply, dependencies, assets, restart)
{ event: 'update:progress', data: { runId: string, step: string, status: 'running' | 'done' | 'error', message: string | null } }
// Issue d'une self-update. 'success' et 'rolled-back' sont émis APRÈS le restart
// (le client doit donc aussi poller GET /api/version-check/last-update pendant
// la coupure SSE) ; 'failed' est émis avant restart (l'ancienne version tourne).
{ event: 'update:finished', data: { runId: string, status: 'success' | 'failed' | 'rolled-back', version?: string, error?: string } }
```

> Les backends de mini-apps peuvent s'abonner IN-PROCESS à ce catalogue via `ctx.on(eventType, handler)` (gardé par la permission `events:<prefix>`, ex. `events:task`). Les types haute-fréquence/internes (`chat:token`, `queue:update`, `*-token-usage`…) ne sont pas abonnables. Voir `docs-site` > mini-apps > backend.

> Le SSE est **global** (pas par Agent). Le client filtre côté frontend par `agentId` pour n'afficher que les événements pertinents. Cela permet de mettre a jour la sidebar (badges, statuts) pour tous les Agents simultanément.

> Les événements `task:*` existants restent inchangés. Les clients qui s'intéressent aux tasks liées aux tickets filtrent côté frontend sur `task.ticketId !== null` (le champ est désormais présent dans le payload des tasks).

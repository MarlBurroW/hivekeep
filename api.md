# KinBot — Contrats API

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
  language: 'fr' | 'en'
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
  language?: 'fr' | 'en'
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
  }>
}
```

---

## Kins

### `GET /api/kins`

```typescript
// Response 200
{
  kins: Array<{
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

### `GET /api/kins/:id`

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

### `POST /api/kins`

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

// Si avatar === 'upload', utiliser POST /api/kins/:id/avatar après création

// Response 201
{ kin: { ...same as GET /api/kins/:id } }
```

### `PATCH /api/kins/:id`

```typescript
// Request (tous optionnels)
{
  name?: string
  role?: string
  character?: string
  expertise?: string
  model?: string
  mcpServerIds?: string[]
}

// Response 200
{ kin: { ...same shape } }
```

### `DELETE /api/kins/:id`

```typescript
// Response 200
{ success: true }
```

### `POST /api/kins/:id/avatar`

Upload ou génération d'avatar.

```typescript
// Mode upload : FormData avec champ "file"
// Mode generate : { mode: 'generate' }
// Mode prompt : { mode: 'prompt', prompt: string }

// Response 200
{ avatarUrl: string }
```

### `GET /api/kins/:id/context-preview`

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

### `PATCH /api/kins/:id/active-project`

Définit le projet actif du Kin. Le contexte du projet sera injecté dans le bloc volatile du prompt système aux tours suivants. Voir `projects.md` § 4.

```typescript
// Request
{ projectId: string | null }

// Response 200
{ activeProjectId: string | null }

// Errors
// 404 — { error: { code: 'PROJECT_NOT_FOUND', message: '...' } }
// 404 — { error: { code: 'KIN_NOT_FOUND', message: '...' } }
```

Un event SSE `kin:active-project` est émis à tous les clients connectés (utile pour synchroniser les chips "Projet actif" dans les autres onglets / vues).

---

## Messages / Chat

### `POST /api/kins/:id/messages`

Envoie un message a un Kin. Déclenche le traitement et le streaming SSE de la réponse.

```typescript
// Request
{
  content: string
  files?: string[]          // IDs de fichiers déjà uploadés
}

// Response 202
{ messageId: string, queuePosition: number }
```

> La réponse du Kin arrive via SSE (pas dans cette response HTTP).

### `GET /api/kins/:id/messages`

Historique paginé des messages.

```typescript
// Query params : ?before={messageId}&limit={number, default 50}

// Response 200
{
  messages: Array<{
    id: string
    role: 'user' | 'assistant' | 'system' | 'tool'
    content: string
    sourceType: 'user' | 'kin' | 'task' | 'cron' | 'system'
    sourceId: string | null
    sourceName: string | null   // pseudonym, kin name, task name, cron name
    isRedacted: boolean
    tokenUsage: { inputTokens: number, outputTokens: number, totalTokens: number, cacheReadTokens?: number, cacheWriteTokens?: number, reasoningTokens?: number, stepCount?: number } | null
    files: Array<{ id: string, name: string, mimeType: string, url: string }>
    createdAt: number
  }>
  hasMore: boolean
}
```

### `POST /api/kins/:id/messages/inject`

Injecte un message dans la conversation en cours. Si le Kin est en train de streamer une réponse, le stream est interrompu (la réponse partielle est sauvegardée) et le message injecté est mis en file d'attente en priorité haute. Utilisé pour la commande `/btw` et la promotion de messages depuis la queue.

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

---

## Tâches

### `GET /api/tasks`

Liste toutes les tâches en cours.

```typescript
// Query params : ?status={pending|in_progress|paused|completed|failed|cancelled}&kinId={string}

// Response 200
{
  tasks: Array<{
    id: string
    parentKinId: string
    parentKinName: string
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

Hard delete avec cascade : tous les tickets et tags du projet sont supprimés. Les tasks historiques liées voient leur `ticketId` mis à NULL (historique préservé dans les threads des Kins). Les Kins qui avaient ce projet en `activeProjectId` voient leur valeur mise à NULL.

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
      parentKinId: string
      parentKinName: string
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

Spawn un sub-Kin pour travailler sur le ticket. Le `kinId` du Kin parent doit être passé explicitement (pas de défaut implicite — cf. `projects.md` § 4). **Toujours en mode `await`** : le mode `async` n'est pas autorisé pour les tasks liées à un ticket (sinon le ticket resterait figé sans turn de cloture, cf. `projects.md` § 5).

```typescript
// Request
{
  kinId: string              // Kin qui spawn la task (= parent_kin_id)
}

// Response 201
{
  task: {
    id: string
    parentKinId: string
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
- **Aucun effet sur le ticket** (status / position / tags inchangés — c'est au Kin ou à l'utilisateur de gérer le statut manuellement)
- Un event SSE `task:status` est émis pour la nouvelle task

---

## Crons

### `GET /api/crons`

```typescript
// Query params : ?kinId={string}

// Response 200
{
  crons: Array<{
    id: string
    kinId: string
    kinName: string
    name: string
    schedule: string
    taskDescription: string
    targetKinId: string | null
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
  kinId: string
  name: string
  schedule: string
  taskDescription: string
  targetKinId?: string
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
  targetKinId?: string
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

Approuve un cron créé par un Kin (qui nécessite validation).

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

## Vault

### `GET /api/vault`

Liste les secrets (clés uniquement, jamais les valeurs).

```typescript
// Response 200
{
  secrets: Array<{
    id: string
    key: string
    createdAt: number
    updatedAt: number
  }>
}
```

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
// Request: FormData avec champ "file" + "kinId"

// Response 201
{ file: { id: string, name: string, mimeType: string, size: number, url: string } }
```

---

## Memories (gestion via UI)

### `GET /api/kins/:id/memories`

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

### `DELETE /api/kins/:id/memories/:memoryId`

```typescript
// Response 200
{ success: true }
```

---

## Compacting (gestion via UI)

### `POST /api/kins/:id/compacting/purge`

Réinitialise le compacting (supprime le snapshot actif).

```typescript
// Response 200
{ success: true }
```

### `GET /api/kins/:id/compacting/snapshots`

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

### `POST /api/kins/:id/compacting/rollback`

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

Liste des item IDs de la setup checklist que l'utilisateur a explicitement skippés. Stockage **global** (pas per-user) sous `app_settings.dismissed_setup_items` — KinBot est un produit individuel ou petit groupe avec configuration partagée.

```typescript
// Response 200
{ items: string[] }
```

Item IDs reconnus côté UI : `add_llm_provider`, `set_default_llm`, `add_embedding_provider`, `set_default_embedding`, `add_image_provider`, `add_search_provider`, `create_first_kin`.

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
kinId?: string
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
    kinId: string | null
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
groupBy: 'provider_type' | 'model_id' | 'kin_id' | 'call_site' | 'day'  // obligatoire
kinId?: string
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

## SSE

### `GET /api/sse`

Connexion SSE **globale** (une seule par client). Le serveur multiplex les événements de tous les Kins.

#### Types d'événements

```typescript
// Tokens LLM en streaming
{ event: 'chat:token', data: { kinId: string, token: string } }

// Réponse LLM terminée
{ event: 'chat:done', data: { kinId: string, messageId: string, tokenUsage?: { inputTokens: number, outputTokens: number, totalTokens: number } } }

// Nouveau message dans le chat (autres sources)
{ event: 'chat:message', data: { kinId: string, message: MessageShape } }

// Changement d'état d'une tâche
{ event: 'task:status', data: { taskId: string, kinId: string, status: string } }

// Tâche terminée
{ event: 'task:done', data: { taskId: string, kinId: string, result: string } }

// Exécution d'un cron
{ event: 'cron:triggered', data: { cronId: string, kinId: string, taskId: string } }

// Queue mise a jour
{ event: 'queue:update', data: { kinId: string, queueSize: number, isProcessing: boolean, processingStartedAt?: number } }

// Erreur sur un Kin
{ event: 'kin:error', data: { kinId: string, error: string } }

// Projet actif d'un Kin changé
{ event: 'kin:active-project', data: { kinId: string, activeProjectId: string | null } }

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
```

> Le SSE est **global** (pas par Kin). Le client filtre côté frontend par `kinId` pour n'afficher que les événements pertinents. Cela permet de mettre a jour la sidebar (badges, statuts) pour tous les Kins simultanément.

> Les événements `task:*` existants restent inchangés. Les clients qui s'intéressent aux tasks liées aux tickets filtrent côté frontend sur `task.ticketId !== null` (le champ est désormais présent dans le payload des tasks).

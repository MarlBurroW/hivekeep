# Adding a new provider

> **For LLM providers, follow "Adding a native LLM provider" in `CLAUDE.md`** —
> they live in `src/server/llm/llm/` + `provider-metadata.ts` + `register.ts`,
> not the `ProviderDefinition` pattern below. This file covers the
> capability-dispatch (`testConnection` / `listModels`) layer.

**3 files to touch, in this order:**

## 1. `src/shared/provider-metadata.ts` — declare capabilities and display name

Add one entry to `PROVIDER_META`:

```ts
myprovider: { capabilities: ['llm', 'embedding'], displayName: 'My Provider' },
```

Available capabilities: `'llm'`, `'embedding'`, `'image'`, `'search'`

Optional flag: `noApiKey: true` if no API key is required (local or OAuth-based auth).

**This is the single source of truth.** `constants.ts`, `PROVIDER_TYPES`, `PROVIDER_CAPABILITIES`, `PROVIDER_DISPLAY_NAMES` — everything derives from here automatically. Do NOT touch those.

---

## 2. `src/server/providers/myprovider.ts` — implement the provider

```ts
import type { ProviderConfig, ProviderDefinition, ProviderModel } from '@/server/providers/types'

export const myproviderProvider: ProviderDefinition = {
  type: 'myprovider',

  async testConnection(config: ProviderConfig) {
    try {
      // Make a lightweight API call to verify credentials
      return { valid: true }
    } catch (error) {
      return { valid: false, error: error instanceof Error ? error.message : 'Connection failed' }
    }
  },

  async listModels(config: ProviderConfig): Promise<ProviderModel[]> {
    try {
      // Fetch model list from the provider API
      // Classify each model: { id, name, capability: 'llm'|'embedding'|'image' }
      // Use API-provided metadata first (e.g. output_modalities, endpoints array)
      // Fall back to name heuristics only if no metadata is available
      return []
    } catch {
      return []
    }
  },
}
```

**Model classification priority (best → worst):**
1. API-provided metadata (e.g. Cohere `endpoints`, Gemini `supportedGenerationMethods`, OpenRouter `output_modalities`)
2. Model type field if the API exposes one (e.g. Together AI `model.type`)
3. Name heuristics as last resort (e.g. `id.includes('embed')`)

---

## 3. `src/server/providers/index.ts` — register the provider

Add the import and one registry entry:

```ts
import { myproviderProvider } from '@/server/providers/myprovider'

const registry: Record<string, ProviderDefinition> = {
  // ...existing entries...
  myprovider: myproviderProvider,
}
```

---

## Checklist

- [ ] Entry in `PROVIDER_META` (capabilities + displayName)
- [ ] Provider file with `testConnection` + `listModels`
- [ ] Entry in `registry` in `index.ts`
- [ ] `bun run dev` still starts without errors

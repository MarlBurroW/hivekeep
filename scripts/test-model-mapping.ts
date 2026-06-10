/**
 * Diagnostic: how well does the model registry's auto-matching cover the REAL
 * catalogues of the built-in providers? For each provider with an API key, lists
 * its live models and reports the models.dev match confidence
 * (exact / normalized / family / none) — so we can spot mapping gaps before
 * relying on the registry (and after a models.dev refresh).
 *
 * Keys: read from process.env, falling back to `.video/.keys.env` if present.
 * Run: `bun scripts/test-model-mapping.ts`
 */
import { existsSync, readFileSync } from 'node:fs'
import { registerBuiltinLLMProviders } from '@/server/llm/llm/register'
import { getLLMProvider } from '@/server/llm/llm/registry'
import { matchModelsDev } from '@/server/llm/metadata/models-dev'

registerBuiltinLLMProviders()

// Optional dev key file (gitignored).
const fileKeys: Record<string, string> = {}
const keyFile = '.video/.keys.env'
if (existsSync(keyFile)) {
  for (const line of readFileSync(keyFile, 'utf8').trim().split('\n')) {
    const i = line.indexOf('=')
    if (i > 0) fileKeys[line.slice(0, i).trim()] = line.slice(i + 1).trim()
  }
}
const keyOf = (name: string) => process.env[name] || fileKeys[name]

// (provider type, env key name)
const PROVIDERS: Array<[string, string]> = [
  ['openai', 'OPENAI_API_KEY'],
  ['anthropic', 'ANTHROPIC_API_KEY'],
  ['gemini', 'GEMINI_API_KEY'],
  ['xai', 'XAI_API_KEY'],
  ['deepseek', 'DEEPSEEK_API_KEY'],
  ['minimax', 'MINIMAX_TOKENPLAN_KEY'],
  ['moonshot', 'MOONSHOT_API_KEY'],
]

let grandUnmatched = 0
for (const [type, keyName] of PROVIDERS) {
  const key = keyOf(keyName)
  if (!key) { console.log(`\n${type}: (no ${keyName} — skipped)`); continue }
  const prov = getLLMProvider(type)
  if (!prov) { console.log(`\n${type}: no provider impl registered`); continue }

  let models
  try {
    models = await prov.listModels({ apiKey: key })
  } catch (err) {
    console.log(`\n${type}: listModels failed — ${(err as Error).message}`)
    continue
  }

  const tally = { exact: 0, normalized: 0, family: 0, none: 0 }
  const review: string[] = []
  for (const m of models) {
    const match = matchModelsDev(type, m.id)
    const c = match?.confidence ?? 'none'
    tally[c]++
    if (c === 'none' || c === 'family') {
      review.push(`    ${m.id}  →  ${c}${match ? ` (${match.key})` : ''}`)
      grandUnmatched++
    }
  }
  console.log(`\n=== ${type} — ${models.length} models ===`)
  console.log(`  exact:${tally.exact}  normalized:${tally.normalized}  family:${tally.family}  none:${tally.none}`)
  if (review.length) console.log('  NEEDS REVIEW:\n' + review.join('\n'))
}

console.log(`\n────────\nTotal models needing review (family/none) across providers: ${grandUnmatched}`)

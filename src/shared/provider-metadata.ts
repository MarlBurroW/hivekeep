/**
 * Single source of truth for provider static metadata.
 *
 * Both the client (via constants.ts) and the server (via providers/index.ts)
 * derive their data from here. Adding a new provider = one entry here
 * + the provider implementation file.
 */
import type { ProviderCapability } from '@/shared/types'

export interface ProviderMeta {
  readonly capabilities: readonly ProviderCapability[]
  readonly displayName: string
  /** True when no API key is required (local or auto-detected credentials) */
  readonly noApiKey?: boolean
  /** True when the API key is optional (provider works without one, but supports one) */
  readonly optionalApiKey?: boolean
  /** URL where users can obtain or manage their API key */
  readonly apiKeyUrl?: string
  /**
   * Name of the icon to use from `@lobehub/icons` (e.g. `"Claude"`, `"OpenAI"`).
   * Must match the whitelist in the frontend's ProviderIcon component.
   * Falls back to a generic chip icon when missing or unsupported.
   */
  readonly lobehubIcon?: string
  /**
   * Secondary fallback icon from react-icons, used when the brand isn't
   * in the Lobehub whitelist. Format: `"<collection>/<ComponentName>"`
   * (e.g. `"si/SiBrave"`, `"si/SiKagi"`). Resolution order: lobehubIcon
   * (when in whitelist) → reactIcon → generic chip icon.
   */
  readonly reactIcon?: string
  /**
   * Brand colour applied to a monochrome `reactIcon` when the host
   * requests its coloured variant. Hex string (`"#FB542B"`). Ignored
   * by Lobehub icons that already have a native `.Color` variant.
   */
  readonly brandColor?: string
}

export const PROVIDER_META = {
  anthropic:          { capabilities: ['llm'],                       displayName: 'Anthropic',              lobehubIcon: 'Claude',  apiKeyUrl: 'https://console.anthropic.com/settings/keys' },
  'anthropic-oauth':  { capabilities: ['llm'],                       displayName: 'Anthropic (Claude Max)', lobehubIcon: 'Claude',  noApiKey: true },
  openai:             { capabilities: ['llm', 'embedding', 'image', 'tts', 'stt'], displayName: 'OpenAI', lobehubIcon: 'OpenAI', apiKeyUrl: 'https://platform.openai.com/api-keys' },
  'openai-codex':     { capabilities: ['llm'],                       displayName: 'OpenAI (Codex CLI)',     lobehubIcon: 'OpenAI',  noApiKey: true },
  gemini:             { capabilities: ['llm', 'image'],              displayName: 'Google Gemini',          lobehubIcon: 'Gemini',  apiKeyUrl: 'https://aistudio.google.com/apikey' },
  openrouter:         { capabilities: ['llm', 'embedding', 'image'], displayName: 'OpenRouter',             lobehubIcon: 'OpenRouter', apiKeyUrl: 'https://openrouter.ai/keys' },
  kilo:               { capabilities: ['llm'],                       displayName: 'Kilo Gateway',           reactIcon: 'lu/LuRoute', brandColor: '#7C3AED', apiKeyUrl: 'https://kilo.ai' },
  ollama:             { capabilities: ['llm', 'search'],             displayName: 'Ollama Cloud',           lobehubIcon: 'Ollama', apiKeyUrl: 'https://ollama.com/settings/keys' },
  xai:                { capabilities: ['llm'],                       displayName: 'xAI',                    lobehubIcon: 'XAI',       apiKeyUrl: 'https://console.x.ai' },
  deepseek:           { capabilities: ['llm'],                       displayName: 'DeepSeek',               lobehubIcon: 'DeepSeek',  apiKeyUrl: 'https://platform.deepseek.com/api_keys' },
  minimax:            { capabilities: ['llm'],                       displayName: 'MiniMax',                lobehubIcon: 'Minimax',   apiKeyUrl: 'https://platform.minimax.io/user-center/basic-information/interface-key' },
  moonshot:           { capabilities: ['llm'],                       displayName: 'Kimi',                   lobehubIcon: 'Kimi',      apiKeyUrl: 'https://platform.moonshot.ai/console/api-keys' },
  'openai-compatible': { capabilities: ['llm', 'embedding'],         displayName: 'OpenAI-compatible',      reactIcon: 'lu/LuServer', optionalApiKey: true },
  'brave-search':     { capabilities: ['search'],                    displayName: 'Brave Search',           reactIcon: 'si/SiBrave', brandColor: '#FB542B', apiKeyUrl: 'https://brave.com/search/api/' },
  'serpapi':          { capabilities: ['search'],                    displayName: 'SerpAPI',                                          apiKeyUrl: 'https://serpapi.com/manage-api-key' },
  'tavily':           { capabilities: ['search'],                    displayName: 'Tavily',                 lobehubIcon: 'Tavily',    apiKeyUrl: 'https://app.tavily.com/home' },
  'perplexity-sonar': { capabilities: ['search'],                    displayName: 'Perplexity Sonar',       lobehubIcon: 'Perplexity', apiKeyUrl: 'https://www.perplexity.ai/settings/api' },
  'searxng':          { capabilities: ['search'],                    displayName: 'SearXNG',                reactIcon: 'si/SiSearxng', brandColor: '#3050FF', noApiKey: true },
  'elevenlabs':       { capabilities: ['tts', 'stt'],                displayName: 'ElevenLabs',             lobehubIcon: 'ElevenLabs', apiKeyUrl: 'https://elevenlabs.io/app/settings/api-keys' },
} as const satisfies Record<string, ProviderMeta>

export type ProviderType = keyof typeof PROVIDER_META

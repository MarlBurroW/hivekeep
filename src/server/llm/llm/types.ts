/**
 * LLM provider types — re-exports from the SDK. Single source of truth in
 * `packages/sdk/src/index.ts`.
 */
export { THINKING_EFFORT_ORDER, downgradeEffort } from '@gezy/sdk'
export type {
  ThinkingEffort,
  LLMModel,
  HivekeepTool,
  HivekeepRole,
  TextBlock,
  ImageBlock,
  ToolUseBlock,
  ToolResultBlock,
  ThinkingBlock,
  HivekeepMessageBlock,
  HivekeepMessage,
  SystemPrompt,
  ChatRequest,
  ChatChunk,
  LLMProvider,
} from '@gezy/sdk'

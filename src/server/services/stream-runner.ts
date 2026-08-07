/**
 * Per-step consumer for a hivekeep `LLMProvider.chat()` stream. Text deltas
 * are streamed to clients live and committed when the step ends normally,
 * whether the step is a pure-text final answer or a tool-call step.
 *
 * Text emitted before tool_use blocks is preamble ("Let me check X..."); the
 * Anthropic tool-use contract treats it as part of the assistant message: it
 * is displayed, persisted, and replayed in history alongside the tool_use
 * blocks (the canonical loop appends the FULL response content). Suppressing
 * it is documented as counterproductive (it pushes models to write tool calls
 * into plain text). Clients interleave it with tool cards via offsets.
 *
 *   - Step ends normally (`stop`/`length`/`tool-calls`) → the streamed deltas
 *     become committed content (caller's accumulator + snapshot). No duplicate
 *     flush event is emitted.
 *   - Step dies (error, abort, stall) → the streamed text is not persisted;
 *     `chat:token-retract` tells clients to truncate their streaming bubble
 *     back to the committed length.
 *
 * When a step follows committed text that doesn't end in whitespace, a "\n\n"
 * separator is injected into the first delta so concatenated step texts stay
 * valid markdown; it flows through the same delta pipe, keeping the
 * `contentLength` invariant intact.
 *
 * Wire contract: every `chat:token` carries `contentLength` = committed length
 * + in-flight step length AFTER appending its token, so clients can dedup
 * against a rehydration snapshot exactly.
 *
 * Thinking deltas are passed through unchanged: they are drafty by design,
 * client UIs treat them as thinking.
 */
import { sseManager } from '@/server/sse/index'
import { createLogger } from '@/server/logger'
import { config } from '@/server/config'
import type { ChatChunk } from '@/server/llm/llm/types'
import type { Usage, FinishReason } from '@/server/llm/core/types'

const log = createLogger('stream-runner')

export interface StreamStepToolCall {
  id: string
  name: string
  args: unknown
  offset: number
}

/** One captured thinking block from a single stream step. `signature` is the
 *  Anthropic cryptographic signature emitted on `signature_delta`; it is
 *  REQUIRED to replay the block on a subsequent step (the API drops unsigned
 *  thinking blocks). Absent for providers that don't sign thinking. */
export interface StreamStepThinking {
  text: string
  signature?: string
}

/** A persisted reasoning segment: `offset` indexes into the committed message
 *  content (for client-side interleaving of reasoning + tool bubbles). The
 *  optional `signature` rides along so a FUTURE resume path can rebuild a
 *  replayable thinking block (not wired yet — resume still strips thinking);
 *  the client ignores it. */
export interface ReasoningSegment {
  offset: number
  text: string
  signature?: string
}

/**
 * Coerce a tool_use `input` value into a plain object. The Anthropic API
 * requires `input` to be a JSON object — anything else makes the next turn
 * fail and permanently bricks the task (the bad entry survives in history).
 *
 * Real-world failure mode that motivated this guard (prod task, read_file
 * call #49): Opus 4.7 occasionally emits invalid JSON in
 * tool_use inputs — e.g. `{"path": "...", "offset": 1, 100, "limit": 80}`
 * where it meant to express a range. Without normalization, the string
 * round-trips through history and trips the API on the next step.
 */
export function normalizeToolUseInput(value: unknown, context?: { toolName?: string; toolCallId?: string }): Record<string, unknown> {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value as Record<string, unknown>
  }
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value)
      if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>
      }
    } catch {
      // fall through to default
    }
  }
  log.warn(
    {
      toolName: context?.toolName,
      toolCallId: context?.toolCallId,
      receivedType: value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value,
      preview: typeof value === 'string' ? value.slice(0, 200) : undefined,
    },
    'Coerced malformed tool_use input to {} — the model will see a validation error from the tool and can re-emit',
  )
  return {}
}

export interface StreamStepOutcome {
  /** Committed text emitted by this step (including pre-tool-call preamble).
   *  Empty string when the step died (error, abort, stall) or produced none. */
  stepText: string
  /** Tool-call intents collected during this step. Forwarded to SSE as they
   *  arrived; returned here so the caller can run them via `executeToolBatch`. */
  stepToolCalls: StreamStepToolCall[]
  /** Thinking blocks emitted during this step, in stream order, each paired
   *  with its own signature. Returned on EVERY path (incl. tool-call steps) so
   *  the caller can re-inject signed thinking blocks into the next step's
   *  assistant turn — restoring reasoning continuity across the tool loop.
   *  Empty when the step produced no thinking (or the provider doesn't sign). */
  stepThinking: StreamStepThinking[]
  /** `finishReason` from the provider. `undefined` if the stream ended
   *  without emitting one (error, abort, or unfinished). */
  finishReason: FinishReason | undefined
  /** Per-step token usage reported by the provider, or `undefined` when no
   *  `finish` chunk was emitted (error/abort mid-stream). */
  usage: Usage | undefined
  /** True when the caller's `abortController.signal` fired mid-stream. */
  wasAborted: boolean
  /** Mid-stream error thrown by the provider. Returned (not thrown) so each
   *  call site applies its own policy. */
  error: Error | null
}

export interface StreamStepAttribution {
  sourceType: 'agent'
  sourceId: string
  sourceName: string
  sourceAvatarUrl: string | null
}

export interface StreamStepContext {
  /** SSE channel — events are sent via `sseManager.sendToAgent(agentId, ...)`. */
  agentId: string
  /** Identifier of the assistant message being streamed. */
  assistantMessageId: string
  /** Signal whose abortion gracefully terminates the loop. */
  abortController: AbortController
  /** Merged into every SSE event's `data` payload (e.g. `{ sessionId }`,
   *  `{ taskId }`, or `{}`). */
  extraSseFields?: Record<string, unknown>
  /** First committed `chat:token` event of the message includes these
   *  attribution fields. Used by the main Agent path so the client can render
   *  correct attribution from the first frame. */
  firstTokenAttribution?: StreamStepAttribution
  /** Mutated in place when a thinking block ends (one entry per segment). */
  reasoningSegments?: ReasoningSegment[]
  /** Live snapshot: `.content` holds committed text (updated when a step's
   *  buffer commits), `.provisional` mirrors the current step's in-flight
   *  buffer delta-by-delta so mid-stream rehydration can serve
   *  `content + provisional` and stay aligned with the `contentLength` values
   *  on the wire. `outputTokens` holds the real provider-reported total from
   *  completed prior steps, used as the base for the live token estimate
   *  emitted during the current step. */
  contentSnapshot?: { content: string; provisional?: string; outputTokens?: number }
  /** Optional periodic persistence (sub-Agent only). Fires every `intervalMs`
   *  while the step runs. */
  checkpoint?: { intervalMs: number; persist: () => void | Promise<void> }
  /** Called when this step's buffered text is committed (normal step end). */
  onCommittedText?: (delta: string, newLength: number) => void
  /** Called when this step's buffered text is dropped because the step died
   *  (error, abort, stall). Use for debug logging; never expose
   *  `droppedText` on SSE. */
  onDroppedText?: (droppedText: string, stepIndex: number) => void
}

/**
 * Consume one provider chat stream and return its outcome.
 *
 * The function never throws — errors are returned as `outcome.error` so each
 * call site can apply its own recovery policy. Abort is returned via
 * `outcome.wasAborted`.
 */
/** Thrown by `withStallTimeout` when a stream goes quiet for too long. */
export class StreamStallError extends Error {
  constructor(public readonly idleMs: number) {
    super(
      `The model provider stopped sending data for ${Math.round(idleMs / 1000)}s. ` +
        'The connection was closed and the turn aborted.',
    )
    this.name = 'StreamStallError'
  }
}

/**
 * Guard an provider stream against going silent forever.
 *
 * Provider SDK timeouts do NOT cover streaming: the Anthropic/OpenAI clients
 * clear their request timer as soon as response HEADERS arrive, so the whole
 * SSE body is then read unbounded. A TCP connection that freezes mid-body
 * leaves `for await` pending forever, the turn never ends, its `finally` never
 * runs, and the Agent stays locked until the process restarts. That is the
 * "stuck for hours" failure mode observed in production.
 *
 * Every provider funnels into this one loop, so bounding it here covers all of
 * them. Each `next()` is raced against an inactivity timer (reset per chunk,
 * NOT a total duration — a legitimately slow generation keeps streaming). On
 * expiry we abort so the provider tears the connection down, then throw so the
 * caller reports a real error instead of hanging.
 */
export async function* withStallTimeout<T>(
  source: AsyncIterable<T>,
  idleMs: number,
  onStall?: () => void,
): AsyncGenerator<T> {
  if (idleMs <= 0) {
    yield* source
    return
  }
  const iterator = source[Symbol.asyncIterator]()
  try {
    for (;;) {
      let timer: ReturnType<typeof setTimeout> | undefined
      const stalled = new Promise<typeof STALL>((resolve) => {
        timer = setTimeout(() => resolve(STALL), idleMs)
      })
      let step: IteratorResult<T> | typeof STALL
      try {
        step = await Promise.race([iterator.next(), stalled])
      } finally {
        if (timer) clearTimeout(timer)
      }
      if (step === STALL) {
        // Abort first so the underlying fetch/SDK releases the socket, then
        // surface the failure. Racing (rather than only aborting) matters: a
        // provider that ignores its signal would otherwise still hang us.
        onStall?.()
        throw new StreamStallError(idleMs)
      }
      if (step.done) return
      yield step.value
    }
  } finally {
    // Best-effort teardown so a stalled or early-exited stream does not leak
    // its connection.
    void Promise.resolve(iterator.return?.()).catch(() => {})
  }
}

const STALL = Symbol('stream-stalled')

export async function runStreamStep(
  stream: AsyncIterable<ChatChunk>,
  ctx: StreamStepContext,
  stepIndex: number,
): Promise<StreamStepOutcome> {
  const prevContentLen = ctx.contentSnapshot?.content.length ?? 0
  let buffered = ''
  const stepToolCalls: StreamStepToolCall[] = []
  const stepThinking: StreamStepThinking[] = []
  let finishReason: FinishReason | undefined
  let usage: Usage | undefined
  let currentReasoning = ''
  /** Signature of the in-flight thinking block, set when its `signature_delta`
   *  arrives, consumed (and reset) by `closeReasoning`. */
  let currentSignature: string | undefined
  let inReasoning = false
  let error: Error | null = null

  const checkpointTimer = ctx.checkpoint
    ? setInterval(() => {
        Promise.resolve(ctx.checkpoint!.persist()).catch(() => {})
      }, ctx.checkpoint.intervalMs)
    : null

  const send = (type: string, data: Record<string, unknown>) => {
    sseManager.sendToAgent(ctx.agentId, {
      type: type as any,
      agentId: ctx.agentId,
      data: { ...data, ...ctx.extraSseFields },
    })
  }

  /** Drop this step's in-flight text: clear the snapshot mirror and, if any
   *  deltas already reached clients, tell them to truncate their streaming
   *  bubble back to the committed length. Only called when the step DIES
   *  (error, abort, stall); steps that end normally commit their text. */
  const retractProvisional = () => {
    if (ctx.contentSnapshot) ctx.contentSnapshot.provisional = ''
    if (buffered.length === 0) return
    send('chat:token-retract', {
      messageId: ctx.assistantMessageId,
      contentLength: prevContentLen,
    })
  }

  /** Close out an open reasoning block: push the segment. (No SSE event — the
   *  client finalizes reasoning from chat:done/refetch; there was no handler.) */
  const closeReasoning = () => {
    if (!inReasoning) return
    if (currentReasoning) {
      if (ctx.reasoningSegments) {
        ctx.reasoningSegments.push({
          offset: prevContentLen + buffered.length,
          text: currentReasoning,
          ...(currentSignature ? { signature: currentSignature } : {}),
        })
      }
      // Capture for cross-step re-injection. One entry per block so each keeps
      // its OWN signature — never merge blocks (the API rejects mis-paired
      // signatures). Unsigned blocks (non-Anthropic, or interrupted before the
      // signature arrives) are kept here but skipped by callers on replay.
      stepThinking.push({ text: currentReasoning, signature: currentSignature })
    }
    currentReasoning = ''
    currentSignature = undefined
    inReasoning = false
  }

  // Emit a smoothly-rising output-token estimate while the step generates so
  // the thinking-bubble counter increments live. The estimate covers text AND
  // reasoning in one place (clients would each have to re-implement the same
  // chars-per-token heuristic over two streams). The real per-step usage from
  // each `finish` chunk reconciles the count upward; the client keeps the
  // running max, so a slight under-estimate (≈4 chars/token) self-corrects and
  // the counter never visibly ticks back.
  const baseOutputTokens = ctx.contentSnapshot?.outputTokens ?? 0
  const usageEstimateTimer = setInterval(() => {
    const estCurrentStep = Math.ceil((buffered.length + currentReasoning.length) / 4)
    const total = baseOutputTokens + estCurrentStep
    if (total > 0) {
      send('chat:token-usage', {
        messageId: ctx.assistantMessageId,
        outputTokens: total,
        estimated: true,
      })
    }
  }, 200)

  let stalled = false
  const guardedStream = withStallTimeout(stream, config.llm.streamIdleTimeoutMs, () => {
    stalled = true
    ctx.abortController.abort()
  })

  try {
    for await (const chunk of guardedStream) {
      switch (chunk.type) {
        case 'thinking-delta': {
          if (!inReasoning) {
            inReasoning = true
            currentReasoning = ''
          }
          currentReasoning += chunk.text
          send('chat:reasoning-token', {
            messageId: ctx.assistantMessageId,
            token: chunk.text,
          })
          break
        }
        case 'thinking-signature': {
          // Signature marks the end of a thinking block. Capture it BEFORE
          // closing so the segment + step-thinking entry carry the signature.
          currentSignature = chunk.signature
          closeReasoning()
          break
        }
        case 'text-delta': {
          // Any reasoning block in flight ends when text starts.
          closeReasoning()
          const isFirstDelta = buffered.length === 0
          let text = chunk.text
          // Keep concatenated step texts valid markdown: if the previous
          // step's committed text doesn't end in whitespace, open this step's
          // text with a paragraph break. Injected into the delta itself so the
          // contentLength invariant holds on the wire.
          if (isFirstDelta && prevContentLen > 0) {
            const committed = ctx.contentSnapshot?.content ?? ''
            if (committed.length > 0 && !/\s$/.test(committed)) text = '\n\n' + text
          }
          buffered += text
          // Mirror the in-flight buffer into the snapshot so a client mounting
          // mid-step rehydrates this step's text too (it moves to `content`
          // when the step commits).
          if (ctx.contentSnapshot) ctx.contentSnapshot.provisional = buffered
          send('chat:token', {
            messageId: ctx.assistantMessageId,
            token: text,
            contentLength: prevContentLen + buffered.length,
            ...(prevContentLen === 0 && isFirstDelta && ctx.firstTokenAttribution
              ? ctx.firstTokenAttribution
              : {}),
          })
          break
        }
        case 'tool-use': {
          closeReasoning()
          const normalizedInput = normalizeToolUseInput(chunk.args, {
            toolName: chunk.name,
            toolCallId: chunk.id,
          })
          // Offset AFTER this step's preamble text, so clients interleave the
          // tool card below the text the model wrote before calling it.
          const toolOffset = prevContentLen + buffered.length
          stepToolCalls.push({
            id: chunk.id,
            name: chunk.name,
            args: normalizedInput,
            offset: toolOffset,
          })
          // We don't have a separate "tool-call-start" signal from the
          // provider abstraction — emit both events together so the client
          // sees the card appear immediately.
          send('chat:tool-call-start', {
            messageId: ctx.assistantMessageId,
            toolCallId: chunk.id,
            toolName: chunk.name,
            contentOffset: toolOffset,
          })
          send('chat:tool-call', {
            messageId: ctx.assistantMessageId,
            toolCallId: chunk.id,
            toolName: chunk.name,
            args: normalizedInput,
            contentOffset: toolOffset,
          })
          break
        }
        case 'finish': {
          closeReasoning()
          finishReason = chunk.reason
          usage = chunk.usage
          break
        }
      }
    }
  } catch (e) {
    // Checked BEFORE the abort branch: the stall guard aborts the controller on
    // purpose, so `signal.aborted` is set — but this is a provider failure, not
    // a user stop, and must surface as an error the caller reports.
    if (stalled) {
      retractProvisional()
      if (buffered.length > 0) ctx.onDroppedText?.(buffered, stepIndex)
      return {
        stepText: '',
        stepToolCalls,
        stepThinking,
        finishReason,
        usage,
        wasAborted: false,
        error: e instanceof Error ? e : new StreamStallError(config.llm.streamIdleTimeoutMs),
      }
    }
    if (ctx.abortController.signal.aborted) {
      retractProvisional()
      if (buffered.length > 0) ctx.onDroppedText?.(buffered, stepIndex)
      return {
        stepText: '',
        stepToolCalls,
        stepThinking,
        finishReason,
        usage,
        wasAborted: true,
        error: null,
      }
    }
    error = e instanceof Error ? e : new Error(String(e))
    retractProvisional()
    if (buffered.length > 0) ctx.onDroppedText?.(buffered, stepIndex)
    return {
      stepText: '',
      stepToolCalls,
      stepThinking,
      finishReason,
      usage,
      wasAborted: false,
      error,
    }
  } finally {
    if (checkpointTimer !== null) clearInterval(checkpointTimer)
    clearInterval(usageEstimateTimer)
  }

  // Step ended normally: commit whatever text it streamed, tool calls or
  // not. Preamble before tool_use is part of the assistant message (displayed,
  // persisted, replayed in history alongside the tool_use blocks); 'length'
  // (output-token limit) is a legitimate, merely truncated answer. The deltas
  // already reached clients live, so committing is a local bookkeeping move
  // (snapshot + caller accumulator) with no flush event.
  if (buffered.length > 0) {
    const newLen = prevContentLen + buffered.length
    if (ctx.contentSnapshot) {
      ctx.contentSnapshot.content += buffered
      ctx.contentSnapshot.provisional = ''
    }
    ctx.onCommittedText?.(buffered, newLen)
  }
  return {
    stepText: buffered,
    stepToolCalls,
    stepThinking,
    finishReason,
    usage,
    wasAborted: false,
    error: null,
  }
}

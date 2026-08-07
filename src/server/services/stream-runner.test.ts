import { describe, expect, it } from 'bun:test'
import { runStreamStep, type StreamStepContext, type ReasoningSegment } from './stream-runner'
import { sseManager } from '@/server/sse/index'
import type { SSEEvent } from '@/server/sse/types'
import type { ChatChunk } from '@/server/llm/llm/types'

/** Build a minimal async stream from a fixed chunk list. */
async function* fakeStream(chunks: ChatChunk[]): AsyncIterable<ChatChunk> {
  for (const c of chunks) yield c
}

function baseCtx(over: Partial<StreamStepContext> = {}): StreamStepContext {
  return {
    agentId: 'agent-test',
    assistantMessageId: 'msg-test',
    abortController: new AbortController(),
    ...over,
  }
}

/** Capture events by patching `sendToAgent` on the (possibly test-mocked)
 *  sseManager object. `mock.module` replaces the module globally for the whole
 *  `bun test` run in other files, so `addTap` may not exist; a property patch
 *  works against both the real manager and the stubs. */
function captureSSE(types: string[]) {
  const events: SSEEvent[] = []
  const original = sseManager.sendToAgent
  sseManager.sendToAgent = ((_agentId: string, event: SSEEvent) => {
    if (types.includes(event.type)) events.push(event)
  }) as typeof sseManager.sendToAgent
  return { events, restore: () => { sseManager.sendToAgent = original } }
}

/** Run one step while capturing every SSE event of the given types. */
async function runCapturing(
  chunks: ChatChunk[],
  ctx: StreamStepContext,
  types: string[],
) {
  const { events, restore } = captureSSE(types)
  try {
    const outcome = await runStreamStep(fakeStream(chunks), ctx, 0)
    return { outcome, events }
  } finally {
    restore()
  }
}

describe('runStreamStep — thinking capture for cross-step re-injection', () => {
  it('captures a signed thinking block on a tool-call step (text is still dropped)', async () => {
    const chunks: ChatChunk[] = [
      { type: 'thinking-delta', text: 'Let me ' },
      { type: 'thinking-delta', text: 'inspect the file.' },
      { type: 'thinking-signature', signature: 'sig-abc' },
      { type: 'text-delta', text: 'I will read it now' }, // pre-narration → dropped
      { type: 'tool-use', id: 't1', name: 'read_file', args: { path: 'a.ts' } },
      { type: 'finish', reason: 'tool-calls', usage: { outputTokens: 5 } },
    ]
    const outcome = await runStreamStep(fakeStream(chunks), baseCtx(), 0)

    // Intermediate (tool) step → narration dropped, but the signed thinking
    // block is exposed so the caller can re-inject it.
    expect(outcome.stepText).toBe('')
    expect(outcome.stepToolCalls).toHaveLength(1)
    expect(outcome.stepToolCalls[0]!.name).toBe('read_file')
    expect(outcome.stepThinking).toEqual([
      { text: 'Let me inspect the file.', signature: 'sig-abc' },
    ])
  })

  it('keeps text on a pure-text final step AND still exposes the thinking block', async () => {
    const chunks: ChatChunk[] = [
      { type: 'thinking-delta', text: 'The answer is 42.' },
      { type: 'thinking-signature', signature: 'sig-final' },
      { type: 'text-delta', text: 'The answer is 42.' },
      { type: 'finish', reason: 'stop', usage: { outputTokens: 3 } },
    ]
    const outcome = await runStreamStep(fakeStream(chunks), baseCtx(), 0)

    expect(outcome.stepText).toBe('The answer is 42.')
    expect(outcome.stepToolCalls).toHaveLength(0)
    expect(outcome.stepThinking).toEqual([
      { text: 'The answer is 42.', signature: 'sig-final' },
    ])
  })

  it('leaves signature undefined for an unsigned thinking block (non-Anthropic / interrupted)', async () => {
    const chunks: ChatChunk[] = [
      { type: 'thinking-delta', text: 'unsigned reasoning' },
      { type: 'text-delta', text: 'done' },
      { type: 'finish', reason: 'stop', usage: {} },
    ]
    const outcome = await runStreamStep(fakeStream(chunks), baseCtx(), 0)

    expect(outcome.stepThinking).toEqual([{ text: 'unsigned reasoning', signature: undefined }])
  })

  it('pairs each of multiple thinking blocks with its OWN signature (never merged)', async () => {
    const chunks: ChatChunk[] = [
      { type: 'thinking-delta', text: 'first thought' },
      { type: 'thinking-signature', signature: 'sig-1' },
      { type: 'tool-use', id: 't1', name: 'grep', args: { q: 'x' } },
      { type: 'thinking-delta', text: 'second thought' },
      { type: 'thinking-signature', signature: 'sig-2' },
      { type: 'tool-use', id: 't2', name: 'grep', args: { q: 'y' } },
      { type: 'finish', reason: 'tool-calls', usage: {} },
    ]
    const outcome = await runStreamStep(fakeStream(chunks), baseCtx(), 0)

    expect(outcome.stepThinking).toEqual([
      { text: 'first thought', signature: 'sig-1' },
      { text: 'second thought', signature: 'sig-2' },
    ])
    expect(outcome.stepToolCalls.map((t) => t.id)).toEqual(['t1', 't2'])
  })

  it('streams text deltas live with rising contentLength and no duplicate flush on commit', async () => {
    const contentSnapshot = { content: 'prior.', provisional: '', outputTokens: 0 }
    const chunks: ChatChunk[] = [
      { type: 'text-delta', text: 'Hello ' },
      { type: 'text-delta', text: 'world' },
      { type: 'finish', reason: 'stop', usage: { outputTokens: 2 } },
    ]
    const { outcome, events } = await runCapturing(
      chunks,
      baseCtx({ contentSnapshot }),
      ['chat:token', 'chat:token-retract'],
    )

    expect(outcome.stepText).toBe('Hello world')
    // One chat:token per delta, nothing more (the commit is silent).
    expect(events.map((e) => e.type)).toEqual(['chat:token', 'chat:token'])
    expect(events[0]!.data.token).toBe('Hello ')
    expect(events[0]!.data.contentLength).toBe('prior.'.length + 'Hello '.length)
    expect(events[1]!.data.token).toBe('world')
    expect(events[1]!.data.contentLength).toBe('prior.'.length + 'Hello world'.length)
    // Committed into the snapshot, provisional mirror cleared.
    expect(contentSnapshot.content).toBe('prior.Hello world')
    expect(contentSnapshot.provisional).toBe('')
  })

  it('retracts streamed provisional text when the step ends in tool calls', async () => {
    const contentSnapshot = { content: 'done: ', provisional: '', outputTokens: 0 }
    const dropped: string[] = []
    const chunks: ChatChunk[] = [
      { type: 'text-delta', text: 'I will now read the file' },
      { type: 'tool-use', id: 't1', name: 'read_file', args: { path: 'a.ts' } },
      { type: 'finish', reason: 'tool-calls', usage: {} },
    ]
    const { outcome, events } = await runCapturing(
      chunks,
      baseCtx({ contentSnapshot, onDroppedText: (txt) => dropped.push(txt) }),
      ['chat:token', 'chat:token-retract'],
    )

    expect(outcome.stepText).toBe('')
    // The pre-narration streamed live, then got retracted to committed length.
    expect(events.map((e) => e.type)).toEqual(['chat:token', 'chat:token-retract'])
    expect(events[1]!.data).toMatchObject({
      messageId: 'msg-test',
      contentLength: 'done: '.length,
    })
    expect(dropped).toEqual(['I will now read the file'])
    expect(contentSnapshot.content).toBe('done: ')
    expect(contentSnapshot.provisional).toBe('')
  })

  it('does not emit a retract when a tool-call step streamed no text', async () => {
    const chunks: ChatChunk[] = [
      { type: 'tool-use', id: 't1', name: 'grep', args: { q: 'x' } },
      { type: 'finish', reason: 'tool-calls', usage: {} },
    ]
    const { events } = await runCapturing(chunks, baseCtx(), ['chat:token', 'chat:token-retract'])
    expect(events).toEqual([])
  })

  it('attaches first-token attribution only on the very first delta of the message', async () => {
    const attribution = {
      sourceType: 'agent' as const,
      sourceId: 'agent-test',
      sourceName: 'Testy',
      sourceAvatarUrl: null,
    }
    const chunks: ChatChunk[] = [
      { type: 'text-delta', text: 'Hi ' },
      { type: 'text-delta', text: 'there' },
      { type: 'finish', reason: 'stop', usage: {} },
    ]
    const { events } = await runCapturing(
      chunks,
      baseCtx({ firstTokenAttribution: attribution, contentSnapshot: { content: '', provisional: '' } }),
      ['chat:token'],
    )
    expect(events[0]!.data.sourceName).toBe('Testy')
    expect(events[1]!.data.sourceName).toBeUndefined()
  })

  it('retracts provisional text when the stream is aborted mid-step', async () => {
    const controller = new AbortController()
    async function* abortingStream(): AsyncIterable<ChatChunk> {
      yield { type: 'text-delta', text: 'partial answer' }
      controller.abort()
      throw new Error('aborted by signal')
    }
    const { events, restore } = captureSSE(['chat:token-retract'])
    try {
      const outcome = await runStreamStep(
        abortingStream(),
        baseCtx({ abortController: controller, contentSnapshot: { content: '', provisional: '' } }),
        0,
      )
      expect(outcome.wasAborted).toBe(true)
      expect(events).toHaveLength(1)
      expect(events[0]!.data.contentLength).toBe(0)
    } finally {
      restore()
    }
  })

  it('writes the signature into reasoningSegments too (the persistence channel)', async () => {
    const reasoningSegments: ReasoningSegment[] = []
    const chunks: ChatChunk[] = [
      { type: 'thinking-delta', text: 'persisted thought' },
      { type: 'thinking-signature', signature: 'sig-persist' },
      { type: 'tool-use', id: 't1', name: 'list_directory', args: {} },
      { type: 'finish', reason: 'tool-calls', usage: {} },
    ]
    await runStreamStep(fakeStream(chunks), baseCtx({ reasoningSegments }), 0)

    expect(reasoningSegments).toHaveLength(1)
    expect(reasoningSegments[0]!.text).toBe('persisted thought')
    expect(reasoningSegments[0]!.signature).toBe('sig-persist')
  })
})

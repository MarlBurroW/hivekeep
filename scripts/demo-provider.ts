/** Local, simulated OpenAI-compatible models for previews and browser checks. */
export const demoModels = [
  { id: 'demo-model-a', name: 'Démo A (simulé)' },
  { id: 'demo-model-b', name: 'Démo B (simulé)' },
] as const

export function startDemoProvider(options: { port?: number } = {}) {
  const encoder = new TextEncoder()
  let inferenceCount = 0
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: options.port ?? 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (url.pathname.endsWith('/models'))
        return Response.json({
          object: 'list',
          data: demoModels.map(({ id }) => ({ id, object: 'model', owned_by: 'demo' })),
        })
      if (!url.pathname.endsWith('/chat/completions'))
        return new Response('Unknown demo endpoint', { status: 404 })
      inferenceCount++
      const body = (await request.json()) as any
      // Keep existing preview Agents working while their old model is replaced.
      const requestedModel = body.model === 'workspace-demo' ? demoModels[0].id : (body.model ?? demoModels[0].id)
      const selectedModel = demoModels.find(({ id }) => id === requestedModel)
      if (!selectedModel)
        return Response.json({ error: { message: 'Unknown demo model', type: 'invalid_request_error' } }, { status: 400 })
      const model = selectedModel.id
      const last = [...(body.messages ?? [])].reverse().find((message: any) => message.role === 'user')
      const prompt = typeof last?.content === 'string' ? last.content : JSON.stringify(last?.content ?? '')
      const lastUserIndex = (body.messages ?? []).findLastIndex((message: any) => message.role === 'user')
      const toolAvailable = body.tools?.some((tool: any) => tool.function?.name === 'read_file')
      const toolComplete = body.messages?.slice(lastUserIndex + 1).some((message: any) => message.role === 'tool')
      const toolCall = prompt.includes('[demo:tool]') && toolAvailable && !toolComplete
        ? { id: `demo_${crypto.randomUUID()}`, type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: 'synthese.md' }) } }
        : undefined
      if (prompt.includes('[demo:error]'))
        return Response.json(
          { error: { message: 'Simulated provider failure', type: 'server_error' } },
          { status: 503 },
        )
      const response =
        `Voici une réponse de démonstration, produite localement. Le travail est enregistré et vous pouvez poursuivre la conversation. Modèle utilisé : ${selectedModel.name}.`
      if (!body.stream)
        return Response.json({
          id: crypto.randomUUID(),
          object: 'chat.completion',
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{ index: 0, message: { role: 'assistant', content: toolCall ? null : response, ...(toolCall ? { tool_calls: [toolCall] } : {}) }, finish_reason: toolCall ? 'tool_calls' : 'stop' }],
          usage: { prompt_tokens: 20, completion_tokens: 25, total_tokens: 45 },
        })
      const id = crypto.randomUUID()
      return new Response(
        new ReadableStream({
          async start(controller) {
            const send = (delta: unknown, finish_reason: string | null = null) =>
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
                ),
              )
            try {
              send({ role: 'assistant' })
              if (toolCall) send({ tool_calls: [{ index: 0, ...toolCall }] })
              else {
                for (const word of response.split(' ')) {
                  await Bun.sleep(prompt.includes('[demo:slow]') ? 180 : 25)
                  send({ content: `${word} ` })
                }
              }
              send({}, toolCall ? 'tool_calls' : 'stop')
              controller.enqueue(encoder.encode('data: [DONE]\n\n'))
              controller.close()
            } catch {
              /* disconnected consumer */
            }
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      )
    },
  })
  return { server, inferenceCount: () => inferenceCount }
}

if (import.meta.main) {
  const { server } = startDemoProvider({ port: Number(process.env.HIVEKEEP_DEMO_PROVIDER_PORT ?? 4197) })
  console.log(`Simulated demo models ready on port ${server.port}`)
  const stop = () => {
    server.stop(true)
    process.exit(0)
  }
  process.on('SIGTERM', stop)
  process.on('SIGINT', stop)
}

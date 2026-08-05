import type { HookName, HookHandler, HookPayloadMap } from '@/server/hooks/types'
import { createLogger } from '@/server/logger'
import { config } from '@/server/config'
import { withTimeout } from '@/server/utils/with-timeout'

const log = createLogger('hooks')

// Erased handler type stored inside the registry. The public `register` /
// `unregister` / `execute` methods preserve the per-hook discriminant; the
// internal map only needs to know it holds *some* HookHandler, which is what
// `AnyHookHandler` captures without forcing distributive intersections.
type AnyHookHandler = (ctx: unknown) => Promise<unknown> | unknown

class HookRegistry {
  private hooks = new Map<HookName, AnyHookHandler[]>()

  register<H extends HookName>(name: H, handler: HookHandler<H>): void {
    let handlers = this.hooks.get(name)
    if (!handlers) {
      handlers = []
      this.hooks.set(name, handlers)
    }
    handlers.push(handler as unknown as AnyHookHandler)
  }

  unregister<H extends HookName>(name: H, handler: HookHandler<H>): void {
    const handlers = this.hooks.get(name)
    if (handlers) {
      const index = handlers.indexOf(handler as unknown as AnyHookHandler)
      if (index !== -1) {
        handlers.splice(index, 1)
      }
    }
  }

  /**
   * Execute all registered handlers for a hook in order. Each handler
   * receives the typed payload for its hook and may return a modified
   * payload to be passed to the next handler.
   *
   * Returns the final payload after all handlers have run.
   */
  async execute<H extends HookName>(
    name: H,
    context: HookPayloadMap[H],
  ): Promise<HookPayloadMap[H]> {
    const handlers = this.hooks.get(name)
    if (!handlers || handlers.length === 0) return context
    log.debug({ hookName: name, handlerCount: handlers.length }, 'Executing hook')

    let currentContext: HookPayloadMap[H] = context

    for (const handler of handlers) {
      // Isolate each handler on BOTH failure axes.
      //
      // Throwing is handled by the catch: a broken plugin must not break the
      // chain nor propagate to the caller.
      //
      // Never settling needs the race. Hooks run in-process on the Agent's
      // turn path (`afterChat` is awaited after the abort controller has
      // already been released), so a handler that never resolves freezes the
      // turn's `finally`, keeps the Agent's lock held forever, and leaves no
      // way to recover short of restarting the server. Bounding it turns a
      // dead Agent into one slow turn and a named culprit in the logs.
      try {
        const result = await withTimeout(
          // A handler may be sync; normalize so the race always gets a promise.
          Promise.resolve((handler as unknown as HookHandler<H>)(currentContext)),
          config.hooks.handlerTimeoutMs,
          () => log.error({ hookName: name, timeoutMs: config.hooks.handlerTimeoutMs }, 'Hook handler timed out — skipping'),
        )
        if (result) {
          currentContext = result
        }
      } catch (err) {
        log.error({ hookName: name, err }, 'Hook handler threw — skipping')
      }
    }

    return currentContext
  }
}

export const hookRegistry = new HookRegistry()

/** Queenie is setup infrastructure, not the user's first working Agent. */
export function isUserAgent(agent: { kind?: string | null }): boolean {
  return agent.kind !== 'configurator'
}

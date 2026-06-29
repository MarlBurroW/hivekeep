// ─── Plugin Card primitives ─────────────────────────────────────────────────
//
// The discriminated union and the supporting types are owned by the SDK
// (`@gezy/sdk`) so plugin authors get autocomplete on every
// primitive without depending on Hivekeep internals. This file re-exports
// them so existing internal call sites keep their import path.
//
// A plugin card is a declarative tree of primitives plus a state object.
// The plugin emits a card once (layout + initial state) and then pushes
// state patches to update the view in place. The client interpolates
// `{{key}}` placeholders in the layout from the current state before
// rendering.
//
// Cards persist as system messages on the conversation
// (role='system', sourceType='system',
// metadata.systemEvent='plugin-card') so they survive reloads and are
// part of the normal message timeline. Live updates ride on the SSE
// `card:updated` event.

export type {
  PluginCardVariant,
  PluginCardActionInput,
  PluginCardAction,
  PluginCardInfoGridItem,
  PluginCardBannerAnimation,
  PluginCardPrimitive,
} from '@gezy/sdk'

export { card } from '@gezy/sdk'

export interface PluginCard {
  /** Name of the plugin that owns this card (matches manifest.name). */
  pluginId: string
  /** Plugin-defined identifier for the kind of card (e.g. 'task-run'). */
  cardType: string
  /** Stable UUID used to target this card with live updates. */
  cardInstanceId: string
  /** Declarative layout. Strings may contain `{{key}}` placeholders. */
  layout: import('@gezy/sdk').PluginCardPrimitive[]
  /** Values interpolated into the layout at render time. */
  state: Record<string, unknown>
}

/** Shape of the `systemEvent` payload surfaced for plugin-card system rows. */
export interface PluginCardSystemEvent {
  type: 'plugin-card'
  pluginCard: PluginCard
}

---
title: Model Registry
description: "The admin Models view: every model your providers expose, with metadata auto-filled from models.dev, plus curation, labels and overrides."
---

The **Model Registry** is the source of truth for per-model metadata in Hivekeep:
context window, input modalities (image / PDF), reasoning support, tool-calling,
pricing, and a human-readable label. Providers handle *transport* (streaming,
auth, the live model list); the registry owns the *catalogue metadata*.

Open it from **the `Models` icon in the left activity bar** (admin only) or from
**Settings → Models → Open the model registry**. It is a full-width table of
every model across every configured provider.

## Where the metadata comes from

Metadata is auto-filled from [models.dev](https://models.dev), an MIT-licensed,
community-maintained database of LLM model metadata. On reconcile, each
`(provider, model id)` is matched against models.dev and the matched entry's
fields are baked into the registry row.

Match confidence is one of:

| Confidence | Meaning |
|---|---|
| **exact** | The id is in models.dev verbatim. |
| **normalized** | Matched after stripping release markers (dates like `-2025-08-07`, `-preview`, `-latest`). |
| **family** | Only a base-family match (low confidence), flagged for review. |
| **none** | Not in models.dev, flagged for review. |

The priority for each field is **admin override (pinned) → the provider's own
API hint → models.dev → default**, with one exception: when models.dev carries
an explicit **reasoning effort list** for a model, that list wins over the
provider's hint (provider hints are often name-pattern heuristics; the curated
per-model list is more accurate). The effective value is computed at reconcile
time and stored on the row, so what you see in the table is exactly what an
Agent gets at runtime.

## Labels

Models are shown by a human-readable **label** (the models.dev `name`, e.g.
*Claude Haiku 4.5*) instead of the raw id (`claude-haiku-4-5-20251001`),
everywhere a model name appears: the model picker, the conversation header, etc.
The id is always still visible as a secondary line. Set a custom label in a
model's edit dialog; leave it blank to fall back to the models.dev label (and
then the id).

## Curation: enable / disable

Toggle any model on or off, directly in the table or in its edit dialog.
**Disabled models are hidden from every model picker**, so you can switch off the
ones you don't want and keep only those you care about.

- Disabling is safe: the chat path never blocks, so an Agent already configured
  on a disabled model keeps working: the model is only hidden from pickers.
- A newly-discovered model with an **uncertain match lands disabled** and flagged
  *to review*. Confirming it (the ✓ on the row, or saving its dialog) clears the
  flag **and enables it**.

Use the **status filter** (enabled / disabled / to-review / unmapped) with the
**bulk actions** (Enable all, Disable all, Confirm reviews) to curate at scale:
e.g. filter *To review* then confirm them all, or filter a provider then disable
the lot.

## Reviewing an uncertain match

When a match is low-confidence (`family`) or absent (`none`), the row is flagged
**review** and disabled. To resolve it:

- **Confirm** (✓) if the auto-match looks right: clears the flag and enables it.
- **Remap** (in the edit dialog) to point the row at the correct models.dev entry,
  searchable across the whole catalogue. Useful for subscription/CLI providers
  (Claude Pro/Max, Codex) whose ids map onto the base provider's entries.

Models genuinely absent from models.dev (niche or brand-new) stay unmapped; set
their metadata manually, or refresh the snapshot once models.dev has them.

## Overriding metadata

Open a model to edit any field: label, context window, max output, pricing,
image / PDF / tool-call support, reasoning. Each field you change is **pinned**:
it survives future resyncs (everything else keeps tracking models.dev). Saving an
unchanged dialog pins nothing.

- **Manual mode** freezes the whole row: nothing auto-syncs.
- **Reset to auto** drops every pin/override and re-derives the row from
  models.dev.

## Keeping it fresh

The bundled models.dev snapshot is baked into the build. Two buttons keep things
current without a release:

- **Resync**: re-match every provider against the current snapshot (picks up new
  model ids the provider now lists, clears stale rows).
- **Update models.dev**: download the latest models.dev catalogue (persisted to
  the data dir, so it survives restarts), then resync. Use this to pick up models
  that models.dev only just added.

Reconciliation also runs automatically: when a provider is created or
(re)validated, and on a periodic background cron.

## Reasoning-aware effort selectors

Every place you pick a reasoning effort (the chat composer, Agent settings,
cron forms, task dialogs) only offers **the levels the selected model actually
supports**, from the registry's reasoning metadata. The full ladder is
`minimal, low, medium, high, xhigh, max`:

- A model with an explicit effort list (e.g. `low → xhigh` on recent OpenAI
  models) shows exactly those levels.
- A reasoning model with no granularity (e.g. Kimi K2.5) shows a single
  **Enabled** toggle.
- A model with no reasoning support shows **Off** with a hint.
- No model context or an unknown model falls back to the
  generic ladder; the provider clamps the request to the closest supported
  level at run time either way.

When you switch a model and its stored effort is out of range, the selector
clamps it to the nearest supported level.

## Capability-driven upload gating

Because the registry knows each model's image / PDF support, the chat composer
**won't let you attach an image or PDF to a model that explicitly can't read it**:
it skips the file and tells you. Files of a type the model accepts (and plain
text files, always) pass through. Capability *unknown* fails open (no block).

## API

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/models` | List every registry row (joined with its provider). |
| `GET` | `/api/models/:id/candidates` | models.dev keys for the remap picker. |
| `PATCH` | `/api/models/:id` | Edit a model (pins changed fields; clears review). |
| `POST` | `/api/models/:id/mode` | Switch `auto` ↔ `manual`. |
| `POST` | `/api/models/:id/remap` | Re-point at a models.dev entry (or clear). |
| `POST` | `/api/models/:id/reset` | Drop all overrides → fully auto. |
| `POST` | `/api/models/bulk` | Bulk `enable` / `disable` / `confirm`. |
| `POST` | `/api/models/resync` | Reconcile every provider against the snapshot. |
| `POST` | `/api/models/refresh-snapshot` | Download the latest models.dev catalogue, then resync. |

See also: [Supported Providers](/docs/providers/supported/),
[Model Selection](/docs/guides/model-selection/), and
[Token Usage & Cost](/docs/features/token-usage/) (the registry's pricing feeds
the cost estimates there).

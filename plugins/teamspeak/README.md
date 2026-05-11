# KinBot Plugin: TeamSpeak

Bridges KinBot to a TeamSpeak server via the local **ts-bot** WebSocket API.

It contributes:

- **A `teamspeak` channel adapter** that ingests TeamSpeak chat messages (and,
  when wake-word transcription is enabled in ts-bot, voice transcriptions) and
  routes outgoing replies to **chat + TTS** following these rules:
  - Private message → chat only (no TTS).
  - Public channel → TTS **and** chat copy (TTS is sometimes glitchy, scrollback is useful).
  - Reply longer than `ttsMaxChars` → short TTS notice + full text in chat.
- **25 tools** (auto-namespaced as `plugin_teamspeak_*` by KinBot) covering
  the full ts-bot WebSocket admin surface:

  Bot voice & chat:
  - `speak` — force TTS playback in the bot's current channel.
  - `stop_speaking` — interrupt ongoing TTS.
  - `send_chat` — send a chat message to the channel or a private user.
  - `move_channel` — move the bot to another channel.
  - `set_nickname` — change the bot's own display nickname.

  Discovery:
  - `get_status` — list channels & clients, show the bot's current location.
  - `get_server_info` — TS3 virtual server metadata (name, welcome message, version, …).

  Client moderation:
  - `poke_client` — send a popup notification to a client.
  - `kick_client` — kick a client from the channel or the server.
  - `move_client` — move another client to a specific channel.

  Channel admin:
  - `create_channel` — create a (optionally temporary) channel with topic / description / password.
  - `set_channel_description` — update an existing channel's description.
  - `delete_channel` — delete a channel (`force=true` to evict clients first).

  Voice listening (Whisper STT):
  - `activate_listener` — start transcribing voice from a specific client.
  - `deactivate_listener` — stop transcribing voice from that client.
  - `set_language` — override the STT language per client (ISO 639-1 code or `"auto"`).
  - `set_timeout` / `get_timeout` — silence-detection timeout in milliseconds (500-10000).

  Voice / TTS parameters:
  - `set_volume` / `get_volume` — TTS playback volume (0-200, 100 = normal, 200 = 2× gain).
  - `set_voice` / `get_voice` — default TTS voice (one of `alloy`, `ash`, `ballad`, `coral`, `echo`, `fable`, `nova`, `onyx`, `sage`, `shimmer`, `verse`).
  - `set_speed` / `get_speed` — TTS speech speed (0.25-4.0, default 1.15).

  History:
  - `get_history` — recent conversation entries (chat + transcriptions) tracked by ts-bot. Optional `count` (default 20, max 50).

## Requirements

- KinBot **≥ 0.39.0** (uses `IncomingMessage.metadata` for structured channel context).
- A running **ts-bot** instance with its WebSocket exposed locally (default
  `ws://127.0.0.1:8080/ws`, no auth — it is meant for localhost only).

## Installation

The plugin lives at `plugins/teamspeak/` inside the KinBot repo. Restart
KinBot or click **Reload Plugins** in the UI to pick it up.

## Configuration

Open **Settings → Plugins → TeamSpeak**:

| Field | Default | Notes |
|---|---|---|
| `wsUrl` | `ws://127.0.0.1:8080/ws` | URL of the ts-bot WebSocket. |
| `defaultVoice` | _(empty)_ | TTS voice id (e.g. `ff_siwis`). Empty = ts-bot server default. |
| `ttsMaxChars` | `300` | Replies longer than this are spoken as a short notice; the full text still goes to chat. `0` disables the soft limit. |
| `enableTtsOnPublic` | `true` | Toggle TTS in public channels. Chat copy is always sent regardless. |
| `ttsTooLongNotice` | `J'ai répondu en chat, c'était trop long pour le vocal.` | Sentence spoken when the reply is too long. |
| `reconnectMaxBackoffMs` | `30000` | Upper bound for exponential reconnect backoff. |

## Usage

1. Make sure ts-bot is running and reachable.
2. In KinBot, create a channel with platform `teamspeak`. Any non-empty value
   for `wsUrl` in the per-channel config will override the plugin-level
   `wsUrl`; otherwise the plugin default applies.
3. Send a chat message in the TS channel where the bot lives — the assigned
   Kin will receive it as an incoming message with full structured context
   (modality, presence, channel, sender) in the `<channel-context>` block.

## Channel context exposed to the LLM

Each incoming message carries a `metadata` object that KinBot serializes into
the `<channel-context>` prompt block:

```jsonc
{
  "modality": "text" | "voice",
  "chatType": "public_channel" | "private",
  "channel": { "id": 5, "name": "Gaming" } | null,
  "sender":  { "uid": "<base64>", "name": "Alice", "session_id": 3 },
  "present": [{ "id": 7, "name": "Bob" }, ...] | null,
  "bot":     { "channel_id": 5, "channel_name": "Gaming" }
}
```

Voice messages additionally include `transcription = { confidence, language, duration_ms }`.

## Channel transfers and identity

The adapter declares `identitySwitchMode: 'native'` and implements
`onIdentityChange`. When a KinBot user invokes the core `transfer_channel`
tool to re-bind the TeamSpeak channel to a different Kin, KinBot calls the
adapter with the new Kin's slug, display name, and avatar URL. The adapter
issues a `set_nickname` command to ts-bot with the new display name
(truncated to 30 chars to stay within typical TS3 server limits), so the
bot's nickname on the TeamSpeak server immediately reflects the bound Kin.

Avatar switching is not supported: TS3 client avatars live in the server's
file-transfer subsystem and ts-bot does not currently expose an upload
endpoint for them. The provided `avatarUrl` is logged at debug level and
skipped. The nickname-only flip is enough for users in the channel to see
which Kin is now talking; outbound chat copies do NOT receive a
`[Kin Name] ` prefix (the native switch handles that side).

## Known limitations / POC scope

- **No automatic contact creation.** When the plugin sees a new sender it just
  logs `new sender detected: <uid>` (the plugin runtime does not yet have
  access to the per-Kin contact tools). Integration with `find_contact_by_identifier`
  is planned for v2.
- **Wake-word / mention filtering is delegated to the LLM.** The plugin
  forwards every chat message it receives. ts-bot's wake-word system handles
  the voice side; chat filtering will be refined later.
- **No native message IDs.** TeamSpeak chat has no per-message identifier, so
  the plugin synthesizes UUIDs for `platformMessageId`.
- The `sender_uid` from ts-bot may arrive as a byte array (observed) rather
  than the documented base64 string. The plugin normalizes both to a stable
  base64 identifier.
- Plugin and ts-bot run on the same host; the WS endpoint is unauthenticated.
  Don't expose it to the public network.

## Internals

- `wsClient.ts` — singleton WebSocket client (one per `wsUrl`) with:
  - Exponential reconnect (jittered, capped by `reconnectMaxBackoffMs`).
  - `command_id`-correlated request/response with 10 s timeout.
  - Smart handling of the two-phase responses ts-bot emits for `get_status`,
    `move_channel`, and `send_message` (placeholder ack → final response).
  - Broadcast event fan-out (multiple consumers can subscribe to event types).
- `index.ts` — plugin entry; wires the channel adapter, the tools, and a
  local cache of channels/clients/own_client_id maintained from
  `client_connected/disconnected/moved` plus periodic `get_status` refreshes.

## Roadmap

- [ ] Auto-create / update KinBot contacts from `sender_uid` + `sender_name`.
- [ ] Smarter chat filtering (wake-word / mention detection on chat side).
- [ ] Forward `connection_status` events as KinBot system notifications.
- [ ] Optionally relay `client_connected` / `client_disconnected` to the Kin
      as system messages for greetings.
- [ ] Live integration tests against a running ts-bot.

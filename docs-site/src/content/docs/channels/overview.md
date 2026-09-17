---
title: Channels Overview
description: Connect your Agents to external messaging platforms like Telegram, Discord, Slack, WhatsApp, Signal, and Matrix.
---

Channels let your Agents communicate with users on external messaging platforms. Each Agent can connect to multiple channels across different platforms, receiving messages, processing them through the AI pipeline, and responding directly on the platform.

## Supported Platforms

| Platform | Transport | Max Message | Attachments |
|----------|-----------|-------------|-------------|
| **Telegram** | Webhook / Polling | 4,096 chars | ✅ Images, files, audio, video |
| **Discord** | Gateway (WebSocket) | 2,000 chars | ✅ Images, files |
| **Slack** | Events API (webhook) | 4,000 chars | ✅ Images, files |
| **WhatsApp** | Cloud API (webhook) | 4,096 chars | ✅ Images, files |
| **WhatsApp (QR)** | Web multi-device (Baileys socket) | 4,096 chars | ✅ Images, files (outbound) |
| **Signal** | signal-cli REST API | 2,000 chars | ✅ Images, files |
| **Matrix** | Long-poll sync | 4,096 chars | ✅ Images, files |

## How Channels Work

1. **Create a channel** in the Hivekeep UI, selecting a platform and providing credentials (bot token, API key, etc.)
2. **Credentials are encrypted** in Hivekeep's vault, never stored in plain text
3. **The adapter starts** and connects to the platform (webhook, gateway, or polling)
4. **Incoming messages** are routed to the Agent's conversation queue, processed by the AI, and replies are sent back through the adapter
5. **Long messages** are automatically split at paragraph/line/sentence boundaries to respect platform limits

## Architecture

Each platform has a **channel adapter** that implements a common interface:

```
ChannelAdapter
├── start(channelId, config, onMessage)    → Connect to platform
├── startWithPairing?(channelId, config, handlers) → Connect + stream QR/connection
│                                              events (interactive pairing, optional)
├── stop(channelId)                         → Disconnect
├── sendMessage(channelId, config, params)  → Send outbound message
├── validateConfig(config)                  → Test credentials before saving
├── getBotInfo(config)                      → Get bot name/username for display
└── sendTypingIndicator?(channelId, config, chatId) → Show typing (optional)
```

### Interactive (QR) pairing

Some platforms have no static token to paste: they pair by scanning a QR code. An adapter advertises this with `pairing: 'qr'` and implements `startWithPairing`, which opens the connection and streams QR + lifecycle events to the host. Hivekeep encodes the QR and pushes it to the UI over the `channel:pairing` SSE event; once you scan it, the channel turns active and the session is persisted so it reconnects on restart. **WhatsApp (QR)** is the built-in example (see [WhatsApp](/docs/channels/whatsapp/)).

Adapters handle platform-specific details: webhook verification, gateway heartbeats, API authentication, file uploads, and message formatting. The rest of Hivekeep treats all channels identically.

## File Attachments

Hivekeep handles file attachments intelligently when received from channels:

- **Images** are passed as native image parts to the LLM for vision-capable models
- **Text-based files** (`.md`, `.txt`, `.json`, `.csv`, etc.) are read and inlined directly into the LLM context so the Agent can access their content
- **PDFs** are passed as native file parts for providers with document support
- **Other binary files** include the stored path so the Agent can use `read_file` to access them

## Channel Tools

Agents have built-in tools for interacting with their channels:

- **`list_channels`**: List all connected channels with status and message counts
- **`list_channel_conversations`**: Discover known users and chat IDs for proactive messaging
- **`send_channel_message`**: Send a message (with optional attachments) to any connected platform
- **`attach_file`**: Attach a file to the current response for channel delivery

These tools are available to main agents only.

## Configuration Limits

| Setting | Default | Description |
|---------|---------|-------------|
| `CHANNELS_MAX_PER_KIN` | 5 | Maximum channel connections per Agent |
| `CHANNEL_MAX_PENDING_BUFFERED` | 10 | Messages buffered per pending contact (replayed as one turn on approval; most recent kept) |

## User Mapping & Contacts

A channel message is only delivered to the Agent once the sender is a known, authorized **contact** (linked to their platform identity). A known contact enables:

- Consistent user identification across conversations
- The Agent remembering who someone is across sessions
- Proactive messaging to known users via `send_channel_message`

### Contact approval

By default, each channel **requires approval** for new senders (the secure default). When an unknown sender writes in:

1. They are placed in a pending queue and notified that their access is awaiting approval (sent once, not on every message).
2. Their messages are **buffered** (up to `CHANNEL_MAX_PENDING_BUFFERED`, default 10, keeping the most recent) instead of being dropped.
3. An admin approves them from **Settings → Channels** (expand the channel). Approval creates or links a contact and authorizes their platform id.
4. On approval, the buffered backlog is replayed to the Agent as a **single turn**, so nothing the sender said while waiting is lost and the Agent responds with full context.

### Disabling approval (auto-create contacts)

Each channel has a per-channel **"Require approval for new contacts"** toggle. Turning it off (which sets `autoCreateContacts`) makes unknown senders flow straight through: a brand-new contact is auto-created and their message is delivered immediately, with no approval step.

:::caution
Disabling approval means **anyone** who messages the channel can trigger the Agent (and incur its costs) without review. Only disable it on channels you intend to be public.
:::

**Anti-impersonation safeguards.** Auto-create always creates a **new, distinct contact** identified only by the platform handle. It never links an unknown sender to an existing contact based on a claimed identity, and no Agent tool can reassign a platform-id authorization. If you let the Agent tidy up auto-created duplicates, it must verify identity before merging, and never treat a claimed name (for example "I'm the boss") as proof, otherwise an impostor could inherit a privileged contact's entries.

## Causal Chain Delivery

When a channel message triggers multi-turn processing (inter-Agent delegation, task results, wakeups), Hivekeep automatically delivers the final response back to the originating platform without requiring the Agent to call `send_channel_message()`.

This works through a **`channelOriginId`** that propagates through the entire causal chain: queue items, messages, tasks, inter-Agent requests/replies, and sub-Agent spawns. When processing completes, Hivekeep checks if the turn belongs to a channel-originated chain and delivers the response automatically.

**Auto-delivered message types:** `agent_reply`, `task_result`, `wakeup`

The Agent also receives a prompt block informing it that delivery is automatic and advising it to adapt formatting for the target platform.

| Setting | Default | Description |
|---------|---------|-------------|
| `CHANNEL_ORIGIN_TTL` | 86400000 (24h) | How long after the inbound message a reply is still auto-delivered back to the channel |

The origin of a channel turn is stored in the database, so a reply still reaches
the right conversation after a long sub-Agent run or a server restart. If no
destination can be resolved (the origin is older than `CHANNEL_ORIGIN_TTL`, or
the channel was deleted), the reply is not sent and the Agent gets a system note
in its conversation telling it to resend explicitly with `send_to_contact` or
`send_channel_message`.

## Plugin Channels

Plugins can register custom channel adapters, extending Hivekeep to support additional platforms beyond the built-in six. Plugin adapters use the same `ChannelAdapter` interface and are managed through the adapter registry.

## Security

- All credentials (bot tokens, API keys, signing secrets) are stored in Hivekeep's **encrypted vault**
- Channels support **allowlists** to restrict which chat IDs, channel IDs, or room IDs the bot responds to
- Webhook endpoints verify request signatures where the platform supports it (Slack, Telegram)

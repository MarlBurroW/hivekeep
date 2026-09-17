---
title: "Connected accounts: email, calendar, contacts"
description: Connect Email, Calendar, and Contacts so Agents can read your mail, manage your calendar, and look up contacts.
---

Connected accounts let your Agents work with the services you already use: **Email**, **Calendar**, and **Contacts** (external address books). You connect an account once in Settings, decide which Agents may use it, and the matching tools become available. Credentials stay encrypted on your server and are never placed in a prompt.

A single connected identity can serve several capabilities at once. Connecting one Google, Microsoft, or iCloud account can cover mail, calendar, and contacts together, because they share the same underlying connection.

## What Agents can do

Once an account is connected and an Agent is allowed to use it, the Agent gets a set of native tools.

**Email** (the `email` toolbox)

- `list_email_accounts`: see which email accounts this Agent may use.
- `list_emails`: list a folder (default INBOX) as compact summaries.
- `read_email`: read one full message by id (headers, plain-text body, attachment metadata).
- `search_emails`: search with structured filters (from, to, subject, text, unread, has_attachment, after, before) or a provider-native `raw` query (for example Gmail operators).
- `send_email`: send a new message or reply in-thread, with optional CC, BCC, HTML body, and workspace-file attachments. Set `watch_reply` to be woken up on the first reply (see below).
- `download_email_attachment`: save an attachment into the Agent workspace.

**Calendar** (the `calendar` toolbox)

- `list_calendar_accounts`, `list_calendars`: discover accounts and the calendars inside them.
- `list_events`: list events in a time range (defaults to "from now"); supports a free-text filter.
- `get_event`: read one event.
- `create_event`, `update_event`, `delete_event`: write access. `update_event` only changes the fields you set. Times are ISO 8601; all-day events use date-only start/end.

**Contacts / address books** (the `address-book` toolbox)

- `list_address_books`, `list_address_book_contacts`: discover accounts and page through a book.
- `get_address_book_contact`: read one full contact card by id.
- `search_address_book`: find people by name, organization, email, or phone fragment.

Contacts are **read-only**. The address-book tools never write to or copy your external contacts into Hivekeep; they fetch on demand. A common pattern is to look up a phone number with `search_address_book`, then hand it to `send_channel_message` to send an SMS through a messaging channel.

The address books here are deliberately separate from Hivekeep's own internal contacts (the `create_contact` / `get_contact` family), which is the Agents' own writable address book. See [Native Tools](/docs/agents/tools/) for that distinction.

## Supported providers

| Provider | Email | Calendar | Contacts | Auth |
|---|---|---|---|---|
| Google (`gmail`) | Gmail API | Google Calendar API | Google People API | OAuth |
| Microsoft / Outlook (`microsoft`) | Graph `/messages` | Graph `/me/events` | Graph `/me/contacts` | OAuth |
| iCloud (`icloud`) | IMAP/SMTP (preset) | CalDAV | CardDAV | Apple ID + app-specific password |
| Generic IMAP (`imap`) | IMAP/SMTP | optional CalDAV | optional CardDAV | host/port/password |
| Generic CalDAV (`caldav`) | no | generic CalDAV by URL | no | password |
| Generic CardDAV (`carddav`) | no | no | generic CardDAV by URL | password |

Email is a pluggable provider family, so a plugin can add another provider (for example Proton) without a core change. The same is true for calendar and contacts. See [Plugins](/docs/plugins/overview/) and [Providers](/docs/providers/supported/).

> Scope note for CalDAV: create and update write the event summary, start, end, description, and location. Sending attendee invitations over CalDAV is out of scope; use Google or Microsoft for invites.

## Connecting an account

All of this lives under **Settings, Connected Accounts**. (Email-only management also has its own **Email accounts** section.) There are two flows, depending on the provider.

### OAuth providers (Google, Microsoft)

OAuth needs a one-time **operator setup** per provider type: you register an OAuth app with the provider and tell Hivekeep its client id and secret.

1. In the provider's developer console, create an OAuth app and add the redirect URI exactly as Hivekeep shows it. The redirect URI is `<your-public-origin>/api/email-accounts/oauth/callback`. The UI displays the exact value to register, so copy it from there rather than guessing.
   - Google: Google Cloud Console, with Gmail / Calendar / People scopes as needed.
   - Microsoft: Azure App registrations (for example Mail.Read, Mail.Send, Calendars.ReadWrite, Contacts.Read, User.Read) on the `common` tenant.
2. Paste the client id and client secret into the provider's card in Settings. The client id is stored in app settings; the secret is stored in the encrypted [vault](/docs/features/vault/).
3. Click **Connect**, optionally toggle "Also access calendar" / "Also read contacts" to request those scopes in the same consent, then complete the provider's consent screen. You are redirected back and the account appears.

When you select multiple capabilities, Hivekeep requests the **union** of the email, calendar, and contacts scopes in one consent and writes a single account that serves all of them. Internally only a long-lived refresh token is stored (encrypted); short-lived access tokens are fetched on demand and never persisted.

> Reverse-proxy note: the redirect URI must match what you registered exactly. Behind a TLS-terminating proxy, set `PUBLIC_URL` to your canonical public origin so Hivekeep builds the correct redirect URI. Google only allows plain `http` on `localhost`/loopback; a LAN IP needs `https`. See [Configuration](/docs/getting-started/configuration/).

### Credential providers (iCloud, generic IMAP / CalDAV / CardDAV)

These need no app registration. You fill in a form and Hivekeep validates the credentials with a live connection **before** storing them encrypted.

- iCloud: generate an app-specific password at appleid.apple.com (Sign-In and Security, App-Specific Passwords), then connect with your Apple ID email and that password. The same password can serve mail, calendar, and contacts in one account.
- Generic IMAP: enter the email address, IMAP host/port, SMTP host/port, username, and password. TLS is inferred from the port (993 implicit TLS, 587/143 STARTTLS; SMTP 465 implicit TLS, 587/25 STARTTLS). You can add an optional CalDAV and CardDAV URL on the same account.

For these multi-capability connects, every requested capability is validated (for example iCloud runs a live IMAP connect and a CardDAV connect with the same password) before a single account row is written.

## Per-account controls

When you connect an account you also control who can use it and, for email, how sends behave.

- **Allowed Agents**: by default an account is available to any Agent that has the matching toolbox enabled. You can restrict it to a specific list of Agents. Every tool call resolves the account and enforces this allow-list against the calling Agent.
- **Send mode** (email only): `direct` sends immediately. `approval` queues the message instead of sending it. The queued send raises a notification, and you approve it (it sends for real) or reject it (it is dropped) under Settings. Approval mode is a good safety net while you build trust in an Agent that sends mail.

### Default account and slugs

Each account has a stable `slug` used by tools. When a tool omits the `account` argument, Hivekeep resolves it: explicit slug, then the configured default account, then the first valid account. With more than one account, an Agent typically calls `list_email_accounts` (or the calendar / address-book equivalent) first and passes the right slug. The default email account is set in app settings.

## Privacy and security

- Credentials are encrypted at rest. OAuth accounts store only a refresh token; access tokens are fetched fresh and never written to disk.
- Secrets are never injected into prompts. A tool resolves the account, gets a fresh token, and hands the provider only what it needs.
- Hivekeep runs as a single process on your own server; your mail, calendar, and contacts are read on demand and not synced into a separate store.
- The allow-list and email approval mode let you scope exactly which Agents touch which account and whether they can send without you.

## A quick example

An Agent asked to "reply to the latest unread email from Marie and confirm Friday":

1. `search_emails` with `from: "Marie"` and `unread: true` to find the message.
2. `read_email` to read the full body and pull the thread id.
3. `send_email` with `reply_to_message_id` set, so the reply stays in the same thread.

If that account is in approval mode, step 3 queues the reply and you approve it before it actually goes out.

## Waiting for a reply

When an Agent sends an email and needs to act on the answer, it can set `watch_reply` on `send_email`. That creates a **one-shot email trigger** for the first reply: it starts a new turn for the Agent, then deletes itself. Any reply counts, even one from a different person than the original recipient (a colleague in copy, an alias, a forwarded thread). A plain "wait for an email from `<recipient>`" condition would miss those.

How the reply is recognized depends on the provider:

- **Gmail and Microsoft** thread messages server-side, so the trigger matches on the thread id of the sent message.
- **IMAP and iCloud** have no thread id, so the trigger matches on the `In-Reply-To` header: a reply references the sent message's `Message-ID`. (If your SMTP server rewrites the `Message-ID` on send, the match can miss; most do not.)

`watch_reply_prompt` sets the instruction the Agent receives when the reply arrives; omit it for a sensible default. The trigger shows up in the account's trigger list like any other (tagged one-shot) and can be edited or removed there. Once the reply arrives it disappears from the list, so watches never pile up against the 20-triggers-per-account limit; a watch whose reply never comes is collected after 30 days. If the account is in approval mode, the trigger is created once you approve and the email is actually sent.

If a reply matches both the watch and one of your standing triggers on the same Agent, the Agent is woken only once (the watch wins, since its prompt is the more specific one). The standing trigger records the match in its log as skipped.

This is built on the same per-account email triggers you can create by hand, which match new mail against a condition tree (sender, subject, body, labels, attachments, thread, in-reply-to) and dispatch to an Agent. `watch_reply` is just the common "follow up on my own email" case wired into the send.

## Related

- [Native Tools](/docs/agents/tools/) for the full tool surface and the internal contacts CRM.
- [Toolboxes](/docs/features/toolboxes/) to control which tools an Agent has.
- [Vault and Secrets](/docs/features/vault/) for how OAuth secrets are stored.
- [Configuration](/docs/getting-started/configuration/) for `PUBLIC_URL` and proxy setup.

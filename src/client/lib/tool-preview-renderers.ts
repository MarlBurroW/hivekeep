/**
 * Built-in tool preview renderers.
 * Each function returns a short string shown inline when a tool call is collapsed,
 * or null to show no preview.
 */
import { registerPreviewRenderer } from '@/client/lib/tool-registry'

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + '…' : s
}

function getArg(args: Record<string, unknown> | null | undefined, key: string): unknown {
  return args?.[key]
}

function getStringArg(args: Record<string, unknown> | null | undefined, key: string): string | undefined {
  const value = getArg(args, key)
  return typeof value === 'string' ? value : undefined
}

function getPathArg(args: Record<string, unknown> | null | undefined): string | null {
  return getStringArg(args, 'path') || null
}

// --- Shell / system ---

registerPreviewRenderer('run_shell', ({ args }) => {
  const cmd = getStringArg(args, 'command')
  return cmd ? truncate(cmd, 60) : null
})

registerPreviewRenderer('execute_sql', ({ args }) => {
  const sql = getStringArg(args, 'sql')
  return sql ? truncate(sql, 50) : null
})

// --- File operations ---

registerPreviewRenderer('read_file', ({ args }) => {
  return getPathArg(args)
})

registerPreviewRenderer('write_file', ({ args }) => {
  return getPathArg(args)
})

registerPreviewRenderer('edit_file', ({ args }) => {
  return getPathArg(args)
})

registerPreviewRenderer('multi_edit', ({ args }) => {
  const path = getPathArg(args)
  const edits = getArg(args, 'edits')
  const count = Array.isArray(edits) ? edits.length : undefined
  return path ? `${path}${count ? ` (${count} edits)` : ''}` : null
})

registerPreviewRenderer('list_directory', ({ args }) => {
  return getPathArg(args) || '.'
})

registerPreviewRenderer('grep', ({ args }) => {
  const pattern = getStringArg(args, 'pattern')
  const glob = getStringArg(args, 'glob')
  return pattern ? `"${truncate(pattern, 30)}"${glob ? ` in ${glob}` : ''}` : null
})

// --- Reasoning / planning ---

registerPreviewRenderer('think', ({ args }) => {
  return (args.thought as string) ? truncate(args.thought as string, 60) : null
})

registerPreviewRenderer('task_todos', ({ args }) => {
  const todos = args.todos
  if (!Array.isArray(todos)) return null
  const total = todos.length
  const completed = todos.filter(
    (todo): todo is { status: string } =>
      typeof todo === 'object' && todo !== null && (todo as { status?: unknown }).status === 'completed',
  ).length
  return `${completed}/${total}`
})

// --- Web ---

registerPreviewRenderer('web_search', ({ args }) => {
  return (args.query as string) ? `"${truncate(args.query as string, 50)}"` : null
})

registerPreviewRenderer('browse_url', ({ args }) => {
  const url = args.url as string
  if (!url) return null
  try {
    const parsed = new URL(url)
    return parsed.hostname + parsed.pathname
  } catch {
    return truncate(url, 50)
  }
})

registerPreviewRenderer('http_request', ({ args }) => {
  const method = args.method as string | undefined
  const url = args.url as string | undefined
  if (!url) return null
  try {
    const parsed = new URL(url)
    const short = parsed.hostname + parsed.pathname
    return method ? `${method} ${short}` : short
  } catch {
    return method ? `${method} ${truncate(url, 45)}` : truncate(url, 50)
  }
})

// --- Memory ---

registerPreviewRenderer('memorize', ({ args }) => {
  return (args.content as string) ? truncate(args.content as string, 50) : null
})

registerPreviewRenderer('recall', ({ args }) => {
  return (args.query as string) ? `"${truncate(args.query as string, 40)}"` : null
})

// --- Contacts ---

registerPreviewRenderer('search_contacts', ({ args }) => {
  return (args.query as string) ? `"${truncate(args.query as string, 40)}"` : null
})

// --- Image ---

registerPreviewRenderer('generate_image', ({ args }) => {
  return (args.prompt as string) ? truncate(args.prompt as string, 50) : null
})

// --- Tasks ---

registerPreviewRenderer('spawn_self', ({ args }) => {
  return (args.title as string) || null
})

registerPreviewRenderer('spawn_agent', ({ args }) => {
  return (args.title as string) || null
})

// --- Screenshot ---

registerPreviewRenderer('screenshot_url', ({ args }) => {
  const url = args.url as string
  if (!url) return null
  try {
    const parsed = new URL(url)
    return parsed.hostname + parsed.pathname
  } catch {
    return truncate(url, 50)
  }
})

// --- Browser sessions (stateful) ---

registerPreviewRenderer('browser_open_session', ({ args }) => {
  const url = args.start_url as string | undefined
  if (!url) return 'open session'
  try {
    const parsed = new URL(url)
    return `open → ${parsed.hostname}${parsed.pathname}`
  } catch {
    return `open → ${truncate(url, 50)}`
  }
})

registerPreviewRenderer('browser_close_session', () => 'close session')

registerPreviewRenderer('browser_navigate', ({ args }) => {
  const url = args.url as string
  if (!url) return null
  try {
    const parsed = new URL(url)
    return `→ ${parsed.hostname}${parsed.pathname}`
  } catch {
    return truncate(url, 50)
  }
})

registerPreviewRenderer('browser_click', ({ args }) => {
  return args.ref ? `click ${args.ref}` : null
})

registerPreviewRenderer('browser_type', ({ args }) => {
  const ref = args.ref as string | undefined
  const text = args.text as string | undefined
  if (!ref) return null
  return `type ${ref}${text ? ` "${truncate(text, 30)}"` : ''}${args.submit ? ' ⏎' : ''}`
})

registerPreviewRenderer('browser_select', ({ args }) => {
  return args.ref ? `select ${args.ref} = ${truncate(String(args.value ?? ''), 25)}` : null
})

registerPreviewRenderer('browser_press_key', ({ args }) => {
  return args.key ? `press ${args.key}${args.ref ? ` on ${args.ref}` : ''}` : null
})

registerPreviewRenderer('browser_scroll', ({ args }) => {
  const dir = args.direction as string | undefined
  return dir ? `scroll ${dir}${args.amount_px ? ` ${args.amount_px}px` : ''}` : null
})

registerPreviewRenderer('browser_wait_for', ({ args }) => {
  return args.condition ? truncate(String(args.condition), 50) : null
})

registerPreviewRenderer('browser_screenshot', ({ args }) => {
  return args.full_page ? 'full page' : 'viewport'
})

registerPreviewRenderer('browser_set_cookies', ({ args }) => {
  const cookies = args.cookies
  const count = Array.isArray(cookies) ? cookies.length : (typeof cookies === 'string' ? cookies.split(';').length : null)
  return count ? `${count} cookie${count > 1 ? 's' : ''}` : null
})

registerPreviewRenderer('browser_get_cookies', ({ args }) => {
  const urls = args.urls
  return Array.isArray(urls) && urls.length > 0 ? `${urls.length} url${urls.length > 1 ? 's' : ''}` : 'all cookies'
})

registerPreviewRenderer('browser_clear_cookies', () => 'clear all')

registerPreviewRenderer('browser_request_human', ({ args }) => {
  return args.reason ? truncate(String(args.reason), 60) : null
})

registerPreviewRenderer('browser_save_state', ({ args }) => {
  return args.name ? `save "${args.name}"` : null
})

registerPreviewRenderer('browser_list_states', () => 'list saved')

registerPreviewRenderer('browser_delete_state', ({ args }) => {
  return args.name ? `delete "${args.name}"` : null
})

// --- Notify ---

registerPreviewRenderer('notify', ({ args }) => {
  return (args.title as string) ? truncate(args.title as string, 50) : null
})

// --- Send message ---

registerPreviewRenderer('send_message', ({ args }) => {
  const slug = args.slug as string | undefined
  return slug || null
})

// --- Store file ---

registerPreviewRenderer('store_file', ({ args }) => {
  return (args.name as string) || null
})

// --- History ---

registerPreviewRenderer('search_history', ({ args }) => {
  return (args.query as string) ? `"${truncate(args.query as string, 40)}"` : null
})

registerPreviewRenderer('browse_history', ({ args }) => {
  const start = args.startDate as string | undefined
  const end = args.endDate as string | undefined
  return start && end ? `${start} → ${end}` : null
})

// --- Links ---

registerPreviewRenderer('extract_links', ({ args }) => {
  const url = args.url as string
  if (!url) return null
  try {
    const parsed = new URL(url)
    return parsed.hostname + parsed.pathname
  } catch {
    return truncate(url, 50)
  }
})

// --- Webhooks ---

registerPreviewRenderer('create_webhook', ({ args }) => {
  return (args.name as string) ? truncate(args.name as string, 50) : null
})

// --- Contacts ---

registerPreviewRenderer('create_contact', ({ args }) => {
  const name = args.name as string | undefined
  const type = args.type as string | undefined
  return name ? `${name}${type ? ` (${type})` : ''}` : null
})

// --- Crons ---

registerPreviewRenderer('create_cron', ({ args }) => {
  const name = args.name as string | undefined
  const schedule = args.schedule as string | undefined
  return name ? `${truncate(name, 35)}${schedule ? ` — ${schedule}` : ''}` : null
})

// --- Wakeups ---

registerPreviewRenderer('wake_me_in', ({ args }) => {
  const seconds = args.seconds as number | undefined
  if (!seconds) return null
  if (seconds >= 3600) return `${Math.round(seconds / 3600)}h`
  if (seconds >= 60) return `${Math.round(seconds / 60)}m`
  return `${seconds}s`
})

// --- Mini apps ---

registerPreviewRenderer('write_mini_app_file', ({ args }) => {
  return getPathArg(args)
})

registerPreviewRenderer('create_mini_app', ({ args }) => {
  const name = args.name as string | undefined
  const slug = args.slug as string | undefined
  return name ? `${truncate(name, 40)}${slug ? ` (${slug})` : ''}` : null
})

// --- Plugins ---

registerPreviewRenderer('install_plugin', ({ args }) => {
  const name = args.name as string | undefined
  const source = args.source as string | undefined
  return name ? `${source ? `${source}: ` : ''}${truncate(name, 45)}` : null
})

// --- Channels ---

registerPreviewRenderer('send_channel_message', ({ args }) => {
  const message = args.message as string | undefined
  return message ? truncate(message, 50) : null
})

// --- Vault ---

registerPreviewRenderer('create_secret', ({ args }) => {
  return (args.key as string) || null
})

// --- Vault entries ---

registerPreviewRenderer('create_vault_entry', ({ args }) => {
  const key = args.key as string | undefined
  const entryType = args.entry_type as string | undefined
  return key ? `${truncate(key, 40)}${entryType ? ` (${entryType})` : ''}` : null
})

// --- Contact notes ---

registerPreviewRenderer('set_contact_note', ({ args }) => {
  const scope = args.scope as string | undefined
  const content = args.content as string | undefined
  return content ? `${scope ? `${scope}: ` : ''}${truncate(content, 45)}` : null
})

// --- Custom tools ---

// Authoring/admin tools all carry a `slug` identifying the target tool.
for (const name of [
  'create_custom_tool',
  'write_custom_tool_file',
  'run_custom_tool_setup',
  'test_custom_tool',
  'update_custom_tool',
  'delete_custom_tool',
]) {
  registerPreviewRenderer(name, ({ args }) => {
    return (args.slug as string) ? truncate(args.slug as string, 50) : null
  })
}

// --- Plugin config ---

registerPreviewRenderer('configure_plugin', ({ args }) => {
  return (args.name as string) ? truncate(args.name as string, 50) : null
})

// --- Plugin details ---

registerPreviewRenderer('get_plugin_details', ({ args }) => {
  return (args.name as string) ? truncate(args.name as string, 50) : null
})

// --- Mini app rollback ---

registerPreviewRenderer('rollback_mini_app', ({ args }) => {
  const appId = args.app_id as string | undefined
  const version = args.version as number | undefined
  return appId ? `${truncate(appId, 40)}${version != null ? ` → v${version}` : ''}` : null
})

// --- Human prompt ---

registerPreviewRenderer('prompt_human', ({ args }) => {
  return (args.question as string) ? truncate(args.question as string, 50) : null
})

// --- Invitations ---

registerPreviewRenderer('create_invitation', ({ args }) => {
  const label = args.label as string | undefined
  return label ? `for ${truncate(label, 50)}` : null
})

// --- Webhook updates ---

registerPreviewRenderer('update_webhook', ({ args }) => {
  const name = args.name as string | undefined
  const id = args.webhook_id as string | undefined
  return name ? truncate(name, 50) : id ? truncate(id, 50) : null
})

// --- Agent creation ---

registerPreviewRenderer('create_agent', ({ args }) => {
  return (args.name as string) ? truncate(args.name as string, 50) : null
})

// --- Contact updates ---

registerPreviewRenderer('update_contact', ({ args }) => {
  const name = args.name as string | undefined
  const id = args.contact_id as string | undefined
  return name ? truncate(name, 50) : id ? truncate(id, 50) : null
})

// --- Secret search ---

registerPreviewRenderer('search_secrets', ({ args }) => {
  return (args.query as string) ? truncate(args.query as string, 50) : null
})

// --- Recurring wakeups ---

registerPreviewRenderer('wake_me_every', ({ args }) => {
  const interval = args.interval_seconds as number | undefined
  if (!interval) return null
  const label = interval >= 3600 ? `${Math.round(interval / 3600)}h` : interval >= 60 ? `${Math.round(interval / 60)}m` : `${interval}s`
  const reason = args.reason as string | undefined
  return reason ? `every ${label} — ${truncate(reason, 35)}` : `every ${label}`
})

// --- Cron updates ---

registerPreviewRenderer('update_cron', ({ args }) => {
  const name = args.name as string | undefined
  const id = args.cron_id as string | undefined
  return name ? truncate(name, 50) : id ? truncate(id, 50) : null
})

// --- MCP servers ---

registerPreviewRenderer('add_mcp_server', ({ args }) => {
  const name = args.name as string | undefined
  const command = args.command as string | undefined
  return name ? `${truncate(name, 35)}${command ? ` (${truncate(command, 15)})` : ''}` : null
})

// --- Contact lookup ---

registerPreviewRenderer('find_contact_by_identifier', ({ args }) => {
  const label = args.label as string | undefined
  const value = args.value as string | undefined
  return label && value ? `${label}: ${truncate(value, 45)}` : null
})

// --- Vault retrieval ---

registerPreviewRenderer('get_vault_entry', ({ args }) => {
  return (args.key as string) ? truncate(args.key as string, 50) : null
})

// --- Cron trigger ---

registerPreviewRenderer('trigger_cron', ({ args }) => {
  return (args.cron_id as string) ? truncate(args.cron_id as string, 50) : null
})

// --- Plugin uninstall ---

registerPreviewRenderer('uninstall_plugin', ({ args }) => {
  return (args.name as string) ? truncate(args.name as string, 50) : null
})

// --- Mini app file read ---

registerPreviewRenderer('read_mini_app_file', ({ args }) => {
  return getPathArg(args)
})

// --- Secret retrieval ---

registerPreviewRenderer('get_secret', ({ args }) => {
  return (args.key as string) ? truncate(args.key as string, 50) : null
})

// --- Stored file search ---

registerPreviewRenderer('search_stored_files', ({ args }) => {
  return (args.query as string) ? `"${truncate(args.query as string, 40)}"` : null
})

// --- Cancel wakeup ---

registerPreviewRenderer('cancel_wakeup', ({ args }) => {
  return (args.wakeup_id as string) ? truncate(args.wakeup_id as string, 50) : null
})

// --- Stored file retrieval ---

registerPreviewRenderer('get_stored_file', ({ args }) => {
  const name = args.name as string | undefined
  const id = args.id as string | undefined
  return name ? truncate(name, 50) : id ? truncate(id, 50) : null
})

// --- Secret deletion ---

registerPreviewRenderer('delete_secret', ({ args }) => {
  return (args.key as string) ? truncate(args.key as string, 50) : null
})

// --- Mini app updates ---

registerPreviewRenderer('update_mini_app', ({ args }) => {
  const name = args.name as string | undefined
  const appId = args.app_id as string | undefined
  return name ? truncate(name, 50) : appId ? truncate(appId, 50) : null
})

// --- Cron journal ---

registerPreviewRenderer('get_cron_journal', ({ args }) => {
  return (args.cron_id as string) ? truncate(args.cron_id as string, 50) : null
})

// --- Mini app snapshots ---

registerPreviewRenderer('create_mini_app_snapshot', ({ args }) => {
  const appId = args.app_id as string | undefined
  const label = args.label as string | undefined
  return appId ? `${truncate(appId, 35)}${label ? ` — ${truncate(label, 15)}` : ''}` : null
})

// --- Contact retrieval ---

registerPreviewRenderer('get_contact', ({ args }) => {
  return (args.contact_id as string) ? truncate(args.contact_id as string, 50) : null
})

// --- Plugin enable/disable ---

registerPreviewRenderer('enable_plugin', ({ args }) => {
  return (args.name as string) ? truncate(args.name as string, 50) : null
})

registerPreviewRenderer('disable_plugin', ({ args }) => {
  return (args.name as string) ? truncate(args.name as string, 50) : null
})

// --- Task details ---

registerPreviewRenderer('get_task_detail', ({ args }) => {
  return (args.task_id as string) ? truncate(args.task_id as string, 50) : null
})

// --- Contact deletion ---

registerPreviewRenderer('delete_contact', ({ args }) => {
  return (args.contact_id as string) ? truncate(args.contact_id as string, 50) : null
})

// --- Memory deletion ---

registerPreviewRenderer('forget', ({ args }) => {
  return (args.memory_id as string) ? truncate(args.memory_id as string, 50) : null
})

// --- User retrieval ---

registerPreviewRenderer('get_user', ({ args }) => {
  return (args.identifier as string) ? truncate(args.identifier as string, 50) : null
})

// --- Secret update ---

registerPreviewRenderer('update_secret', ({ args }) => {
  return (args.key as string) ? truncate(args.key as string, 50) : null
})

// --- Cron deletion ---

registerPreviewRenderer('delete_cron', ({ args }) => {
  return (args.cron_id as string) ? truncate(args.cron_id as string, 50) : null
})

// --- Mini app deletion ---

registerPreviewRenderer('delete_mini_app', ({ args }) => {
  return (args.app_id as string) ? truncate(args.app_id as string, 50) : null
})

// --- Memory update ---

registerPreviewRenderer('update_memory', ({ args }) => {
  const memoryId = args.memory_id as string | undefined
  const content = args.content as string | undefined
  return content ? truncate(content, 50) : memoryId ? truncate(memoryId, 50) : null
})

// --- Mini app file deletion ---

registerPreviewRenderer('delete_mini_app_file', ({ args }) => {
  return getPathArg(args)
})

// --- Email ---

registerPreviewRenderer('list_emails', ({ args }) => {
  const folder = args.folder as string | undefined
  const query = args.query as string | undefined
  if (query) return `"${truncate(query, 40)}"`
  return folder ? truncate(folder, 40) : 'INBOX'
})

registerPreviewRenderer('search_emails', ({ args }) => {
  const raw = args.raw as string | undefined
  if (raw) return truncate(raw, 50)
  const parts = [args.from, args.to, args.subject, args.text].filter(
    (v): v is string => typeof v === 'string' && v.length > 0,
  )
  return parts.length ? truncate(parts.join(' '), 50) : null
})

registerPreviewRenderer('read_email', ({ args }) => {
  return (args.message_id as string) ? truncate(args.message_id as string, 40) : null
})

registerPreviewRenderer('send_email', ({ args }) => {
  const to = args.to
  const recipients = Array.isArray(to) ? to.filter((v): v is string => typeof v === 'string') : []
  const subject = args.subject as string | undefined
  if (recipients.length) {
    const head = truncate(recipients[0]!, 30)
    const extra = recipients.length > 1 ? ` +${recipients.length - 1}` : ''
    return subject ? `${head}${extra}: ${truncate(subject, 25)}` : `${head}${extra}`
  }
  return subject ? truncate(subject, 50) : null
})

registerPreviewRenderer('download_email_attachment', ({ args }) => {
  return (args.save_as as string) || (args.attachment_id as string) || null
})

// --- Address book ---

registerPreviewRenderer('search_address_book', ({ args }) => {
  return (args.query as string) ? `"${truncate(args.query as string, 40)}"` : null
})

registerPreviewRenderer('get_address_book_contact', ({ args }) => {
  return (args.contact_id as string) ? truncate(args.contact_id as string, 40) : null
})

// --- Calendar ---

registerPreviewRenderer('list_events', ({ args }) => {
  const query = args.query as string | undefined
  if (query) return `"${truncate(query, 40)}"`
  const min = args.time_min as string | undefined
  const max = args.time_max as string | undefined
  if (min && max) return `${truncate(min, 20)} → ${truncate(max, 20)}`
  return min ? `from ${truncate(min, 30)}` : null
})

registerPreviewRenderer('get_event', ({ args }) => {
  return (args.event_id as string) ? truncate(args.event_id as string, 40) : null
})

registerPreviewRenderer('create_event', ({ args }) => {
  const title = args.title as string | undefined
  const start = args.start as string | undefined
  return title ? `${truncate(title, 35)}${start ? ` (${truncate(start, 16)})` : ''}` : null
})

registerPreviewRenderer('update_event', ({ args }) => {
  const title = args.title as string | undefined
  const id = args.event_id as string | undefined
  return title ? truncate(title, 50) : id ? truncate(id, 40) : null
})

registerPreviewRenderer('delete_event', ({ args }) => {
  return (args.event_id as string) ? truncate(args.event_id as string, 40) : null
})

/**
 * Tool result renderer registry.
 * Re-exports from tool-registry (cycle-safe) and registers built-in renderers.
 */
export type {
  ToolResultRendererProps,
  ToolPreviewRendererProps,
  ToolPreviewFn,
} from '@/client/lib/tool-registry'

export {
  registerRenderer,
  getRenderer,
  registerPreviewRenderer,
  getPreviewRenderer,
} from '@/client/lib/tool-registry'

import { registerRenderer } from '@/client/lib/tool-registry'

// Register built-in renderers
import { ShellResultRenderer } from '@/client/components/chat/renderers/ShellResultRenderer'
import { HttpRequestRenderer } from '@/client/components/chat/renderers/HttpRequestRenderer'
import { FileReadRenderer } from '@/client/components/chat/renderers/FileReadRenderer'
import { FileWriteRenderer } from '@/client/components/chat/renderers/FileWriteRenderer'
import { FileEditRenderer } from '@/client/components/chat/renderers/FileEditRenderer'
import { ListDirectoryRenderer } from '@/client/components/chat/renderers/ListDirectoryRenderer'
import { BrowserScreenshotRenderer } from '@/client/components/chat/renderers/BrowserScreenshotRenderer'
import { BrowserPageStateRenderer } from '@/client/components/chat/renderers/BrowserPageStateRenderer'
import { SqlResultRenderer } from '@/client/components/chat/renderers/SqlResultRenderer'
import { WebSearchRenderer } from '@/client/components/chat/renderers/WebSearchRenderer'
import { GeneratedImageRenderer } from '@/client/components/chat/renderers/GeneratedImageRenderer'
import { MemoryResultRenderer } from '@/client/components/chat/renderers/MemoryResultRenderer'
import { BrowseUrlRenderer } from '@/client/components/chat/renderers/BrowseUrlRenderer'
import { ContactResultRenderer } from '@/client/components/chat/renderers/ContactResultRenderer'
import { EmailResultRenderer } from '@/client/components/chat/renderers/EmailResultRenderer'
import { AddressBookResultRenderer } from '@/client/components/chat/renderers/AddressBookResultRenderer'
import { CalendarResultRenderer } from '@/client/components/chat/renderers/CalendarResultRenderer'
import { TaskSpawnRenderer } from '@/client/components/chat/renderers/TaskSpawnRenderer'
import { CronResultRenderer } from '@/client/components/chat/renderers/CronResultRenderer'
import { GrepResultRenderer } from '@/client/components/chat/renderers/GrepResultRenderer'
import { MultiEditRenderer } from '@/client/components/chat/renderers/MultiEditRenderer'
import { ThinkRenderer } from '@/client/components/chat/renderers/ThinkRenderer'
import { TaskTodosRenderer } from '@/client/components/chat/renderers/TaskTodosRenderer'

registerRenderer('run_shell', ShellResultRenderer)
registerRenderer('http_request', HttpRequestRenderer)
registerRenderer('read_file', FileReadRenderer)
registerRenderer('write_file', FileWriteRenderer)
registerRenderer('edit_file', FileEditRenderer)
registerRenderer('multi_edit', MultiEditRenderer)
registerRenderer('list_directory', ListDirectoryRenderer)
registerRenderer('grep', GrepResultRenderer)
registerRenderer('execute_sql', SqlResultRenderer)
registerRenderer('web_search', WebSearchRenderer)
registerRenderer('generate_image', GeneratedImageRenderer)

// Reasoning / planning aids — code-task tools
registerRenderer('think', ThinkRenderer)
registerRenderer('task_todos', TaskTodosRenderer)

// Memory lookups — list-of-hits shaped results
registerRenderer('recall', MemoryResultRenderer)
registerRenderer('browse_url', BrowseUrlRenderer)

// Contacts — single-contact / contact-list shaped results
registerRenderer('get_contact', ContactResultRenderer)
registerRenderer('search_contacts', ContactResultRenderer)
registerRenderer('create_contact', ContactResultRenderer)
registerRenderer('update_contact', ContactResultRenderer)
registerRenderer('find_contact_by_identifier', ContactResultRenderer)

// Email — accounts / message list / full message / send + download confirmations
registerRenderer('list_email_accounts', EmailResultRenderer)
registerRenderer('list_emails', EmailResultRenderer)
registerRenderer('search_emails', EmailResultRenderer)
registerRenderer('read_email', EmailResultRenderer)
registerRenderer('send_email', EmailResultRenderer)
registerRenderer('download_email_attachment', EmailResultRenderer)

// Address book (external contacts) — accounts / contact list / single contact
registerRenderer('list_address_books', AddressBookResultRenderer)
registerRenderer('list_address_book_contacts', AddressBookResultRenderer)
registerRenderer('get_address_book_contact', AddressBookResultRenderer)
registerRenderer('search_address_book', AddressBookResultRenderer)

// Calendar — accounts / calendars / event list / single event / delete confirmation
registerRenderer('list_calendar_accounts', CalendarResultRenderer)
registerRenderer('list_calendars', CalendarResultRenderer)
registerRenderer('list_events', CalendarResultRenderer)
registerRenderer('get_event', CalendarResultRenderer)
registerRenderer('create_event', CalendarResultRenderer)
registerRenderer('update_event', CalendarResultRenderer)
registerRenderer('delete_event', CalendarResultRenderer)

// Tasks — spawn confirmation / task detail card
registerRenderer('spawn_self', TaskSpawnRenderer)
registerRenderer('spawn_agent', TaskSpawnRenderer)
registerRenderer('get_task_detail', TaskSpawnRenderer)

// Crons — single cron / cron list / execution journal
registerRenderer('create_cron', CronResultRenderer)
registerRenderer('update_cron', CronResultRenderer)
registerRenderer('list_crons', CronResultRenderer)
registerRenderer('get_cron_journal', CronResultRenderer)

// Browser tools — screenshot-shaped results (image thumbnail with click-to-zoom)
registerRenderer('screenshot_url', BrowserScreenshotRenderer)
registerRenderer('browser_screenshot', BrowserScreenshotRenderer)
registerRenderer('browser_request_human', BrowserScreenshotRenderer)

// Browser tools — page-state-shaped results (URL + title + refs + snapshot)
registerRenderer('browser_open_session', BrowserPageStateRenderer)
registerRenderer('browser_close_session', BrowserPageStateRenderer)
registerRenderer('browser_navigate', BrowserPageStateRenderer)
registerRenderer('browser_click', BrowserPageStateRenderer)
registerRenderer('browser_type', BrowserPageStateRenderer)
registerRenderer('browser_select', BrowserPageStateRenderer)
registerRenderer('browser_press_key', BrowserPageStateRenderer)
registerRenderer('browser_scroll', BrowserPageStateRenderer)
registerRenderer('browser_wait_for', BrowserPageStateRenderer)

// Register built-in preview renderers (collapsed inline view)
import '@/client/lib/tool-preview-renderers'

/**
 * CalDAV calendar for a generic IMAP account — keyed `imap`, so one IMAP/SMTP
 * connection can also serve calendar when the user supplies a CalDAV server URL.
 * Reads `caldav_url` + the shared username/password from the account config.
 */
import { calDavOps } from '@/server/calendar/providers/caldav-core'
import type {
  CalendarProvider,
  CalendarRef,
  CalendarEvent,
  EventListOptions,
  EventListResult,
  CreateEventParams,
  UpdateEventParams,
} from '@/server/calendar/types'
import type { ProviderConfig, AuthResult } from '@gezy/sdk'

function ops(config: ProviderConfig) {
  const serverUrl = config.caldav_url ?? ''
  if (!serverUrl) throw new Error('CalDAV server URL (caldav_url) is required to use the calendar for this account')
  return calDavOps(
    { serverUrl, username: config.username ?? config.email ?? '', password: config.password ?? '' },
    config.username ?? config.email,
  )
}

export const imapCalendarProvider: CalendarProvider = {
  type: 'imap',
  displayName: 'IMAP / CalDAV',
  reactIcon: 'md/MdEmail',
  brandColor: '#64748b',
  configSchema: [],
  capabilities: { supportsOAuth: false, supportsWrite: true },

  async authenticate(config: ProviderConfig): Promise<AuthResult> {
    if (!config.caldav_url) {
      return { valid: false, error: 'Enter a CalDAV server URL to enable the calendar for this account.' }
    }
    return ops(config).authenticate()
  },
  listCalendars(config: ProviderConfig): Promise<CalendarRef[]> {
    return ops(config).listCalendars()
  },
  listEvents(options: EventListOptions, config: ProviderConfig): Promise<EventListResult> {
    return ops(config).listEvents(options)
  },
  getEvent(calendarId: string, eventId: string, config: ProviderConfig): Promise<CalendarEvent> {
    return ops(config).getEvent(calendarId, eventId)
  },
  createEvent(params: CreateEventParams, config: ProviderConfig): Promise<CalendarEvent> {
    return ops(config).createEvent(params)
  },
  updateEvent(params: UpdateEventParams, config: ProviderConfig): Promise<CalendarEvent> {
    return ops(config).updateEvent(params)
  },
  deleteEvent(calendarId: string, eventId: string, config: ProviderConfig): Promise<void> {
    return ops(config).deleteEvent(calendarId, eventId)
  },
}

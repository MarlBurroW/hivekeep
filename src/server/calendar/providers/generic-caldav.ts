/**
 * Generic CalDAV calendar provider — any CalDAV server (OVH, Fastmail,
 * Nextcloud, …) by URL + username + password. Shares the CalDAV core with iCloud.
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
  return calDavOps(
    { serverUrl: config.server_url ?? '', username: config.username ?? '', password: config.password ?? '' },
    config.username,
  )
}

export const genericCalDavProvider: CalendarProvider = {
  type: 'caldav',
  displayName: 'CalDAV',
  reactIcon: 'md/MdEvent',
  brandColor: '#64748b',
  configSchema: [
    {
      key: 'server_url',
      type: 'url',
      label: 'CalDAV server URL',
      required: true,
      placeholder: 'https://caldav.example.com',
      description: 'The CalDAV endpoint of your provider (e.g. OVH, Fastmail, Nextcloud).',
    },
    { key: 'username', type: 'text', label: 'Username', required: true, placeholder: 'you@example.com' },
    {
      key: 'password',
      type: 'secret',
      label: 'Password',
      required: true,
      placeholder: 'password or app password',
      description: 'Many providers require an app-specific password.',
    },
  ],
  capabilities: { supportsOAuth: false, supportsWrite: true },

  authenticate(config: ProviderConfig): Promise<AuthResult> {
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

/**
 * iCloud calendar provider (CalDAV) — preset Apple endpoint, app-specific
 * password. Keyed `icloud`, the same type as the iCloud email + contacts
 * providers, so one iCloud account serves mail + contacts + calendar.
 */
import { calDavOps } from '@/server/calendar/providers/caldav-core'
import { ICLOUD_CONFIG_SCHEMA } from '@/server/contacts/providers/icloud'
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

const ICLOUD_CALDAV_URL = 'https://caldav.icloud.com'

function ops(config: ProviderConfig) {
  return calDavOps(
    { serverUrl: ICLOUD_CALDAV_URL, username: config.apple_id ?? '', password: config.app_password ?? '' },
    config.apple_id,
  )
}

export const icloudCalendarProvider: CalendarProvider = {
  type: 'icloud',
  displayName: 'iCloud Calendar',
  reactIcon: 'si/SiIcloud',
  brandColor: '#3693F3',
  apiKeyUrl: 'https://appleid.apple.com/account/manage',
  configSchema: ICLOUD_CONFIG_SCHEMA,
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

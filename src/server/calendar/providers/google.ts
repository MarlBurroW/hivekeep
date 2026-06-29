/**
 * Google Calendar provider (Calendar API v3). Same identity (`type: 'gmail'`)
 * as the Gmail email + Google contacts providers — one Google account serves
 * mail + contacts + calendar. Full CRUD; declares the calendar OAuth scope.
 */
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

const CAL = 'https://www.googleapis.com/calendar/v3'

// ─── Pure mapping (exported for tests) ───────────────────────────────────────

interface GoogleTime {
  dateTime?: string
  date?: string
  timeZone?: string
}
interface GoogleEvent {
  id: string
  summary?: string
  description?: string
  location?: string
  start?: GoogleTime
  end?: GoogleTime
  status?: string
  htmlLink?: string
  updated?: string
  attendees?: Array<{ email?: string; displayName?: string; responseStatus?: string }>
  organizer?: { email?: string; displayName?: string }
}

export function googleEventToEvent(e: GoogleEvent, calendarId: string): CalendarEvent {
  const allDay = !!e.start?.date
  return {
    id: e.id,
    calendarId,
    title: e.summary || '(no title)',
    description: e.description,
    location: e.location,
    start: e.start?.dateTime ?? e.start?.date ?? '',
    end: e.end?.dateTime ?? e.end?.date ?? '',
    allDay,
    timeZone: e.start?.timeZone,
    status: e.status,
    url: e.htmlLink,
    updatedAt: e.updated ? Date.parse(e.updated) : undefined,
    organizer: e.organizer?.email ? { email: e.organizer.email, name: e.organizer.displayName } : undefined,
    attendees: (e.attendees ?? [])
      .filter((a) => a.email)
      .map((a) => ({ email: a.email!, name: a.displayName, responseStatus: a.responseStatus })),
  }
}

/** Build a Google start/end time object from an ISO string + all-day flag. */
export function toGoogleTime(value: string, allDay: boolean | undefined, timeZone?: string): GoogleTime {
  if (allDay) return { date: value.slice(0, 10) }
  return { dateTime: value, ...(timeZone ? { timeZone } : {}) }
}

export function buildGoogleEventBody(
  p: { title?: string; description?: string; location?: string; start?: string; end?: string; allDay?: boolean; timeZone?: string; attendees?: Array<{ email: string; name?: string }> },
): Record<string, unknown> {
  const body: Record<string, unknown> = {}
  if (p.title !== undefined) body.summary = p.title
  if (p.description !== undefined) body.description = p.description
  if (p.location !== undefined) body.location = p.location
  if (p.start !== undefined) body.start = toGoogleTime(p.start, p.allDay, p.timeZone)
  if (p.end !== undefined) body.end = toGoogleTime(p.end, p.allDay, p.timeZone)
  if (p.attendees !== undefined) body.attendees = p.attendees.map((a) => ({ email: a.email, displayName: a.name }))
  return body
}

// ─── API plumbing ────────────────────────────────────────────────────────────

async function calFetch(config: ProviderConfig, path: string, init?: RequestInit): Promise<unknown> {
  const token = config.accessToken
  if (!token) throw new Error('Google: missing access token')
  const res = await fetch(path.startsWith('http') ? path : `${CAL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init?.headers ?? {}),
    },
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`Google Calendar ${res.status} on ${path}: ${text.slice(0, 300)}`)
  return text ? JSON.parse(text) : {}
}

const enc = encodeURIComponent

// ─── Provider ────────────────────────────────────────────────────────────────

export const googleCalendarProvider: CalendarProvider = {
  type: 'gmail',
  displayName: 'Google Calendar',
  reactIcon: 'si/SiGooglecalendar',
  brandColor: '#4285F4',
  configSchema: [],
  capabilities: { supportsOAuth: true, supportsWrite: true },
  oauth: {
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: ['openid', 'https://www.googleapis.com/auth/userinfo.email', 'https://www.googleapis.com/auth/calendar'],
    authorizeParams: { access_type: 'offline', prompt: 'select_account consent' },
    userInfoUrl: 'https://www.googleapis.com/oauth2/v2/userinfo',
  },

  async authenticate(config: ProviderConfig): Promise<AuthResult> {
    try {
      await calFetch(config, '/users/me/calendarList?maxResults=1')
      return { valid: true, accountLabel: config.email_address ?? config.account_label }
    } catch (err) {
      return { valid: false, error: err instanceof Error ? err.message : 'Google Calendar auth failed' }
    }
  },

  async listCalendars(config: ProviderConfig): Promise<CalendarRef[]> {
    const res = (await calFetch(config, '/users/me/calendarList')) as {
      items?: Array<{ id: string; summary?: string; primary?: boolean; accessRole?: string; backgroundColor?: string }>
    }
    return (res.items ?? []).map((c) => ({
      id: c.id,
      name: c.summary || c.id,
      primary: c.primary,
      readOnly: c.accessRole === 'reader' || c.accessRole === 'freeBusyReader',
      color: c.backgroundColor,
    }))
  },

  async listEvents(options: EventListOptions, config: ProviderConfig): Promise<EventListResult> {
    if (options.pageToken && options.pageToken.startsWith('http')) {
      const page = (await calFetch(config, options.pageToken)) as { items?: GoogleEvent[]; nextPageToken?: string }
      const calendarId = options.calendarId ?? 'primary'
      return { events: (page.items ?? []).map((e) => googleEventToEvent(e, calendarId)), nextPageToken: page.nextPageToken }
    }
    const calendarId = options.calendarId ?? 'primary'
    const params = new URLSearchParams({
      singleEvents: 'true',
      orderBy: 'startTime',
      maxResults: String(Math.min(Math.max(options.limit ?? 25, 1), 250)),
      timeMin: options.timeMin ?? new Date().toISOString(),
    })
    if (options.timeMax) params.set('timeMax', options.timeMax)
    if (options.query) params.set('q', options.query)
    if (options.pageToken) params.set('pageToken', options.pageToken)
    const page = (await calFetch(config, `/calendars/${enc(calendarId)}/events?${params.toString()}`)) as {
      items?: GoogleEvent[]
      nextPageToken?: string
    }
    return {
      events: (page.items ?? []).map((e) => googleEventToEvent(e, calendarId)),
      nextPageToken: page.nextPageToken,
    }
  },

  async getEvent(calendarId: string, eventId: string, config: ProviderConfig): Promise<CalendarEvent> {
    const e = (await calFetch(config, `/calendars/${enc(calendarId)}/events/${enc(eventId)}`)) as GoogleEvent
    return googleEventToEvent(e, calendarId)
  },

  async createEvent(params: CreateEventParams, config: ProviderConfig): Promise<CalendarEvent> {
    const calendarId = params.calendarId ?? 'primary'
    const e = (await calFetch(config, `/calendars/${enc(calendarId)}/events`, {
      method: 'POST',
      body: JSON.stringify(buildGoogleEventBody(params)),
    })) as GoogleEvent
    return googleEventToEvent(e, calendarId)
  },

  async updateEvent(params: UpdateEventParams, config: ProviderConfig): Promise<CalendarEvent> {
    const e = (await calFetch(config, `/calendars/${enc(params.calendarId)}/events/${enc(params.eventId)}`, {
      method: 'PATCH',
      body: JSON.stringify(buildGoogleEventBody(params)),
    })) as GoogleEvent
    return googleEventToEvent(e, params.calendarId)
  },

  async deleteEvent(calendarId: string, eventId: string, config: ProviderConfig): Promise<void> {
    await calFetch(config, `/calendars/${enc(calendarId)}/events/${enc(eventId)}`, { method: 'DELETE' })
  },
}

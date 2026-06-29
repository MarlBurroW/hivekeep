/**
 * Microsoft 365 / Outlook calendar provider (Microsoft Graph). Same identity
 * (`type: 'microsoft'`) as the Outlook email + contacts providers. Full CRUD.
 * Graph dateTimes carry no offset (paired with a timeZone) — on write we
 * normalize any ISO input to UTC; on read we surface the dateTime + timeZone.
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

const GRAPH = 'https://graph.microsoft.com/v1.0'

// ─── Pure mapping (exported for tests) ───────────────────────────────────────

interface GraphDateTime {
  dateTime?: string
  timeZone?: string
}
interface GraphEvent {
  id: string
  subject?: string
  bodyPreview?: string
  body?: { contentType?: string; content?: string }
  location?: { displayName?: string }
  start?: GraphDateTime
  end?: GraphDateTime
  isAllDay?: boolean
  webLink?: string
  lastModifiedDateTime?: string
  showAs?: string
  organizer?: { emailAddress?: { address?: string; name?: string } }
  attendees?: Array<{ emailAddress?: { address?: string; name?: string }; status?: { response?: string } }>
}

function htmlToText(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/[ \t]{2,}/g, ' ').trim()
}

export function graphEventToEvent(e: GraphEvent, calendarId: string): CalendarEvent {
  const isHtml = e.body?.contentType?.toLowerCase() === 'html'
  const description = e.body?.content ? (isHtml ? htmlToText(e.body.content) : e.body.content) : e.bodyPreview
  return {
    id: e.id,
    calendarId,
    title: e.subject || '(no title)',
    description: description || undefined,
    location: e.location?.displayName || undefined,
    start: e.start?.dateTime ?? '',
    end: e.end?.dateTime ?? '',
    allDay: e.isAllDay,
    timeZone: e.start?.timeZone,
    status: e.showAs,
    url: e.webLink,
    updatedAt: e.lastModifiedDateTime ? Date.parse(e.lastModifiedDateTime) : undefined,
    organizer: e.organizer?.emailAddress?.address
      ? { email: e.organizer.emailAddress.address, name: e.organizer.emailAddress.name }
      : undefined,
    attendees: (e.attendees ?? [])
      .filter((a) => a.emailAddress?.address)
      .map((a) => ({ email: a.emailAddress!.address!, name: a.emailAddress!.name, responseStatus: a.status?.response })),
  }
}

/** Normalize an ISO string to a Graph dateTimeTimeZone (UTC, offset stripped). */
export function toGraphTime(value: string, allDay: boolean | undefined): GraphDateTime {
  if (allDay) return { dateTime: `${value.slice(0, 10)}T00:00:00`, timeZone: 'UTC' }
  const d = new Date(value)
  const iso = Number.isNaN(d.getTime()) ? value : d.toISOString()
  return { dateTime: iso.replace('Z', '').slice(0, 23), timeZone: 'UTC' }
}

export function buildGraphEventBody(p: {
  title?: string
  description?: string
  location?: string
  start?: string
  end?: string
  allDay?: boolean
  attendees?: Array<{ email: string; name?: string }>
}): Record<string, unknown> {
  const body: Record<string, unknown> = {}
  if (p.title !== undefined) body.subject = p.title
  if (p.description !== undefined) body.body = { contentType: 'text', content: p.description }
  if (p.location !== undefined) body.location = { displayName: p.location }
  if (p.allDay !== undefined) body.isAllDay = p.allDay
  if (p.start !== undefined) body.start = toGraphTime(p.start, p.allDay)
  if (p.end !== undefined) body.end = toGraphTime(p.end, p.allDay)
  if (p.attendees !== undefined)
    body.attendees = p.attendees.map((a) => ({ emailAddress: { address: a.email, name: a.name }, type: 'required' }))
  return body
}

// ─── Graph plumbing ──────────────────────────────────────────────────────────

async function graphFetch(config: ProviderConfig, path: string, init?: RequestInit): Promise<unknown> {
  const token = config.accessToken
  if (!token) throw new Error('Microsoft: missing access token')
  const res = await fetch(path.startsWith('http') ? path : `${GRAPH}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init?.headers ?? {}),
    },
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`Microsoft Graph ${res.status} on ${path}: ${text.slice(0, 300)}`)
  return text ? JSON.parse(text) : {}
}

const EVENT_SELECT =
  '$select=id,subject,bodyPreview,body,location,start,end,isAllDay,webLink,lastModifiedDateTime,showAs,organizer,attendees'

// ─── Provider ────────────────────────────────────────────────────────────────

export const microsoftCalendarProvider: CalendarProvider = {
  type: 'microsoft',
  displayName: 'Outlook Calendar',
  reactIcon: 'bi/BiLogoMicrosoft',
  brandColor: '#0078D4',
  configSchema: [],
  capabilities: { supportsOAuth: true, supportsWrite: true },
  oauth: {
    authorizeUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    scopes: ['openid', 'email', 'offline_access', 'https://graph.microsoft.com/Calendars.ReadWrite', 'https://graph.microsoft.com/User.Read'],
    authorizeParams: { prompt: 'select_account' },
    userInfoUrl: 'https://graph.microsoft.com/v1.0/me',
  },

  async authenticate(config: ProviderConfig): Promise<AuthResult> {
    try {
      await graphFetch(config, '/me/calendars?$top=1')
      return { valid: true, accountLabel: config.email_address ?? config.account_label }
    } catch (err) {
      return { valid: false, error: err instanceof Error ? err.message : 'Microsoft Calendar auth failed' }
    }
  },

  async listCalendars(config: ProviderConfig): Promise<CalendarRef[]> {
    const res = (await graphFetch(config, '/me/calendars')) as {
      value?: Array<{ id: string; name?: string; isDefaultCalendar?: boolean; canEdit?: boolean; hexColor?: string }>
    }
    return (res.value ?? []).map((c) => ({
      id: c.id,
      name: c.name || c.id,
      primary: c.isDefaultCalendar,
      readOnly: c.canEdit === false,
      color: c.hexColor && c.hexColor !== 'auto' ? c.hexColor : undefined,
    }))
  },

  async listEvents(options: EventListOptions, config: ProviderConfig): Promise<EventListResult> {
    if (options.pageToken) {
      const page = (await graphFetch(config, options.pageToken)) as { value?: GraphEvent[]; '@odata.nextLink'?: string }
      const calendarId = options.calendarId ?? 'default'
      return { events: (page.value ?? []).map((e) => graphEventToEvent(e, calendarId)), nextPageToken: page['@odata.nextLink'] }
    }
    const start = options.timeMin ?? new Date().toISOString()
    // calendarView requires an end bound — default to a 90-day window.
    const end = options.timeMax ?? new Date(Date.parse(start) + 90 * 86400_000).toISOString()
    const top = Math.min(Math.max(options.limit ?? 25, 1), 100)
    const base = options.calendarId ? `/me/calendars/${options.calendarId}/calendarView` : '/me/calendarView'
    const params = `startDateTime=${encodeURIComponent(start)}&endDateTime=${encodeURIComponent(end)}&$top=${top}&$orderby=${encodeURIComponent('start/dateTime')}&${EVENT_SELECT}`
    const page = (await graphFetch(config, `${base}?${params}`)) as { value?: GraphEvent[]; '@odata.nextLink'?: string }
    const calendarId = options.calendarId ?? 'default'
    let events = (page.value ?? []).map((e) => graphEventToEvent(e, calendarId))
    if (options.query) {
      const q = options.query.toLowerCase()
      events = events.filter((e) => [e.title, e.description, e.location].some((v) => v?.toLowerCase().includes(q)))
    }
    return { events, nextPageToken: page['@odata.nextLink'] }
  },

  async getEvent(calendarId: string, eventId: string, config: ProviderConfig): Promise<CalendarEvent> {
    const e = (await graphFetch(config, `/me/events/${eventId}?${EVENT_SELECT}`)) as GraphEvent
    return graphEventToEvent(e, calendarId)
  },

  async createEvent(params: CreateEventParams, config: ProviderConfig): Promise<CalendarEvent> {
    const path = params.calendarId ? `/me/calendars/${params.calendarId}/events` : '/me/events'
    const e = (await graphFetch(config, path, { method: 'POST', body: JSON.stringify(buildGraphEventBody(params)) })) as GraphEvent
    return graphEventToEvent(e, params.calendarId ?? 'default')
  },

  async updateEvent(params: UpdateEventParams, config: ProviderConfig): Promise<CalendarEvent> {
    const e = (await graphFetch(config, `/me/events/${params.eventId}`, {
      method: 'PATCH',
      body: JSON.stringify(buildGraphEventBody(params)),
    })) as GraphEvent
    return graphEventToEvent(e, params.calendarId)
  },

  async deleteEvent(_calendarId: string, eventId: string, config: ProviderConfig): Promise<void> {
    await graphFetch(config, `/me/events/${eventId}`, { method: 'DELETE' })
  },
}

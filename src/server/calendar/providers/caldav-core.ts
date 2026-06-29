/**
 * Shared CalDAV calendar core — used by the iCloud provider (preset server) and
 * the generic CalDAV provider. iCalendar (VEVENT) parsing + generation via
 * `ical.js`; CalDAV transport via `tsdav`. An event id is its CalDAV href, the
 * calendar id is the collection href.
 *
 * Scope note: create/update write SUMMARY / DTSTART / DTEND / DESCRIPTION /
 * LOCATION. Attendee invitations over CalDAV are out of scope (read-only mapping
 * of existing ATTENDEEs); use Google/Microsoft for invites.
 */
import { createDAVClient } from 'tsdav'
import ICAL from 'ical.js'
import { v4 as uuid } from 'uuid'
import type {
  CalendarRef,
  CalendarEvent,
  EventListOptions,
  EventListResult,
  CreateEventParams,
  UpdateEventParams,
  EventAttendee,
  AuthResult,
} from '@gezy/sdk'

export interface CalDavCreds {
  serverUrl: string
  username: string
  password: string
}

// ─── Pure iCalendar helpers (exported for tests) ─────────────────────────────

function icalTimeToIso(t: ICAL.Time): { value: string; allDay: boolean; timeZone?: string } {
  if (t.isDate) return { value: t.toString().slice(0, 10), allDay: true }
  return { value: t.toJSDate().toISOString(), allDay: false, timeZone: t.zone?.tzid }
}

/** Parse a single VEVENT (from a VCALENDAR string) into the cross-provider shape. */
export function parseVEvent(icalString: string): Omit<CalendarEvent, 'id' | 'calendarId'> | null {
  const comp = new ICAL.Component(ICAL.parse(icalString))
  const vevent = comp.getFirstSubcomponent('vevent')
  if (!vevent) return null
  const event = new ICAL.Event(vevent)
  const start = event.startDate ? icalTimeToIso(event.startDate) : { value: '', allDay: false }
  const end = event.endDate ? icalTimeToIso(event.endDate) : { value: '', allDay: false }
  const attendees: EventAttendee[] = vevent.getAllProperties('attendee').map((p) => {
    const email = String(p.getFirstValue() ?? '').replace(/^mailto:/i, '')
    return { email, name: (p.getParameter('cn') as string) || undefined, responseStatus: (p.getParameter('partstat') as string)?.toLowerCase() }
  })
  const organizerProp = vevent.getFirstProperty('organizer')
  const organizerEmail = organizerProp ? String(organizerProp.getFirstValue() ?? '').replace(/^mailto:/i, '') : ''
  const lastMod = vevent.getFirstPropertyValue('last-modified') as ICAL.Time | null
  return {
    title: event.summary || '(no title)',
    description: event.description || undefined,
    location: event.location || undefined,
    start: start.value,
    end: end.value,
    allDay: start.allDay,
    timeZone: start.timeZone,
    status: (vevent.getFirstPropertyValue('status') as string)?.toLowerCase() || undefined,
    organizer: organizerEmail ? { email: organizerEmail, name: (organizerProp?.getParameter('cn') as string) || undefined } : undefined,
    attendees: attendees.length ? attendees : undefined,
    updatedAt: lastMod ? lastMod.toJSDate().getTime() : undefined,
  }
}

function toIcalTime(value: string, allDay: boolean | undefined): ICAL.Time {
  if (allDay) return ICAL.Time.fromDateString(value.slice(0, 10))
  return ICAL.Time.fromJSDate(new Date(value), true)
}

/** Build a VCALENDAR string for one event. `existing` (an iCal string) is used
 *  on update so unchanged properties / the UID are preserved. */
export function buildVEvent(
  fields: {
    uid: string
    title?: string
    description?: string
    location?: string
    start?: string
    end?: string
    allDay?: boolean
  },
  existing?: string,
): string {
  let vcalendar: ICAL.Component
  let vevent: ICAL.Component
  if (existing) {
    vcalendar = new ICAL.Component(ICAL.parse(existing))
    vevent = vcalendar.getFirstSubcomponent('vevent') ?? new ICAL.Component('vevent')
  } else {
    vcalendar = new ICAL.Component('vcalendar')
    vcalendar.updatePropertyWithValue('version', '2.0')
    vcalendar.updatePropertyWithValue('prodid', '-//Gezy//Calendar//EN')
    vevent = new ICAL.Component('vevent')
    vcalendar.addSubcomponent(vevent)
  }
  const event = new ICAL.Event(vevent)
  if (!event.uid) event.uid = fields.uid
  if (fields.title !== undefined) event.summary = fields.title
  if (fields.description !== undefined) event.description = fields.description
  if (fields.location !== undefined) event.location = fields.location
  if (fields.start !== undefined) event.startDate = toIcalTime(fields.start, fields.allDay)
  if (fields.end !== undefined) event.endDate = toIcalTime(fields.end, fields.allDay)
  vevent.updatePropertyWithValue('dtstamp', ICAL.Time.fromJSDate(new Date(), true))
  vevent.updatePropertyWithValue('last-modified', ICAL.Time.fromJSDate(new Date(), true))
  return vcalendar.toString()
}

// ─── CalDAV transport ────────────────────────────────────────────────────────

type DAVClient = Awaited<ReturnType<typeof createDAVClient>>
interface DAVCal {
  url: string
  displayName?: string | Record<string, unknown>
  components?: string[]
  readOnly?: boolean
}
interface DAVObj {
  url: string
  etag?: string
  data?: unknown
}

function calName(c: DAVCal): string {
  return (typeof c.displayName === 'string' ? c.displayName : undefined) || c.url
}

function isEventCalendar(c: DAVCal): boolean {
  return !c.components || c.components.includes('VEVENT')
}

async function withClient<T>(creds: CalDavCreds, fn: (client: DAVClient) => Promise<T>): Promise<T> {
  const client = await createDAVClient({
    serverUrl: creds.serverUrl,
    credentials: { username: creds.username, password: creds.password },
    authMethod: 'Basic',
    defaultAccountType: 'caldav',
  })
  return fn(client)
}

function objToEvent(obj: DAVObj, calendarUrl: string): CalendarEvent | null {
  if (typeof obj.data !== 'string' || !obj.data.includes('BEGIN:VEVENT')) return null
  const parsed = parseVEvent(obj.data)
  if (!parsed) return null
  return { ...parsed, id: obj.url, calendarId: calendarUrl }
}

/** Build CalDAV calendar operations bound to a set of credentials. */
export function calDavOps(creds: CalDavCreds, label?: string) {
  async function resolveCalendar(client: DAVClient, calendarId?: string): Promise<DAVCal> {
    const cals = ((await client.fetchCalendars()) as DAVCal[]).filter(isEventCalendar)
    if (cals.length === 0) throw new Error('No calendar found')
    if (calendarId) {
      const found = cals.find((c) => c.url === calendarId || calendarId.startsWith(c.url))
      if (found) return found
    }
    return cals[0]!
  }

  return {
    async authenticate(): Promise<AuthResult> {
      try {
        await withClient(creds, async (client) => {
          await client.fetchCalendars()
        })
        return { valid: true, accountLabel: label ?? creds.username }
      } catch (err) {
        return { valid: false, error: err instanceof Error ? err.message : 'CalDAV authentication failed' }
      }
    },

    async listCalendars(): Promise<CalendarRef[]> {
      return withClient(creds, async (client) => {
        const cals = ((await client.fetchCalendars()) as DAVCal[]).filter(isEventCalendar)
        return cals.map((c, i) => ({ id: c.url, name: calName(c), primary: i === 0, readOnly: c.readOnly }))
      })
    },

    async listEvents(options: EventListOptions): Promise<EventListResult> {
      return withClient(creds, async (client) => {
        const calendar = await resolveCalendar(client, options.calendarId)
        const timeRange =
          options.timeMin || options.timeMax
            ? {
                start: options.timeMin ?? new Date().toISOString(),
                end: options.timeMax ?? new Date(Date.now() + 90 * 86400_000).toISOString(),
              }
            : undefined
        const objs = (await client.fetchCalendarObjects({ calendar: calendar as never, timeRange })) as DAVObj[]
        const events = objs
          .map((o) => objToEvent(o, calendar.url))
          .filter((e): e is CalendarEvent => !!e)
          .sort((a, b) => a.start.localeCompare(b.start))
        const limit = Math.min(Math.max(options.limit ?? 50, 1), 500)
        return { events: events.slice(0, limit) }
      })
    },

    async getEvent(calendarId: string, eventId: string): Promise<CalendarEvent> {
      return withClient(creds, async (client) => {
        const calendar = await resolveCalendar(client, calendarId)
        const objs = (await client.fetchCalendarObjects({ calendar: calendar as never, objectUrls: [eventId] })) as DAVObj[]
        const event = objs.map((o) => objToEvent(o, calendar.url)).find(Boolean)
        if (!event) throw new Error(`Event not found: ${eventId}`)
        return event
      })
    },

    async createEvent(params: CreateEventParams): Promise<CalendarEvent> {
      return withClient(creds, async (client) => {
        const calendar = await resolveCalendar(client, params.calendarId)
        const id = uuid()
        const ics = buildVEvent({ uid: id, ...params })
        await client.createCalendarObject({ calendar: calendar as never, iCalString: ics, filename: `${id}.ics` })
        const url = `${calendar.url.replace(/\/$/, '')}/${id}.ics`
        const parsed = parseVEvent(ics)!
        return { ...parsed, id: url, calendarId: calendar.url }
      })
    },

    async updateEvent(params: UpdateEventParams): Promise<CalendarEvent> {
      return withClient(creds, async (client) => {
        const calendar = await resolveCalendar(client, params.calendarId)
        const objs = (await client.fetchCalendarObjects({ calendar: calendar as never, objectUrls: [params.eventId] })) as DAVObj[]
        const obj = objs[0]
        if (!obj || typeof obj.data !== 'string') throw new Error(`Event not found: ${params.eventId}`)
        const ics = buildVEvent({ uid: '', ...params }, obj.data)
        await client.updateCalendarObject({ calendarObject: { url: obj.url, data: ics, etag: obj.etag } as never })
        const parsed = parseVEvent(ics)!
        return { ...parsed, id: obj.url, calendarId: calendar.url }
      })
    },

    async deleteEvent(calendarId: string, eventId: string): Promise<void> {
      return withClient(creds, async (client) => {
        const calendar = await resolveCalendar(client, calendarId)
        const objs = (await client.fetchCalendarObjects({ calendar: calendar as never, objectUrls: [eventId] })) as DAVObj[]
        const obj = objs[0]
        await client.deleteCalendarObject({ calendarObject: { url: eventId, etag: obj?.etag } as never })
      })
    },
  }
}

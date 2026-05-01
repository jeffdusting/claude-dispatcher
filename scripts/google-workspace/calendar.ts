#!/usr/bin/env bun
/**
 * Calendar helper for Alex (acting on jeffdusting@waterroads.com.au).
 *
 * Read+write per the Workspace SA's `https://www.googleapis.com/auth/calendar`
 * scope. Operator-confirmed at session opening — Alex can create, modify,
 * accept, and decline events on Jeff's behalf.
 *
 * Subcommands:
 *   list-calendars                                            — enumerate calendars Alex can see.
 *   list-events [--cal C] [--days N] [--max N] [--query Q]   — list events in a window.
 *   get-event --id ID [--cal C]                              — fetch a single event.
 *   create-event --start S --end E --summary "S" [--description D] [--attendees a@b,c@d] [--cal C] [--location L]
 *   update-event --id ID [...same fields...]                  — patch fields on an event.
 *   delete-event --id ID [--cal C]                           — delete an event.
 *   respond --id ID --response accepted|declined|tentative [--cal C]
 *
 * All output is JSON to stdout. Errors print { ok: false, error: ... } and
 * exit non-zero.
 */

import { ALEX_PRINCIPAL, calendarService, AuthError } from './auth.js'

type Args = Record<string, string | boolean>

function parseArgs(argv: string[]): Args {
  const args: Args = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next === undefined || next.startsWith('--')) {
        args[key] = true
      } else {
        args[key] = next
        i++
      }
    }
  }
  return args
}

function fail(error: string, code = 'CALENDAR_ERROR'): never {
  console.log(JSON.stringify({ ok: false, code, error }))
  process.exit(1)
}

function ok(payload: unknown): void {
  console.log(JSON.stringify({ ok: true, ...(payload as object) }))
}

function calendarId(args: Args): string {
  return (args.cal as string) ?? 'primary'
}

async function listCalendars() {
  const cal = calendarService(ALEX_PRINCIPAL)
  const list = await cal.calendarList.list()
  const items = (list.data.items ?? []).map((c) => ({
    id: c.id,
    summary: c.summary,
    primary: c.primary ?? false,
    timezone: c.timeZone,
    accessRole: c.accessRole,
  }))
  ok({ count: items.length, calendars: items })
}

async function listEvents(args: Args) {
  const cal = calendarService(ALEX_PRINCIPAL)
  const days = Number(args.days ?? 7)
  const maxResults = Number(args.max ?? 50)
  const calId = calendarId(args)
  const timeMin = new Date().toISOString()
  const timeMax = new Date(Date.now() + days * 24 * 3600_000).toISOString()
  const q = (args.query as string) ?? undefined
  const list = await cal.events.list({
    calendarId: calId,
    timeMin,
    timeMax,
    maxResults,
    singleEvents: true,
    orderBy: 'startTime',
    q,
  })
  const events = (list.data.items ?? []).map((e) => ({
    id: e.id,
    summary: e.summary,
    description: e.description,
    location: e.location,
    start: e.start?.dateTime ?? e.start?.date,
    end: e.end?.dateTime ?? e.end?.date,
    attendees: (e.attendees ?? []).map((a) => ({ email: a.email, response: a.responseStatus })),
    status: e.status,
    htmlLink: e.htmlLink,
    organizer: e.organizer?.email,
  }))
  ok({ count: events.length, calendarId: calId, windowDays: days, events })
}

async function getEvent(args: Args) {
  const id = String(args.id ?? '')
  if (!id) fail('--id required', 'BAD_ARGS')
  const cal = calendarService(ALEX_PRINCIPAL)
  const e = await cal.events.get({ calendarId: calendarId(args), eventId: id })
  ok({ event: e.data })
}

interface EventBody {
  summary?: string
  description?: string
  location?: string
  start?: { dateTime?: string; date?: string; timeZone?: string }
  end?: { dateTime?: string; date?: string; timeZone?: string }
  attendees?: { email: string }[]
}

function buildEventBody(args: Args): EventBody {
  const body: EventBody = {}
  if (args.summary) body.summary = String(args.summary)
  if (args.description) body.description = String(args.description)
  if (args.location) body.location = String(args.location)
  if (args.start) body.start = { dateTime: String(args.start) }
  if (args.end) body.end = { dateTime: String(args.end) }
  if (args.attendees) {
    const list = String(args.attendees)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    body.attendees = list.map((email) => ({ email }))
  }
  return body
}

async function createEvent(args: Args) {
  const body = buildEventBody(args)
  if (!body.summary || !body.start || !body.end) {
    fail('--summary, --start and --end required', 'BAD_ARGS')
  }
  const cal = calendarService(ALEX_PRINCIPAL)
  const e = await cal.events.insert({
    calendarId: calendarId(args),
    requestBody: body,
    sendUpdates: 'none',
  })
  ok({
    eventId: e.data.id,
    htmlLink: e.data.htmlLink,
    note: 'created with sendUpdates=none — Alex creates the event but invitations are not sent until operator confirms',
  })
}

async function updateEvent(args: Args) {
  const id = String(args.id ?? '')
  if (!id) fail('--id required', 'BAD_ARGS')
  const cal = calendarService(ALEX_PRINCIPAL)
  const body = buildEventBody(args)
  const e = await cal.events.patch({
    calendarId: calendarId(args),
    eventId: id,
    requestBody: body,
    sendUpdates: 'none',
  })
  ok({ eventId: e.data.id, htmlLink: e.data.htmlLink, updated: Object.keys(body) })
}

async function deleteEvent(args: Args) {
  const id = String(args.id ?? '')
  if (!id) fail('--id required', 'BAD_ARGS')
  const cal = calendarService(ALEX_PRINCIPAL)
  await cal.events.delete({
    calendarId: calendarId(args),
    eventId: id,
    sendUpdates: 'none',
  })
  ok({ eventId: id, deleted: true })
}

async function respond(args: Args) {
  const id = String(args.id ?? '')
  const response = String(args.response ?? '')
  if (!id || !response) fail('--id and --response required', 'BAD_ARGS')
  if (!['accepted', 'declined', 'tentative'].includes(response)) {
    fail(`--response must be accepted|declined|tentative, got '${response}'`, 'BAD_ARGS')
  }
  const cal = calendarService(ALEX_PRINCIPAL)
  const e = await cal.events.get({ calendarId: calendarId(args), eventId: id })
  const updated = (e.data.attendees ?? []).map((a) =>
    a.email === ALEX_PRINCIPAL || a.self ? { ...a, responseStatus: response } : a,
  )
  const r = await cal.events.patch({
    calendarId: calendarId(args),
    eventId: id,
    requestBody: { attendees: updated },
    sendUpdates: 'none',
  })
  ok({ eventId: r.data.id, response, htmlLink: r.data.htmlLink })
}

const COMMANDS: Record<string, (args: Args) => Promise<void>> = {
  'list-calendars': () => listCalendars(),
  'list-events': listEvents,
  'get-event': getEvent,
  'create-event': createEvent,
  'update-event': updateEvent,
  'delete-event': deleteEvent,
  respond,
}

async function main() {
  const argv = process.argv.slice(2)
  const cmd = argv[0]
  if (!cmd || !COMMANDS[cmd]) {
    fail(`unknown subcommand. Available: ${Object.keys(COMMANDS).join(', ')}.`, 'UNKNOWN_COMMAND')
  }
  try {
    await COMMANDS[cmd](parseArgs(argv.slice(1)))
  } catch (e) {
    if (e instanceof AuthError) fail(e.message, e.code)
    const err = e as Error
    fail(err.message ?? String(e), 'API_ERROR')
  }
}

main()

/**
 * The calendar tool (fork feature, 2026-10-28): READ-ONLY access to the
 * learner's calendars through their private iCal links (CALENDAR_ICS_URL —
 * one or more comma-separated https/webcal URLs, stored with the keys in
 * auth.json and reflected into process.env like every other key).
 *
 * The teacher sees only date, time and title per event — no descriptions,
 * locations or attendees. The links themselves never reach the model:
 * calendars are labelled by their own name (X-WR-CALNAME) or "Calendar N".
 * Present in the toolset only while a link is saved (tools.ts).
 */

import ICAL from "ical.js";
import { Type } from "typebox";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { serverExecute } from "../tool-execute.ts";

export const CALENDAR_ENV = "CALENDAR_ICS_URL";
const DEFAULT_DAYS = 7;
const MAX_DAYS = 60;
const CACHE_MS = 5 * 60_000;
/** Runaway guard for pathological recurrence rules. */
const MAX_OCCURRENCES = 5_000;

export interface CalendarEvent {
	title: string;
	start: Date;
	end: Date;
	allDay: boolean;
}

/** The saved links, webcal:// normalized to https://. */
export function calendarUrls(raw = process.env[CALENDAR_ENV]): string[] {
	return (raw ?? "")
		.split(",")
		.map((u) => u.trim())
		.filter(Boolean)
		.map((u) => u.replace(/^webcal:\/\//i, "https://"));
}

export function calendarAvailable(): boolean {
	return calendarUrls().length > 0;
}

/** A calendar file's own display name, when it declares one. */
export function calendarName(icsText: string): string | null {
	const comp = new ICAL.Component(ICAL.parse(icsText));
	const name = comp.getFirstPropertyValue("x-wr-calname");
	return typeof name === "string" && name.trim() ? name.trim() : null;
}

/**
 * Every event occurrence overlapping [from, to): recurring events expanded,
 * per-occurrence overrides (RECURRENCE-ID) applied, EXDATEs and cancelled
 * events dropped. Sorted by start.
 */
export function eventsBetween(icsText: string, from: Date, to: Date): CalendarEvent[] {
	const comp = new ICAL.Component(ICAL.parse(icsText));
	for (const tz of comp.getAllSubcomponents("vtimezone")) ICAL.TimezoneService.register(tz);

	const masters = new Map<string, ICAL.Event>();
	const overrides: ICAL.Component[] = [];
	const singles: ICAL.Event[] = [];
	for (const vevent of comp.getAllSubcomponents("vevent")) {
		if (vevent.hasProperty("recurrence-id")) overrides.push(vevent);
		else {
			const event = new ICAL.Event(vevent);
			if (event.isRecurring()) masters.set(event.uid, event);
			else singles.push(event);
		}
	}
	for (const vevent of overrides) {
		const master = masters.get(String(vevent.getFirstPropertyValue("uid")));
		if (master) master.relateException(vevent);
		else singles.push(new ICAL.Event(vevent));
	}

	const out: CalendarEvent[] = [];
	const cancelled = (c: ICAL.Component) => String(c.getFirstPropertyValue("status") ?? "").toUpperCase() === "CANCELLED";
	const push = (c: ICAL.Component, summary: string, start: ICAL.Time, end: ICAL.Time) => {
		if (cancelled(c)) return;
		const s = start.toJSDate();
		const e = end.toJSDate();
		if (e > from && s < to) out.push({ title: summary || "(untitled)", start: s, end: e, allDay: start.isDate });
	};

	for (const event of singles) push(event.component, event.summary, event.startDate, event.endDate ?? event.startDate);

	const rangeEnd = ICAL.Time.fromJSDate(to, true);
	for (const event of masters.values()) {
		if (cancelled(event.component)) continue;
		const it = event.iterator();
		for (let n = 0, next = it.next(); next && n < MAX_OCCURRENCES; n++, next = it.next()) {
			if (next.compare(rangeEnd) >= 0) break;
			const d = event.getOccurrenceDetails(next);
			push(d.item.component, d.item.summary, d.startDate, d.endDate);
		}
	}
	return out.sort((a, b) => a.start.getTime() - b.start.getTime());
}

const pad = (n: number) => String(n).padStart(2, "0");
const hm = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const dayKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const dayLabel = (d: Date) =>
	d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric" });

/** The agenda the model reads: grouped by local day, times in local time. */
export function formatAgenda(events: CalendarEvent[], from: Date, to: Date): string {
	const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
	const last = new Date(to.getTime() - 1);
	const header = `Calendar ${dayKey(from)} to ${dayKey(last)} (times in ${zone}):`;
	if (events.length === 0) return `${header}\nNo events.`;
	const lines = [header];
	let current = "";
	for (const e of events) {
		// An event that began before the range is listed on the range's first day.
		const shown = e.start < from ? from : e.start;
		const key = dayKey(shown);
		if (key !== current) {
			current = key;
			lines.push("", dayLabel(shown));
		}
		lines.push(e.allDay ? `  all day       ${e.title}` : `  ${hm(e.start)}–${hm(e.end)}   ${e.title}`);
	}
	return lines.join("\n");
}

// ─── fetching (cached per link, process-wide) ─────────────────────────────────

interface CalendarCacheGlobal {
	__lhCalendarCache?: Map<string, { at: number; text: string }>;
}

async function fetchCalendar(url: string): Promise<string> {
	const g = globalThis as CalendarCacheGlobal;
	g.__lhCalendarCache ??= new Map();
	const hit = g.__lhCalendarCache.get(url);
	if (hit && Date.now() - hit.at < CACHE_MS) return hit.text;
	const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
	if (!res.ok) throw new Error(`HTTP ${res.status}`);
	const text = await res.text();
	if (!text.includes("BEGIN:VCALENDAR")) throw new Error("not an iCal file");
	g.__lhCalendarCache.set(url, { at: Date.now(), text });
	return text;
}

/** Local midnight of an ISO date (YYYY-MM-DD), or of today. */
function startOfDay(iso?: string): Date {
	if (iso) {
		const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso.trim());
		if (!m) throw new Error(`from must be a date like 2026-10-28, got "${iso}"`);
		return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
	}
	const now = new Date();
	return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

const calendarInput = Type.Object({
	from: Type.Optional(
		Type.String({ description: "First day to show, as YYYY-MM-DD in the learner's local time (default: today)" }),
	),
	days: Type.Optional(
		Type.Integer({ description: `Number of days to show (default ${DEFAULT_DAYS}, max ${MAX_DAYS})` }),
	),
});

export const calendarTool: AgentTool<typeof calendarInput> = {
	name: "calendar",
	label: "calendar",
	description:
		"Read the learner's calendar (read-only). Returns each event's day, start–end time and title for the " +
		`requested range, grouped by day in the learner's local time. Default range: today plus ${DEFAULT_DAYS - 1} days; max ${MAX_DAYS} days.`,
	parameters: calendarInput,
	execute: serverExecute("calendar", calendarInput, async (input) => {
		const urls = calendarUrls();
		if (urls.length === 0) throw new Error("No calendar is connected");
		const from = startOfDay(input.from);
		const days = Math.min(Math.max(input.days ?? DEFAULT_DAYS, 1), MAX_DAYS);
		const to = new Date(from.getFullYear(), from.getMonth(), from.getDate() + days);

		const sections: string[] = [];
		for (const [i, url] of urls.entries()) {
			let text: string;
			try {
				text = await fetchCalendar(url);
			} catch (e) {
				sections.push(`Calendar ${i + 1}: could not be read (${(e as Error).message})`);
				continue;
			}
			const name = calendarName(text) ?? `Calendar ${i + 1}`;
			const agenda = formatAgenda(eventsBetween(text, from, to), from, to);
			sections.push(urls.length > 1 ? `## ${name}\n${agenda}` : agenda);
		}
		return sections.join("\n\n");
	}),
};

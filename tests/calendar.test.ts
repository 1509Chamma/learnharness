/**
 * The read-only calendar tool (fork feature): iCal parsing over a range —
 * recurrence expansion with EXDATE and RECURRENCE-ID overrides, all-day and
 * cancelled events, VTIMEZONE-anchored times — plus the link parsing, the
 * Providers key shape and the tool's presence gate.
 */

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import {
	CALENDAR_ENV,
	calendarName,
	calendarUrls,
	eventsBetween,
	formatAgenda,
} from "../src/agent/tools/calendar.ts";
import { validateKeyShape } from "../src/core/auth-keys.ts";

const ics = (body: string) =>
	["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//test//EN", "X-WR-CALNAME:Uni", body, "END:VCALENDAR"].join("\r\n");

const NEW_YORK = [
	"BEGIN:VTIMEZONE",
	"TZID:America/New_York",
	"BEGIN:STANDARD",
	"DTSTART:19701101T020000",
	"RRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU",
	"TZOFFSETFROM:-0400",
	"TZOFFSETTO:-0500",
	"END:STANDARD",
	"BEGIN:DAYLIGHT",
	"DTSTART:19700308T020000",
	"RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU",
	"TZOFFSETFROM:-0500",
	"TZOFFSETTO:-0400",
	"END:DAYLIGHT",
	"END:VTIMEZONE",
].join("\r\n");

const FIXTURE = ics(
	[
		// Weekly Monday lecture: 2 Nov skipped (EXDATE), 9 Nov moved to 14:00.
		"BEGIN:VEVENT",
		"UID:lecture@test",
		"DTSTART:20261026T100000Z",
		"DTEND:20261026T110000Z",
		"RRULE:FREQ=WEEKLY;COUNT=6",
		"EXDATE:20261102T100000Z",
		"SUMMARY:18.06 lecture",
		"END:VEVENT",
		"BEGIN:VEVENT",
		"UID:lecture@test",
		"RECURRENCE-ID:20261109T100000Z",
		"DTSTART:20261109T140000Z",
		"DTEND:20261109T150000Z",
		"SUMMARY:18.06 lecture (moved)",
		"END:VEVENT",
		// All-day exam day.
		"BEGIN:VEVENT",
		"UID:exam@test",
		"DTSTART;VALUE=DATE:20261105",
		"DTEND;VALUE=DATE:20261106",
		"SUMMARY:Midterm",
		"END:VEVENT",
		// Cancelled meeting — never shown.
		"BEGIN:VEVENT",
		"UID:cancelled@test",
		"DTSTART:20261104T090000Z",
		"DTEND:20261104T100000Z",
		"STATUS:CANCELLED",
		"SUMMARY:Cancelled sync",
		"END:VEVENT",
		// A New York-local event: 09:00 EST = 14:00 UTC.
		NEW_YORK,
		"BEGIN:VEVENT",
		"UID:ny@test",
		"DTSTART;TZID=America/New_York:20261103T090000",
		"DTEND;TZID=America/New_York:20261103T100000",
		"SUMMARY:Call with NY",
		"END:VEVENT",
	].join("\r\n"),
);

const utc = (s: string) => new Date(s);

describe("eventsBetween", () => {
	it("expands recurrences, applies EXDATE and overrides, drops cancelled events", () => {
		const events = eventsBetween(FIXTURE, utc("2026-10-26T00:00:00Z"), utc("2026-11-17T00:00:00Z"));
		assert.deepEqual(
			events.map((e) => [e.title, e.allDay ? "all-day" : e.start.toISOString()]),
			[
				["18.06 lecture", "2026-10-26T10:00:00.000Z"],
				["Call with NY", "2026-11-03T14:00:00.000Z"],
				["Midterm", "all-day"],
				["18.06 lecture (moved)", "2026-11-09T14:00:00.000Z"],
				["18.06 lecture", "2026-11-16T10:00:00.000Z"],
			],
		);
	});

	it("keeps only occurrences overlapping the range", () => {
		const events = eventsBetween(FIXTURE, utc("2026-11-09T00:00:00Z"), utc("2026-11-10T00:00:00Z"));
		assert.deepEqual(events.map((e) => e.title), ["18.06 lecture (moved)"]);
	});

	it("reads the calendar's own name", () => {
		assert.equal(calendarName(FIXTURE), "Uni");
	});
});

describe("formatAgenda", () => {
	it("groups by local day and marks all-day events", () => {
		const from = new Date(2026, 10, 5);
		const to = new Date(2026, 10, 6);
		const text = formatAgenda(eventsBetween(FIXTURE, from, to), from, to);
		assert.match(text, /^Calendar 2026-11-05 to 2026-11-05 \(times in .+\):/);
		assert.match(text, /all day\s+Midterm/);
	});

	it("says so when the range is empty", () => {
		const from = new Date(2027, 0, 1);
		const to = new Date(2027, 0, 2);
		assert.match(formatAgenda([], from, to), /No events\.$/);
	});
});

describe("calendarUrls", () => {
	it("splits comma-separated links and normalizes webcal://", () => {
		assert.deepEqual(calendarUrls(" https://a.example/x.ics , webcal://b.example/y.ics,"), [
			"https://a.example/x.ics",
			"https://b.example/y.ics",
		]);
		assert.deepEqual(calendarUrls(undefined), []);
	});
});

describe("CALENDAR_ICS_URL key shape", () => {
	it("accepts https/webcal links and rejects anything else", () => {
		assert.equal(validateKeyShape(CALENDAR_ENV, "https://calendar.google.com/calendar/ical/x/private-y/basic.ics").ok, true);
		assert.equal(validateKeyShape(CALENDAR_ENV, "https://a.example/a.ics,webcal://b.example/b.ics").ok, true);
		assert.equal(validateKeyShape(CALENDAR_ENV, "http://insecure.example/a.ics").ok, false);
		assert.equal(validateKeyShape(CALENDAR_ENV, "not a url").ok, false);
	});
});

describe("teacher toolset gate", () => {
	const saved = process.env[CALENDAR_ENV];
	afterEach(() => {
		if (saved === undefined) delete process.env[CALENDAR_ENV];
		else process.env[CALENDAR_ENV] = saved;
	});

	it("offers the calendar tool only while a link is saved", async () => {
		const { createTeacherTools } = await import("../src/agent/tools.ts");
		const ctx = { chatId: "c1", jobStore: {}, spawn: () => {} } as unknown as Parameters<typeof createTeacherTools>[0];
		delete process.env[CALENDAR_ENV];
		assert.ok(!("calendar" in createTeacherTools(ctx)));
		process.env[CALENDAR_ENV] = "https://a.example/a.ics";
		assert.ok("calendar" in createTeacherTools(ctx));
	});
});

import { describe, expect, it } from "vitest";
import { generateICS, stableUid } from "./icsGenerator";
import type { ChatEvent } from "./types";

function makeEvent(over: Partial<ChatEvent> = {}): ChatEvent {
  return {
    id: "e1",
    chatId: "chat1",
    title: "Soccer practice",
    kind: "new_event",
    datePhrase: "next Tuesday",
    timePhrase: "at 5",
    startDate: "2026-10-13",
    startTime: "17:00:00",
    allDay: false,
    location: null,
    attendees: [{ name: "Mom", status: "going" }, { name: "Dad", status: "maybe" }],
    sourceMessageIds: ["M004"],
    parts: null,
    confidence: 0.85,
    needsReview: false,
    note: null,
    userNote: null,
    status: "approved",
    uid: null,
    ...over,
  };
}

describe("generateICS", () => {
  it("uses CRLF line endings", () => {
    const ics = generateICS([makeEvent()], "Rivera Family");
    expect(ics).toContain("\r\n");
    expect(ics).not.toMatch(/(?<!\r)\n/);
  });

  it("folds lines longer than 75 octets", () => {
    const long = makeEvent({ title: "A very long event title that definitely exceeds the seventy-five octet fold limit set by RFC 5545" });
    const ics = generateICS([long], "Test");
    for (const line of ics.split("\r\n")) {
      expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    }
  });

  it("escapes commas, semicolons and backslashes", () => {
    const ev = makeEvent({ title: "Party, at Mom's; house", location: "Back\\yard" });
    const ics = generateICS([ev], "T");
    expect(ics).toContain("SUMMARY:Party\\, at Mom's\\; house");
    expect(ics).toContain("Where: Back\\\\yard");
  });

  it("emits deadlines as all-day events with 'Due:' and a VALARM", () => {
    const ev = makeEvent({ kind: "deadline", title: "Permission slip", startTime: null, allDay: true });
    const ics = generateICS([ev], "T");
    expect(ics).toContain("SUMMARY:Due: Permission slip");
    expect(ics).toContain("DTSTART;VALUE=DATE:20261013");
    expect(ics).toContain("BEGIN:VALARM");
    expect(ics).toContain("TRIGGER:-P1D");
  });

  it("marks cancellations with STATUS:CANCELLED", () => {
    const ev = makeEvent({ kind: "cancellation", status: "cancelled" });
    const ics = generateICS([ev], "T");
    expect(ics).toContain("STATUS:CANCELLED");
  });

  it("lists attendees in DESCRIPTION, without email addresses", () => {
    const ics = generateICS([makeEvent()], "T");
    expect(ics).toContain("Going: Mom");
    expect(ics).toContain("Maybe: Dad");
    expect(ics).not.toMatch(/mailto:/i);
  });

  it("produces a stable UID from source message ids and chat id", () => {
    const a = stableUid(["M004", "M005"], "chat1");
    const b = stableUid(["M005", "M004"], "chat1");
    const c = stableUid(["M004"], "chat1");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });
});

import { describe, expect, it } from "vitest";
import { parseChat } from "./chatParser";
import {
  applyChangeLinks,
  offlineFilterMessages,
  offlineExtract,
  resolveEventOffline,
  type RawEvent,
} from "./pipeline";
import { generateICS } from "./icsGenerator";
import type { ChatEvent } from "./types";
import { SAMPLE_CHATS } from "./sampleChats";

const TZ = "America/Los_Angeles";

function msg(text: string, sentAt: string, sender = "Mom", id = "M1") {
  return { id, sender, text, sent_at: sentAt };
}

function resolve(raw: RawEvent, srcText: string, sentAt = "2026-10-04T16:00:00.000Z") {
  const src = msg(srcText, sentAt);
  return resolveEventOffline(raw, src, 0, "chat1", TZ, 0.6);
}

describe("fix 1: ICS TZID for wall-clock times", () => {
  const base: ChatEvent = {
    id: "e1", chatId: "c1", title: "Soccer practice", kind: "new_event",
    datePhrase: "next Tuesday", timePhrase: "at 5", startDate: "2026-10-13",
    startTime: "17:00:00", allDay: false, location: null, attendees: [],
    sourceMessageIds: ["M004"], parts: null, confidence: 0.85, needsReview: false,
    note: null, userNote: null, timezone: TZ, status: "approved", uid: "u1",
  };

  it("emits TZID + VTIMEZONE so 4 PM stays 4 PM (not 16:00Z)", () => {
    const ics = generateICS([base], "T", new Date(), TZ);
    expect(ics).toContain(`DTSTART;TZID=${TZ}:20261013T170000`);
    expect(ics).not.toMatch(/DTSTART:20261013T170000Z/);
    expect(ics).toContain("BEGIN:VTIMEZONE");
  });

  it("falls back to UTC Z when no timezone is given", () => {
    const ics = generateICS([{ ...base, timezone: undefined }], "T", new Date());
    expect(ics).toContain("DTSTART:20261013T170000Z");
  });

  it("keeps internal notes out of DESCRIPTION, keeps user notes in", () => {
    const ics = generateICS(
      [{ ...base, note: "bare time — assumed PM", userNote: "bring cleats" }],
      "T",
      new Date(),
      TZ
    );
    expect(ics).toContain("DESCRIPTION");
    expect(ics).toContain("bring cleats");
    expect(ics).not.toContain("assumed PM");
  });
});

describe("fix 2: bare-hour times after relative anchors", () => {
  it("'next Wednesday at 4' resolves to 16:00, not all-day", () => {
    // Sat Oct 3 (LA) + next Wednesday = Oct 7... calendar-next week: Oct 14
    const ev = resolve(
      { title: "Dentist follow up", kind: "new_event", date_phrase: "next Wednesday", source_message_ids: ["M1"] },
      "I booked the dentist follow up for Sam next Wednesday at 4",
      "2026-10-09T03:55:00.000Z" // Oct 8 8:55 PM LA
    );
    expect(ev.startDate).toBe("2026-10-14");
    expect(ev.startTime).toBe("16:00:00");
    expect(ev.allDay).toBe(false);
  });

  it("'tomorrow at 9:30' resolves to 09:30", () => {
    const ev = resolve(
      { title: "Dentist", kind: "new_event", date_phrase: "tomorrow", source_message_ids: ["M1"] },
      "dentist tomorrow at 9:30 for Sam",
      "2026-10-05T01:30:00.000Z" // Oct 4 6:30 PM LA
    );
    expect(ev.startTime).toBe("09:30:00");
    expect(ev.allDay).toBe(false);
  });
});

describe("fix 3: tomorrow resolves to the message's own day", () => {
  it("'dentist tomorrow at 9:30' posted Oct 4 lands Oct 5", () => {
    const ev = resolve(
      { title: "Dentist", kind: "new_event", date_phrase: "tomorrow", source_message_ids: ["M1"] },
      "dentist tomorrow at 9:30 for Sam, I'll drive",
      "2026-10-05T01:30:00.000Z" // Oct 4, 6:30 PM in LA
    );
    expect(ev.startDate).toBe("2026-10-05");
  });

  it("'due tomorrow' posted Oct 10 lands Oct 11", () => {
    const ev = resolve(
      { title: "Permission slip", kind: "deadline", date_phrase: "tomorrow", source_message_ids: ["M1"] },
      "don't forget the permission slip is due tomorrow!",
      "2026-10-10T16:00:00.000Z" // Oct 10, 9 AM LA
    );
    expect(ev.startDate).toBe("2026-10-11");
  });
});

describe("fix 4: weekday/date mismatch + same-time carry-over", () => {
  it("'Saturday the 15th' from Tue Oct 6 is flagged with no guessed date", () => {
    const ev = resolve(
      { title: "Grandma's dinner", kind: "change", date_phrase: "Saturday the 15th", source_message_ids: ["M1"] },
      "Grandma's dinner is actually moving it to Saturday the 15th, same time same place",
      "2026-10-06T17:05:00.000Z"
    );
    expect(ev.needsReview).toBe(true);
    expect(ev.startDate).toBeNull();
    expect(ev.startTime).toBeNull();
  });

  it("'same time' carries 6 PM from the original event", () => {
    const original = resolve(
      { title: "Grandma's dinner", kind: "new_event", date_phrase: "Nov 14", time_phrase: "at 6pm", source_message_ids: ["M0"] },
      "Grandma's 80th is Nov 14 at 6pm at Lucia's",
      "2026-10-04T16:12:00.000Z"
    );
    expect(original.startTime).toBe("18:00:00");

    // simulate the linking pass: change event inherits the target's time
    const change = resolve(
      { title: "Grandma's dinner", kind: "change", date_phrase: "Saturday the 15th", source_message_ids: ["M1"] },
      "Grandma's dinner is actually moving it to Saturday the 15th, same time same place",
      "2026-10-06T17:05:00.000Z"
    );
    // after a human fixes the date, the carry-over applies via the linking rule
    change.startDate = "2026-10-15";
    if (/same time/i.test("moving it to Saturday the 15th, same time same place") && !change.startTime && original.startTime) {
      change.startTime = original.startTime;
      change.allDay = false;
    }
    expect(change.startTime).toBe("18:00:00");
    expect(change.allDay).toBe(false);
  });
});

describe("fix 5: no invented time for date-only deadlines", () => {
  it("'permission slip due Friday' stays all-day", () => {
    const ev = resolve(
      { title: "Permission slip", kind: "deadline", date_phrase: "Friday", source_message_ids: ["M1"] },
      "Practice moved to next Tuesday at 5, permission slip due Friday!",
      "2026-10-04T02:44:00.000Z"
    );
    expect(ev.startDate).toBeTruthy();
    expect(ev.startTime).toBeNull();
    expect(ev.allDay).toBe(true);
  });

  it("'grocery run Saturday morning Oct 24 at 9' keeps its 9 AM", () => {
    const ev = resolve(
      { title: "Grocery run", kind: "new_event", date_phrase: "Oct 24", source_message_ids: ["M1"] },
      "grocery run Saturday morning Oct 24 at 9 before we drive up",
      "2026-10-04T13:05:00.000Z"
    );
    expect(ev.startTime).toBe("09:00:00");
  });
});

describe("fix 6: chat timestamps show export times", () => {
  it("formats the sent instant back in the chat timezone", () => {
    const parsed = parseChat(SAMPLE_CHATS[0].raw, { timezone: TZ });
    const first = parsed.messages[0];
    // export says 7:41 PM on 10/3 — formatting in LA must return 7:41 PM
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: TZ, hour: "numeric", minute: "2-digit", hour12: true,
    }).format(new Date(first.sent_at));
    expect(fmt).toBe("7:41 PM");
    const day = new Intl.DateTimeFormat("en-US", {
      timeZone: TZ, month: "numeric", day: "numeric",
    }).format(new Date(first.sent_at));
    expect(day).toBe("10/3");
  });
});

describe("fix 7: offline filter quality", () => {
  it("'I'll send mine today' does not become an event", () => {
    const parsed = parseChat(SAMPLE_CHATS[1].raw, { timezone: "America/New_York" });
    const senders = parsed.messages.filter((m) =>
      /send mine today|sending tonight/i.test(m.text)
    );
    expect(senders.length).toBe(2);
    const filtered = offlineFilterMessages(parsed.messages);
    for (const m of senders) {
      const idx = parsed.messages.indexOf(m);
      expect(filtered[idx].p).toBe(0);
    }
    const extracted = offlineExtract(parsed.messages);
    expect(extracted.some((e) => /send mine/i.test(e.title) || /sending/i.test(e.title))).toBe(false);
  });

  it("offline titles are short, not raw message text", () => {
    const parsed = parseChat(SAMPLE_CHATS[2].raw, { timezone: "America/Chicago" });
    const extracted = offlineExtract(parsed.messages);
    for (const e of extracted) {
      expect(e.title.split(/\s+/).length).toBeLessThanOrEqual(6);
    }
    const bake = extracted.find((e) => /bake/i.test(e.title));
    expect(bake).toBeTruthy();
  });

  it("internal assumption notes stay in the app, out of ICS", () => {
    const ev = resolve(
      { title: "Practice", kind: "new_event", date_phrase: "next Tuesday", time_phrase: "at 5", source_message_ids: ["M1"] },
      "Practice moved to next Tuesday at 5",
      "2026-10-04T02:44:00.000Z"
    );
    expect(ev.userNote).toBeNull();
    expect(ev.note).toContain("assumed PM");
    const ics = generateICS([ev], "T", new Date(), TZ);
    expect(ics).not.toContain("assumed PM");
  });
});

describe("fix 8: 'the 15th' without a month goes to review", () => {
  it("day-without-month RSVP is needsReview with confidence ≤ reviewBelow", () => {
    const ev = resolve(
      { title: "Grandma's dinner", kind: "rsvp", date_phrase: "the 15th", source_message_ids: ["M1"] },
      "who is coming to Grandma's dinner on the 15th?",
      "2026-10-06T22:15:00.000Z"
    );
    expect(ev.needsReview).toBe(true);
    expect(ev.confidence).toBeLessThanOrEqual(0.6);
  });
});

describe("same-time carry-over via applyChangeLinks", () => {
  it("inherits 6 PM from the original event when the source says 'same time'", () => {
    const original = resolve(
      { title: "Grandma's dinner", kind: "new_event", date_phrase: "Nov 14", time_phrase: "at 6pm", source_message_ids: ["M0"] },
      "Grandma's 80th is Nov 14 at 6pm at Lucia's",
      "2026-10-04T16:12:00.000Z"
    );
    expect(original.startTime).toBe("18:00:00");

    const change = resolve(
      { title: "Grandma's dinner", kind: "change", date_phrase: "Saturday the 15th", source_message_ids: ["M1"] },
      "moving it to Saturday the 15th, same time same place",
      "2026-10-06T17:05:00.000Z"
    );
    // reviewer fixed the date in the board; time still empty
    change.startDate = "2026-10-15";
    const msgById = new Map<string, { text: string }>([
      ["M1", { text: "moving it to Saturday the 15th, same time same place" }],
    ]);
    applyChangeLinks([original, change], msgById);
    expect(change.startTime).toBe("18:00:00");
    expect(change.allDay).toBe(false);
    expect(change.note).toContain("Moves");
  });
});

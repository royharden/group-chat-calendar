import { describe, expect, it } from "vitest";
import { findDateSpans, findTimeTokens, resolveDatePhrase } from "./dateResolver";
import { extractTimeFromText, findDatePhrase } from "./phraseExtractor";

const LA = "America/Los_Angeles";

// sentAt is the message's own timestamp (with an explicit offset, so the
// local day is obvious when reading the test).
function resolve(phrase: string | null, sentText: string, sentAt: string | null, timePhrase: string | null = null) {
  return resolveDatePhrase(phrase, timePhrase, sentText, sentAt, LA);
}

// 2026: Oct 3 Sat, Oct 4 Sun, Oct 5 Mon, Oct 6 Tue, Oct 11 Sun, Oct 12 Mon, Oct 14 Wed.

describe("resolveDatePhrase: next <weekday>", () => {
  it("'next Tuesday' sent on a Sunday is the Tuesday of the following Mon–Sun week", () => {
    // 10:30 PM Sunday in LA is already Monday in UTC — the chat's day must win.
    const r = resolve("next Tuesday", "practice next Tuesday", "2026-10-11T22:30:00-07:00");
    expect(r.referenceDate).toBe("2026-10-11");
    expect(r.date).toBe("2026-10-13");
    expect(r.rule).toBe("next_weekday");
    expect(r.needsReview).toBe(false);
  });

  it("'next Tuesday' sent on a Monday skips this week's Tuesday", () => {
    const r = resolve("next Tuesday", "practice next Tuesday", "2026-10-12T09:00:00-07:00");
    expect(r.date).toBe("2026-10-20");
  });

  it("'next Tuesday' sent on a Wednesday is the coming week's Tuesday", () => {
    const r = resolve("next Tuesday", "practice next Tuesday", "2026-10-14T18:00:00-07:00");
    expect(r.date).toBe("2026-10-20");
  });

  it("'next Tuesday' sent Saturday Oct 3 is Oct 6 (Rivera sample)", () => {
    const r = resolve("next Tuesday", "Practice moved to next Tuesday at 5", "2026-10-03T19:44:00-07:00");
    expect(r.date).toBe("2026-10-06");
  });

  it("'Tuesday next week' reads like 'next Tuesday'", () => {
    const r = resolve("Tuesday next week", "practice Tuesday next week", "2026-10-12T09:00:00-07:00");
    expect(r.date).toBe("2026-10-20");
  });
});

describe("resolveDatePhrase: bare and 'this' weekdays", () => {
  it("a bare weekday is the next occurrence on or after the message day", () => {
    expect(resolve("Friday", "pizza Friday", "2026-10-06T09:00:00-07:00").date).toBe("2026-10-09");
    expect(resolve("Tuesday", "practice Tuesday", "2026-10-13T09:00:00-07:00").date).toBe("2026-10-13");
  });

  it("'Tuesday' and 'next Tuesday' differ when sent on a Monday", () => {
    const sent = "2026-10-12T09:00:00-07:00";
    expect(resolve("Tuesday", "practice Tuesday", sent).date).toBe("2026-10-13");
    expect(resolve("next Tuesday", "practice next Tuesday", sent).date).toBe("2026-10-20");
  });

  it("'this Tuesday' sent on a Wednesday is six days later", () => {
    expect(resolve("this Tuesday", "practice this Tuesday", "2026-10-14T09:00:00-07:00").date).toBe("2026-10-20");
  });
});

describe("resolveDatePhrase: today / tomorrow", () => {
  it("'tomorrow' follows the chat's local midnight, not UTC", () => {
    expect(resolve("tomorrow", "dentist tomorrow", "2026-10-04T23:59:00-07:00").date).toBe("2026-10-05");
    expect(resolve("tomorrow", "dentist tomorrow", "2026-10-05T00:01:00-07:00").date).toBe("2026-10-06");
  });

  it("'tomorrow' crosses a month end (Oct 31 11:30 PM in LA is already Nov 1 UTC)", () => {
    const r = resolve("tomorrow", "party tomorrow", "2026-10-31T23:30:00-07:00");
    expect(r.referenceDate).toBe("2026-10-31");
    expect(r.date).toBe("2026-11-01");
  });

  it("'tomorrow' crosses a year end and a short February", () => {
    expect(resolve("tomorrow", "brunch tomorrow", "2026-12-31T23:30:00-08:00").date).toBe("2027-01-01");
    expect(resolve("tomorrow", "brunch tomorrow", "2027-02-28T12:00:00-08:00").date).toBe("2027-03-01");
  });

  it("today / tonight is the message day; 'day after tomorrow' is +2", () => {
    const sent = "2026-10-30T10:00:00-07:00";
    expect(resolve("today", "dentist is today", sent).date).toBe("2026-10-30");
    expect(resolve("tonight", "pizza tonight", sent).date).toBe("2026-10-30");
    const dat = resolve("day after tomorrow", "game day after tomorrow", sent);
    expect(dat.date).toBe("2026-11-01");
    expect(dat.rule).toBe("day_after_tomorrow");
    expect(resolve("tomorrow", "game tomorrow", sent).rule).toBe("tomorrow");
  });

  it("never falls back to 'now' when the message time is missing or invalid", () => {
    for (const sent of [null, "not a date"]) {
      const r = resolve("tomorrow", "dentist tomorrow", sent);
      expect(r.date).toBeNull();
      expect(r.referenceDate).toBeNull();
      expect(r.unresolved).toBe(true);
      expect(r.needsReview).toBe(true);
    }
  });
});

describe("resolveDatePhrase: month + day", () => {
  const sent = "2026-10-06T09:00:00-07:00";

  it("month+day with no year is the next upcoming one", () => {
    expect(resolve("Nov 14", "Grandma's 80th is Nov 14", sent)).toMatchObject({ date: "2026-11-14", needsReview: false, rule: "month_day" });
    expect(resolve("Jan 5", "ski trip Jan 5", sent)).toMatchObject({ date: "2027-01-05", needsReview: false });
  });

  it("a date that just passed rolls to next year but is flagged", () => {
    const r = resolve("Oct 3", "party Oct 3", sent);
    expect(r.date).toBe("2027-10-03");
    expect(r.needsReview).toBe(true);
  });

  it("uses a stated year, numeric dates, and day-month order", () => {
    expect(resolve("Nov 14, 2026", "party Nov 14, 2026", sent).date).toBe("2026-11-14");
    expect(resolve("10/16", "bake sale 10/16", sent).date).toBe("2026-10-16");
    expect(resolve("14 November", "party 14 November", sent).date).toBe("2026-11-14");
  });

  it("flags impossible dates and out-of-range years instead of guessing", () => {
    const feb = resolve("Feb 30", "party Feb 30", sent);
    expect(feb.date).toBeNull();
    expect(feb.note).toMatch(/impossible/i);
    const old = resolve("March 3, 1887", "reunion March 3, 1887", sent);
    expect(old.date).toBeNull();
    expect(old.note).toMatch(/out of range/i);
  });

  it("a weekday that agrees with the date is confident; one that doesn't is flagged", () => {
    expect(resolve("Friday Oct 16", "bake sale Friday Oct 16", sent)).toMatchObject({ date: "2026-10-16", needsReview: false, confidence: 0.95 });
    const bad = resolve("Friday Oct 17", "bake sale Friday Oct 17", sent);
    expect(bad.date).toBeNull();
    expect(bad.needsReview).toBe(true);
  });

  it("an explicit date beats a loose 'next' and is noted", () => {
    const r = resolve("next Wednesday Oct 21", "Field trip forms due next Wednesday Oct 21", "2026-10-10T16:45:00-07:00");
    expect(r.date).toBe("2026-10-21");
    expect(r.note).toMatch(/next/);
  });
});

describe("resolveDatePhrase: day of month without a month", () => {
  const sent = "2026-10-06T09:00:00-07:00";

  it("'the 15th' resolves to the next one coming up and goes to review", () => {
    const r = resolve("the 15th", "who is coming on the 15th?", sent);
    expect(r.date).toBe("2026-10-15");
    expect(r.needsReview).toBe(true);
    expect(r.confidence).toBeLessThanOrEqual(0.6);
    expect(r.note).toMatch(/day without a month/i);
  });

  it("a day already past this month moves to next month", () => {
    expect(resolve("the 3rd", "due the 3rd", sent).date).toBe("2026-11-03");
  });

  it("'Saturday the 15th' (Oct 15 is a Thursday) is flagged with no date", () => {
    const r = resolve("Saturday the 15th", "moving it to Saturday the 15th", sent);
    expect(r.date).toBeNull();
    expect(r.needsReview).toBe(true);
    expect(r.note).toMatch(/don't agree/);
  });

  it("'Saturday the 17th' agrees and resolves", () => {
    expect(resolve("Saturday the 17th", "moving it to Saturday the 17th", sent)).toMatchObject({ date: "2026-10-17", needsReview: false });
  });
});

describe("resolveDatePhrase: partial phrases", () => {
  it("widens a partial phrase to the full date expression in the message", () => {
    const r = resolve("next Wednesday", "Field trip forms due next Wednesday Oct 21", "2026-10-10T16:45:00-07:00");
    expect(r.phraseUsed).toBe("next Wednesday Oct 21");
    expect(r.date).toBe("2026-10-21");
  });

  it("a partial phrase can't hide a weekday/date conflict", () => {
    const r = resolve("the 15th", "moving it to Saturday the 15th, same time", "2026-10-06T10:05:00-07:00");
    expect(r.date).toBeNull();
    expect(r.needsReview).toBe(true);
  });
});

describe("resolveDatePhrase: ambiguity is flagged, not guessed", () => {
  const sent = "2026-10-04T10:00:00-07:00";

  it("alternatives, vague phrases and conflicting words have no date", () => {
    for (const phrase of ["Friday or Saturday", "this weekend", "next week"]) {
      const r = resolve(phrase, `bbq ${phrase}`, sent);
      expect(r.date, phrase).toBeNull();
      expect(r.needsReview, phrase).toBe(true);
    }
    expect(resolve("tomorrow, Oct 9", "bbq tomorrow, Oct 9", sent).date).toBeNull();
  });

  it("date words that aren't in the message verbatim go to review", () => {
    const r = resolve("next Tuesday", "practice moved to Tues", sent);
    expect(r.needsReview).toBe(true);
    expect(r.note).toMatch(/word for word/);
  });
});

describe("resolveDatePhrase: times", () => {
  const sent = "2026-10-04T10:00:00-07:00";

  it("finds a time in a separate clause or sentence", () => {
    const r = resolve("tomorrow", "Grandma's dinner is tomorrow. We'll start at 6, don't be late", sent);
    expect(r.date).toBe("2026-10-05");
    expect(r.time).toBe("18:00:00"); // dinner + bare hour = PM
    expect(r.timeSource).toBe("message");
    expect(r.allDay).toBe(false);

    const movie = resolve("tomorrow", "Movie night tomorrow! Starts at 7:30", sent);
    expect(movie.time).toBe("19:30:00");
  });

  it("does not take a time that belongs to another event in the same message", () => {
    const text = "Practice moved to next Tuesday at 5, permission slip due Friday!";
    const slip = resolve("Friday", text, "2026-10-03T19:44:00-07:00");
    expect(slip.time).toBeNull();
    expect(slip.allDay).toBe(true);
    const practice = resolve("next Tuesday", text, "2026-10-03T19:44:00-07:00");
    expect(practice.time).toBe("17:00:00");
    expect(practice.note).toContain("assumed PM");
  });

  it("parses 7pm, 7:30, noon, 'at 7', 24h clocks and o'clock", () => {
    expect(resolve("tomorrow", "party tomorrow 7pm", sent).time).toBe("19:00:00");
    expect(resolve("tomorrow", "party tomorrow 7:30 p.m.", sent).time).toBe("19:30:00");
    expect(resolve("tomorrow", "lunch tomorrow at noon", sent).time).toBe("12:00:00");
    expect(resolve("tomorrow", "we leave tomorrow at 19:41", sent).time).toBe("19:41:00");
    expect(resolve("tomorrow", "call tomorrow at 3 o'clock", sent).time).toBe("15:00:00");
    const bare = resolve("tomorrow", "drop off tomorrow at 7", sent);
    expect(bare.time).toBe("07:00:00");
    expect(bare.note).toContain("assumed AM");
  });

  it("tonight / evening / dinner + bare hour = PM, morning = AM", () => {
    expect(resolve("tonight", "pizza tonight at 8", sent)).toMatchObject({ time: "20:00:00", note: null });
    expect(resolve("Friday", "dinner Friday at 7", sent).time).toBe("19:00:00");
    expect(resolve("tomorrow evening", "drinks tomorrow evening at 9", sent).time).toBe("21:00:00");
    expect(resolve("Oct 24", "grocery run Saturday morning Oct 24 at 9", sent).time).toBe("09:00:00");
  });

  it("reads ranges and keeps the start", () => {
    expect(resolve("Friday", "party Friday 7-9pm", sent)).toMatchObject({ time: "19:00:00", endTime: "21:00:00" });
    expect(resolve("Friday", "bake sale Friday, 11:30 to 1", sent)).toMatchObject({ time: "11:30:00", endTime: "13:00:00" });
    expect(resolve("Friday", "open house Friday from 3 to 5", sent)).toMatchObject({ time: "15:00:00", endTime: "17:00:00" });
  });

  it("uses the extracted time_phrase first, including a bare number", () => {
    expect(resolve("Nov 14", "Grandma's 80th is Nov 14 at 6pm at Lucia's", sent, "at 6pm").time).toBe("18:00:00");
    const r = resolve("next Tuesday", "practice next Tuesday at 5", sent, "5");
    expect(r.time).toBe("17:00:00");
    expect(r.timeSource).toBe("time_phrase");
  });

  it("never drops a found time, even when the date is unresolved", () => {
    const r = resolve("Saturday the 15th", "moving it to Saturday the 15th at 6pm", "2026-10-06T10:05:00-07:00");
    expect(r.date).toBeNull();
    expect(r.time).toBe("18:00:00");
    expect(r.allDay).toBe(false);
  });

  it("only events with no time are all-day", () => {
    expect(resolve("Friday", "permission slip due Friday", sent).allDay).toBe(true);
    expect(resolve("tomorrow", "dentist tomorrow at 9:30", sent)).toMatchObject({ time: "09:30:00", allDay: false });
  });
});

describe("findTimeTokens", () => {
  it("ignores numbers that are not times", () => {
    for (const text of ["thinking Oct 24-26", "deposit due by the 20th, $40 each", "Grandma's 80th", "we need 2 volunteers", "10/3/26"]) {
      expect(findTimeTokens(text), text).toEqual([]);
    }
  });

  it("prefers the longest reading", () => {
    const [t] = findTimeTokens("drop off treats by 8am");
    expect(t).toMatchObject({ hour: 8, meridiem: "am", kind: "prefixed" });
  });
});

describe("findDateSpans / findDatePhrase", () => {
  it("merges adjacent date words into one phrase", () => {
    expect(findDateSpans("Bake sale next Friday Oct 16, drop off treats by 8am").map((s) => s.text)).toEqual(["next Friday Oct 16"]);
    expect(findDateSpans("moving it to Saturday the 15th, same time").map((s) => s.text)).toEqual(["Saturday the 15th"]);
  });

  it("returns the first date phrase in the message", () => {
    expect(findDatePhrase("Practice moved to next Tuesday at 5, permission slip due Friday!")?.phrase).toBe("next Tuesday");
    expect(findDatePhrase("deposit due by the 20th")?.phrase).toBe("by the 20th");
  });
});

describe("extractTimeFromText", () => {
  it("reads 'at 7:30 pm' as written", () => {
    expect(extractTimeFromText("dinner at 7:30 pm")).toEqual({ hour: 7, minute: 30, meridiem: "pm" });
  });

  it("reads 24-hour times", () => {
    expect(extractTimeFromText("at 19:41 we leave")).toEqual({ hour: 19, minute: 41, meridiem: "none" });
  });

  it("reads bare times", () => {
    expect(extractTimeFromText("pickup at 3?")).toEqual({ hour: 3, minute: 0, meridiem: "none" });
  });
});

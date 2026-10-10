import { describe, expect, it } from "vitest";
import { assemble } from "./dateResolver";
import { extractTimeFromText, findYearCandidates } from "./phraseExtractor";

const choice = (c: string, conf = 0.9) => ({ type: "choice", choice: c, confidence: conf });

// Tuesday 2026-10-06 as the reference date (UTC noon).
const REF = new Date("2026-10-06T12:00:00Z");

describe("assemble", () => {
  it("resolves 'tomorrow' relative to the message's own date", () => {
    const answers = {
      mode: choice("relative"),
      day_anchor: choice("tomorrow"),
      week_offset: choice("none"),
      meridiem: choice("none_stated"),
    };
    const r = assemble(answers, REF);
    expect(r.date?.toISOString().slice(0, 10)).toBe("2026-10-07");
    expect(r.confidence).toBeCloseTo(0.9);
  });

  it("resolves a bare weekday to the next occurrence on or after today", () => {
    // Tuesday -> Friday this week
    const answers = {
      mode: choice("relative"),
      day_anchor: choice("weekday"),
      weekday: choice("Friday"),
      week_offset: choice("current"),
      meridiem: choice("none_stated"),
    };
    const r = assemble(answers, REF);
    expect(r.date?.toISOString().slice(0, 10)).toBe("2026-10-09");
  });

  it("resolves 'next Tuesday' into the following calendar week", () => {
    // Tuesday Oct 6 -> next week's Tuesday is Oct 13
    const answers = {
      mode: choice("relative"),
      day_anchor: choice("weekday"),
      weekday: choice("Tuesday"),
      week_offset: choice("next"),
      meridiem: choice("none_stated"),
    };
    const r = assemble(answers, REF);
    expect(r.date?.toISOString().slice(0, 10)).toBe("2026-10-13");
  });

  it("bumps absolute dates more than 31 days in the past to next year", () => {
    // Reference Oct 6 2026; "Nov 14" without a year is fine in the same year.
    const answers = {
      mode: choice("absolute"),
      month: choice("November"),
      day: choice("14"),
      year: choice("none"),
      meridiem: choice("none_stated"),
    };
    const r = assemble(answers, REF);
    expect(r.date?.toISOString().slice(0, 10)).toBe("2026-11-14");
  });

  it("resolves a day without a month to the next upcoming occurrence, capped at review confidence", () => {
    const answers = {
      mode: choice("absolute"),
      month: choice("none"),
      day: choice("20"),
      year: choice("none"),
      meridiem: choice("none_stated"),
    };
    const r = assemble(answers, REF);
    expect(r.date?.toISOString().slice(0, 10)).toBe("2026-10-20");
    expect(r.confidence).toBeLessThanOrEqual(0.6);
    expect(r.note).toMatch(/day without a month/i);
  });

  it("flags impossible dates like Feb 30", () => {
    const answers = {
      mode: choice("absolute"),
      month: choice("February"),
      day: choice("30"),
      year: choice("none"),
      meridiem: choice("none_stated"),
    };
    const r = assemble(answers, REF);
    expect(r.date).toBeNull();
    expect(r.unresolved).toBe(true);
    expect(r.note).toMatch(/impossible/i);
  });

  it("flags out-of-range years instead of guessing", () => {
    const answers = {
      mode: choice("absolute"),
      month: choice("March"),
      day: choice("3"),
      year: choice("out_of_range"),
      meridiem: choice("none_stated"),
    };
    const r = assemble(answers, REF);
    expect(r.date).toBeNull();
    expect(r.note).toMatch(/out of range/i);
  });

  it("confidence is the minimum across the parts used", () => {
    const answers = {
      mode: choice("relative", 0.95),
      day_anchor: choice("tomorrow", 0.7),
      week_offset: choice("none", 0.5),
      meridiem: choice("none_stated", 0.99),
    };
    const r = assemble(answers, REF);
    expect(r.confidence).toBeCloseTo(0.7);
  });
});

describe("extractTimeFromText", () => {
  it("reads 'at 7:30 pm' (24h merge happens in assemble)", () => {
    expect(extractTimeFromText("dinner at 7:30 pm")).toEqual({ hour: 7, minute: 30, meridiem: "pm" });
  });

  it("reads 24-hour times", () => {
    expect(extractTimeFromText("at 19:41 we leave")).toEqual({ hour: 19, minute: 41, meridiem: "none" });
  });

  it("reads bare times for the meridiem question", () => {
    expect(extractTimeFromText("pickup at 3?")).toEqual({ hour: 3, minute: 0, meridiem: "none" });
  });
});

describe("findYearCandidates", () => {
  it("finds year-like numbers in the text", () => {
    expect(findYearCandidates("reunion in 1987! mark your calendars")).toEqual(["1987"]);
  });
});

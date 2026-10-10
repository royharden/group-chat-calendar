import { WEEKDAYS, MONTHS } from "./constants";
import type { DatePartsAnswers } from "./types";

export interface ResolvedDate {
  date: Date | null; // normalized to UTC noon of the resolved calendar day
  time: { hour: number; minute: number } | null;
  confidence: number; // minimum confidence among the parts actually used
  usedParts: string[];
  unresolved: boolean;
  assumed?: boolean; // code made an assumption (e.g. day without a month)
  note?: string;
}

interface ChoiceAnswer {
  choice: string;
  confidence: number;
  probabilities?: Record<string, number>;
}

function isChoice(a: unknown): a is ChoiceAnswer {
  return (
    typeof a === "object" && a !== null && "choice" in (a as object) &&
    typeof (a as ChoiceAnswer).choice === "string"
  );
}

function getChoice(answers: DatePartsAnswers, q: string): ChoiceAnswer | null {
  const a = answers[q];
  return isChoice(a) ? a : null;
}

export function readMeridiem(answers: DatePartsAnswers): "am" | "pm" | "none_stated" {
  const m = getChoice(answers, "meridiem");
  if (m?.choice === "am" || m?.choice === "pm") return m.choice;
  return "none_stated";
}

export function readTimeOfDay(answers: DatePartsAnswers): { time: { hour: number; minute: number } | null; note?: string } {
  const hour = Number((answers["time_hour"] as { choice: string } | undefined)?.choice);
  const minute = Number((answers["time_minute"] as { choice: string } | undefined)?.choice);
  void hour; void minute;
  return { time: null };
}

export function assemble(
  answers: DatePartsAnswers,
  referenceDate: Date,
  opts: { reviewBelow?: number } = {}
): ResolvedDate {
  void MONTHS; void WEEKDAYS;
  const usedParts: string[] = [];
  const notes: string[] = [];
  let confidence = 1;

  const bump = (q: string, conf: number) => {
    usedParts.push(q);
    confidence = Math.min(confidence, conf);
  };

  const modeA = getChoice(answers, "mode");
  const mode = modeA?.choice === "absolute" ? "absolute" : modeA?.choice === "relative" ? "relative" : "none";
  if (mode !== "none" && modeA) bump("mode", modeA.confidence);

  const refYear = referenceDate.getUTCFullYear();
  const base = new Date(
    Date.UTC(referenceDate.getUTCFullYear(), referenceDate.getUTCMonth(), referenceDate.getUTCDate(), 12)
  );

  if (mode === "absolute") {
    const monthA = getChoice(answers, "month");
    const dayA = getChoice(answers, "day");
    const yearA = getChoice(answers, "year");

    if (!dayA || dayA.choice === "none") {
      return { date: null, time: null, confidence: 0, usedParts, unresolved: true, note: "absolute date incomplete" };
    }
    bump("day", dayA.confidence);
    const day = Number(dayA.choice);
    if (!Number.isInteger(day) || day < 1 || day > 31) {
      return { date: null, time: null, confidence, usedParts, unresolved: true, note: "invalid day" };
    }

    // No month named but a day of month is: resolve to the next upcoming
    // occurrence of that day, capped at review confidence (an assumption).
    if (!monthA || monthA.choice === "none") {
      const probe = new Date(Date.UTC(refYear, base.getUTCMonth(), day, 12));
      if (probe.getUTCDate() !== day) {
        return { date: null, time: null, confidence, usedParts, unresolved: true, note: "impossible date" };
      }
      const candidate = new Date(probe.getTime());
      if (candidate.getTime() < base.getTime()) {
        candidate.setUTCMonth(candidate.getUTCMonth() + 1);
        if (candidate.getUTCDate() !== day) {
          return { date: null, time: null, confidence, usedParts, unresolved: true, note: "impossible date" };
        }
      }
      notes.push("day without a month — assumed the next one coming up");
      return {
        date: candidate,
        time: extractTime(answers, notes),
        confidence: Math.min(confidence, 0.6),
        usedParts,
        unresolved: false,
        assumed: true,
        note: notes.join("; ") || undefined,
      };
    }
    bump("month", monthA.confidence);

    const month = MONTHS.indexOf(monthA.choice);
    if (month < 0) {
      return { date: null, time: null, confidence, usedParts, unresolved: true, note: "invalid month" };
    }

    let year = refYear;
    let yearStated = false;
    if (yearA && yearA.choice !== "none") {
      if (yearA.choice === "out_of_range") {
        bump("year", yearA.confidence);
        return { date: null, time: null, confidence, usedParts, unresolved: true, note: "year out of range" };
      }
      const y = Number(yearA.choice);
      if (!Number.isInteger(y) || y < 1970 || y > 2100) {
        return { date: null, time: null, confidence, usedParts, unresolved: true, note: "year out of range" };
      }
      year = y;
      yearStated = true;
      bump("year", yearA.confidence);
    }

    // Impossible dates (Feb 30, Apr 31) are flagged, never guessed.
    const probe = new Date(Date.UTC(year, month, day, 12));
    if (probe.getUTCDate() !== day || probe.getUTCMonth() !== month) {
      return { date: null, time: null, confidence, usedParts, unresolved: true, note: "impossible date" };
    }

    const candidate = new Date(Date.UTC(year, month, day, 12));
    // No stated year and the date is > 31 days in the past: bump to next year.
    if (!yearStated && referenceDate.getTime() - candidate.getTime() > 31 * 86_400_000) {
      candidate.setUTCFullYear(candidate.getUTCFullYear() + 1);
      if (candidate.getUTCMonth() !== month || candidate.getUTCDate() !== day) {
        return { date: null, time: null, confidence, usedParts, unresolved: true, note: "impossible date" };
      }
    }

    return { date: candidate, time: extractTime(answers, notes), confidence, usedParts, unresolved: false, note: notes.join("; ") || undefined };
  }

  if (mode === "relative") {
    const anchorA = getChoice(answers, "day_anchor");
    const anchor = anchorA?.choice ?? "none";
    if (anchor === "none") {
      return { date: null, time: null, confidence: 0, usedParts, unresolved: true, note: "relative date unresolved" };
    }
    if (anchorA) bump("day_anchor", anchorA.confidence);

    const result = new Date(base.getTime());

    if (anchor === "today" || anchor === "tomorrow" || anchor === "day_after") {
      result.setUTCDate(result.getUTCDate() + (anchor === "today" ? 0 : anchor === "tomorrow" ? 1 : 2));
      return { date: result, time: extractTime(answers, notes), confidence, usedParts, unresolved: false, note: notes.join("; ") || undefined };
    }

    if (anchor === "weekday") {
      const weekdayA = getChoice(answers, "weekday");
      if (!weekdayA || weekdayA.choice === "none" || WEEKDAYS.indexOf(weekdayA.choice) < 0) {
        return { date: null, time: null, confidence, usedParts, unresolved: true, note: "weekday anchor without a weekday" };
      }
      bump("weekday", weekdayA.confidence);
      const targetDow = WEEKDAYS.indexOf(weekdayA.choice);
      const refDow = base.getUTCDay();

      const weekOffsetA = getChoice(answers, "week_offset");
      const weekOffset = weekOffsetA?.choice === "next" ? "next" : weekOffsetA?.choice === "current" ? "current" : "none";
      if (weekOffsetA && weekOffset !== "none") bump("week_offset", weekOffsetA.confidence);

      let delta: number;
      if (weekOffset === "next") {
        // the following calendar week (Monday-based)
        const nextMonday = refDow === 0 ? 1 : 8 - refDow;
        const offsetFromMonday = (targetDow + 6) % 7;
        delta = nextMonday + offsetFromMonday;
      } else {
        // bare weekday: the next occurrence on or after today
        delta = (targetDow - refDow + 7) % 7;
      }

      result.setUTCDate(result.getUTCDate() + delta);
      return { date: result, time: extractTime(answers, notes), confidence, usedParts, unresolved: false, note: notes.join("; ") || undefined };
    }
  }

  return { date: null, time: null, confidence: 0, usedParts, unresolved: true, note: "date could not be resolved" };
}

function extractTime(answers: DatePartsAnswers, notes: string[]): { hour: number; minute: number } | null {
  const hm = (answers["time_of_day"] as { hour?: number; minute?: number } | undefined) ?? undefined;
  void hm;

  // hour/minute come from code-side regex (see extractTimeFromText), delivered here as plain numbers
  const hour = (answers as Record<string, unknown>)["__hour"] as number | undefined;
  const minute = (answers as Record<string, unknown>)["__minute"] as number | undefined;
  if (hour == null) return null;

  const meridiem = readMeridiem(answers);
  let h = hour;
  if (meridiem === "none_stated") {
    if (h >= 1 && h <= 6) {
      h += 12;
      notes.push("bare time — assumed PM");
    }
  } else if (meridiem === "pm" && h < 12) {
    h += 12;
  } else if (meridiem === "am" && h === 12) {
    h = 0;
  }
  return { hour: h, minute: minute ?? 0 };
}

export { MONTHS, WEEKDAYS };

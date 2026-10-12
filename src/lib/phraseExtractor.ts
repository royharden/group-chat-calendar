import { MONTHS, WEEKDAYS } from "./constants";
import { findDateSpans, findTimeTokens } from "./dateResolver";

// Phrase spotting for offline mode. Resolution itself lives in
// dateResolver.ts (resolveDatePhrase), shared by live and offline runs.

export interface ExtractedTime {
  hour: number;
  minute: number;
  meridiem: "am" | "pm" | "none";
}

// The first time expression as written (no 24h conversion): "at 7:30 pm",
// "19:41", "at 3". Day numbers inside dates ("Nov 14") are never times.
export function extractTimeFromText(text: string): ExtractedTime | null {
  const [t] = findTimeTokens(text);
  if (!t) return null;
  return { hour: t.hour, minute: t.minute, meridiem: t.meridiem ?? "none" };
}

export interface ExtractedDatePhrase {
  phrase: string;
  kind: "absolute" | "relative" | "none";
}

const MONTH_DAY_RE =
  /\b(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|jun(e)?|jul(y)?|aug(ust)?|sep(t|tember)?|oct(ober)?|nov(ember)?|dec(ember)?)\.?\s+\d{1,2}(st|nd|rd|th)?\b/i;
const NUMERIC_DATE_RE = /\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b/;

// The first date expression in the message, verbatim (adjacent pieces merged:
// "Saturday the 15th", "next Friday Oct 16").
export function findDatePhrase(text: string): ExtractedDatePhrase | null {
  const [span] = findDateSpans(text);
  if (!span) return null;
  const absolute = MONTH_DAY_RE.test(span.text) || NUMERIC_DATE_RE.test(span.text) || /\d/.test(span.text);
  return { phrase: span.text, kind: absolute ? "absolute" : "relative" };
}

export function findTimePhrase(text: string): string | null {
  const [t] = findTimeTokens(text);
  return t ? t.text.trim() : null;
}

export { MONTH_DAY_RE, NUMERIC_DATE_RE, MONTHS, WEEKDAYS };

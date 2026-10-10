import { MONTHS, WEEKDAYS } from "./constants";

export interface ExtractedTime {
  hour: number;
  minute: number;
  meridiem: "am" | "pm" | "none";
}

// RFC 5545 style time spotting: only "at/by/from 5", "7:30", or "6pm"
// so that day numbers inside date phrases ("Nov 14") are never read as times.
export function extractTimeFromText(text: string): ExtractedTime | null {
  const patterns: RegExp[] = [
    /\b(?:at|by|from)\s+(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)?\b(?![/\d])/gi,
    /\b(\d{1,2}):(\d{2})\s*(a\.?m\.?|p\.?m\.?)?\b/gi,
    /\b(\d{1,2})()\s*(a\.?m\.?|p\.?m\.?)\b/gi,
  ];
  for (const re of patterns) {
    const m = re.exec(text);
    if (!m) continue;
    const hour = Number(m[1]);
    const minute = m[2] ? Number(m[2]) : 0;
    if (hour > 24 || minute > 59) continue;
    const merText = (m[3] ?? "").toLowerCase().replace(/\./g, "");
    const meridiem: ExtractedTime["meridiem"] | "none" =
      merText.startsWith("p") ? "pm" : merText.startsWith("a") ? "am" : "none";
    return { hour, minute, meridiem: meridiem as ExtractedTime["meridiem"] };
  }
  return null;
}

export interface ExtractedDatePhrase {
  phrase: string;
  kind: "absolute" | "relative" | "none";
}

const MONTH_DAY_RE =
  /\b(jan(uary)?|feb(ruary)?|mar(ch)?|apr(il)?|may|jun(e)?|jul(y)?|aug(ust)?|sep(t|tember)?|oct(ober)?|nov(ember)?|dec(ember)?)\.?\s+\d{1,2}(st|nd|rd|th)?\b/i;
const NUMERIC_DATE_RE = /\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b/;
const TODAY_RE = /\b(today|tonight)\b/i;
const TOMORROW_RE = /\btomorrow\b/i;
const DAY_AFTER_RE = /\bday after tomorrow\b/i;
const NEXT_WEEKDAY_RE =
  /\bnext\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i;
const THIS_WEEKDAY_RE =
  /\b(this|on)\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i;
const BARE_WEEKDAY_RE =
  /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i;
const BY_THE_NTH_RE = /\bby (the )?\d{1,2}(st|nd|rd|th)?\b/i;

export function findDatePhrase(text: string): ExtractedDatePhrase | null {
  if (DAY_AFTER_RE.test(text)) return { phrase: text.match(DAY_AFTER_RE)![0], kind: "relative" };
  if (TOMORROW_RE.test(text)) return { phrase: text.match(TOMORROW_RE)![0], kind: "relative" };
  if (TODAY_RE.test(text)) return { phrase: text.match(TODAY_RE)![0], kind: "relative" };
  if (NEXT_WEEKDAY_RE.test(text)) return { phrase: text.match(NEXT_WEEKDAY_RE)![0], kind: "relative" };
  if (MONTH_DAY_RE.test(text)) return { phrase: text.match(MONTH_DAY_RE)![0], kind: "absolute" };
  if (NUMERIC_DATE_RE.test(text)) return { phrase: text.match(NUMERIC_DATE_RE)![0], kind: "absolute" };
  if (THIS_WEEKDAY_RE.test(text)) return { phrase: text.match(THIS_WEEKDAY_RE)![0], kind: "relative" };
  if (BARE_WEEKDAY_RE.test(text)) return { phrase: text.match(BARE_WEEKDAY_RE)![0], kind: "relative" };
  if (BY_THE_NTH_RE.test(text)) return { phrase: text.match(BY_THE_NTH_RE)![0], kind: "absolute" };
  return null;
}

// Year-like numbers found in the text, used to restrict Jev's `year` choices.
export function findYearCandidates(text: string): string[] {
  const candidates = new Set<string>();
  const re = /\b(19|20)\d{2}\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) candidates.add(m[0]);
  return Array.from(candidates);
}

export function findTimePhrase(text: string): string | null {
  const m =
    text.match(/\b(?:at|by|from)\s+\d{1,2}(:\d{2})?\s*(a\.?m\.?|p\.?m\.?)?\b/i) ??
    text.match(/\b\d{1,2}:\d{2}\s*(a\.?m\.?|p\.?m\.?)?\b/i);
  return m ? m[0] : null;
}

// Find the time stated in the same sentence as the date phrase. Prevents a
// time from one event ("practice at 5") leaking into another event parsed
// from the same message ("permission slip due Friday").
export function timeFromSentence(text: string, datePhrase: string): ExtractedTime | null {
  if (!datePhrase) return null;
  const sentences = text.split(/(?<=[.!?])\s+|\n|,\s+/);
  const host = sentences.find((s) => s.toLowerCase().includes(datePhrase.toLowerCase()));
  if (!host) return null;
  return extractTimeFromText(host);
}

// A weekday name inside the date phrase, if any ("Saturday the 15th").
export function weekdayInPhrase(datePhrase: string): string | null {
  if (!datePhrase) return null;
  const m = datePhrase.match(/\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i);
  return m ? WEEKDAYS.find((w) => w.toLowerCase() === m[1].toLowerCase()) ?? null : null;
}

export { MONTH_DAY_RE, NUMERIC_DATE_RE, MONTHS, WEEKDAYS };

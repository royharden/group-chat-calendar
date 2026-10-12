import { WEEKDAYS, MONTHS } from "./constants";
import { zonedCalendarNoon } from "./chatParser";

// Pure date/time resolution in code. The LLM only copies the verbatim
// date_phrase / time_phrase; everything here is deterministic and tested.
//
// Reference day: the message's own sent_at, taken as a calendar day in the
// chat's timezone (zonedCalendarNoon), never the viewer's "now".
//   today / tonight         -> ref
//   tomorrow                -> ref + 1
//   day after tomorrow      -> ref + 2
//   Tuesday / this Tuesday  -> next Tuesday on or after ref
//   next Tuesday            -> Tuesday of the following Mon–Sun week
//   Nov 14 (no year)        -> next upcoming Nov 14
// Anything ambiguous is flagged for review instead of guessed.

export type DateRule =
  | "today"
  | "tomorrow"
  | "day_after_tomorrow"
  | "yesterday"
  | "weekday"
  | "next_weekday"
  | "month_day"
  | "numeric_date"
  | "day_of_month"
  | "none";

export interface PhraseResolution {
  date: string | null; // yyyy-mm-dd
  time: string | null; // HH:mm:ss (24h)
  endTime: string | null; // HH:mm:ss, from a range like "7-9pm"
  allDay: boolean; // true only when there is a date and no time
  confidence: number;
  needsReview: boolean;
  unresolved: boolean; // no date could be determined
  rule: DateRule;
  referenceDate: string | null; // yyyy-mm-dd, the message's day in the chat timezone
  phraseUsed: string | null; // the verbatim date words that were resolved (may be wider than the input)
  timeText: string | null; // the time words that were used
  timeSource: "time_phrase" | "message" | null;
  notes: string[];
  note: string | null; // notes joined for the review board (never exported)
}

export interface ResolveOptions {
  endTimePhrase?: string | null;
}

// ---------------------------------------------------------------- dates --

const DAY_MS = 86_400_000;

function utcNoon(y: number, m0: number, d: number): Date {
  return new Date(Date.UTC(y, m0, d, 12));
}

function makeDate(y: number, m0: number, d: number): Date | null {
  if (m0 < 0 || m0 > 11 || d < 1 || d > 31) return null;
  const date = utcNoon(y, m0, d);
  return date.getUTCFullYear() === y && date.getUTCMonth() === m0 && date.getUTCDate() === d ? date : null;
}

function addDays(d: Date, n: number): Date {
  return utcNoon(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + n);
}

function ymd(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function onOrAfter(ref: Date, dow: number): Date {
  return addDays(ref, (dow - ref.getUTCDay() + 7) % 7);
}

// The weekday in the Mon–Sun week after the one containing ref.
function inFollowingWeek(ref: Date, dow: number): Date {
  const refDow = ref.getUTCDay();
  const toNextMonday = refDow === 0 ? 1 : 8 - refDow;
  return addDays(ref, toNextMonday + ((dow + 6) % 7));
}

function upcomingDayOfMonth(ref: Date, day: number): Date | null {
  const thisMonth = makeDate(ref.getUTCFullYear(), ref.getUTCMonth(), day);
  if (thisMonth && thisMonth.getTime() >= ref.getTime()) return thisMonth;
  const nextM = (ref.getUTCMonth() + 1) % 12;
  const nextY = ref.getUTCFullYear() + (nextM === 0 ? 1 : 0);
  return makeDate(nextY, nextM, day);
}

const MONTH_WORD =
  "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?";
// Lenient (abbreviations) inside a date phrase; strict full names when
// scanning whole messages, where "sat"/"sun"/"wed" are ordinary words.
const WEEKDAY_LENIENT =
  "(sun(?:day)?|mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday|s)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?)\\b\\.?";
const WEEKDAY_STRICT = "(sunday|monday|tuesday|tues|wednesday|weds|thursday|thurs|friday|saturday)\\b";
const ORDINAL = "(\\d{1,2})(?:st|nd|rd|th)\\b";

const RE = {
  dayAfter: /\bday\s+after\s+(?:tomorrow|tomorow|tmrw|tmr)\b/i,
  tomorrow: /\b(?:tomorrow|tomorow|tmrw|tmr|tmrrw|2moro|2morrow)\b/i,
  today: /\b(?:today|tonight|tonite|this\s+(?:morning|afternoon|evening))\b/i,
  yesterday: /\byesterday\b/i,
  weekday: new RegExp(`\\b${WEEKDAY_LENIENT}`, "gi"),
  monthDay: new RegExp(`\\b${MONTH_WORD}\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+(\\d{4})\\b)?`, "i"),
  dayMonth: new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_WORD}(?:,?\\s+(\\d{4})\\b)?`, "i"),
  numeric: /(?<![\d/])(\d{1,2})\/(\d{1,2})(?:\/(\d{4}|\d{2}))?(?![\d/])/,
  iso: /\b(\d{4})-(\d{2})-(\d{2})\b/,
  ordinal: new RegExp(`\\b${ORDINAL}`, "i"),
  vague: /\b(?:weekend|next\s+week|end\s+of|sometime|soon|later|asap|tbd)\b/i,
  next: /\bnext\b/i,
  last: /\blast\b/i,
  alternatives: /\bor\b/i,
};

function weekdayIndex(word: string): number {
  const w = word.toLowerCase();
  return ["su", "mo", "tu", "we", "th", "fr", "sa"].findIndex((p) => w.startsWith(p));
}

function monthIndex(word: string): number {
  return MONTHS.findIndex((m) => m.toLowerCase().startsWith(word.toLowerCase().replace(/\.$/, "").slice(0, 3)));
}

interface ExplicitDate {
  rule: "month_day" | "numeric_date";
  month0: number;
  day: number;
  year: number | null;
}

function parseExplicitDate(p: string): ExplicitDate | null {
  const iso = p.match(RE.iso);
  if (iso) return { rule: "numeric_date", year: +iso[1], month0: +iso[2] - 1, day: +iso[3] };
  const md = p.match(RE.monthDay);
  if (md) return { rule: "month_day", month0: monthIndex(md[1]), day: +md[2], year: md[3] ? +md[3] : null };
  const dm = p.match(RE.dayMonth);
  if (dm) return { rule: "month_day", month0: monthIndex(dm[2]), day: +dm[1], year: dm[3] ? +dm[3] : null };
  const num = p.match(RE.numeric);
  if (num) {
    // M/D like the WhatsApp export itself; 2-digit years are 20xx.
    const y = num[3] ? (num[3].length === 2 ? 2000 + +num[3] : +num[3]) : null;
    return { rule: "numeric_date", month0: +num[1] - 1, day: +num[2], year: y };
  }
  return null;
}

// ---------------------------------------------------------------- times --

export interface TimeToken {
  start: number;
  end: number;
  text: string;
  kind: "range" | "prefixed" | "clock" | "ampm" | "oclock" | "noon" | "midnight" | "bare";
  hour: number;
  minute: number;
  meridiem: "am" | "pm" | null;
  leadingZero: boolean;
  endHour?: number;
  endMinute?: number;
  endMeridiem?: "am" | "pm" | null;
}

const MER = "(a\\.?m\\.?|p\\.?m\\.?)(?![a-z])";
const T = `(\\d{1,2})(?::(\\d{2}))?\\s*(?:${MER})?`;
const AFTER_NUMBER_GUARD =
  "(?![\\d/:%])(?!(?:st|nd|rd|th)\\b)(?!\\s*(?:minutes?|mins?|hours?|hrs?|days?|weeks?|months?|years?|people|kids|of\\b|percent|dollars|bucks|%|x\\b))";

const TIME_RE = {
  range: new RegExp(
    `(?:\\b(from|between|at)\\s+)?(?<![\\d/:.$])\\b${T}\\s*(-|–|—|\\bto\\b|\\buntil\\b|\\btill\\b|\\btil\\b|\\band\\b)\\s*${T}(?![\\d/])`,
    "gi"
  ),
  prefixed: new RegExp(`(?:\\b(?:at|by|around|from|after|before)\\s+|@\\s*)${T}(?:\\s*o'?clock)?(?:\\s*ish)?${AFTER_NUMBER_GUARD}`, "gi"),
  clock: new RegExp(`(?<![\\d:/.$])\\b(\\d{1,2}):(\\d{2})(?!\\d)(?:\\s*${MER})?`, "gi"),
  ampm: new RegExp(`(?<![\\d:/.$])\\b(\\d{1,2})\\s*${MER}`, "gi"),
  oclock: /\b(\d{1,2})\s*o'?clock\b/gi,
  noon: /\b(noon|midday|midnight)\b/gi,
  bare: new RegExp(`^\\s*${T}\\s*$`, "i"),
};

function mer(s: string | undefined): "am" | "pm" | null {
  if (!s) return null;
  return s.toLowerCase().startsWith("p") ? "pm" : "am";
}

function validClock(h: number, m: number, meridiem: "am" | "pm" | null): boolean {
  if (!Number.isInteger(h) || !Number.isInteger(m) || m > 59) return false;
  return meridiem ? h >= 1 && h <= 12 : h <= 23;
}

// Every time expression in `text`, left to right, overlaps removed (longest
// wins). Bare numbers only count with a prefix ("at 7"), so "Oct 24-26",
// "$40", "80th" and "the 20th" are never read as times. `bareNumber` also
// accepts a lone "5" — used for an extracted time_phrase.
export function findTimeTokens(text: string, opts: { bareNumber?: boolean } = {}): TimeToken[] {
  const found: TimeToken[] = [];
  const push = (t: TimeToken) => found.push(t);

  for (const m of text.matchAll(TIME_RE.range)) {
    const prefix = m[1]?.toLowerCase();
    const [h1, min1, mer1, sep, h2, min2, mer2] = [m[2], m[3], m[4], m[5].toLowerCase(), m[6], m[7], m[8]];
    const strong = !!(min1 || min2 || mer1 || mer2 || prefix);
    if (!strong || (sep === "and" && prefix !== "between")) continue;
    const a = { h: +h1, m: min1 ? +min1 : 0, mer: mer(mer1) };
    const b = { h: +h2, m: min2 ? +min2 : 0, mer: mer(mer2) };
    if (!validClock(a.h, a.m, a.mer) || !validClock(b.h, b.m, b.mer)) continue;
    push({
      start: m.index!, end: m.index! + m[0].length, text: m[0], kind: "range",
      hour: a.h, minute: a.m, meridiem: a.mer, leadingZero: h1.length === 2 && h1.startsWith("0"),
      endHour: b.h, endMinute: b.m, endMeridiem: b.mer,
    });
  }
  for (const m of text.matchAll(TIME_RE.prefixed)) {
    const h = +m[1], min = m[2] ? +m[2] : 0, me = mer(m[3]);
    if (!validClock(h, min, me)) continue;
    push({ start: m.index!, end: m.index! + m[0].length, text: m[0], kind: "prefixed", hour: h, minute: min, meridiem: me, leadingZero: m[1].length === 2 && m[1].startsWith("0") });
  }
  for (const m of text.matchAll(TIME_RE.clock)) {
    const h = +m[1], min = +m[2], me = mer(m[3]);
    if (!validClock(h, min, me)) continue;
    push({ start: m.index!, end: m.index! + m[0].length, text: m[0], kind: "clock", hour: h, minute: min, meridiem: me, leadingZero: m[1].length === 2 && m[1].startsWith("0") });
  }
  for (const m of text.matchAll(TIME_RE.ampm)) {
    const h = +m[1], me = mer(m[2]);
    if (!validClock(h, 0, me)) continue;
    push({ start: m.index!, end: m.index! + m[0].length, text: m[0], kind: "ampm", hour: h, minute: 0, meridiem: me, leadingZero: false });
  }
  for (const m of text.matchAll(TIME_RE.oclock)) {
    const h = +m[1];
    if (h < 1 || h > 12) continue;
    push({ start: m.index!, end: m.index! + m[0].length, text: m[0], kind: "oclock", hour: h, minute: 0, meridiem: null, leadingZero: false });
  }
  for (const m of text.matchAll(TIME_RE.noon)) {
    const midnight = m[1].toLowerCase() === "midnight";
    push({ start: m.index!, end: m.index! + m[0].length, text: m[0], kind: midnight ? "midnight" : "noon", hour: midnight ? 0 : 12, minute: 0, meridiem: null, leadingZero: false });
  }
  if (opts.bareNumber && found.length === 0) {
    const m = text.match(TIME_RE.bare);
    if (m) {
      const h = +m[1], min = m[2] ? +m[2] : 0, me = mer(m[3]);
      if (validClock(h, min, me)) {
        const start = text.indexOf(m[1]);
        push({ start, end: text.trimEnd().length, text: text.trim(), kind: "bare", hour: h, minute: min, meridiem: me, leadingZero: m[1].length === 2 && m[1].startsWith("0") });
      }
    }
  }

  found.sort((x, y) => x.start - y.start || y.end - y.start - (x.end - x.start));
  const out: TimeToken[] = [];
  for (const t of found) {
    if (out.some((o) => t.start < o.end && o.start < t.end)) continue;
    out.push(t);
  }
  return out;
}

const PM_CONTEXT = /\b(?:tonight|tonite|evening|night|dinner|supper|afternoon)\b/i;
const AM_CONTEXT = /\b(?:morning|breakfast|brunch)\b/i;

function contextOf(text: string): "am" | "pm" | "both" | null {
  const pm = PM_CONTEXT.test(text);
  const am = AM_CONTEXT.test(text);
  return pm && am ? "both" : pm ? "pm" : am ? "am" : null;
}

const to24 = (h: number, me: "am" | "pm") => (me === "pm" ? (h % 12) + 12 : h % 12);
const hhmm = (h: number, m: number) => `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00`;

interface ClockReading {
  time: string;
  endTime: string | null;
  assumed: "am" | "pm" | null;
  ambiguous: boolean;
}

// Turn a token into a 24h time. Explicit am/pm and 24h clocks win; then
// context ("tonight/evening/dinner" + bare hour = PM, "morning" = AM);
// otherwise 1–6 are assumed PM and 7–11 AM, and the assumption is noted.
function readClock(t: TimeToken, localContext: string, messageContext: string): ClockReading {
  let assumed: ClockReading["assumed"] = null;
  let ambiguous = false;
  let start: number;

  let meridiem = t.meridiem;
  if (!meridiem && t.kind === "range" && t.endMeridiem && t.endHour !== undefined) {
    // "7-9pm" -> 7pm; "11-1pm" -> 11am (the range crosses noon)
    const crossesNoon = t.hour % 12 > t.endHour % 12;
    meridiem = crossesNoon ? (t.endMeridiem === "pm" ? "am" : "pm") : t.endMeridiem;
  }

  if (t.kind === "noon" || t.kind === "midnight") {
    start = t.hour;
  } else if (meridiem) {
    start = to24(t.hour, meridiem);
  } else if (t.hour >= 13 || t.hour === 0 || t.leadingZero) {
    start = t.hour;
  } else {
    let ctx = contextOf(localContext);
    if (!ctx) ctx = contextOf(messageContext);
    if (ctx === "pm") start = t.hour === 12 ? 12 : t.hour + 12;
    else if (ctx === "am") start = t.hour % 12 === 0 ? 12 : t.hour;
    else {
      ambiguous = ctx === "both";
      if (t.hour === 12) start = 12;
      else if (t.hour <= 6) {
        start = t.hour + 12;
        assumed = "pm";
      } else {
        start = t.hour;
        assumed = "am";
      }
    }
  }

  let endTime: string | null = null;
  if (t.kind === "range" && t.endHour !== undefined) {
    let end: number;
    if (t.endMeridiem) end = to24(t.endHour, t.endMeridiem);
    else if (t.endHour >= 13 || t.endHour === 0) end = t.endHour;
    else {
      end = t.endHour;
      while (end * 60 + (t.endMinute ?? 0) <= start * 60 + t.minute && end < 24) end += 12;
    }
    if (end <= 23) endTime = hhmm(end, t.endMinute ?? 0);
  }

  return { time: hhmm(start, t.minute), endTime, assumed, ambiguous };
}

// ------------------------------------------------------- date spans --

export interface DateSpan {
  start: number;
  end: number;
  text: string;
}

const SPAN_RES: RegExp[] = [
  /\bday\s+after\s+(?:tomorrow|tomorow|tmrw|tmr)\b/gi,
  /\b(?:tomorrow|tomorow|tmrw|tmr|tmrrw|2moro|2morrow)(?:\s+(?:morning|afternoon|evening|night))?\b/gi,
  /\b(?:today|tonight|tonite|this\s+(?:morning|afternoon|evening))\b/gi,
  /\byesterday\b/gi,
  new RegExp(`\\b(?:(?:next|this|coming|on)\\s+)?${WEEKDAY_STRICT}(?:\\s+next\\s+week)?`, "gi"),
  new RegExp(`\\b${MONTH_WORD}\\s+\\d{1,2}(?:st|nd|rd|th)?\\b(?:,?\\s+\\d{4}\\b)?`, "gi"),
  new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_WORD}(?:,?\\s+\\d{4}\\b)?`, "gi"),
  /(?<![\d/])\d{1,2}\/\d{1,2}(?:\/(?:\d{4}|\d{2}))?(?![\d/])/g,
  /\b\d{4}-\d{2}-\d{2}\b/g,
  new RegExp(`\\b(?:(?:on|by|before|until|till|for)\\s+)?the\\s+${ORDINAL}`, "gi"),
];

const SPAN_GLUE = /^[\s,]*(?:(?:the|on|of|morning|afternoon|evening|night)[\s,]*)*$/i;

// Every date expression in a message, with adjacent pieces merged
// ("Saturday the 15th", "Saturday morning Oct 24", "next Friday Oct 16").
export function findDateSpans(text: string): DateSpan[] {
  const raw: DateSpan[] = [];
  for (const re of SPAN_RES) {
    for (const m of text.matchAll(re)) raw.push({ start: m.index!, end: m.index! + m[0].length, text: m[0] });
  }
  raw.sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start));
  const spans: DateSpan[] = [];
  for (const s of raw) {
    if (spans.some((o) => s.start < o.end && o.start < s.end)) continue;
    spans.push(s);
  }
  const merged: DateSpan[] = [];
  for (const s of spans) {
    const prev = merged[merged.length - 1];
    if (prev && SPAN_GLUE.test(text.slice(prev.end, s.start))) {
      prev.end = s.end;
      prev.text = text.slice(prev.start, prev.end);
    } else {
      merged.push({ ...s });
    }
  }
  return merged;
}

// Locate a phrase in text, case-insensitive and whitespace-tolerant.
function locate(text: string, phrase: string): DateSpan | null {
  const words = phrase.trim().split(/\s+/).filter(Boolean);
  if (!words.length || !text) return null;
  const pattern = words
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/['’]/g, "['’]"))
    .join("\\s+");
  const m = new RegExp(pattern, "i").exec(text);
  return m ? { start: m.index, end: m.index + m[0].length, text: m[0] } : null;
}

const CLAUSE_BREAK = /[.!?;\n]+|,\s/g;

function clauseIndexer(text: string): (pos: number) => number {
  const breaks: number[] = [];
  for (const m of text.matchAll(CLAUSE_BREAK)) breaks.push(m.index!);
  return (pos: number) => breaks.filter((b) => b < pos).length;
}

function clauseAround(text: string, pos: number): string {
  let start = 0;
  let end = text.length;
  for (const m of text.matchAll(CLAUSE_BREAK)) {
    if (m.index! < pos) start = m.index! + m[0].length;
    else {
      end = m.index!;
      break;
    }
  }
  return text.slice(start, end);
}

interface PickedTime {
  token: TimeToken;
  source: "time_phrase" | "message";
  localContext: string;
}

// The time for this event: the extracted time_phrase first, then the whole
// message. A time found elsewhere in the message is only taken when it is
// closer (same clause first, then characters) to this event's date phrase
// than to any other date in the message — so "practice next Tuesday at 5,
// permission slip due Friday" never gives the slip a 5 PM.
function pickTime(datePhrase: string, timePhrase: string, sentText: string): PickedTime | null {
  if (timePhrase.trim()) {
    const [token] = findTimeTokens(timePhrase, { bareNumber: true });
    if (token) {
      const at = locate(sentText, timePhrase);
      const local = `${timePhrase} ${datePhrase} ${at ? clauseAround(sentText, at.start) : ""}`;
      return { token, source: "time_phrase", localContext: local };
    }
  }
  if (!sentText) return null;

  const tokens = findTimeTokens(sentText);
  if (!tokens.length) return null;
  const spans = findDateSpans(sentText);
  let ours = datePhrase.trim() ? locate(sentText, datePhrase) : null;
  if (ours) {
    // a span overlapping our phrase is ours too ("Saturday morning Oct 24")
    for (const s of spans) {
      if (s.start < ours.end && ours.start < s.end) ours = { start: Math.min(s.start, ours.start), end: Math.max(s.end, ours.end), text: "" };
    }
  } else if (spans.length === 1) {
    ours = spans[0];
  } else if (spans.length > 1) {
    return null; // can't tell which date this time belongs to
  }
  const others = ours ? spans.filter((s) => !(s.start < ours!.end && ours!.start < s.end)) : [];

  const clauseAt = clauseIndexer(sentText);
  const score = (span: DateSpan, t: TimeToken) => {
    const [c0, c1, ct] = [clauseAt(span.start), clauseAt(Math.max(span.start, span.end - 1)), clauseAt(t.start)];
    const clauseGap = ct < c0 ? c0 - ct : ct > c1 ? ct - c1 : 0;
    const charGap = t.start >= span.end ? t.start - span.end : span.start >= t.end ? span.start - t.end : 0;
    return clauseGap * 1000 + charGap;
  };

  let best: { token: TimeToken; s: number } | null = null;
  for (const t of tokens) {
    const s = ours ? score(ours, t) : 0;
    if (others.some((o) => score(o, t) < s)) continue;
    if (!best || s < best.s) best = { token: t, s };
  }
  if (!best) return null;
  const local = `${datePhrase} ${clauseAround(sentText, best.token.start)}`;
  return { token: best.token, source: "message", localContext: local };
}

// ------------------------------------------------------------- resolve --

export function resolveDatePhrase(
  phrase: string | null | undefined,
  timePhrase: string | null | undefined,
  sentText: string | null | undefined,
  refISO: string | null | undefined,
  timezone: string,
  opts: ResolveOptions = {}
): PhraseResolution {
  const text = sentText ?? "";
  // Read the whole date expression around the extracted words: if the model
  // copied only "next Wednesday" from "next Wednesday Oct 21", resolve the
  // full (still verbatim) span so the explicit date and any conflict count.
  let datePhrase = (phrase ?? "").trim();
  const located = datePhrase ? locate(text, datePhrase) : null;
  if (located) {
    let start = located.start;
    let end = located.end;
    for (const s of findDateSpans(text)) {
      if (s.start < end && start < s.end) {
        start = Math.min(start, s.start);
        end = Math.max(end, s.end);
      }
    }
    datePhrase = text.slice(start, end);
  }
  const notes: string[] = [];
  let review = false;
  let confidence = 0.9;
  const flag = (note: string, cap = 0.6) => {
    notes.push(note);
    review = true;
    confidence = Math.min(confidence, cap);
  };

  // ---- reference day ----
  const refInstant = refISO ? new Date(refISO) : null;
  const ref = refInstant && !Number.isNaN(refInstant.getTime()) ? zonedCalendarNoon(refInstant, timezone || "UTC") : null;

  // ---- date ----
  let date: Date | null = null;
  let rule: DateRule = "none";
  let unresolvedReason: string | null = null;
  const p = datePhrase.toLowerCase().replace(/[’]/g, "'").replace(/\s+/g, " ");

  if (!ref) {
    unresolvedReason = "the message has no usable timestamp";
  } else if (!p) {
    unresolvedReason = "no date mentioned";
  } else if (RE.alternatives.test(p)) {
    unresolvedReason = `“${datePhrase}” offers more than one day`;
  } else {
    const explicit = parseExplicitDate(p);
    const weekdays = [...new Set([...p.matchAll(RE.weekday)].map((m) => weekdayIndex(m[1])))].filter((d) => d >= 0);
    const relative = RE.dayAfter.test(p)
      ? "day_after_tomorrow"
      : RE.tomorrow.test(p)
        ? "tomorrow"
        : RE.today.test(p)
          ? "today"
          : RE.yesterday.test(p)
            ? "yesterday"
            : null;
    const ordinal = p.match(RE.ordinal);

    if (explicit) {
      rule = explicit.rule;
      confidence = 0.95;
      if (explicit.year !== null && (explicit.year < 1970 || explicit.year > 2100)) {
        unresolvedReason = "year out of range";
      } else if (explicit.year !== null) {
        date = makeDate(explicit.year, explicit.month0, explicit.day);
        if (!date) unresolvedReason = "impossible date";
        else if (date.getTime() < ref.getTime()) flag("that date is already in the past");
      } else {
        const thisYear = makeDate(ref.getUTCFullYear(), explicit.month0, explicit.day);
        if (thisYear && thisYear.getTime() >= ref.getTime()) {
          date = thisYear;
        } else {
          date = makeDate(ref.getUTCFullYear() + 1, explicit.month0, explicit.day);
          if (!date) unresolvedReason = "impossible date";
          else if (thisYear && ref.getTime() - thisYear.getTime() <= 31 * DAY_MS) {
            flag("that date just passed this year — assumed next year");
          }
        }
      }
    } else if (relative) {
      rule = relative;
      confidence = 0.95;
      const offset = { today: 0, tomorrow: 1, day_after_tomorrow: 2, yesterday: -1 }[relative];
      date = addDays(ref, offset);
      if (relative === "yesterday") flag("refers to a day before the message was sent");
    } else if (weekdays.length) {
      if (RE.last.test(p)) {
        unresolvedReason = "refers to a past week";
      } else if (ordinal) {
        // "Saturday the 15th": the day number decides, the weekday must agree.
        rule = "day_of_month";
        date = upcomingDayOfMonth(ref, +ordinal[1]);
        if (!date) unresolvedReason = "impossible date";
      } else {
        rule = RE.next.test(p) ? "next_weekday" : "weekday";
        date = rule === "next_weekday" ? inFollowingWeek(ref, weekdays[0]) : onOrAfter(ref, weekdays[0]);
        if (weekdays.length > 1) flag("names several weekdays — used the first one");
      }
    } else if (ordinal) {
      rule = "day_of_month";
      date = upcomingDayOfMonth(ref, +ordinal[1]);
      if (!date) unresolvedReason = "impossible date";
      else flag("day without a month — assumed the next one coming up");
    } else if (RE.vague.test(p)) {
      unresolvedReason = `“${datePhrase}” is too vague to pin to a day`;
    } else {
      unresolvedReason = "date could not be resolved";
    }

    // "tomorrow, Oct 5": the relative word and the explicit date must agree.
    if (date && explicit && relative) {
      const offset = { today: 0, tomorrow: 1, day_after_tomorrow: 2, yesterday: -1 }[relative];
      if (ymd(addDays(ref, offset)) !== ymd(date)) {
        date = null;
        unresolvedReason = `says “${datePhrase}”, but the day and the date don't agree — needs a human`;
      }
    }

    // A named weekday must agree with the date we got any other way.
    if (date && weekdays.length && rule !== "weekday" && rule !== "next_weekday") {
      if (weekdays.length > 1 || weekdays[0] !== date.getUTCDay()) {
        date = null;
        unresolvedReason = `says “${datePhrase}”, but the weekday and the date don't agree — needs a human`;
      } else {
        confidence = Math.max(confidence, 0.95);
        if (explicit && RE.next.test(p) && ymd(inFollowingWeek(ref, weekdays[0])) !== ymd(date)) {
          notes.push(`“next” read as the stated date (${ymd(date)})`);
        }
      }
    }
  }

  if (date === null && !unresolvedReason) unresolvedReason = "date could not be resolved";
  if (unresolvedReason) {
    date = null;
    notes.unshift(unresolvedReason);
    review = true;
  }

  if (datePhrase && text && !located) {
    flag("the date words aren't in the message word for word");
  }

  // ---- time ----
  let time: string | null = null;
  let endTime: string | null = null;
  let timeText: string | null = null;
  let timeSource: PhraseResolution["timeSource"] = null;
  const picked = pickTime(datePhrase, timePhrase ?? "", text);
  if (picked) {
    const reading = readClock(picked.token, `${picked.localContext} ${opts.endTimePhrase ?? ""}`, text);
    time = reading.time;
    endTime = reading.endTime;
    timeText = picked.token.text.trim();
    timeSource = picked.source;
    if (reading.ambiguous) flag("the time could be morning or evening — needs a human");
    else if (reading.assumed === "pm") flag("bare time — assumed PM", 0.75);
    else if (reading.assumed === "am") flag("bare time — assumed AM", 0.75);
    if (picked.source === "time_phrase" && text && !locate(text, timePhrase ?? "")) {
      flag("the time words aren't in the message word for word");
    }
  }
  if (!endTime && opts.endTimePhrase && time) {
    const [endToken] = findTimeTokens(opts.endTimePhrase, { bareNumber: true });
    if (endToken) {
      const startHour = Number(time.slice(0, 2));
      let h = endToken.meridiem ? to24(endToken.hour, endToken.meridiem) : endToken.hour;
      while (!endToken.meridiem && h * 60 + endToken.minute <= startHour * 60 && h < 24) h += 12;
      if (h <= 23) endTime = hhmm(h, endToken.minute);
    }
  }

  if (date === null) confidence = 0;
  // Review-only flags keep the event out of "Ready" regardless of the slider.
  const needsReview =
    date === null ||
    (review && notes.some((n) => !/^bare time — assumed|^“next” read as/.test(n)));

  return {
    date: date ? ymd(date) : null,
    time,
    endTime,
    allDay: date !== null && time === null,
    confidence: Math.round(confidence * 100) / 100,
    needsReview,
    unresolved: date === null,
    rule: date ? rule : "none",
    referenceDate: ref ? ymd(ref) : null,
    phraseUsed: datePhrase || null,
    timeText,
    timeSource,
    notes,
    note: notes.length ? notes.join("; ") : null,
  };
}

export { MONTHS, WEEKDAYS };

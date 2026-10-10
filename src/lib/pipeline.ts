import { parseChat, zonedCalendarNoon, type ParsedMessage } from "./chatParser";
import { pool, invokeJev, RateLimitedError } from "./jevClient";
import { assemble } from "./dateResolver";
import {
  extractTimeFromText,
  findYearCandidates,
  findDatePhrase,
  timeFromSentence,
  weekdayInPhrase,
} from "./phraseExtractor";
import { MONTHS, WEEKDAYS } from "./constants";
import { stableUid } from "./icsGenerator";
import type { ChatEvent, Attendee, PipelineStats, DatePartsAnswers } from "./types";

export interface ChatMessageView extends ParsedMessage {
  isEvent: number | null;
  kind: string | null;
  kindConf: number | null;
}

export interface PipelineResult {
  chatId: string;
  feedSlug: string;
  title: string;
  timezone: string;
  members: string[];
  messages: ChatMessageView[];
  events: ChatEvent[];
  stats: PipelineStats;
  offlineReason: string | null;
}

export interface RawEvent {  title: string;
  kind: string;
  date_phrase: string;
  time_phrase?: string;
  location?: string;
  notes?: string;
  source_message_ids: string[];
  refers_to_title?: string;
}

const FILTER_QUESTIONS = {
  is_event: {
    type: "noul",
    instructions:
      "Does `message` propose, confirm, or change a specific event, appointment, or deadline?",
    criteria: {
      true: "`message` names something happening or due at a specific time or day.",
      false: "`message` is chat, a reaction, or has no event or deadline.",
    },
  },
  kind: {
    type: "choice",
    instructions: "What does `message` do?",
    criteria: {
      new_event: "Proposes or announces an event.",
      deadline: "States something is due by a time.",
      change: "Moves or edits an earlier event.",
      cancellation: "Cancels an earlier event.",
      rsvp: "Says who is or isn't coming.",
      none: "None of these.",
      uncertain: "Can't tell.",
    },
  },
};

const DATE_PART_QUESTIONS = {
  mode: {
    type: "choice",
    instructions: "How does `date_phrase` refer to a date?",
    criteria: {
      absolute: "A calendar date: a month and a day of month.",
      relative: "Relative to the day `message` was sent: today, tomorrow, or a weekday.",
      none: "Not a date reference.",
    },
  },
  month: {
    type: "choice",
    instructions: "Which month does `date_phrase` name?",
    criteria: {
      January: null, February: null, March: null, April: null, May: null,
      June: null, July: null, August: null, September: null, October: null,
      November: null, December: null, none: "No month is named or implied.",
    },
  },
  day: {
    type: "choice",
    instructions: "Which day of the month does `date_phrase` name?",
    criteria: Object.fromEntries([
      ...Array.from({ length: 31 }, (_, i) => [String(i + 1), null]),
      ["none", "No day of month is named."],
    ]),
  },
  year: {
    type: "choice",
    instructions: "Which year does `date_phrase` refer to?",
    criteria: {} as Record<string, string | null>,
  },
  day_anchor: {
    type: "choice",
    instructions: "What day does `date_phrase` anchor to?",
    criteria: {
      today: "The day `message` was sent.",
      tomorrow: "The day after `message` was sent.",
      day_after: "Two days after `message` was sent.",
      weekday: "A named weekday, e.g. 'Tuesday'.",
      none: "No day anchor.",
    },
  },
  weekday: {
    type: "choice",
    instructions: "Which weekday does `date_phrase` name?",
    criteria: {
      Sunday: null, Monday: null, Tuesday: null, Wednesday: null,
      Thursday: null, Friday: null, Saturday: null, none: "No weekday named.",
    },
  },
  week_offset: {
    type: "choice",
    instructions: "Does `date_phrase` say which week the weekday falls in?",
    criteria: {
      current: "This week, or no week is specified.",
      next: "The following calendar week (e.g. 'next Tuesday').",
      none: "No week offset stated.",
    },
  },
  meridiem: {
    type: "choice",
    instructions:
      "If `message` states a bare time without am/pm (like 'at 7'), is it morning or evening? If no time is stated at all, answer none_stated.",
    criteria: {
      am: "Morning.",
      pm: "Afternoon or evening.",
      none_stated: "No time is stated, or the time already includes am/pm.",
    },
  },
};

export interface RunOptions {
  chatTitle: string;
  rawChat: string;
  timezone: string;
  mode: "live" | "mock";
  reviewBelow?: number;
  onStage?: (stage: string, detail?: string) => void;
  onProgress?: (msg: string) => void;
}

async function extractEvents(
  messages: ParsedMessage[],
  mode: "live" | "mock"
): Promise<{ events: RawEvent[]; extractor: string }> {
  const { supabase } = await import("./supabase");
  const { data, error } = await supabase.functions.invoke("extract-events", {
    body: { messages, mode },
  });
  if (error) {
    const { readableFunctionError } = await import("./jevClient");
    // Throws RateLimitedError when the daily cap is hit.
    throw await readableFunctionError(error).then(
      (m) => new Error(m),
      (e) => e
    );
  }
  if (!data || !Array.isArray(data.events)) {
    throw new Error(data?.error || "Extractor returned an unexpected response");
  }
  return { events: data.events as RawEvent[], extractor: String(data.extractor ?? "unknown") };
}

// Offline stand-ins used when the daily AI cap is hit. The regex filter is a
// coarse approximation of Jev's is_event judgement; everything is capped at
// review confidence so a human sees it all.

const EVENTY_RE =
  /\b(today|tonight|tomorrow|next\s+(mon|tues|wednes|thurs|fri|satur|sun)day|due|deadline|practice|appointment|dinner|party|pickup|meeting|game|sale|dismissal|trip|reserved?)\b/i;

// First-person send/commit intents are chatter, not events, even though they
// contain a time-ish word ("I'll send mine today", "sending tonight").
const CHATTER_RE =
  /\b(i'?ll|i will|im i'm|sending|sent|sending mine|send mine|send it|sent mine|will send|i'll be sending|mine|submit|sending it)\b/i;

function looksLikeChatter(text: string): boolean {
  const lower = text.toLowerCase();
  if (!CHATTER_RE.test(lower)) return false;
  return /\b(send|sent|sending|submit|submitting)\w*\b/.test(lower) || /\bmine\b/.test(lower);
}

export function offlineFilterMessages(messages: ParsedMessage[]): { p: number; kind: string | null }[] {
  return messages.map((m) => {
    if (!EVENTY_RE.test(m.text)) return { p: 0, kind: null };
    if (looksLikeChatter(m.text)) return { p: 0, kind: null };
    const lower = m.text.toLowerCase();
    let kind = "new_event";
    if (/\b(cancel|postpone)\b/.test(lower)) kind = "cancellation";
    else if (/\b(moved|reschedul|pushed)\b/.test(lower)) kind = "change";
    else if (/\bdue\b/.test(lower)) kind = "deadline";
    else if (/\b(coming|i'?m in|i'll be there|can'?t make it)\b/.test(lower)) kind = "rsvp";
    return { p: 0.55, kind };
  });
}

export function offlineExtract(messages: ParsedMessage[]): RawEvent[] {
  const events: RawEvent[] = [];
  for (const m of messages) {
    if (looksLikeChatter(m.text)) continue;
    const phrase = findDatePhrase(m.text);
    if (!phrase) continue;
    const lower = m.text.toLowerCase();
    let kind = "new_event";
    if (/\b(cancel|postpone)\b/.test(lower)) kind = "cancellation";
    else if (/\b(moved|reschedul|pushed)\b/.test(lower)) kind = "change";
    else if (/\bdue\b/.test(lower)) kind = "deadline";
    const firstSentence = m.text.split(/[.!?\n]/)[0].trim();
    // Title from the sentence that holds the date phrase — "Good morning
    // Room 4B parents! Bake sale next Friday" should be titled "Bake sale".
    const dateSentence =
      m.text
        .split(/(?<=[.!?])\s+|\n/)
        .find((s) => s.toLowerCase().includes(phrase.phrase.toLowerCase())) ?? firstSentence;
    // For change messages, the thing being moved is the subject: "Practice moved
    // to Saturday the 15th" should link to the original "Soccer practice" event.
    const subjectMatch =
      kind === "change"
        ? dateSentence.match(/^(.*?)(?:\s+(?:moved|reschedul\w*|pushed|changed|switched)\b)/i)
        : null;
    const subject = subjectMatch?.[1]?.replace(/^(ok|okay|so|hey|hi|just)\s+/i, "").trim();
    const shortTitle =
      subject ||
      dateSentence
        .replace(/^(ok|okay|so|hey|hi|just)\s+/i, "")
        .replace(/\b(?:is|are|will be|has been|gets)\b.*$/i, "")
        .trim();
    const title = (shortTitle || firstSentence).split(/\s+/).slice(0, 6).join(" ") || m.text.slice(0, 40);
    events.push({
      title,
      kind,
      date_phrase: phrase.phrase,
      time_phrase: timeFromSentence(m.text, phrase.phrase)
        ? m.text.match(/\b(?:at|by|from)\s+\d{1,2}(:\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)?\b/i)?.[0]
        : null,
      source_message_ids: [m.id],
    });
  }
  return events;
}

function wordJaccard(a: string, b: string): number {
  const setA = new Set(a.toLowerCase().split(/\W+/).filter(Boolean));
  const setB = new Set(b.toLowerCase().split(/\W+/).filter(Boolean));
  if (setA.size === 0 || setB.size === 0) return 0;
  let inter = 0;
  for (const w of setA) if (setB.has(w)) inter++;
  return inter / (setA.size + setB.size - inter);
}

export function resolveEventOffline(
  raw: RawEvent,
  src: ParsedMessage | undefined,
  idx: number,
  chatId: string,
  timezone: string,
  reviewBelow: number
): ChatEvent {
    const refDate = src ? zonedCalendarNoon(new Date(src.sent_at), timezone) : new Date();
    const answers: DatePartsAnswers = {};
    const timeMatch =
      timeFromSentence(src?.text ?? "", raw.date_phrase ?? "") ??
      (raw.time_phrase ? extractTimeFromText(raw.time_phrase) : null);
    if (timeMatch) {
      answers["__hour"] = timeMatch.hour;
      answers["__minute"] = timeMatch.minute;
      if (timeMatch.meridiem !== "none") {
        answers["meridiem"] = { type: "choice", choice: timeMatch.meridiem, confidence: 0.99 };
      }
    }
    const phrase = raw.date_phrase ?? "";
    const lower = phrase.toLowerCase();
    if (/\b(today|tonight)\b/.test(lower)) {
      answers["mode"] = { choice: "relative", confidence: 0.7 };
      answers["day_anchor"] = { choice: "today", confidence: 0.7 };
    } else if (/\btomorrow\b/.test(lower)) {
      answers["mode"] = { choice: "relative", confidence: 0.7 };
      answers["day_anchor"] = { choice: "tomorrow", confidence: 0.7 };
    } else {
      for (let di = 0; di < WEEKDAYS.length; di++) {
        if (new RegExp(`\\b${WEEKDAYS[di]}\\b`, "i").test(phrase)) {
          answers["mode"] = { choice: "relative", confidence: 0.7 };
          answers["day_anchor"] = { choice: "weekday", confidence: 0.7 };
          answers["weekday"] = { choice: WEEKDAYS[di], confidence: 0.7 };
          answers["week_offset"] = { choice: /\bnext\b/i.test(lower) ? "next" : "current", confidence: 0.6 };
          break;
        }
      }
      if (!answers["mode"]) {
        for (let mi = 0; mi < MONTHS.length; mi++) {
          if (new RegExp(`\\b${MONTHS[mi].slice(0, 3)}\\w*\\b`, "i").test(phrase)) {
            const dayM = phrase.match(/\b(\d{1,2})\b/);
            if (dayM) {
              answers["mode"] = { choice: "absolute", confidence: 0.7 };
              answers["month"] = { choice: MONTHS[mi], confidence: 0.7 };
              answers["day"] = { choice: String(Math.min(31, Math.max(1, Number(dayM[1])))), confidence: 0.7 };
            }
            break;
          }
        }
      }
      if (!answers["mode"]) {
        const dayOnly = phrase.match(/\b(\d{1,2})(st|nd|rd|th)?\b/);
        if (dayOnly && Number(dayOnly[1]) >= 1 && Number(dayOnly[1]) <= 31) {
          answers["mode"] = { choice: "absolute", confidence: 0.5 };
          answers["month"] = { choice: "none", confidence: 0.5 };
          answers["day"] = { choice: dayOnly[1], confidence: 0.5 };
        }
      }
    }
    const result = assemble(answers, refDate, { reviewBelow });

    // Weekday/date mismatch ("Saturday the 15th"): flag for review, no guessed date.
    const namedWeekday = weekdayInPhrase(phrase);
    const statedDay = phrase.match(/\b(\d{1,2})(?:st|nd|rd|th)\b/i);
    const dayDisagrees =
      namedWeekday &&
      statedDay &&
      result.date &&
      Number(statedDay[1]) !== result.date.getUTCDate();
    if (
      (namedWeekday && result.date && WEEKDAYS.indexOf(namedWeekday) !== result.date.getUTCDay()) ||
      dayDisagrees
    ) {
      return {
        id: `tmp-${idx}`,
        chatId,
        title: raw.title || "Event",
        kind: raw.kind || "new_event",
        datePhrase: phrase || null,
        timePhrase: raw.time_phrase || null,
        startDate: null,
        startTime: null,
        allDay: false,
        location: raw.location || null,
        attendees: [],
        sourceMessageIds: raw.source_message_ids || [],
        parts: answers,
        confidence: Math.min(result.confidence, reviewBelow),
        needsReview: true,
        note: `says “${phrase}”, but the weekday and the date don't agree — needs a human`,
        userNote: raw.notes || null,
        timezone,
        status: "pending",
        uid: stableUid(raw.source_message_ids || [], chatId, raw.title || "Event"),
      };
    }
    return {
      id: `tmp-${idx}`,
      chatId,
      title: raw.title || "Event",
      kind: raw.kind || "new_event",
      datePhrase: phrase || null,
      timePhrase: raw.time_phrase || null,
      startDate: result.date ? result.date.toISOString().slice(0, 10) : null,
      startTime: result.time
        ? `${String(result.time.hour).padStart(2, "0")}:${String(result.time.minute).padStart(2, "0")}:00`
        : null,
      allDay: raw.kind === "deadline" || (!result.time && !!result.date),
      location: raw.location || null,
      attendees: [],
      sourceMessageIds: raw.source_message_ids || [],
      parts: answers,
      confidence: Math.min(result.confidence, 0.6),
      needsReview: true,
      note: result.note || null,
      userNote: raw.notes || null,
      timezone,
      status: "pending",
      uid: stableUid(raw.source_message_ids || [], chatId, raw.title || "Event"),
    };
}

export function applyChangeLinks(
  events: ChatEvent[],
  msgById: Map<string, { text: string }>
): void {
  for (const ev of events) {
    if (ev.kind !== "change" && ev.kind !== "cancellation") continue;
    const srcMsg = ev.sourceMessageIds.map((id) => msgById.get(id)).find(Boolean);
    const target = events.find(
      (other) =>
        other !== ev &&
        (other.kind === "new_event" || other.kind === "deadline") &&
        wordJaccard(other.title, ev.title) >= 0.5
    );
    if (target) {
      if (srcMsg && /same time/i.test(srcMsg.text) && !ev.startTime && target.startTime) {
        ev.startTime = target.startTime;
        ev.allDay = false;
        ev.userNote = [ev.userNote, `same time as “${target.title}”`].filter(Boolean).join(" · ");
      }
      if (srcMsg && /same place/i.test(srcMsg.text) && !ev.location && target.location) {
        ev.location = target.location;
      }
      ev.note = `${ev.kind === "change" ? "Moves" : "Cancels"} “${target.title}”${ev.note ? ` · ${ev.note}` : ""}`;
      (ev.parts ?? {})["__linked_event_uid"] = target.uid ?? "";
    }
  }
}

export async function runPipeline(opts: RunOptions): Promise<PipelineResult> {
  const reviewBelow = opts.reviewBelow ?? 0.6;
  const stats: PipelineStats = {
    totalMessages: 0, keptMessages: 0, jevCostUsd: 0, jevLatencyMs: 0,
    extractLatencyMs: 0, datePartsCostUsd: 0, datePartsLatencyMs: 0,
    attendeesCostUsd: 0, attendeesLatencyMs: 0, model: "", extractor: "",
  };

  // ---------- Stage 0: parse ----------
  opts.onStage?.("parse");
  const parsed = parseChat(opts.rawChat, { timezone: opts.timezone });
  if (parsed.messages.length === 0) throw new Error("No messages found in the pasted chat");
  stats.totalMessages = parsed.messages.length;
  opts.onProgress?.(`Parsed ${parsed.messages.length} messages from ${parsed.members.length} people`);

  // ---------- Persist chat + messages ----------
  const { supabase } = await import("./supabase");
  const feedSlug = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
  const { data: chatRow, error: chatErr } = await supabase
    .from("chats")
    .insert({
      title: opts.chatTitle || "Pasted chat",
      timezone: opts.timezone,
      members: parsed.members,
      feed_slug: feedSlug,
    })
    .select()
    .single();
  if (chatErr || !chatRow) throw new Error(`Could not save chat: ${chatErr?.message}`);
  const chatId = chatRow.id as string;

  const { error: msgErr } = await supabase.from("messages").insert(
    parsed.messages.map((m, i) => ({
      chat_id: chatId,
      idx: i,
      msg_key: m.id,
      sent_at: m.sent_at,
      sender: m.sender,
      text: m.text,
    }))
  );
  if (msgErr) throw new Error(`Could not save messages: ${msgErr.message}`);

  // ---------- Stage 1: Jev filter (or offline filter) ----------
  opts.onStage?.("filter", `${parsed.messages.length} messages`);
  let offlineReason: string | null = null;
  let isEventP: number[];
  let kindInfo: { choice: string | null; confidence: number }[];

  try {
    const filterResults = await pool(parsed.messages, 8, (msg) =>
      invokeJev({ previous_message: "", message: `${msg.sender}: ${msg.text}` }, FILTER_QUESTIONS)
    );
    for (const r of filterResults) {
      stats.jevCostUsd += r.cost_usd;
      stats.jevLatencyMs += r.latency_ms;
      stats.model = r.model;
    }

    isEventP = filterResults.map((r) => {
      const a = r.answers["is_event"] as { noul?: number } | undefined;
      return typeof a?.noul === "number" ? a.noul : 0;
    });
    kindInfo = filterResults.map((r) => {
      const a = r.answers["kind"] as { choice?: string; confidence?: number } | undefined;
      return { choice: a?.choice ?? "none", confidence: a?.confidence ?? 0 };
    });

    await Promise.all([
      supabase.from("messages").upsert(
        parsed.messages.map((m, i) => ({
          chat_id: chatId,
          msg_key: m.id,
          is_event_p: isEventP[i],
          kind: kindInfo[i].choice,
          kind_conf: kindInfo[i].confidence,
        })),
        { onConflict: "chat_id,msg_key" }
      ),
      supabase.from("jev_calls").insert(
        filterResults.map((r, i) => ({
          chat_id: chatId,
          stage: "filter",
          request: { message_key: parsed.messages[i].id },
          response: r.answers,
          latency_ms: r.latency_ms,
          input_tokens: r.usage.input_tokens,
          cost_usd: r.cost_usd,
        }))
      ),
    ]);
  } catch (err) {
    if (!(err instanceof RateLimitedError)) throw err;
    // Daily AI cap hit: fall back to the offline filter for the whole run.
    offlineReason = err.message;
    opts.onProgress?.("Daily AI limit reached — switching to offline mode");
    const offline = offlineFilterMessages(parsed.messages);
    isEventP = offline.map((o) => o.p);
    kindInfo = offline.map((o) => ({ choice: o.kind, confidence: o.p }));
    stats.extractor = "offline";
  }

  const views: ChatMessageView[] = parsed.messages.map((m, i) => ({
    ...m,
    isEvent: isEventP[i],
    kind: kindInfo[i].choice,
    kindConf: kindInfo[i].confidence,
  }));

  const keptIdx = parsed.messages.map((_, i) => i).filter((i) => isEventP[i] >= 0.5);
  stats.keptMessages = keptIdx.length;
  if (!offlineReason) {
    opts.onProgress?.(
      `Jev kept ${keptIdx.length} of ${parsed.messages.length} messages · ${stats.jevCostUsd.toFixed(4)} · ${stats.jevLatencyMs}ms`
    );
  }

  // ---------- Stage 2: LLM extraction (or offline extraction) ----------
  opts.onStage?.("extract");
  let extractRes: { events: RawEvent[]; extractor: string };
  if (offlineReason) {
    extractRes = { events: offlineExtract(keptIdx.map((i) => parsed.messages[i])), extractor: "offline-regex" };
    opts.onProgress?.(`Extracted ${extractRes.events.length} candidate events (offline-regex)`);
  } else {
    const contextIds = new Set<string>();
    for (const i of keptIdx) {
      for (let j = Math.max(0, i - 2); j <= i; j++) contextIds.add(parsed.messages[j].id);
    }
    const extractInput = views.filter((m) => contextIds.has(m.id));
    const extractStart = Date.now();
    try {
      extractRes = await extractEvents(extractInput, opts.mode);
    } catch (err) {
      if (!(err instanceof RateLimitedError)) throw err;
      offlineReason = err.message;
      opts.onProgress?.("Daily AI limit reached — switching to offline mode");
      extractRes = { events: offlineExtract(keptIdx.map((i) => parsed.messages[i])), extractor: "offline-regex" };
    }
    stats.extractLatencyMs = Date.now() - extractStart;
    stats.extractor = extractRes.extractor;
    if (!offlineReason) {
      opts.onProgress?.(`Extracted ${extractRes.events.length} candidate events (${extractRes.extractor})`);
    }
  }

  // ---------- Stage 3: Jev date parts + code resolution (or offline) ----------
  opts.onStage?.("date-parts");
  const msgById = new Map(parsed.messages.map((m) => [m.id, m]));


  let resolved: ChatEvent[];
  if (offlineReason) {
    resolved = extractRes.events.map((raw, idx) =>
      resolveEventOffline(raw, raw.source_message_ids?.[0] ? msgById.get(raw.source_message_ids[0]) : undefined, idx, chatId, opts.timezone, reviewBelow)
    );
    opts.onProgress?.(`Date parts resolved offline: ${resolved.length} events, all flagged for review`);
  } else {
    try {
      resolved = await pool(extractRes.events, 8, async (raw, idx) => {
    const firstId = raw.source_message_ids?.[0];
    const src = firstId ? msgById.get(firstId) : undefined;
    const sourceText = src ? `${src.sender}: ${src.text}` : raw.title;
    const refDate = src ? zonedCalendarNoon(new Date(src.sent_at), opts.timezone) : new Date();
    const datePhrase = raw.date_phrase ?? "";

    const yearCriteria: Record<string, string | null> = {};
    const yearCandidates = new Set<string>([
      ...findYearCandidates(sourceText),
      String(refDate.getUTCFullYear()),
      String(refDate.getUTCFullYear() + 1),
    ]);
    for (const y of yearCandidates) yearCriteria[y] = null;
    yearCriteria["none"] = "No specific year is stated.";
    yearCriteria["out_of_range"] = "A year outside the listed options.";

    const questions = {
      ...DATE_PART_QUESTIONS,
      year: { ...DATE_PART_QUESTIONS.year, criteria: yearCriteria },
    };
    const r = await invokeJev({ message: sourceText, date_phrase: datePhrase }, questions);

    const answers = r.answers as DatePartsAnswers;

    // Code parses hour/minute by regex; Jev only reads the meridiem. Times are
    // only read from the sentence holding the date phrase, so a time meant for
    // another event (or a bare date-only deadline) never picks one up.
    const timeMatch =
      timeFromSentence(src?.text ?? "", datePhrase) ??
      (raw.time_phrase ? extractTimeFromText(raw.time_phrase) : null);
    if (timeMatch) {
      answers["__hour"] = timeMatch.hour;
      answers["__minute"] = timeMatch.minute;
      if (timeMatch.meridiem !== "none") {
        answers["meridiem"] = {
          type: "choice",
          choice: timeMatch.meridiem,
          confidence: 0.99,
        };
      }
    }

    // Gate: only read `weekday` when the anchor is a weekday (the "Black Friday" trap).
    const anchorA = answers["day_anchor"] as { choice?: string } | undefined;
    const weekdayA = answers["weekday"] as { choice?: string; confidence?: number } | undefined;
    if (anchorA?.choice !== "weekday" || !weekdayA || (weekdayA.confidence ?? 0) < 0.6) {
      delete answers["weekday"];
    }

    const result = assemble(answers, refDate, { reviewBelow });

    // Weekday/date mismatch ("Saturday the 15th"): flag for review, no guessed date.
    const namedWeekday = weekdayInPhrase(datePhrase);
    const statedDay = datePhrase.match(/\b(\d{1,2})(?:st|nd|rd|th)\b/i);
    const dayDisagrees =
      namedWeekday &&
      statedDay &&
      result.date &&
      Number(statedDay[1]) !== result.date.getUTCDate();
    if (
      (namedWeekday && result.date && WEEKDAYS.indexOf(namedWeekday) !== result.date.getUTCDay()) ||
      dayDisagrees
    ) {
      stats.datePartsCostUsd += r.cost_usd;
      stats.datePartsLatencyMs += r.latency_ms;
      return {
        id: `tmp-${idx}`,
        chatId,
        title: raw.title || "Event",
        kind: raw.kind || "new_event",
        datePhrase: datePhrase || null,
        timePhrase: raw.time_phrase || null,
        startDate: null,
        startTime: null,
        allDay: false,
        location: raw.location || null,
        attendees: [],
        sourceMessageIds: raw.source_message_ids || [],
        parts: answers,
        confidence: Math.min(result.confidence, reviewBelow),
        needsReview: true,
        note: `says “${datePhrase}”, but the weekday and the date don't agree — needs a human`,
        userNote: raw.notes || null,
        timezone: opts.timezone,
        status: "pending",
        uid: stableUid(raw.source_message_ids || [], chatId, raw.title || "Event"),
      };
    }

    const startDate = result.date ? result.date.toISOString().slice(0, 10) : null;
    const startTime = result.time
      ? `${String(result.time.hour).padStart(2, "0")}:${String(result.time.minute).padStart(2, "0")}:00`
      : null;

    const ev: ChatEvent = {
      id: `tmp-${idx}`,
      chatId,
      title: raw.title || "Event",
      kind: raw.kind || "new_event",
      datePhrase: datePhrase || null,
      timePhrase: raw.time_phrase || null,
      startDate,
      startTime,
      allDay: raw.kind === "deadline" || (!startTime && !!startDate),
      location: raw.location || null,
      attendees: [],
      sourceMessageIds: raw.source_message_ids || [],
      parts: answers,
      confidence: result.confidence,
      needsReview: result.unresolved || result.assumed || result.confidence < reviewBelow,
      note: result.note || null,
      userNote: raw.notes || null,
      timezone: opts.timezone,
      status: "pending",
      uid: stableUid(raw.source_message_ids || [], chatId, raw.title || "Event"),
    };
    stats.datePartsCostUsd += r.cost_usd;
    stats.datePartsLatencyMs += r.latency_ms;
    return ev;
  });
    } catch (err) {
      if (!(err instanceof RateLimitedError)) throw err;
      offlineReason = err.message;
      opts.onProgress?.("Daily AI limit reached — switching to offline mode");
      resolved = extractRes.events.map((raw, idx) =>
        resolveEventOffline(raw, raw.source_message_ids?.[0] ? msgById.get(raw.source_message_ids[0]) : undefined, idx, chatId, opts.timezone, reviewBelow)
      );
    }
  }
  opts.onProgress?.(
    `Date parts: ${resolved.filter((e) => !e.needsReview).length} resolved, ${resolved.filter((e) => e.needsReview).length} need review · ${stats.datePartsCostUsd.toFixed(4)}`
  );

  // ---------- Stage 4: attendees (skipped offline; best-effort live) ----------
  opts.onStage?.("attendees");
  const memberList = parsed.members;
  if (offlineReason) {
    opts.onProgress?.("Attendee detection skipped in offline mode");
  } else {
    await pool(resolved, 4, async (ev) => {
    if (ev.kind === "cancellation") return;
    const src = ev.sourceMessageIds.map((id) => msgById.get(id)).find(Boolean);
    if (!src) return;
    const srcTime = new Date(src.sent_at).getTime();
    const replies = parsed.messages
      .filter((m) => {
        const t = new Date(m.sent_at).getTime();
        return t >= srcTime && t <= srcTime + 12 * 3600_000;
      })
      .slice(0, 15);
    if (replies.length === 0 || memberList.length === 0) return;

    const attendingQuestions: Record<string, unknown> = {};
    for (const member of memberList) {
      attendingQuestions[`attending_${member}`] = {
        type: "noul",
        instructions: `Do these messages say \`${member}\` will attend \`${ev.title}\`?`,
        criteria: {
          true: "The messages say or clearly imply `member` is coming.",
          false: "The messages say `member` is not coming, or never indicate.",
        },
      };
    }
    try {
      const r = await invokeJev(
        {
          event_title: ev.title,
          source_message: `${src.sender}: ${src.text}`,
          replies: replies.map((m) => `${m.sender}: ${m.text}`).join("\n"),
        },
        attendingQuestions
      );
      stats.attendeesCostUsd += r.cost_usd;
      stats.attendeesLatencyMs += r.latency_ms;
      const attendees: Attendee[] = memberList.map((member) => {
        const a = r.answers[`attending_${member}`] as { noul?: number } | undefined;
        const p = typeof a?.noul === "number" ? a.noul : 0;
        const status: Attendee["status"] = p >= 0.7 ? "going" : p >= 0.35 ? "maybe" : "not_listed";
        return { name: member, status };
      });
      ev.attendees = attendees.filter((a) => a.status !== "not_listed");
    } catch {
      // attendee stage is best-effort; keep the event
    }
  });
  }


  // ---------- Code: link changes/cancellations, carry over "same time/place" ----------
  applyChangeLinks(resolved, msgById);

  const deduped: ChatEvent[] = [];
  for (const ev of resolved) {
    const dup = deduped.find(
      (d) =>
        d.startDate &&
        ev.startDate &&
        d.startDate === ev.startDate &&
        wordJaccard(d.title, ev.title) >= 0.5
    );
    if (dup) {
      if (ev.confidence > dup.confidence) {
        deduped.splice(deduped.indexOf(dup), 1, ev);
      }
    } else {
      deduped.push(ev);
    }
  }

  // ---------- Persist events ----------
  const { error: evErr } = await supabase.from("events").insert(
    deduped.map((ev) => ({
      chat_id: chatId,
      title: ev.title,
      kind: ev.kind,
      date_phrase: ev.datePhrase,
      time_phrase: ev.timePhrase,
      start_date: ev.startDate,
      start_time: ev.startTime,
      all_day: ev.allDay,
      location: ev.location,
      attendees: ev.attendees,
      source_message_ids: ev.sourceMessageIds,
      parts: ev.parts,
      confidence: ev.confidence,
      needs_review: ev.needsReview,
      note: ev.note,
      user_note: ev.userNote,
      status: ev.status,
      uid: ev.uid,
    }))
  );
  if (evErr) throw new Error(`Could not save events: ${evErr.message}`);

  opts.onStage?.("done");
  return {
    chatId,
    feedSlug,
    title: opts.chatTitle || "Pasted chat",
    timezone: opts.timezone,
    members: parsed.members,
    messages: views,
    events: deduped,
    stats,
    offlineReason,
  };
}

import { parseChat, type ParsedMessage } from "./chatParser";
import { pool, invokeJev, readableFunctionError, RateLimitedError, clip, safeMemberName, JEV_LIMITS } from "./jevClient";
import { resolveDatePhrase } from "./dateResolver";
import { findDatePhrase } from "./phraseExtractor";
import { stableUid } from "./icsGenerator";
import { createChat, saveInBatches, CHAT_STORE_LIMITS, type ChatWriteAccess } from "./chatStore";
import type { ChatEvent, Attendee, PipelineStats } from "./types";

export interface ChatMessageView extends ParsedMessage {
  isEvent: number | null;
  kind: string | null;
  kindConf: number | null;
}

export interface PipelineResult {
  chatId: string;
  feedSlug: string;
  writeToken: string; // needed for chat-store writes (approve/edit); kept in memory only
  title: string;
  timezone: string;
  members: string[];
  messages: ChatMessageView[];
  events: ChatEvent[];
  stats: PipelineStats;
  offlineReason: string | null;
}

export interface RawEvent {
  title: string;
  kind: string;
  date_phrase: string;
  time_phrase?: string | null;
  end_time_phrase?: string | null;
  location?: string;
  notes?: string;
  source_message_ids: string[];
  refers_to_title?: string;
}

const EVENT_KINDS = new Set(["new_event", "deadline", "change", "cancellation", "rsvp"]);
const LABEL_KINDS = new Set([...EVENT_KINDS, "none", "uncertain"]);

// Mirrors the size caps enforced by supabase/functions/extract-events.
export const EXTRACT_LIMITS = { messages: 60, textChars: 2_000, senderChars: 80, totalChars: 24_000 };

export interface RunOptions {
  chatTitle: string;
  rawChat: string;
  timezone: string;
  mode: "live" | "mock";
  reviewBelow?: number;
  onStage?: (stage: string, detail?: string) => void;
  onProgress?: (msg: string) => void;
}

type ExtractInput = { id: string; sender: string; text: string };

// Split the messages for extraction into requests that fit the server caps.
// Each request is one upstream LLM call and counts against the daily cap.
export function chunkForExtraction(messages: ExtractInput[]): ExtractInput[][] {
  const chunks: ExtractInput[][] = [];
  let current: ExtractInput[] = [];
  let chars = 0;
  for (const m of messages) {
    const item = {
      id: m.id,
      sender: clip(m.sender, EXTRACT_LIMITS.senderChars),
      text: clip(m.text, EXTRACT_LIMITS.textChars),
    };
    const size = item.sender.length + item.text.length;
    if (current.length && (current.length >= EXTRACT_LIMITS.messages || chars + size > EXTRACT_LIMITS.totalChars)) {
      chunks.push(current);
      current = [];
      chars = 0;
    }
    current.push(item);
    chars += size;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

async function extractEvents(
  messages: ExtractInput[],
  mode: "live" | "mock"
): Promise<{ events: RawEvent[]; extractor: string }> {
  const { supabase } = await import("./supabase");
  const events: RawEvent[] = [];
  let extractor = "none";
  for (const chunk of chunkForExtraction(messages)) {
    const { data, error } = await supabase.functions.invoke("extract-events", {
      body: { messages: chunk, mode },
    });
    if (error) {
      // Throws RateLimitedError when the cap is hit or the AI is unavailable.
      throw await readableFunctionError(error).then(
        (m) => new Error(m),
        (e) => e
      );
    }
    if (!data || !Array.isArray(data.events)) {
      throw new Error(data?.error || "Extractor returned an unexpected response");
    }
    events.push(...(data.events as RawEvent[]));
    extractor = String(data.extractor ?? "unknown");
  }
  return { events, extractor };
}

// Offline stand-ins used when the AI is unavailable (daily cap hit, keys not
// configured, counter down). The regex filter is a coarse approximation of
// Jev's is_event judgement; everything is capped at review confidence so a
// human sees it all. Dates use the same code resolver as live runs.

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
    // No time_phrase: the resolver reads the time from the message itself.
    events.push({ title, kind, date_phrase: phrase.phrase, source_message_ids: [m.id] });
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

// The message an event's date phrase came from: the source message that
// contains the phrase, else the first one. Its sent_at is the reference day.
export function pickSourceMessage(raw: RawEvent, msgById: Map<string, ParsedMessage>): ParsedMessage | undefined {
  const sources = (raw.source_message_ids ?? [])
    .map((id) => msgById.get(id))
    .filter((m): m is ParsedMessage => !!m);
  const phrase = (raw.date_phrase ?? "").trim().toLowerCase();
  return (phrase ? sources.find((m) => m.text.toLowerCase().includes(phrase)) : undefined) ?? sources[0];
}

// Turn an extracted event into a ChatEvent. Dates and times are resolved in
// code from the verbatim phrases against the source message's own sent_at.
export function resolveEvent(
  raw: RawEvent,
  src: ParsedMessage | undefined,
  idx: number,
  chatId: string,
  timezone: string,
  reviewBelow: number,
  opts: { offline: boolean }
): ChatEvent {
  const res = resolveDatePhrase(raw.date_phrase, raw.time_phrase, src?.text ?? "", src?.sent_at ?? null, timezone, {
    endTimePhrase: raw.end_time_phrase,
  });
  const notes = [...res.notes];
  let needsReview = res.needsReview || res.confidence < reviewBelow;
  if (src?.sent_at_estimated && res.date && res.rule !== "month_day" && res.rule !== "numeric_date") {
    notes.push("the export has no timestamps — relative dates count from the day it was pasted");
    needsReview = true;
  }
  if (opts.offline) needsReview = true;

  const parts: ChatEvent["parts"] = {
    resolver: "code",
    rule: res.rule,
    reference_date: res.referenceDate ?? "unknown",
  };
  if (res.timeSource) parts.time_source = res.timeSource;
  if (res.endTime) parts.end_time = res.endTime;

  const title = raw.title || "Event";
  return {
    id: `tmp-${idx}`,
    chatId,
    title,
    kind: EVENT_KINDS.has(raw.kind) ? raw.kind : "new_event",
    datePhrase: res.phraseUsed || raw.date_phrase || null,
    timePhrase: raw.time_phrase || res.timeText || null,
    startDate: res.date,
    startTime: res.time,
    allDay: res.allDay,
    location: raw.location || null,
    attendees: [],
    sourceMessageIds: raw.source_message_ids || [],
    parts,
    confidence: opts.offline ? Math.min(res.confidence, 0.6) : res.confidence,
    needsReview,
    note: notes.length ? notes.join("; ") : null,
    userNote: raw.notes || null,
    timezone,
    status: "pending",
    uid: stableUid(raw.source_message_ids || [], chatId, title),
  };
}

export function resolveEventOffline(
  raw: RawEvent,
  src: ParsedMessage | undefined,
  idx: number,
  chatId: string,
  timezone: string,
  reviewBelow: number
): ChatEvent {
  return resolveEvent(raw, src, idx, chatId, timezone, reviewBelow, { offline: true });
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

// Members to ask Jev about for one event. Small groups: everyone. Larger
// groups: whoever spoke in, or is named in, the reply window (server cap).
function attendeeCandidates(members: string[], replies: ParsedMessage[]): string[] {
  const safe = [...new Set(members.map(safeMemberName).filter(Boolean))];
  if (safe.length <= JEV_LIMITS.members) return safe;
  const involved = safe.filter((name) =>
    replies.some((m) => safeMemberName(m.sender) === name || m.text.toLowerCase().includes(name.toLowerCase()))
  );
  return involved.slice(0, JEV_LIMITS.members);
}

function repliesBlock(replies: ParsedMessage[]): string {
  const perLine = Math.floor(JEV_LIMITS.replies / JEV_LIMITS.replyLines) - 10;
  return replies
    .slice(0, JEV_LIMITS.replyLines)
    .map((m) => clip(`${m.sender}: ${m.text}`.replace(/\s*\n\s*/g, " "), perLine))
    .join("\n");
}

const OFFLINE_SWITCH = "AI unavailable — switching to offline mode";

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

  // ---------- Persist chat + messages (via chat-store) ----------
  let access: ChatWriteAccess;
  let feedSlug: string;
  try {
    const created = await createChat(opts.chatTitle || "Pasted chat", opts.timezone, parsed.members);
    access = { chatId: created.chatId, writeToken: created.writeToken };
    feedSlug = created.feedSlug;
  } catch (err) {
    throw new Error(`Could not save chat: ${err instanceof Error ? err.message : String(err)}`);
  }
  const chatId = access.chatId;

  try {
    await saveInBatches(
      "save_messages",
      access,
      "messages",
      parsed.messages.map((m, i) => ({
        msg_key: m.id,
        idx: i,
        sent_at: m.sent_at,
        sender: m.sender.slice(0, 80),
        text: clip(m.text, CHAT_STORE_LIMITS.messageText),
      }))
    );
  } catch (err) {
    throw new Error(`Could not save messages: ${err instanceof Error ? err.message : String(err)}`);
  }

  // ---------- Stage 1: Jev filter (or offline filter) ----------
  opts.onStage?.("filter", `${parsed.messages.length} messages`);
  let offlineReason: string | null = null;
  let isEventP: number[];
  let kindInfo: { choice: string | null; confidence: number }[];

  try {
    const filterResults = await pool(parsed.messages, 8, (msg) =>
      invokeJev({
        task: "filter",
        state: { previous_message: "", message: clip(`${msg.sender}: ${msg.text}`, JEV_LIMITS.message) },
      })
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

    // Best effort, like before: labels and telemetry never block the run.
    await Promise.all([
      saveInBatches(
        "update_message_labels",
        access,
        "labels",
        parsed.messages.map((m, i) => ({
          msg_key: m.id,
          is_event_p: Math.min(1, Math.max(0, Number(isEventP[i]) || 0)),
          kind: kindInfo[i].choice && LABEL_KINDS.has(kindInfo[i].choice!) ? kindInfo[i].choice : null,
          kind_conf: Math.min(1, Math.max(0, Number(kindInfo[i].confidence) || 0)),
        }))
      ).catch((e) => console.warn("Could not save message labels", e)),
      saveInBatches(
        "log_jev_calls",
        access,
        "calls",
        filterResults.map((r, i) => ({
          stage: "filter",
          request: { message_key: parsed.messages[i].id },
          response: r.answers,
          latency_ms: Math.round(r.latency_ms),
          input_tokens: Math.round(r.usage.input_tokens),
          cost_usd: r.cost_usd,
        }))
      ).catch((e) => console.warn("Could not log Jev calls", e)),
    ]);
  } catch (err) {
    if (!(err instanceof RateLimitedError)) throw err;
    // Daily cap hit or AI unavailable: offline filter for the whole run.
    offlineReason = err.message;
    opts.onProgress?.(OFFLINE_SWITCH);
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
    const extractInput = parsed.messages
      .filter((m) => contextIds.has(m.id))
      .map((m) => ({ id: m.id, sender: m.sender, text: m.text }));
    const extractStart = Date.now();
    try {
      extractRes = await extractEvents(extractInput, opts.mode);
    } catch (err) {
      if (!(err instanceof RateLimitedError)) throw err;
      offlineReason = err.message;
      opts.onProgress?.(OFFLINE_SWITCH);
      extractRes = { events: offlineExtract(keptIdx.map((i) => parsed.messages[i])), extractor: "offline-regex" };
    }
    stats.extractLatencyMs = Date.now() - extractStart;
    stats.extractor = extractRes.extractor;
    if (!offlineReason) {
      opts.onProgress?.(`Extracted ${extractRes.events.length} candidate events (${extractRes.extractor})`);
    }
  }

  // ---------- Stage 3: resolve dates and times in code ----------
  opts.onStage?.("date-parts");
  const msgById = new Map(parsed.messages.map((m) => [m.id, m]));
  const resolved = extractRes.events.map((raw, idx) =>
    resolveEvent(raw, pickSourceMessage(raw, msgById), idx, chatId, opts.timezone, reviewBelow, {
      offline: !!offlineReason,
    })
  );
  opts.onProgress?.(
    offlineReason
      ? `Dates resolved in code: ${resolved.length} events, all flagged for review (offline)`
      : `Dates resolved in code: ${resolved.filter((e) => !e.needsReview).length} ready, ${resolved.filter((e) => e.needsReview).length} need review`
  );

  // ---------- Stage 4: attendees (skipped offline; best-effort live) ----------
  opts.onStage?.("attendees");
  const memberList = parsed.members;
  if (offlineReason) {
    opts.onProgress?.("Attendee detection skipped in offline mode");
  } else {
    let attendeesUnavailable = false;
    await pool(resolved, 4, async (ev) => {
      if (attendeesUnavailable || ev.kind === "cancellation") return;
      const src = ev.sourceMessageIds.map((id) => msgById.get(id)).find(Boolean);
      if (!src) return;
      const srcTime = new Date(src.sent_at).getTime();
      const replies = parsed.messages
        .filter((m) => {
          const t = new Date(m.sent_at).getTime();
          return t >= srcTime && t <= srcTime + 12 * 3600_000;
        })
        .slice(0, JEV_LIMITS.replyLines);
      const members = attendeeCandidates(memberList, replies);
      if (replies.length === 0 || members.length === 0) return;

      try {
        const r = await invokeJev({
          task: "attendees",
          state: {
            event_title: clip(ev.title, JEV_LIMITS.title),
            source_message: clip(`${src.sender}: ${src.text}`, JEV_LIMITS.message),
            replies: repliesBlock(replies),
          },
          members,
        });
        stats.attendeesCostUsd += r.cost_usd;
        stats.attendeesLatencyMs += r.latency_ms;
        const attendees: Attendee[] = memberList.map((member) => {
          const a = r.answers[`attending_${safeMemberName(member)}`] as { noul?: number } | undefined;
          const p = typeof a?.noul === "number" ? a.noul : 0;
          const status: Attendee["status"] = p >= 0.7 ? "going" : p >= 0.35 ? "maybe" : "not_listed";
          return { name: member, status };
        });
        ev.attendees = attendees.filter((a) => a.status !== "not_listed");
      } catch (err) {
        // attendee stage is best-effort; keep the event. Stop asking once
        // the cap is hit or the AI is unavailable.
        if (err instanceof RateLimitedError) attendeesUnavailable = true;
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

  // ---------- Persist events (via chat-store) ----------
  try {
    await saveInBatches(
      "save_events",
      access,
      "events",
      deduped.map((ev) => ({
        title: clip(ev.title, 200),
        kind: ev.kind,
        date_phrase: ev.datePhrase ? clip(ev.datePhrase, 200) : null,
        time_phrase: ev.timePhrase ? clip(ev.timePhrase, 100) : null,
        start_date: ev.startDate,
        start_time: ev.startTime,
        all_day: ev.allDay,
        location: ev.location ? clip(ev.location, 200) : null,
        attendees: ev.attendees,
        source_message_ids: ev.sourceMessageIds.slice(0, 50),
        parts: ev.parts,
        confidence: Math.min(1, Math.max(0, ev.confidence)),
        needs_review: ev.needsReview,
        note: ev.note ? clip(ev.note, 1_000) : null,
        user_note: ev.userNote ? clip(ev.userNote, 1_000) : null,
        status: ev.status,
        uid: ev.uid,
      }))
    );
  } catch (err) {
    throw new Error(`Could not save events: ${err instanceof Error ? err.message : String(err)}`);
  }

  opts.onStage?.("done");
  return {
    chatId,
    feedSlug,
    writeToken: access.writeToken,
    title: opts.chatTitle || "Pasted chat",
    timezone: opts.timezone,
    members: parsed.members,
    messages: views,
    events: deduped,
    stats,
    offlineReason,
  };
}

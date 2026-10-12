import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";

// The only write path for chats, messages, events and jev_calls. The anon key
// can read those tables but cannot write them (see the lock_down_data_tables
// migration). Writes are limited to the actions below, with whitelisted and
// size-checked fields. `create_chat` hands back a random write token (only its
// SHA-256 hash is stored); every other action must present it for that chat.

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const MAX_BODY_CHARS = 1_000_000;
const MAX_MEMBERS = 200;
const MAX_MESSAGES_PER_REQUEST = 500;
const MAX_MESSAGE_TEXT = 4_000;
const MAX_MESSAGE_CHARS_PER_REQUEST = 600_000;
const MAX_LABELS_PER_REQUEST = 1_000;
const MAX_CALLS_PER_REQUEST = 500;
const MAX_EVENTS_PER_REQUEST = 500;

const STATUSES = new Set(["pending", "approved", "rejected", "cancelled"]);
const KINDS = new Set(["new_event", "deadline", "change", "cancellation", "rsvp"]);
const LABEL_KINDS = new Set([...KINDS, "none", "uncertain"]);
const STAGES = new Set(["filter", "attendees"]);
const ATTENDEE_STATUSES = new Set(["going", "maybe", "not_listed"]);
const EVENT_PATCH_FIELDS = new Set(["status", "title", "start_date", "start_time", "all_day", "location", "user_note"]);
const HUMAN_EDIT_FIELDS = ["title", "start_date", "start_time", "all_day", "location", "user_note"];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const MSG_KEY_RE = /^M\d{1,6}$/;
const UID_RE = /^[A-Za-z0-9._@-]{1,200}$/;
const TZ_RE = /^[A-Za-z0-9_+\-/]{1,64}$/;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

const bad = (message: string) => new HttpError(400, message);

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function onlyKeys(obj: Record<string, unknown>, allowed: string[], where: string) {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) throw bad(`${where}: ${key} is not allowed`);
  }
}

function optText(v: unknown, max: number, field: string): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== "string") throw bad(`${field} must be a string`);
  if (v.length > max) throw new HttpError(413, `${field} is longer than ${max} characters`);
  return v;
}

function reqText(v: unknown, max: number, field: string): string {
  const s = optText(v, max, field);
  if (s === null || !s.trim()) throw bad(`${field} is required`);
  return s;
}

function prob(v: unknown, field: string): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1) throw bad(`${field} must be between 0 and 1`);
  return v;
}

function int(v: unknown, min: number, max: number, field: string): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) throw bad(`${field} is out of range`);
  return v;
}

function num(v: unknown, min: number, max: number, field: string): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) throw bad(`${field} is out of range`);
  return v;
}

function bool(v: unknown, field: string): boolean {
  if (typeof v !== "boolean") throw bad(`${field} must be true or false`);
  return v;
}

function isoDate(v: unknown, field: string): string | null {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v)) throw bad(`${field} must be YYYY-MM-DD`);
  const [y, m, d] = v.split("-").map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== m - 1 || probe.getUTCDate() !== d) {
    throw bad(`${field} is not a real date`);
  }
  return v;
}

function clockTime(v: unknown, field: string): string | null {
  if (v === null || v === undefined || v === "") return null;
  const m = typeof v === "string" ? v.match(/^(\d{2}):(\d{2})(?::(\d{2}))?$/) : null;
  if (!m || Number(m[1]) > 23 || Number(m[2]) > 59 || Number(m[3] ?? 0) > 59) throw bad(`${field} must be HH:MM[:SS]`);
  return `${m[1]}:${m[2]}:${m[3] ?? "00"}`;
}

function smallJson(v: unknown, max: number, field: string): unknown {
  if (v === null || v === undefined) return null;
  const s = JSON.stringify(v);
  if (s === undefined) throw bad(`${field} must be JSON`);
  if (s.length > max) throw new HttpError(413, `${field} is larger than ${max} characters`);
  return v;
}

function list(v: unknown, max: number, field: string): unknown[] {
  if (!Array.isArray(v)) throw bad(`${field} must be an array`);
  if (v.length > max) throw new HttpError(413, `At most ${max} ${field} per request`);
  return v;
}

function validTimezone(v: unknown): string {
  if (typeof v !== "string" || !TZ_RE.test(v)) throw bad("timezone must be an IANA name");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: v });
  } catch {
    throw bad("timezone must be an IANA name");
  }
  return v;
}

function randomHex(bytes: number): string {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
}

function randomToken(): string {
  const a = new Uint8Array(32);
  crypto.getRandomValues(a);
  return btoa(String.fromCharCode(...a)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function sha256Hex(s: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function dbError(action: string, error: unknown): HttpError {
  console.error(`[chat-store] ${action} failed:`, error);
  return new HttpError(500, `Could not ${action.replace(/_/g, " ")}`);
}

async function authorize(admin: SupabaseClient, body: Record<string, unknown>): Promise<string> {
  const chatId = body.chat_id;
  const token = body.write_token;
  if (typeof chatId !== "string" || !UUID_RE.test(chatId)) throw bad("chat_id must be a uuid");
  if (typeof token !== "string" || !TOKEN_RE.test(token)) throw new HttpError(403, "Not allowed to change this chat");
  const { data, error } = await admin.from("chats").select("write_token_hash").eq("id", chatId).maybeSingle();
  if (error) throw dbError("check access", error);
  const stored = (data as { write_token_hash?: string | null } | null)?.write_token_hash;
  if (!stored || !timingSafeEqual(await sha256Hex(token), stored)) {
    throw new HttpError(403, "Not allowed to change this chat");
  }
  return chatId;
}

async function createChat(admin: SupabaseClient, body: Record<string, unknown>) {
  onlyKeys(body, ["action", "title", "timezone", "members"], "create_chat");
  const title = optText(body.title, 120, "title")?.trim() || "Pasted chat";
  const timezone = validTimezone(body.timezone ?? "UTC");
  const members = list(body.members ?? [], MAX_MEMBERS, "members").map((m) => reqText(m, 80, "member"));
  const feedSlug = randomHex(16); // 128 bits: the unguessable token in the public ICS feed URL
  const writeToken = randomToken(); // 256 bits: returned once, only the hash is stored
  const { data, error } = await admin
    .from("chats")
    .insert({ title, timezone, members, feed_slug: feedSlug, write_token_hash: await sha256Hex(writeToken) })
    .select("id")
    .single();
  if (error || !data) throw dbError("create_chat", error);
  return { chat_id: (data as { id: string }).id, feed_slug: feedSlug, write_token: writeToken };
}

async function saveMessages(admin: SupabaseClient, body: Record<string, unknown>) {
  onlyKeys(body, ["action", "chat_id", "write_token", "messages"], "save_messages");
  const chatId = await authorize(admin, body);
  let chars = 0;
  const rows = list(body.messages, MAX_MESSAGES_PER_REQUEST, "messages").map((m) => {
    if (!isObject(m)) throw bad("Each message must be an object");
    onlyKeys(m, ["msg_key", "idx", "sent_at", "sender", "text"], "message");
    if (typeof m.msg_key !== "string" || !MSG_KEY_RE.test(m.msg_key)) throw bad("msg_key must look like M001");
    const sentAt = optText(m.sent_at, 40, "sent_at");
    if (!sentAt || Number.isNaN(Date.parse(sentAt))) throw bad("sent_at must be an ISO timestamp");
    const text = reqText(m.text, MAX_MESSAGE_TEXT, "text");
    chars += text.length;
    if (chars > MAX_MESSAGE_CHARS_PER_REQUEST) throw new HttpError(413, "Too much message text in one request");
    return {
      chat_id: chatId,
      msg_key: m.msg_key,
      idx: int(m.idx, 0, 1_000_000, "idx") ?? 0,
      sent_at: new Date(sentAt).toISOString(),
      sender: optText(m.sender, 80, "sender") ?? "",
      text,
    };
  });
  if (rows.length === 0) return { saved: 0 };
  const { error } = await admin.from("messages").insert(rows);
  if (error) throw dbError("save_messages", error);
  return { saved: rows.length };
}

async function updateMessageLabels(admin: SupabaseClient, body: Record<string, unknown>) {
  onlyKeys(body, ["action", "chat_id", "write_token", "labels"], "update_message_labels");
  const chatId = await authorize(admin, body);
  const labels = new Map<string, { is_event_p: number | null; kind: string | null; kind_conf: number | null }>();
  for (const l of list(body.labels, MAX_LABELS_PER_REQUEST, "labels")) {
    if (!isObject(l)) throw bad("Each label must be an object");
    onlyKeys(l, ["msg_key", "is_event_p", "kind", "kind_conf"], "label");
    if (typeof l.msg_key !== "string" || !MSG_KEY_RE.test(l.msg_key)) throw bad("msg_key must look like M001");
    const kind = optText(l.kind, 20, "kind");
    if (kind !== null && !LABEL_KINDS.has(kind)) throw bad("kind is not a known label");
    labels.set(l.msg_key, { is_event_p: prob(l.is_event_p, "is_event_p"), kind, kind_conf: prob(l.kind_conf, "kind_conf") });
  }
  if (labels.size === 0) return { updated: 0 };

  // Upsert needs the full row, so merge the labels into the stored messages.
  const { data: existing, error: readErr } = await admin
    .from("messages")
    .select("msg_key, idx, sent_at, sender, text")
    .eq("chat_id", chatId)
    .in("msg_key", [...labels.keys()]);
  if (readErr) throw dbError("update_message_labels", readErr);
  const rows = (existing ?? []).map((m: Record<string, unknown>) => ({
    chat_id: chatId,
    ...m,
    ...labels.get(m.msg_key as string),
  }));
  if (rows.length === 0) return { updated: 0 };
  const { error } = await admin.from("messages").upsert(rows, { onConflict: "chat_id,msg_key" });
  if (error) throw dbError("update_message_labels", error);
  return { updated: rows.length };
}

async function logJevCalls(admin: SupabaseClient, body: Record<string, unknown>) {
  onlyKeys(body, ["action", "chat_id", "write_token", "calls"], "log_jev_calls");
  const chatId = await authorize(admin, body);
  const rows = list(body.calls, MAX_CALLS_PER_REQUEST, "calls").map((c) => {
    if (!isObject(c)) throw bad("Each call must be an object");
    onlyKeys(c, ["stage", "request", "response", "latency_ms", "input_tokens", "cost_usd"], "call");
    if (typeof c.stage !== "string" || !STAGES.has(c.stage)) throw bad("stage must be filter or attendees");
    return {
      chat_id: chatId,
      stage: c.stage,
      request: smallJson(c.request, 2_000, "request"),
      response: smallJson(c.response, 4_000, "response"),
      latency_ms: int(c.latency_ms, 0, 600_000, "latency_ms"),
      input_tokens: int(c.input_tokens, 0, 1_000_000, "input_tokens"),
      cost_usd: num(c.cost_usd, 0, 10, "cost_usd"),
    };
  });
  if (rows.length === 0) return { logged: 0 };
  const { error } = await admin.from("jev_calls").insert(rows);
  if (error) throw dbError("log_jev_calls", error);
  return { logged: rows.length };
}

const EVENT_FIELDS = [
  "title", "kind", "date_phrase", "time_phrase", "start_date", "start_time", "all_day", "location",
  "attendees", "source_message_ids", "parts", "confidence", "needs_review", "note", "user_note", "status", "uid",
];

function eventRow(e: unknown, chatId: string) {
  if (!isObject(e)) throw bad("Each event must be an object");
  onlyKeys(e, EVENT_FIELDS, "event");
  const kind = e.kind ?? "new_event";
  if (typeof kind !== "string" || !KINDS.has(kind)) throw bad("kind is not a known event kind");
  const status = e.status ?? "pending";
  if (typeof status !== "string" || !STATUSES.has(status)) throw bad("status is not a known status");
  if (typeof e.uid !== "string" || !UID_RE.test(e.uid)) throw bad("uid is invalid");
  const attendees = list(e.attendees ?? [], 100, "attendees").map((a) => {
    if (!isObject(a)) throw bad("Each attendee must be an object");
    onlyKeys(a, ["name", "status"], "attendee");
    if (typeof a.status !== "string" || !ATTENDEE_STATUSES.has(a.status)) throw bad("attendee status is invalid");
    return { name: reqText(a.name, 80, "attendee name"), status: a.status };
  });
  const sourceIds = list(e.source_message_ids ?? [], 50, "source_message_ids").map((id) => {
    if (typeof id !== "string" || !MSG_KEY_RE.test(id)) throw bad("source_message_ids must look like M001");
    return id;
  });
  return {
    chat_id: chatId,
    title: reqText(e.title, 200, "title"),
    kind,
    date_phrase: optText(e.date_phrase, 200, "date_phrase"),
    time_phrase: optText(e.time_phrase, 100, "time_phrase"),
    start_date: isoDate(e.start_date, "start_date"),
    start_time: clockTime(e.start_time, "start_time"),
    all_day: bool(e.all_day ?? false, "all_day"),
    location: optText(e.location, 200, "location"),
    attendees,
    source_message_ids: sourceIds,
    parts: smallJson(e.parts, 8_000, "parts"),
    confidence: prob(e.confidence, "confidence") ?? 0,
    needs_review: bool(e.needs_review ?? false, "needs_review"),
    note: optText(e.note, 1_000, "note"),
    user_note: optText(e.user_note, 1_000, "user_note"),
    status,
    uid: e.uid,
  };
}

async function saveEvents(admin: SupabaseClient, body: Record<string, unknown>) {
  onlyKeys(body, ["action", "chat_id", "write_token", "events"], "save_events");
  const chatId = await authorize(admin, body);
  const rows = list(body.events, MAX_EVENTS_PER_REQUEST, "events").map((e) => eventRow(e, chatId));
  if (rows.length === 0) return { saved: 0 };
  const { error } = await admin.from("events").insert(rows);
  if (error) throw dbError("save_events", error);
  return { saved: rows.length };
}

async function updateEvent(admin: SupabaseClient, body: Record<string, unknown>) {
  onlyKeys(body, ["action", "chat_id", "write_token", "uid", "patch"], "update_event");
  const chatId = await authorize(admin, body);
  if (typeof body.uid !== "string" || !UID_RE.test(body.uid)) throw bad("uid is invalid");
  const patch = body.patch;
  if (!isObject(patch) || Object.keys(patch).length === 0) throw bad("patch must be a non-empty object");
  for (const key of Object.keys(patch)) {
    if (!EVENT_PATCH_FIELDS.has(key)) throw bad(`patch.${key} cannot be changed`);
  }

  const row: Record<string, unknown> = {};
  if ("status" in patch) {
    if (typeof patch.status !== "string" || !STATUSES.has(patch.status)) throw bad("status is not a known status");
    row.status = patch.status;
  }
  if ("title" in patch) row.title = reqText(patch.title, 200, "title").trim();
  if ("start_date" in patch) row.start_date = isoDate(patch.start_date, "start_date");
  if ("start_time" in patch) row.start_time = clockTime(patch.start_time, "start_time");
  if ("all_day" in patch) row.all_day = bool(patch.all_day, "all_day");
  if ("location" in patch) row.location = optText(patch.location, 200, "location");
  if ("user_note" in patch) row.user_note = optText(patch.user_note, 1_000, "user_note");
  // A human edit is a review.
  if (HUMAN_EDIT_FIELDS.some((f) => f in patch)) row.needs_review = false;

  const { data, error } = await admin.from("events").update(row).eq("chat_id", chatId).eq("uid", body.uid).select("id");
  if (error) throw dbError("update_event", error);
  if (!data || data.length === 0) throw new HttpError(404, "Event not found");
  return { updated: data.length };
}

const ACTIONS: Record<string, (admin: SupabaseClient, body: Record<string, unknown>) => Promise<unknown>> = {
  create_chat: createChat,
  save_messages: saveMessages,
  update_message_labels: updateMessageLabels,
  log_jev_calls: logJevCalls,
  save_events: saveEvents,
  update_event: updateEvent,
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const declared = Number(req.headers.get("content-length") ?? "0");
    if (declared > MAX_BODY_CHARS * 4) throw new HttpError(413, "Request is too large");
    const raw = await req.text();
    if (raw.length > MAX_BODY_CHARS) throw new HttpError(413, "Request is too large");
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      throw bad("Body must be JSON");
    }
    if (!isObject(body)) throw bad("Body must be an object");
    const handler = typeof body.action === "string" && Object.hasOwn(ACTIONS, body.action) ? ACTIONS[body.action] : null;
    if (!handler) throw bad("Unknown action");

    const url = Deno.env.get("SUPABASE_URL");
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!url || !key) throw new HttpError(503, "Storage is not configured");
    const admin = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

    return json({ ok: true, ...((await handler(admin, body)) as Record<string, unknown>) });
  } catch (err) {
    if (err instanceof HttpError) return json({ error: err.message }, err.status);
    console.error("[chat-store] unexpected error:", err);
    return json({ error: "Could not save that change" }, 500);
  }
});

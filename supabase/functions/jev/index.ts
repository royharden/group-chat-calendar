import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@2.57.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const FUNCTION_NAME = "jev";
const MODEL = "jev-1.13.0";
const JEV_URL = "https://api.typesafe.ai/v1/systemone";
const COST_PER_INPUT_TOKEN = 0.042 / 1_000_000;
const DAILY_CALL_CAP = 200; // whole app, shared with extract-events
const MAX_ATTEMPTS = 3;

// Request size caps. The client trims to fit; anything larger is refused.
const MAX_BODY_CHARS = 16_000;
const MAX_MESSAGE_CHARS = 2_000;
const MAX_TITLE_CHARS = 200;
const MAX_REPLIES_CHARS = 6_000;
const MAX_REPLY_LINES = 15;
const MAX_MEMBERS = 30;
const MAX_MEMBER_CHARS = 60;

type Questions = Record<string, unknown>;

// Only these two question sets can be sent to Jev. The client picks a task
// and supplies the inputs; it can never send its own questions.
const FILTER_QUESTIONS: Questions = {
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

function attendeeQuestions(members: string[], eventTitle: string): Questions {
  // eslint-disable-next-line no-control-regex -- strip control characters on purpose
  const title = eventTitle.replace(/[`\u0000-\u001f\u007f]+/g, " ").trim();
  const questions: Questions = {};
  for (const member of members) {
    questions[`attending_${member}`] = {
      type: "noul",
      instructions: `Do these messages say \`${member}\` will attend \`${title}\`?`,
      criteria: {
        true: "The messages say or clearly imply `member` is coming.",
        false: "The messages say `member` is not coming, or never indicate.",
      },
    };
  }
  return questions;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// 503 + rate_limited: the client switches to offline mode with this notice.
// Used for every "can't safely call the AI" case: missing/rejected key,
// counter error, or a null/missing counter result (fail closed).
function unavailable(reason: string): Response {
  console.error(`[${FUNCTION_NAME}] AI unavailable: ${reason}`);
  return json(
    {
      error:
        "The AI helpers are unavailable right now, so this run used offline mode: events were found with the built-in rules.",
      rate_limited: true,
      offline: true,
      daily_cap: DAILY_CALL_CAP,
    },
    503
  );
}

function rateLimited(): Response {
  return json(
    {
      error: `You've used all ${DAILY_CALL_CAP} free AI calls for today. The app is now running in sample mode — try again tomorrow, or explore the bundled sample chats.`,
      rate_limited: true,
      calls_used: DAILY_CALL_CAP,
      daily_cap: DAILY_CALL_CAP,
    },
    429
  );
}

class RequestError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function readJson(req: Request, maxChars: number): Promise<unknown> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > maxChars * 4) throw new RequestError(413, "Request is too large");
  const text = await req.text();
  if (text.length > maxChars) throw new RequestError(413, "Request is too large");
  try {
    return JSON.parse(text);
  } catch {
    throw new RequestError(400, "Body must be JSON");
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function exactStringFields(
  value: unknown,
  limits: Record<string, { max: number; required: boolean }>
): Record<string, string> {
  if (!isObject(value)) throw new RequestError(400, "state must be an object");
  for (const key of Object.keys(value)) {
    if (!(key in limits)) throw new RequestError(400, `state.${key} is not allowed`);
  }
  const out: Record<string, string> = {};
  for (const [key, { max, required }] of Object.entries(limits)) {
    const v = value[key] ?? "";
    if (typeof v !== "string") throw new RequestError(400, `state.${key} must be a string`);
    if (required && !v.trim()) throw new RequestError(400, `state.${key} is required`);
    if (v.length > max) throw new RequestError(413, `state.${key} is longer than ${max} characters`);
    out[key] = v;
  }
  return out;
}

function parseMembers(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) throw new RequestError(400, "members must be a non-empty array");
  if (value.length > MAX_MEMBERS) throw new RequestError(413, `At most ${MAX_MEMBERS} members per request`);
  const seen = new Set<string>();
  for (const m of value) {
    if (typeof m !== "string") throw new RequestError(400, "members must be strings");
    const name = m.trim();
    // eslint-disable-next-line no-control-regex -- strip control characters on purpose
    if (!name || name.length > MAX_MEMBER_CHARS || /[`\u0000-\u001f\u007f]/.test(name)) {
      throw new RequestError(400, "Invalid member name");
    }
    seen.add(name);
  }
  return [...seen];
}

interface JevRequest {
  state: Record<string, string>;
  questions: Questions;
}

function parseJevRequest(body: unknown): JevRequest {
  if (!isObject(body)) throw new RequestError(400, "Body must be an object");
  if ("questions" in body) throw new RequestError(400, "questions are chosen by the server");
  const allowedTop = new Set(["task", "state", "members"]);
  for (const key of Object.keys(body)) {
    if (!allowedTop.has(key)) throw new RequestError(400, `${key} is not allowed`);
  }

  if (body.task === "filter") {
    if ("members" in body) throw new RequestError(400, "members is not allowed for filter");
    const state = exactStringFields(body.state, {
      previous_message: { max: MAX_MESSAGE_CHARS, required: false },
      message: { max: MAX_MESSAGE_CHARS, required: true },
    });
    return { state, questions: FILTER_QUESTIONS };
  }

  if (body.task === "attendees") {
    const state = exactStringFields(body.state, {
      event_title: { max: MAX_TITLE_CHARS, required: true },
      source_message: { max: MAX_MESSAGE_CHARS, required: true },
      replies: { max: MAX_REPLIES_CHARS, required: false },
    });
    if (state.replies.split("\n").length > MAX_REPLY_LINES) {
      throw new RequestError(413, `At most ${MAX_REPLY_LINES} reply lines`);
    }
    const members = parseMembers(body.members);
    return { state, questions: attendeeQuestions(members, state.event_title) };
  }

  throw new RequestError(400, "task must be 'filter' or 'attendees'");
}

function serviceClient(): SupabaseClient | null {
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

type Slot = { ok: true; count: number } | { ok: false; response: Response };

// Count ONE upstream fetch against the app-wide daily cap. Must run before
// every fetch to Jev, retries included. Anything other than a valid count
// fails closed.
async function reserveCall(admin: SupabaseClient): Promise<Slot> {
  let data: unknown = null;
  let error: unknown = null;
  try {
    ({ data, error } = await admin.rpc("increment_usage", { fn_name: FUNCTION_NAME, cap: DAILY_CALL_CAP }));
  } catch (err) {
    error = err;
  }
  if (error) {
    const detail = error instanceof Error ? error.message : JSON.stringify(error);
    return { ok: false, response: unavailable(`usage counter error: ${detail}`) };
  }
  const count =
    typeof data === "number" ? data : typeof data === "string" && /^-?\d+$/.test(data) ? Number(data) : NaN;
  if (count === -1 || count > DAILY_CALL_CAP) return { ok: false, response: rateLimited() };
  if (!Number.isInteger(count) || count < 1) {
    return { ok: false, response: unavailable(`usage counter returned ${JSON.stringify(data ?? null)}`) };
  }
  return { ok: true, count };
}

async function callJev(request: JevRequest, apiKey: string, admin: SupabaseClient): Promise<Response> {
  let lastErr: Error | null = null;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(400 * 2 ** (attempt - 1));

    const slot = await reserveCall(admin);
    if (!slot.ok) return slot.response;

    const started = Date.now();
    let res: Response;
    try {
      res = await fetch(JEV_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: MODEL, state: request.state, questions: request.questions }),
      });
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      continue;
    }

    if (res.status === 429 || res.status === 529) {
      await res.body?.cancel();
      lastErr = new Error(`Rate limited (${res.status})`);
      continue;
    }
    if (res.status === 401 || res.status === 403) {
      await res.body?.cancel();
      return unavailable("the Jev API key was rejected");
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      console.error(`[${FUNCTION_NAME}] Jev API error ${res.status}: ${text.slice(0, 500)}`);
      return json({ error: `Jev API error ${res.status}. Try again in a moment.` }, 502);
    }

    const data = await res.json().catch(() => null);
    if (!isObject(data)) return json({ error: "Jev returned an unexpected response" }, 502);
    const latency = Date.now() - started;
    const model = typeof data.model === "string" ? data.model : MODEL;
    const usage = isObject(data.usage) ? data.usage : {};
    const inputTokens = Number(usage.input_tokens ?? 0) || 0;
    const rawAnswers = isObject(data.answers) ? data.answers : {};
    const answers: Record<string, unknown> = {};
    for (const key of Object.keys(request.questions)) {
      if (key in rawAnswers) answers[key] = rawAnswers[key];
    }
    return json({
      answers,
      model,
      usage: { input_tokens: inputTokens, output_tokens: Number(usage.output_tokens ?? 0) || 0 },
      latency_ms: latency,
      cost_usd: inputTokens * COST_PER_INPUT_TOKEN,
      calls_used: slot.count,
      daily_cap: DAILY_CALL_CAP,
    });
  }

  console.error(`[${FUNCTION_NAME}] giving up after ${MAX_ATTEMPTS} attempts: ${lastErr?.message}`);
  return json({ error: "Jev is not responding right now. Try again in a moment." }, 502);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let request: JevRequest;
  try {
    request = parseJevRequest(await readJson(req, MAX_BODY_CHARS));
  } catch (err) {
    if (err instanceof RequestError) return json({ error: err.message }, err.status);
    return json({ error: "Bad request" }, 400);
  }

  const apiKey = Deno.env.get("TYPESAFE_API_KEY");
  if (!apiKey) return unavailable("TYPESAFE_API_KEY is not set");
  const admin = serviceClient();
  if (!admin) return unavailable("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are not set");

  try {
    return await callJev(request, apiKey, admin);
  } catch (err) {
    console.error(`[${FUNCTION_NAME}] unexpected error:`, err);
    return json({ error: "Jev is not responding right now. Try again in a moment." }, 502);
  }
});

// Handler tests for the edge functions. No network: Deno.serve is stubbed to
// capture each handler and fetch is stubbed to fake PostgREST, Jev and OpenAI.
// Run with: npm run test:functions   (requires Deno)
import { assert, assertEquals, assertMatch } from "jsr:@std/assert@1";

type Handler = (req: Request) => Response | Promise<Response>;
const handlers: Record<string, Handler> = {};
let loading = "";
(Deno as unknown as { serve: unknown }).serve = (h: Handler) => {
  handlers[loading] = h;
  return { finished: Promise.resolve(), shutdown: () => Promise.resolve() };
};
loading = "jev";
await import("../jev/index.ts");
loading = "extract-events";
await import("../extract-events/index.ts");
loading = "chat-store";
await import("../chat-store/index.ts");
loading = "ics-feed";
await import("../ics-feed/index.ts");

const SUPABASE_URL = "http://supabase.test";
const OPENAI_BASE = "http://openai.test/v1";

interface Seen {
  method: string;
  url: URL;
  headers: Headers;
  body: string;
}
let seen: Seen[] = [];
let route: (r: Seen) => Response | Promise<Response> = () => new Response("unexpected", { status: 599 });

globalThis.fetch = (async (input: Request | URL | string, init?: RequestInit) => {
  const req = new Request(input, init);
  const r: Seen = { method: req.method, url: new URL(req.url), headers: req.headers, body: await req.text() };
  seen.push(r);
  return route(r);
}) as typeof fetch;

const jsonRes = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const isCounter = (r: Seen) => r.url.pathname === "/rest/v1/rpc/increment_usage";
const isJev = (r: Seen) => r.url.host === "api.typesafe.ai";
const isOpenAI = (r: Seen) => r.url.host === "openai.test";
const count = (pred: (r: Seen) => boolean) => seen.filter(pred).length;

function env(vars: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(vars)) {
    if (v === undefined) Deno.env.delete(k);
    else Deno.env.set(k, v);
  }
}

function reset(vars: Record<string, string | undefined> = {}) {
  seen = [];
  env({
    SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: "service-role-test",
    TYPESAFE_API_KEY: "jev-test",
    OPENAI_API_KEY: "openai-test",
    OPENAI_BASE_URL: OPENAI_BASE,
    OPENAI_MODEL: undefined,
    ...vars,
  });
}

function post(fn: string, body: unknown): Promise<Response> {
  return Promise.resolve(
    handlers[fn](
      new Request(`http://fn.test/${fn}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: typeof body === "string" ? body : JSON.stringify(body),
      })
    )
  );
}

const filterBody = { task: "filter", state: { previous_message: "", message: "Mom: practice at 5 tomorrow" } };
const jevOk = (answers: Record<string, unknown> = { is_event: { noul: 0.9 }, kind: { choice: "new_event", confidence: 0.8 } }) =>
  jsonRes({ answers, usage: { input_tokens: 100, output_tokens: 3 }, model: "jev-1.13.0" });

// ---------------------------------------------------------------- jev ----

Deno.test("jev: missing TYPESAFE_API_KEY -> 503 rate_limited, nothing counted or called", async () => {
  reset({ TYPESAFE_API_KEY: undefined });
  route = () => jevOk();
  const res = await post("jev", filterBody);
  assertEquals(res.status, 503);
  assertEquals((await res.json()).rate_limited, true);
  assertEquals(seen.length, 0);
});

Deno.test("jev: missing service-role env -> 503 rate_limited", async () => {
  reset({ SUPABASE_SERVICE_ROLE_KEY: undefined });
  route = () => jevOk();
  const res = await post("jev", filterBody);
  assertEquals(res.status, 503);
  assertEquals((await res.json()).rate_limited, true);
  assertEquals(count(isJev), 0);
});

Deno.test("jev: refuses client questions, unknown tasks/keys and oversize input", async () => {
  reset();
  route = () => jevOk();
  const cases: [unknown, number][] = [
    [{ ...filterBody, questions: { evil: { type: "noul", instructions: "anything" } } }, 400],
    [{ task: "summarize", state: { message: "x" } }, 400],
    [{ ...filterBody, model: "gpt-x" }, 400],
    [{ task: "filter", state: { message: "x", system: "y" } }, 400],
    [{ task: "filter", state: { message: "x".repeat(2_001) } }, 413],
    [{ task: "attendees", state: { event_title: "t", source_message: "s", replies: "a\n".repeat(20) }, members: ["Mom"] }, 413],
    [{ task: "attendees", state: { event_title: "t", source_message: "s", replies: "" }, members: Array.from({ length: 31 }, (_, i) => `P${i}`) }, 413],
    [{ task: "attendees", state: { event_title: "t", source_message: "s", replies: "" }, members: ["bad`name"] }, 400],
    ["x".repeat(16_001), 413],
  ];
  for (const [body, status] of cases) {
    const res = await post("jev", body);
    assertEquals(res.status, status, JSON.stringify(body).slice(0, 80));
    await res.body?.cancel();
  }
  assertEquals(seen.length, 0, "nothing counted or fetched for invalid requests");
});

Deno.test("jev: counter -1 -> 429 rate_limited, no upstream call", async () => {
  reset();
  route = (r) => (isCounter(r) ? jsonRes(-1) : jevOk());
  const res = await post("jev", filterBody);
  assertEquals(res.status, 429);
  assertEquals((await res.json()).rate_limited, true);
  assertEquals(count(isJev), 0);
});

Deno.test("jev: null / missing / garbage counter result fails closed (503)", async () => {
  for (const body of ["null", "", '"abc"', "{}", "0"]) {
    reset();
    route = (r) =>
      isCounter(r) ? new Response(body, { status: 200, headers: { "Content-Type": "application/json" } }) : jevOk();
    const res = await post("jev", filterBody);
    assertEquals(res.status, 503, `counter body ${JSON.stringify(body)}`);
    assertEquals((await res.json()).rate_limited, true);
    assertEquals(count(isJev), 0);
  }
});

Deno.test("jev: counter RPC error or network failure fails closed (503)", async () => {
  reset();
  route = (r) => (isCounter(r) ? jsonRes({ message: "permission denied", code: "42501" }, 401) : jevOk());
  let res = await post("jev", filterBody);
  assertEquals(res.status, 503);
  assertEquals((await res.json()).rate_limited, true);

  reset();
  route = (r) => {
    if (isCounter(r)) throw new TypeError("connection refused");
    return jevOk();
  };
  res = await post("jev", filterBody);
  assertEquals(res.status, 503);
  assertEquals((await res.json()).rate_limited, true);
  assertEquals(count(isJev), 0);
});

Deno.test("jev: filter happy path uses the server's questions and counts once", async () => {
  reset();
  route = (r) => (isCounter(r) ? jsonRes(5) : jevOk({ is_event: { noul: 0.9 }, kind: { choice: "new_event" }, injected: 1 }));
  const res = await post("jev", filterBody);
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.calls_used, 5);
  assertEquals(Object.keys(body.answers).sort(), ["is_event", "kind"]);
  const counter = seen.find(isCounter)!;
  assertEquals(JSON.parse(counter.body), { fn_name: "jev", cap: 200 });
  assertEquals(counter.headers.get("Authorization"), "Bearer service-role-test");
  const upstream = JSON.parse(seen.find(isJev)!.body);
  assertEquals(Object.keys(upstream.questions).sort(), ["is_event", "kind"]);
  assertEquals(upstream.state, filterBody.state);
  assertEquals(seen.map((r) => (isCounter(r) ? "count" : "jev")), ["count", "jev"]);
});

Deno.test("jev: every retry is counted before it is sent", async () => {
  reset();
  let jevCalls = 0;
  route = (r) => {
    if (isCounter(r)) return jsonRes(count(isCounter));
    jevCalls++;
    return jevCalls < 3 ? jsonRes({ error: "busy" }, 429) : jevOk();
  };
  const res = await post("jev", filterBody);
  assertEquals(res.status, 200);
  await res.body?.cancel();
  assertEquals(seen.map((r) => (isCounter(r) ? "count" : "jev")), ["count", "jev", "count", "jev", "count", "jev"]);
});

Deno.test("jev: cap reached during a retry stops before the next upstream call", async () => {
  reset();
  route = (r) => (isCounter(r) ? jsonRes(count(isCounter) === 1 ? 200 : -1) : jsonRes({}, 529));
  const res = await post("jev", filterBody);
  assertEquals(res.status, 429);
  assertEquals((await res.json()).rate_limited, true);
  assertEquals(count(isJev), 1);
});

Deno.test("jev: a rejected key switches to offline mode", async () => {
  reset();
  route = (r) => (isCounter(r) ? jsonRes(1) : jsonRes({ error: "bad key" }, 401));
  const res = await post("jev", filterBody);
  assertEquals(res.status, 503);
  assertEquals((await res.json()).rate_limited, true);
});

Deno.test("jev: attendees questions are built server-side from members", async () => {
  reset();
  route = (r) => (isCounter(r) ? jsonRes(9) : jevOk({ "attending_Aunt Rosa": { noul: 0.9 } }));
  const res = await post("jev", {
    task: "attendees",
    state: { event_title: "Grandma's `dinner`", source_message: "Mom: dinner Sat", replies: "Aunt Rosa: I'll be there" },
    members: ["Aunt Rosa", "Dad"],
  });
  assertEquals(res.status, 200);
  await res.body?.cancel();
  const upstream = JSON.parse(seen.find(isJev)!.body);
  assertEquals(Object.keys(upstream.questions), ["attending_Aunt Rosa", "attending_Dad"]);
  assertEquals(upstream.questions["attending_Dad"].instructions, "Do these messages say `Dad` will attend `Grandma's  dinner`?");
});

// ------------------------------------------------------ extract-events ----

const msgs = [
  { id: "M001", sender: "Mom", text: "Practice moved to next Tuesday at 5" },
  { id: "M002", sender: "Dad", text: "ok" },
];
const openAiOk = (events: unknown[]) =>
  jsonRes({ choices: [{ message: { content: JSON.stringify({ events }) } }] });

Deno.test("extract-events: missing OPENAI_API_KEY in live mode -> 503 rate_limited", async () => {
  reset({ OPENAI_API_KEY: undefined });
  route = () => openAiOk([]);
  const res = await post("extract-events", { messages: msgs, mode: "live" });
  assertEquals(res.status, 503);
  assertEquals((await res.json()).rate_limited, true);
  assertEquals(seen.length, 0);
});

Deno.test("extract-events: mock mode makes no counted or upstream call", async () => {
  reset({ OPENAI_API_KEY: undefined });
  route = () => openAiOk([]);
  const res = await post("extract-events", { messages: msgs, mode: "mock" });
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.extractor, "mock-regex");
  assertEquals(body.events[0].date_phrase, "next Tuesday");
  assertEquals(seen.length, 0);
});

Deno.test("extract-events: refuses request-supplied model/URLs and oversize requests", async () => {
  reset();
  route = () => openAiOk([]);
  const many = Array.from({ length: 61 }, (_, i) => ({ id: `M${i + 1}`, sender: "a", text: "hi" }));
  const fat = Array.from({ length: 20 }, (_, i) => ({ id: `M${i + 1}`, sender: "a", text: "x".repeat(1_900) }));
  const cases: [unknown, number][] = [
    [{ messages: msgs, model: "gpt-4" }, 400],
    [{ messages: msgs, base_url: "http://evil" }, 400],
    [{ messages: msgs, supabase_url: "http://evil", service_role_key: "k" }, 400],
    [{ messages: msgs, mode: "admin" }, 400],
    [{ messages: many }, 413],
    [{ messages: [{ id: "M1", sender: "a", text: "x".repeat(2_001) }] }, 413],
    [{ messages: fat }, 413],
    [{ messages: [{ id: "../x", sender: "a", text: "hi" }] }, 400],
  ];
  for (const [body, status] of cases) {
    const res = await post("extract-events", body);
    assertEquals(res.status, status, JSON.stringify(body).slice(0, 80));
    await res.body?.cancel();
  }
  assertEquals(seen.length, 0);
});

Deno.test("extract-events: counter -1 / null / error never reach OpenAI", async () => {
  const cases: [() => Response, number][] = [
    [() => jsonRes(-1), 429],
    [() => new Response("null", { headers: { "Content-Type": "application/json" } }), 503],
    [() => jsonRes({ message: "boom" }, 500), 503],
  ];
  for (const [counter, status] of cases) {
    reset();
    route = (r) => (isCounter(r) ? counter() : openAiOk([]));
    const res = await post("extract-events", { messages: msgs });
    assertEquals(res.status, status);
    assertEquals((await res.json()).rate_limited, true);
    assertEquals(count(isOpenAI), 0);
  }
});

Deno.test("extract-events: live call counts once, sends no temperature, sanitizes output", async () => {
  reset();
  route = (r) =>
    isCounter(r)
      ? jsonRes(12)
      : openAiOk([
          { title: "Practice", kind: "new_event", date_phrase: "next Tuesday", time_phrase: "at 5", source_message_ids: ["M001", "M999"] },
          { title: "x".repeat(500), kind: "drop_tables", date_phrase: 42 },
        ]);
  const res = await post("extract-events", { messages: msgs });
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.calls_used, 12);
  assertEquals(body.extractor, "gpt-6-luna");
  assertEquals(body.events[0].source_message_ids, ["M001"]);
  assertEquals(body.events[1].kind, "new_event");
  assertEquals(body.events[1].title.length, 120);
  assertEquals(body.events[1].date_phrase, "");
  assertEquals(JSON.parse(seen.find(isCounter)!.body), { fn_name: "extract-events", cap: 200 });
  const req = JSON.parse(seen.find(isOpenAI)!.body);
  assertEquals("temperature" in req, false);
  assertEquals(req.model, "gpt-6-luna");
  assertEquals(seen.map((r) => (isCounter(r) ? "count" : "openai")), ["count", "openai"]);
});

Deno.test("extract-events: rejected key switches to offline mode", async () => {
  reset();
  route = (r) => (isCounter(r) ? jsonRes(1) : jsonRes({ error: "bad key" }, 401));
  const res = await post("extract-events", { messages: msgs });
  assertEquals(res.status, 503);
  assertEquals((await res.json()).rate_limited, true);
});

// ----------------------------------------------------------- chat-store ----

const CHAT_ID = "3f0a2c1e-1111-4222-8333-444455556666";
let storedHash = "";

function pgRoute(r: Seen): Response {
  const object = (r.headers.get("Accept") ?? "").includes("vnd.pgrst.object");
  if (r.url.pathname === "/rest/v1/chats" && r.method === "POST") {
    storedHash = JSON.parse(r.body).write_token_hash;
    return jsonRes(object ? { id: CHAT_ID } : [{ id: CHAT_ID }], 201);
  }
  if (r.url.pathname === "/rest/v1/chats" && r.method === "GET") {
    const row = { write_token_hash: storedHash };
    return jsonRes(object ? row : [row]);
  }
  if (r.url.pathname === "/rest/v1/events" && r.method === "PATCH") return jsonRes([{ id: "e1" }]);
  return jsonRes({ message: "unexpected" }, 500);
}

async function createChat(): Promise<{ chat_id: string; feed_slug: string; write_token: string }> {
  const res = await post("chat-store", { action: "create_chat", title: "Rivera", timezone: "America/Los_Angeles", members: ["Mom"] });
  assertEquals(res.status, 200);
  return await res.json();
}

Deno.test("chat-store: create_chat issues a 128-bit feed slug and stores only the token hash", async () => {
  reset();
  route = pgRoute;
  const chat = await createChat();
  assertMatch(chat.feed_slug, /^[0-9a-f]{32}$/);
  assertMatch(chat.write_token, /^[A-Za-z0-9_-]{43}$/);
  const insert = JSON.parse(seen.find((r) => r.method === "POST")!.body);
  assertEquals(insert.feed_slug, chat.feed_slug);
  assert(!JSON.stringify(insert).includes(chat.write_token), "plain token is never stored");
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(chat.write_token));
  assertEquals(insert.write_token_hash, Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join(""));
});

Deno.test("chat-store: create_chat rejects a bogus timezone", async () => {
  reset();
  route = pgRoute;
  const res = await post("chat-store", { action: "create_chat", timezone: "Mars/Olympus\r\nX:1" });
  assertEquals(res.status, 400);
  await res.body?.cancel();
});

Deno.test("chat-store: update_event needs the chat's write token", async () => {
  reset();
  route = pgRoute;
  const chat = await createChat();
  seen = [];
  const res = await post("chat-store", {
    action: "update_event", chat_id: CHAT_ID, write_token: "A".repeat(43), uid: "gc-1@groupchat.calendar", patch: { status: "approved" },
  });
  assertEquals(res.status, 403);
  await res.body?.cancel();
  assertEquals(seen.filter((r) => r.method === "PATCH").length, 0);
  assert(chat.write_token);
});

Deno.test("chat-store: update_event only accepts whitelisted fields", async () => {
  reset();
  route = pgRoute;
  const chat = await createChat();
  for (const patch of [{ needs_review: false }, { chat_id: "x" }, { confidence: 1 }, { status: "deleted" }, { start_date: "2026-02-30" }, {}]) {
    const res = await post("chat-store", { action: "update_event", chat_id: CHAT_ID, write_token: chat.write_token, uid: "u1", patch });
    assertEquals(res.status, 400, JSON.stringify(patch));
    await res.body?.cancel();
  }
});

Deno.test("chat-store: update_event writes the whitelisted patch for that chat only", async () => {
  reset();
  route = pgRoute;
  const chat = await createChat();
  seen = [];
  const res = await post("chat-store", {
    action: "update_event", chat_id: CHAT_ID, write_token: chat.write_token, uid: "gc-1@groupchat.calendar",
    patch: { title: "Soccer", start_date: "2026-10-13", start_time: "17:00", all_day: false },
  });
  assertEquals(res.status, 200);
  await res.body?.cancel();
  const patch = seen.find((r) => r.method === "PATCH")!;
  assertEquals(patch.url.searchParams.get("chat_id"), `eq.${CHAT_ID}`);
  assertEquals(patch.url.searchParams.get("uid"), "eq.gc-1@groupchat.calendar");
  assertEquals(JSON.parse(patch.body), { title: "Soccer", start_date: "2026-10-13", start_time: "17:00:00", all_day: false, needs_review: false });

  seen = [];
  const res2 = await post("chat-store", {
    action: "update_event", chat_id: CHAT_ID, write_token: chat.write_token, uid: "gc-1@groupchat.calendar", patch: { status: "approved" },
  });
  assertEquals(res2.status, 200);
  await res2.body?.cancel();
  assertEquals(JSON.parse(seen.find((r) => r.method === "PATCH")!.body), { status: "approved" });
});

Deno.test("chat-store: rejects unknown actions, unknown event fields and oversize batches", async () => {
  reset();
  route = pgRoute;
  const chat = await createChat();
  const auth = { chat_id: CHAT_ID, write_token: chat.write_token };
  const cases: [unknown, number][] = [
    [{ action: "reset_counters" }, 400],
    [{ action: "__proto__" }, 400],
    [{ action: "save_events", ...auth, events: [{ title: "x", uid: "u1", chat_id: "other" }] }, 400],
    [{ action: "save_messages", ...auth, messages: Array.from({ length: 501 }, (_, i) => ({ msg_key: `M${i}`, idx: i, sent_at: "2026-10-03T00:00:00Z", sender: "a", text: "b" })) }, 413],
    [{ action: "log_jev_calls", ...auth, calls: [{ stage: "admin" }] }, 400],
  ];
  for (const [body, status] of cases) {
    const res = await post("chat-store", body);
    assertEquals(res.status, status, JSON.stringify(body).slice(0, 80));
    await res.body?.cancel();
  }
});

// ------------------------------------------------------------- ics-feed ----

Deno.test("ics-feed: read-only, validates the slug, serves only that chat", async () => {
  reset();
  route = (r) => {
    if (r.method !== "GET") return jsonRes({ message: "write attempted" }, 500);
    if (r.url.pathname === "/rest/v1/chats") {
      return r.url.searchParams.get("feed_slug") === "eq.abcdef0123456789abcdef0123456789"
        ? jsonRes([{ id: CHAT_ID, title: "Rivera", timezone: "America/Los_Angeles" }])
        : jsonRes([]);
    }
    if (r.url.pathname === "/rest/v1/events") {
      assertEquals(r.url.searchParams.get("chat_id"), `eq.${CHAT_ID}`);
      return jsonRes([
        { title: "Permission slip", kind: "deadline", start_date: "2026-10-09", start_time: "15:00:00", all_day: false, location: null, attendees: [], source_message_ids: ["M004"], status: "approved", uid: "gc-1@x\r\nBEGIN:VEVENT", user_note: null },
        { title: "No date", kind: "new_event", start_date: null, start_time: null, all_day: false, location: null, attendees: [], source_message_ids: [], status: "approved", uid: "u2", user_note: null },
      ]);
    }
    return jsonRes({}, 500);
  };

  const get = (q: string, method = "GET") => Promise.resolve(handlers["ics-feed"](new Request(`http://fn.test/ics-feed${q}`, { method })));

  let res = await get("?slug=abcdef0123456789abcdef0123456789", "POST");
  assertEquals(res.status, 405);
  await res.body?.cancel();

  res = await get("?slug=../../etc");
  assertEquals(res.status, 404);
  await res.body?.cancel();

  res = await get("?slug=ffffffffffffffffffffffffffffffff");
  assertEquals(res.status, 404);
  await res.body?.cancel();

  res = await get("?slug=abcdef0123456789abcdef0123456789");
  assertEquals(res.status, 200);
  assertMatch(res.headers.get("content-type") ?? "", /text\/calendar/);
  const ics = await res.text();
  assert(ics.includes("DTSTART;TZID=America/Los_Angeles:20261009T150000"), "timed deadline keeps its time");
  assert(!ics.includes("DTEND"), "a deadline is a moment, not a block");
  const lines = ics.split("\r\n");
  assertEquals(lines.filter((l) => l === "BEGIN:VEVENT").length, 1, "CRLF in a stored uid cannot inject a VEVENT; dateless events skipped");
  assert(lines.includes("UID:gc-1@x BEGIN:VEVENT"), "line breaks in the uid are flattened");
  assert(seen.every((r) => r.method === "GET"), "feed never writes");
});

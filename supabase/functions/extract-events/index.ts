// @ts-nocheck
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const DAILY_CALL_CAP = 200;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

type ParsedMessage = {
  id: string;
  sent_at: string;
  sender: string;
  text: string;
};

type ExtractedEvent = {
  title: string;
  kind: string;
  date_phrase: string;
  time_phrase?: string;
  end_time_phrase?: string;
  location?: string;
  notes?: string;
  source_message_ids: string[];
  refers_to_title?: string;
};

const SYSTEM_PROMPT = `You extract calendar events from group-chat messages.

Rules:
- date_phrase MUST be copied VERBATIM from the source text. Never resolve, normalize, or infer an actual date.
- time_phrase likewise verbatim if a time is stated.
- kind is one of: new_event, deadline, change, cancellation, rsvp.
- refers_to_title: only for change/cancellation — the title of the earlier event it refers to.
- source_message_ids: the ids of the messages the event comes from.
- Do not invent events not grounded in the messages.`;

function userPrompt(messages: ParsedMessage[]): string {
  const lines = messages
    .map((m) => `[${m.id}] ${m.sent_at} ${m.sender}: ${m.text.replace(/\n/g, " ")}`)
    .join("\n");
  return `Messages:\n${lines}\n\nReturn JSON: {"events":[{"title","kind","date_phrase","time_phrase","end_time_phrase","location","notes","source_message_ids","refers_to_title"}]}`;
}

async function callOpenAI(messages: ParsedMessage[], apiKey: string, baseUrl: string, model: string) {
  const res = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt(messages) },
      ],
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    if (res.status === 401 || res.status === 403) {
      throw new Error("The extraction API key was rejected. Check the OPENAI_API_KEY secret.");
    }
    if (res.status === 429) {
      throw new Error("Rate limited by the extraction API. Try again in a moment.");
    }
    if (res.status === 400) {
      throw new Error(`The extraction request was rejected (400). ${text.slice(0, 200)}`);
    }
    throw new Error(`Extraction API error ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new Error("OpenAI returned no content");
  const parsed = JSON.parse(content);
  if (!Array.isArray(parsed?.events)) throw new Error("OpenAI response missing events array");
  return parsed.events as ExtractedEvent[];
}

function mockExtract(messages: ParsedMessage[]): ExtractedEvent[] {
  const events: ExtractedEvent[] = [];

  for (const m of messages) {
    const text = m.text;

    const patterns: Array<{ re: RegExp; kind: string }> = [
      { re: /\b(today|tonight)\b/i, kind: "new_event" },
      { re: /\btomorrow\b/i, kind: "new_event" },
      { re: /\bday after tomorrow\b/i, kind: "new_event" },
      { re: /\bnext\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i, kind: "new_event" },
      { re: /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/i, kind: "new_event" },
      { re: /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(st|nd|rd|th)?\b/i, kind: "new_event" },
      { re: /\b\d{1,2}\/\d{1,2}(\/\d{2,4})?\b/i, kind: "new_event" },
      { re: /\bby (the )?\d{1,2}(st|nd|rd|th)\b/i, kind: "deadline" },
      { re: /\bdue (by |on |this )?(friday|monday|tuesday|wednesday|thursday|saturday|sunday|today|tomorrow)\b/i, kind: "deadline" },
      { re: /\bdue (by |on |this )?(today|tomorrow)\b/i, kind: "deadline" },
    ];

    let matched: { re: RegExp; kind: string } | null = null;
    let phrase = "";
    for (const p of patterns) {
      const m2 = text.match(p.re);
      if (m2) {
        matched = p;
        phrase = m2[0];
        break;
      }
    }
    if (!matched) continue;

    let kind = matched.kind;
    const lower = text.toLowerCase();
    if (/\b(moved|reschedul|pushed|changed)\b/.test(lower)) kind = "change";
    if (/\b(cancel|postpone|no more|off)\b/.test(lower)) kind = "cancellation";

    const firstSentence = text.split(/[.!?\n]/)[0].trim();
    const words = firstSentence.split(/\s+/).slice(0, 8).join(" ");
    const title = words.length > 4 ? words : text.slice(0, 50).trim();

    const event: ExtractedEvent = {
      title: title || "Event",
      kind,
      date_phrase: phrase,
      time_phrase: text.match(/\b(at|by|from)\s+\d{1,2}(:\d{2})?\s*(am|pm)?\b/i)?.[0],
      source_message_ids: [m.id],
    };

    if (kind === "change" || kind === "cancellation") {
      event.refers_to_title = title;
    }

    events.push(event);
  }
  return events;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });

  try {
    if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

    const body = await req.json();
    const messages: ParsedMessage[] = Array.isArray(body?.messages) ? body.messages : [];
    const mode: string = body?.mode ?? "live";
    if (messages.length === 0) return json({ events: [], extractor: "none" });

    if (mode === "mock") {
      return json({ events: mockExtract(messages), extractor: "mock-regex" });
    }

    const { createClient } = await import("npm:@supabase/supabase-js@2.57.4");
    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );
    const { data: callCount, error: usageErr } = await admin.rpc("bump_function_usage", {
      p_function_name: "extract-events",
    });
    if (usageErr) throw new Error(`Usage tracking failed: ${usageErr.message}`);
    if (Number(callCount ?? 0) > DAILY_CALL_CAP) {
      return json(
        {
          error: `You've used all ${DAILY_CALL_CAP} free AI calls for today. The app is now running in sample mode — try again tomorrow, or explore the bundled sample chats.`,
          rate_limited: true,
          calls_used: Number(callCount),
          daily_cap: DAILY_CALL_CAP,
        },
        429
      );
    }

    const apiKey = Deno.env.get("OPENAI_API_KEY");
    if (!apiKey) return json({ events: mockExtract(messages), extractor: "mock-regex (no OPENAI_API_KEY)" });

    const baseUrl = (Deno.env.get("OPENAI_BASE_URL") ?? "https://api.openai.com/v1").replace(/\/$/, "");
    const model = Deno.env.get("OPENAI_MODEL") ?? "gpt-6-luna";
    const events = await callOpenAI(messages, apiKey, baseUrl, model);
    return json({ events, extractor: model, calls_used: Number(callCount), daily_cap: DAILY_CALL_CAP });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return json({ events: [], extractor: null, error: message }, 502);
  }
});

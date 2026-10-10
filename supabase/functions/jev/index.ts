// @ts-nocheck
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

const MODEL = "jev-1.13.0";
const COST_PER_INPUT_TOKEN = 0.042 / 1_000_000;
const DAILY_CALL_CAP = 200;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

// Count this call in the database and refuse once the daily cap is hit.
// The cap is tracked per AI function per day in `function_usage`.
async function checkDailyCap(client, functionName) {
  const { data, error } = await client.rpc("bump_function_usage", {
    p_function_name: functionName,
  });
  if (error) throw new Error(`Usage tracking failed: ${error.message}`);
  const count = Number(data ?? 0);
  return { count, overCap: count > DAILY_CALL_CAP };
}

function rateLimitedResponse(count) {
  return json(
    {
      error: `You've used all ${DAILY_CALL_CAP} free AI calls for today (this was call ${count}). The app is now running in sample mode — try again tomorrow, or explore the bundled sample chats.`,
      rate_limited: true,
      calls_used: count,
      daily_cap: DAILY_CALL_CAP,
    },
    429
  );
}

async function callTypesafe(state: unknown, questions: unknown, apiKey: string) {
  const url = "https://api.typesafe.ai/v1/systemone";
  let lastErr: Error | null = null;

  for (let attempt = 0; attempt < 3; attempt++) {
    const started = Date.now();
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ model: MODEL, state, questions }),
      });
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      await sleep(400 * 2 ** attempt);
      continue;
    }

    if (res.status === 429 || res.status === 529) {
      lastErr = new Error(`Rate limited (${res.status})`);
      await sleep(400 * 2 ** attempt);
      continue;
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      if (res.status === 401 || res.status === 403) {
        throw new Error("The Jev API key was rejected. Check the TYPESAFE_API_KEY secret.");
      }
      throw new Error(`Jev API error ${res.status}: ${text.slice(0, 200)}`);
    }

    const data = await res.json();
    const latency = Date.now() - started;
    const model = data?.model ?? MODEL;
    console.log("response.model:", model);

    const usage = data?.usage ?? {};
    const inputTokens = Number(usage.input_tokens ?? 0);
    const answers = data?.answers ?? {};
    return {
      answers,
      model,
      usage: { input_tokens: inputTokens, output_tokens: Number(usage.output_tokens ?? 0) },
      latency_ms: latency,
      cost_usd: inputTokens * COST_PER_INPUT_TOKEN,
    };
  }

  throw lastErr ?? new Error("Jev is not responding right now. Try again in a moment.");
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });

  try {
    if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

    const apiKey = Deno.env.get("TYPESAFE_API_KEY");
    if (!apiKey) return json({ error: "TYPESAFE_API_KEY is not configured" }, 500);

    const body = await req.json();
    const state = body?.state;
    const questions = body?.questions;
    if (!state || !questions) return json({ error: "state and questions are required" }, 400);

    const { createClient } = await import("npm:@supabase/supabase-js@2.57.4");
    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { count, overCap } = await checkDailyCap(admin, "jev");
    if (overCap) return rateLimitedResponse(count);

    const result = await callTypesafe(state, questions, apiKey);
    return json({ ...result, calls_used: count, daily_cap: DAILY_CALL_CAP });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return json({ error: message }, 502);
  }
});

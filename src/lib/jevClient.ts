import { FunctionsHttpError } from "@supabase/supabase-js";

export interface JevCallResult {
  answers: Record<string, unknown>;
  model: string;
  usage: { input_tokens: number; output_tokens: number };
  latency_ms: number;
  cost_usd: number;
}

// Thrown when an edge function answers `rate_limited: true` — the daily cap
// was hit (429) or the AI is unavailable (503: missing key, counter error).
// The pipeline catches it and switches to offline mode.
export class RateLimitedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RateLimitedError";
  }
}

// Edge-function errors carry a JSON body like {error: "..."}. Surface that
// message instead of an opaque FunctionsHttpError.
export async function readableFunctionError(err: unknown): Promise<string> {
  if (err instanceof FunctionsHttpError) {
    const status = err.context?.status;
    let body: { error?: string; message?: string; rate_limited?: boolean } | null = null;
    try {
      body = await err.context.json();
    } catch {
      body = null;
    }
    if (body?.rate_limited) {
      throw new RateLimitedError(body.error ?? "Daily AI call limit reached.");
    }
    const detail = body?.error ?? body?.message ?? "";
    if (status === 401 || status === 403) {
      return detail || "The request was not authorized. Check VITE_SUPABASE_ANON_KEY.";
    }
    if (status === 429) {
      return detail || "Rate limited by the API. Try again in a moment.";
    }
    if (status && status >= 500) {
      return detail || `The API is having trouble (server error ${status}).`;
    }
    return detail || `Request failed with status ${status ?? "unknown"}.`;
  }
  if (err instanceof Error && err.message) return err.message;
  return String(err);
}

// Mirrors the size caps enforced by supabase/functions/jev.
export const JEV_LIMITS = {
  message: 2_000,
  title: 200,
  replies: 6_000,
  replyLines: 15,
  members: 30,
  memberName: 60,
};

export function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// Member names become part of Jev's instructions; the server refuses
// backticks and control characters, so strip them the same way here.
export function safeMemberName(name: string): string {
  // eslint-disable-next-line no-control-regex -- strip control characters on purpose
  return name.replace(/[`\u0000-\u001f\u007f]/g, "").trim().slice(0, JEV_LIMITS.memberName);
}

// The jev function only runs these two question sets; it builds the
// questions itself from the task and these inputs.
export type JevTask =
  | { task: "filter"; state: { previous_message: string; message: string } }
  | {
      task: "attendees";
      state: { event_title: string; source_message: string; replies: string };
      members: string[];
    };

export async function invokeJev(request: JevTask): Promise<JevCallResult> {
  const { supabase } = await import("./supabase");
  const { data, error } = await supabase.functions.invoke("jev", { body: request });
  if (error) {
    // readableFunctionError throws RateLimitedError for rate_limited bodies.
    throw await readableFunctionError(error).then(
      (m) => new Error(m),
      (e) => e
    );
  }
  if (!data || typeof data !== "object" || !("answers" in data)) {
    throw new Error("Jev returned an unexpected response");
  }
  return data as JevCallResult;
}

// Fan out over an async worker with bounded concurrency. After the first
// failure no new items are started, so a hit cap or an outage doesn't keep
// sending (and paying for) requests in the background.
export async function pool<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
  onProgress?: (done: number, total: number) => void
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let done = 0;
  let failed = false;

  async function runOne(): Promise<void> {
    while (!failed && next < items.length) {
      const idx = next++;
      try {
        results[idx] = await worker(items[idx], idx);
      } catch (err) {
        failed = true;
        throw err;
      } finally {
        done++;
        onProgress?.(done, items.length);
      }
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => runOne());
  await Promise.all(workers);
  return results;
}

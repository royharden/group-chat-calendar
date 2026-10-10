import { FunctionsHttpError } from "@supabase/supabase-js";

export interface JevCallResult {
  answers: Record<string, unknown>;
  model: string;
  usage: { input_tokens: number; output_tokens: number };
  latency_ms: number;
  cost_usd: number;
}

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
    let body: { error?: string; rate_limited?: boolean } | null = null;
    try {
      body = await err.context.json();
    } catch {
      body = null;
    }
    if (body?.rate_limited) {
      throw new RateLimitedError(body.error ?? "Daily AI call limit reached.");
    }
    const detail = body?.error ?? "";
    if (status === 401 || status === 403) {
      return detail || "The API key was rejected. Check the TYPESAFE_API_KEY secret.";
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

async function invokeJev(
  state: Record<string, unknown>,
  questions: Record<string, unknown>,
  signal?: AbortSignal
): Promise<JevCallResult> {
  const { supabase } = await import("./supabase");
  const { data, error } = await supabase.functions.invoke("jev", {
    body: { state, questions },
  });
  if (error) {
    // readableFunctionError throws RateLimitedError when the daily cap is hit.
    const message = await readableFunctionError(error).catch((e) => {
      if (e instanceof RateLimitedError) throw e;
      return readableFunctionError(error);
    });
    throw new Error(message);
  }
  if (!data || typeof data !== "object" || !("answers" in data)) {
    throw new Error("Jev returned an unexpected response");
  }
  return data as JevCallResult;
}

export { invokeJev };

// Fan out over an async worker with bounded concurrency.
export async function pool<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
  onProgress?: (done: number, total: number) => void
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  let done = 0;

  async function runOne(): Promise<void> {
    while (next < items.length) {
      const idx = next++;
      try {
        results[idx] = await worker(items[idx], idx);
      } catch (err) {
        // Propagate the error by rejecting: rethrow and abandon the rest.
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

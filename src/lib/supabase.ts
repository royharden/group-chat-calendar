import { createClient } from "@supabase/supabase-js";

// import.meta.env exists in the browser/Vite; Node-based scripts fall back to process.env.
const env = (import.meta as { env?: Record<string, string | undefined> }).env ?? {};
const procEnv = typeof process !== "undefined" ? (process.env as Record<string, string | undefined>) : {};

const url = env.VITE_SUPABASE_URL ?? procEnv.VITE_SUPABASE_URL;
const anonKey = env.VITE_SUPABASE_ANON_KEY ?? procEnv.VITE_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  throw new Error("Missing VITE_SUPABASE_URL or VITE_SUPABASE_ANON_KEY");
}

export const supabase = createClient(url, anonKey);

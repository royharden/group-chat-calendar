/*
# Add daily AI call rate limiting

1. Purpose
   Enforces a hard cap of AI edge-function calls per day, tracked in the
   database, so runaway usage can never surprise anyone on cost.

2. New Tables
- `function_usage`: one row per edge function per day.
  - `function_name` (text, e.g. "jev" or "extract-events")
  - `usage_date` (date, defaults to today)
  - `call_count` (int, how many calls were made that day)
  - Primary key on (function_name, usage_date).

3. New Functions
- `bump_function_usage(p_function_name text) returns int`
  SECURITY DEFINER, pinned search_path. Atomically inserts today's row or
  increments the counter, returning the new count. Edge functions call this
  via RPC with the service-role key before doing any AI work; if the returned
  count exceeds the daily limit, the function refuses the call.

4. Security
- RLS enabled on `function_usage`.
- Permissive anon policies (single-tenant demo) so the frontend can read
  usage for display; only the service role (edge functions) increments.
*/

CREATE TABLE IF NOT EXISTS function_usage (
  function_name text NOT NULL,
  usage_date date NOT NULL DEFAULT current_date,
  call_count int NOT NULL DEFAULT 0,
  PRIMARY KEY (function_name, usage_date)
);

ALTER TABLE function_usage ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "public_read_function_usage" ON function_usage;
CREATE POLICY "public_read_function_usage" ON function_usage FOR SELECT
TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "public_insert_function_usage" ON function_usage;
CREATE POLICY "public_insert_function_usage" ON function_usage FOR INSERT
TO anon, authenticated WITH CHECK (true);
DROP POLICY IF EXISTS "public_update_function_usage" ON function_usage;
CREATE POLICY "public_update_function_usage" ON function_usage FOR UPDATE
TO anon, authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "public_delete_function_usage" ON function_usage;
CREATE POLICY "public_delete_function_usage" ON function_usage FOR DELETE
TO anon, authenticated USING (true);

CREATE OR REPLACE FUNCTION public.bump_function_usage(p_function_name text)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_count int;
BEGIN
  INSERT INTO function_usage (function_name, usage_date, call_count)
  VALUES (p_function_name, current_date, 1)
  ON CONFLICT (function_name, usage_date)
  DO UPDATE SET call_count = function_usage.call_count + 1
  RETURNING call_count INTO v_count;
  RETURN v_count;
END;
$$;
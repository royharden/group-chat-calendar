/*
# Replace the daily AI cap with a service-role-only counter

1. Why
   `function_usage` had permissive anon policies, so anyone holding the public
   anon key could reset the counter, and `bump_function_usage` was executable
   by anon. The cap could be bypassed from the browser.

2. Removed
- `bump_function_usage(text)`
- `function_usage` table (and its anon policies)

3. New table: `usage_counters`
- `fn` (text): edge function name, or `app_total` for the app-wide total
- `day` (date): the UTC day
- `calls` (int): upstream AI calls counted that day
- Primary key (fn, day)
- RLS enabled with NO anon/authenticated policies, and every privilege
  revoked from anon and authenticated. Only the service role (edge functions)
  can touch it.

4. New function: `increment_usage(fn_name text, cap int default 200) returns int`
- SECURITY DEFINER with a pinned search_path.
- Atomically bumps the `fn_name` row and the `app_total` row for today
  (INSERT ... ON CONFLICT DO UPDATE ... RETURNING) and returns the app_total
  count, or -1 once the app-wide total is over `cap`.
- Edge functions call it once per upstream paid fetch (every retry and every
  batch item counts) BEFORE making the fetch.
- EXECUTE is revoked from PUBLIC, anon and authenticated; granted to
  service_role only.
*/

DROP FUNCTION IF EXISTS public.bump_function_usage(text);
DROP TABLE IF EXISTS public.function_usage;

CREATE TABLE IF NOT EXISTS public.usage_counters (
  fn text NOT NULL,
  day date NOT NULL,
  calls int NOT NULL DEFAULT 0,
  PRIMARY KEY (fn, day)
);

ALTER TABLE public.usage_counters ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.usage_counters FROM PUBLIC;
REVOKE ALL ON TABLE public.usage_counters FROM anon, authenticated;
GRANT ALL ON TABLE public.usage_counters TO service_role;

CREATE OR REPLACE FUNCTION public.increment_usage(fn_name text, cap int DEFAULT 200)
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_day date := (now() AT TIME ZONE 'utc')::date;
  v_cap int := COALESCE(cap, 200);
  v_total int;
BEGIN
  IF fn_name IS NULL OR length(fn_name) = 0 OR length(fn_name) > 64 OR fn_name = 'app_total' THEN
    RAISE EXCEPTION 'increment_usage: invalid fn_name';
  END IF;

  INSERT INTO public.usage_counters (fn, day, calls)
  VALUES (fn_name, v_day, 1)
  ON CONFLICT (fn, day) DO UPDATE SET calls = usage_counters.calls + 1;

  INSERT INTO public.usage_counters (fn, day, calls)
  VALUES ('app_total', v_day, 1)
  ON CONFLICT (fn, day) DO UPDATE SET calls = usage_counters.calls + 1
  RETURNING calls INTO v_total;

  IF v_total IS NULL OR v_total > v_cap THEN
    RETURN -1;
  END IF;
  RETURN v_total;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.increment_usage(text, int) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.increment_usage(text, int) TO service_role;

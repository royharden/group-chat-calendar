/*
# Lock down writes on chats, messages, events and jev_calls

1. Why
   The initial schema gave the anon key full INSERT/UPDATE/DELETE on every
   table, so anyone with the public key could edit or wipe any chat, rewrite
   events served by the live ICS feeds, or forge telemetry.

2. Policies
- Dropped every `public_insert_*`, `public_update_*` and `public_delete_*`
  policy on `chats`, `messages`, `events` and `jev_calls`.
- Kept the `public_read_*` SELECT policies: anon can still read.
- Also revoked INSERT/UPDATE/DELETE/TRUNCATE privileges from anon and
  authenticated as defense in depth (TRUNCATE is not covered by RLS).

3. Writes now go through the `chat-store` edge function
- It uses the service-role client and only offers whitelisted actions
  (create_chat, save_messages, update_message_labels, log_jev_calls,
  save_events, update_event).
- `create_chat` returns a random write token; only its SHA-256 hash is stored,
  in the new `chats.write_token_hash` column. Every other action must present
  the token for that chat, so one visitor cannot edit another visitor's chat.

4. Secret columns hidden from anon
- `chats.feed_slug` is the unguessable token in the public ICS feed URL, and
  `chats.write_token_hash` guards writes. Neither is readable by anon or
  authenticated any more: table-level SELECT is replaced with a column-level
  grant on the non-secret columns. Anon still has SELECT on
  id, title, timezone, members and created_at (select those columns
  explicitly; `select=*` on chats is now denied for anon).
*/

-- 1. Drop public write policies -------------------------------------------
DROP POLICY IF EXISTS "public_insert_chats" ON public.chats;
DROP POLICY IF EXISTS "public_update_chats" ON public.chats;
DROP POLICY IF EXISTS "public_delete_chats" ON public.chats;

DROP POLICY IF EXISTS "public_insert_messages" ON public.messages;
DROP POLICY IF EXISTS "public_update_messages" ON public.messages;
DROP POLICY IF EXISTS "public_delete_messages" ON public.messages;

DROP POLICY IF EXISTS "public_insert_events" ON public.events;
DROP POLICY IF EXISTS "public_update_events" ON public.events;
DROP POLICY IF EXISTS "public_delete_events" ON public.events;

DROP POLICY IF EXISTS "public_insert_jev_calls" ON public.jev_calls;
DROP POLICY IF EXISTS "public_update_jev_calls" ON public.jev_calls;
DROP POLICY IF EXISTS "public_delete_jev_calls" ON public.jev_calls;

-- 2. Revoke write privileges (RLS stays enabled; SELECT policies remain) ----
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.chats FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.messages FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.events FROM anon, authenticated;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON TABLE public.jev_calls FROM anon, authenticated;

-- 3. Per-chat write token (hash only) --------------------------------------
ALTER TABLE public.chats ADD COLUMN IF NOT EXISTS write_token_hash text;

-- 4. Hide the secret columns from anon/authenticated ------------------------
REVOKE SELECT ON TABLE public.chats FROM anon, authenticated;
GRANT SELECT (id, title, timezone, members, created_at) ON TABLE public.chats TO anon, authenticated;

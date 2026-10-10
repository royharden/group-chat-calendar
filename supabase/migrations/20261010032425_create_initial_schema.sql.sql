/*
# Group Chat to Calendar — initial schema (single-tenant, no auth)

1. Purpose
   Stores pasted group chats, parsed messages, extracted events with date
   resolution parts, and Jev call telemetry for the cost dashboard.

2. New Tables
- `chats`: one row per pasted chat. `title`, `timezone` (IANA name),
  `members` (jsonb array of sender names), `feed_slug` (unique public slug
  for the ICS feed), `created_at`.
- `messages`: parsed messages in order. `msg_key` is the stable "M001" id
  used by the pipeline. `is_event_p` is Jev's probability, `kind` is the
  stage-1 choice answer, `kind_conf` its confidence.
- `events`: extracted events. `parts` holds the raw Jev date-part answers
  for the probability bars in review; `status` is
  pending|approved|rejected|cancelled; `uid` is the stable ICS UID.
- `jev_calls`: one row per Jev request (or grouped batch) with latency,
  tokens, and cost for the pipeline strip and export stats.

3. Security
- RLS enabled on all four tables.
- Single-tenant demo with no sign-in: permissive `TO anon, authenticated`
  policies allow the anon-key frontend full CRUD on this public workspace.
*/

CREATE TABLE IF NOT EXISTS chats (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL DEFAULT 'Untitled chat',
  timezone text NOT NULL DEFAULT 'UTC',
  members jsonb NOT NULL DEFAULT '[]'::jsonb,
  feed_slug text UNIQUE NOT NULL DEFAULT encode(gen_random_uuid()::text::bytea, 'hex'),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id uuid NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  idx int NOT NULL,
  msg_key text NOT NULL,
  sent_at timestamptz NOT NULL,
  sender text NOT NULL,
  text text NOT NULL,
  is_event_p numeric,
  kind text,
  kind_conf numeric,
  UNIQUE (chat_id, msg_key)
);

CREATE TABLE IF NOT EXISTS events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id uuid NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  title text NOT NULL,
  kind text NOT NULL DEFAULT 'new_event',
  date_phrase text,
  time_phrase text,
  start_date date,
  start_time time,
  all_day bool NOT NULL DEFAULT false,
  location text,
  attendees jsonb NOT NULL DEFAULT '[]'::jsonb,
  source_message_ids text[] NOT NULL DEFAULT '{}',
  parts jsonb,
  confidence numeric,
  needs_review bool NOT NULL DEFAULT false,
  note text,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),
  uid text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS jev_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chat_id uuid REFERENCES chats(id) ON DELETE CASCADE,
  stage text NOT NULL,
  request jsonb,
  response jsonb,
  latency_ms int,
  input_tokens int,
  cost_usd numeric,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS messages_chat_idx ON messages (chat_id, idx);
CREATE INDEX IF NOT EXISTS events_chat_idx ON events (chat_id, created_at);
CREATE INDEX IF NOT EXISTS chats_feed_slug_idx ON chats (feed_slug);
CREATE INDEX IF NOT EXISTS jev_calls_chat_idx ON jev_calls (chat_id, created_at);

ALTER TABLE chats ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE events ENABLE ROW LEVEL SECURITY;
ALTER TABLE jev_calls ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "public_read_chats" ON chats;
CREATE POLICY "public_read_chats" ON chats FOR SELECT
TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "public_insert_chats" ON chats;
CREATE POLICY "public_insert_chats" ON chats FOR INSERT
TO anon, authenticated WITH CHECK (true);
DROP POLICY IF EXISTS "public_update_chats" ON chats;
CREATE POLICY "public_update_chats" ON chats FOR UPDATE
TO anon, authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "public_delete_chats" ON chats;
CREATE POLICY "public_delete_chats" ON chats FOR DELETE
TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "public_read_messages" ON messages;
CREATE POLICY "public_read_messages" ON messages FOR SELECT
TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "public_insert_messages" ON messages;
CREATE POLICY "public_insert_messages" ON messages FOR INSERT
TO anon, authenticated WITH CHECK (true);
DROP POLICY IF EXISTS "public_update_messages" ON messages;
CREATE POLICY "public_update_messages" ON messages FOR UPDATE
TO anon, authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "public_delete_messages" ON messages;
CREATE POLICY "public_delete_messages" ON messages FOR DELETE
TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "public_read_events" ON events;
CREATE POLICY "public_read_events" ON events FOR SELECT
TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "public_insert_events" ON events;
CREATE POLICY "public_insert_events" ON events FOR INSERT
TO anon, authenticated WITH CHECK (true);
DROP POLICY IF EXISTS "public_update_events" ON events;
CREATE POLICY "public_update_events" ON events FOR UPDATE
TO anon, authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "public_delete_events" ON events;
CREATE POLICY "public_delete_events" ON events FOR DELETE
TO anon, authenticated USING (true);

DROP POLICY IF EXISTS "public_read_jev_calls" ON jev_calls;
CREATE POLICY "public_read_jev_calls" ON jev_calls FOR SELECT
TO anon, authenticated USING (true);
DROP POLICY IF EXISTS "public_insert_jev_calls" ON jev_calls;
CREATE POLICY "public_insert_jev_calls" ON jev_calls FOR INSERT
TO anon, authenticated WITH CHECK (true);
DROP POLICY IF EXISTS "public_update_jev_calls" ON jev_calls;
CREATE POLICY "public_update_jev_calls" ON jev_calls FOR UPDATE
TO anon, authenticated USING (true) WITH CHECK (true);
DROP POLICY IF EXISTS "public_delete_jev_calls" ON jev_calls;
CREATE POLICY "public_delete_jev_calls" ON jev_calls FOR DELETE
TO anon, authenticated USING (true);
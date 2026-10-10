/*
# Separate internal notes from user-facing notes on events

1. Plain-English summary
   The events table previously had a single `note` column that mixed two kinds
   of information: internal pipeline explanations ("bare time — assumed PM",
   "day without a month — assumed the next one coming up") which are only meant
   for the review board, and user-facing remarks a chat member actually typed
   (e.g. "bring cleats"), which belong in the exported calendar file. This
   migration adds a second column, `user_note`, to hold the user-facing text so
   internal explanations are never leaked into ICS exports.

2. Modified tables
   - `events`: new nullable column `user_note text`.

3. Security
   - No RLS changes. The events table already has public read/write policies
     (single-tenant, no-auth app); the new column inherits table-level access.
*/

ALTER TABLE events ADD COLUMN IF NOT EXISTS user_note text;

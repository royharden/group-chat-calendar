import { readableFunctionError } from "./jevClient";

// Client for the `chat-store` edge function — the only way to write chats,
// messages, events and jev_calls (the anon key is read-only on those tables).

export type ChatStoreAction =
  | "create_chat"
  | "save_messages"
  | "update_message_labels"
  | "log_jev_calls"
  | "save_events"
  | "update_event";

// Mirrors the per-request caps enforced by supabase/functions/chat-store.
export const CHAT_STORE_LIMITS = {
  batch: 500,
  members: 200,
  memberName: 80,
  messageText: 4_000,
};

// Proof that this browser created the chat. Returned once by create_chat and
// kept in memory; the server stores only its hash.
export interface ChatWriteAccess {
  chatId: string;
  writeToken: string;
}

export interface EventPatch {
  status?: "pending" | "approved" | "rejected" | "cancelled";
  title?: string;
  start_date?: string | null;
  start_time?: string | null;
  all_day?: boolean;
  location?: string | null;
  user_note?: string | null;
}

async function call<T>(action: ChatStoreAction, payload: Record<string, unknown>): Promise<T> {
  const { supabase } = await import("./supabase");
  const { data, error } = await supabase.functions.invoke("chat-store", { body: { action, ...payload } });
  if (error) {
    const message = await readableFunctionError(error).catch((e: unknown) => (e instanceof Error ? e.message : String(e)));
    throw new Error(message);
  }
  if (!data || typeof data !== "object") throw new Error("chat-store returned an unexpected response");
  return data as T;
}

export async function createChat(
  title: string,
  timezone: string,
  members: string[]
): Promise<ChatWriteAccess & { feedSlug: string }> {
  const res = await call<{ chat_id: string; feed_slug: string; write_token: string }>("create_chat", {
    title: title.slice(0, 120),
    timezone,
    members: members
      .map((m) => m.trim().slice(0, CHAT_STORE_LIMITS.memberName))
      .filter(Boolean)
      .slice(0, CHAT_STORE_LIMITS.members),
  });
  return { chatId: res.chat_id, feedSlug: res.feed_slug, writeToken: res.write_token };
}

// Sends rows in batches that fit the server's per-request cap.
export async function saveInBatches(
  action: "save_messages" | "update_message_labels" | "log_jev_calls" | "save_events",
  access: ChatWriteAccess,
  key: "messages" | "labels" | "calls" | "events",
  rows: unknown[]
): Promise<void> {
  for (let i = 0; i < rows.length; i += CHAT_STORE_LIMITS.batch) {
    await call(action, {
      chat_id: access.chatId,
      write_token: access.writeToken,
      [key]: rows.slice(i, i + CHAT_STORE_LIMITS.batch),
    });
  }
}

export async function updateEvent(access: ChatWriteAccess, uid: string, patch: EventPatch): Promise<void> {
  await call("update_event", { chat_id: access.chatId, write_token: access.writeToken, uid, patch });
}

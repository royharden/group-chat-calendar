/**
 * End-to-end test: runs the three bundled sample chats through the live
 * pipeline (Jev filter -> LLM extract -> code date resolution -> attendees),
 * then checks approve/edit persistence through chat-store, ICS download, the
 * ics-feed edge function, and that the anon key can no longer write tables
 * or touch the usage counter. Works in offline mode too (no AI keys set).
 * Run with: npx tsx scripts/e2eTest.ts
 */
import { runPipeline } from "../src/lib/pipeline";
import { generateICS } from "../src/lib/icsGenerator";
import { updateEvent } from "../src/lib/chatStore";
import { SAMPLE_CHATS } from "../src/lib/sampleChats";
import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";

config({ path: new URL("../.env", import.meta.url).pathname });

const url = process.env.VITE_SUPABASE_URL!;
const anonKey = process.env.VITE_SUPABASE_ANON_KEY!;
// Edge functions use verify_jwt = true: always send the anon key as Bearer.
const supabase = createClient(url, anonKey, {
  global: { headers: { Authorization: `Bearer ${anonKey}` } },
});

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  ok  ${name}`);
  } else {
    failures++;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

function expectEventTitles(events: { title: string; kind: string }[], mustInclude: string[], label: string) {
  for (const must of mustInclude) {
    const hit = events.some((e) => e.title.toLowerCase().includes(must.toLowerCase()));
    check(`${label}: event mentioning "${must}" extracted`, hit, `got: ${events.map((e) => e.title).join(" | ")}`);
  }
}

async function securityChecks() {
  console.log("\n=== security ===");
  const { error: rpcErr } = await supabase.rpc("increment_usage", { fn_name: "jev", cap: 100000 });
  check("anon cannot call increment_usage", !!rpcErr, "rpc succeeded");

  const { data: counters, error: countersErr } = await supabase.from("usage_counters").select("*");
  check("anon cannot read usage_counters", !!countersErr || (counters ?? []).length === 0, JSON.stringify(counters));

  const { error: oldRpcErr } = await supabase.rpc("bump_function_usage", { p_function_name: "jev" });
  check("old bump_function_usage is gone", !!oldRpcErr);

  const { error: insertErr } = await supabase.from("chats").insert({ title: "anon write" });
  check("anon cannot insert chats", !!insertErr);

  const { error: slugErr } = await supabase.from("chats").select("feed_slug").limit(1);
  check("anon cannot read feed slugs", !!slugErr);

  const { error: readErr } = await supabase.from("events").select("id, title").limit(1);
  check("anon can still read events", !readErr, readErr?.message);

  const feed404 = await fetch(`${url}/functions/v1/ics-feed?slug=${"0".repeat(32)}`);
  check("ics-feed with an unknown slug returns 404", feed404.status === 404, `status ${feed404.status}`);

  const { error: questionsErr } = await supabase.functions.invoke("jev", {
    body: { task: "filter", state: { previous_message: "", message: "hi" }, questions: { anything: {} } },
  });
  check("jev refuses client-supplied questions", !!questionsErr);
}

async function main() {
  console.log(`Running E2E against ${url}\n`);

  for (const sample of SAMPLE_CHATS) {
    console.log(`\n=== ${sample.name} ===`);
    const result = await runPipeline({
      chatTitle: sample.name,
      rawChat: sample.raw,
      timezone: sample.timezone,
      mode: "live",
      reviewBelow: 0.6,
      onProgress: (m) => console.log(`  · ${m}`),
    });
    if (result.offlineReason) console.log(`  (offline mode: ${result.offlineReason})`);

    check("pipeline returned messages", result.messages.length > 0);
    check("events extracted", result.events.length > 0);
    console.log(
      `  events: ${result.events.map((e) => `${e.title} [${e.kind}] ${e.startDate ?? "?"} ${e.startTime ?? ""} conf=${e.confidence.toFixed(2)} review=${e.needsReview}`).join("\n          ")}`
    );

    // Per-sample expectations (code date resolution — same live or offline)
    if (sample.id === "rivera") {
      if (!result.offlineReason) expectEventTitles(result.events, ["practice", "grandma", "dentist", "permission"], "Rivera");
      const nov = result.events.find((e) => e.datePhrase?.toLowerCase().includes("nov 14"));
      if (nov) check("Rivera: Nov 14 resolved", nov.startDate === "2026-11-14", `got ${nov.startDate}`);
      const tuesday = result.events.find((e) => e.datePhrase?.toLowerCase().includes("next tuesday"));
      // Sat Oct 3 message + "next Tuesday" = Tuesday Oct 6 (following calendar week)
      check("Rivera: next Tuesday resolved to 2026-10-06", tuesday?.startDate === "2026-10-06", `got ${tuesday?.startDate}`);
      check("Rivera: next Tuesday keeps its 5 PM", tuesday?.startTime === "17:00:00", `got ${tuesday?.startTime}`);
      const dentist = result.events.find((e) => e.title.toLowerCase().includes("dentist") && e.startTime);
      check("Rivera: dentist has a 9:30 time", dentist?.startTime === "09:30:00", `got ${dentist?.startTime}`);
    }
    if (sample.id === "lake") {
      expectEventTitles(result.events, ["deposit"], "Lake");
      const deposit = result.events.find((e) => e.title.toLowerCase().includes("deposit"));
      check("Lake: deposit due Oct 20 with an assumption note", deposit?.startDate === "2026-10-20" && (deposit?.note ?? "").length > 0, `got ${deposit?.startDate} note=${deposit?.note}`);
    }
    if (sample.id === "room4b") {
      expectEventTitles(result.events, ["bake"], "Room4B");
      const pickup = result.events.find((e) => e.datePhrase?.toLowerCase().includes("3"));
      // "pickup at 3?" has no date — should land in review
      check("Room4B: 'pickup at 3' needs review (no date)", pickup?.needsReview === true || pickup === undefined, `needsReview=${pickup?.needsReview}`);
    }

    // --- approve + edit persistence (chat-store with the chat's write token) ---
    const target = result.events.find((e) => e.startDate);
    if (!target?.uid) {
      failures++;
      console.log("FAIL  no event with a startDate to approve");
      continue;
    }
    const access = { chatId: result.chatId, writeToken: result.writeToken };
    const apErr = await updateEvent(access, target.uid, { status: "approved" }).then(() => null, (e: Error) => e);
    check("approve persisted via chat-store", !apErr, apErr?.message);

    const edErr = await updateEvent(access, target.uid, { title: `${target.title} (edited)`, start_time: "18:00:00", all_day: false }).then(
      () => null,
      (e: Error) => e
    );
    check("edit persisted via chat-store", !edErr, edErr?.message);

    const { data: reread, error: rrErr } = await supabase
      .from("events")
      .select("status, title, start_time")
      .eq("chat_id", result.chatId)
      .eq("uid", target.uid)
      .maybeSingle();
    check("re-read after approve+edit", !rrErr && reread?.status === "approved" && reread!.title.includes("(edited)"), rrErr?.message ?? JSON.stringify(reread));

    // anon can no longer write: a direct update is denied and changes nothing
    await supabase.from("events").update({ title: "anon was here" }).eq("uid", target.uid);
    const { data: after } = await supabase.from("events").select("title").eq("chat_id", result.chatId).eq("uid", target.uid).maybeSingle();
    check("anon direct update has no effect", !!after && after.title !== "anon was here", JSON.stringify(after));

    const wrongToken = await updateEvent({ chatId: result.chatId, writeToken: "A".repeat(43) }, target.uid, { status: "rejected" }).then(
      () => null,
      (e: Error) => e
    );
    check("chat-store refuses a wrong write token", !!wrongToken);

    // revert the edit so the ICS/feed checks see the real title
    await updateEvent(access, target.uid, { title: target.title, start_time: target.startTime, all_day: target.allDay, status: "pending" });

    // --- ICS generation ---
    const approvedEvents = result.events.map((e) => ({ ...e, status: "approved" as const }));
    const ics = generateICS(approvedEvents, sample.name);
    check("ICS starts VCALENDAR", ics.startsWith("BEGIN:VCALENDAR"));
    check("ICS has CRLF endings", ics.includes("\r\n"));
    check("ICS has VEVENTs", (ics.match(/BEGIN:VEVENT/g) ?? []).length >= 1);
    check("ICS lines ≤ 75 octets", ics.split("\r\n").every((l) => new TextEncoder().encode(l).length <= 75));

    // --- ics-feed function (public: no auth header, like a calendar app) ---
    const feedResp = await fetch(`${url}/functions/v1/ics-feed?slug=${result.feedSlug}`);
    check("ics-feed returns 200", feedResp.ok, `status ${feedResp.status}`);
    const feedText = await feedResp.text();
    check("ics-feed content-type is text/calendar", (feedResp.headers.get("content-type") ?? "").includes("text/calendar"), feedResp.headers.get("content-type") ?? "");
    check("ics-feed body is VCALENDAR", feedText.startsWith("BEGIN:VCALENDAR"), feedText.slice(0, 120));
  }

  await securityChecks();

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("E2E crashed:", err instanceof Error ? err.message : err);
  process.exit(1);
});

/**
 * End-to-end test: runs the three bundled sample chats through the live
 * pipeline (Jev filter -> LLM extract -> Jev date parts -> attendees),
 * then checks approve/edit persistence, ICS download, and the ics-feed
 * edge function. Run with: npx tsx scripts/e2eTest.ts
 */
import { parseChat } from "../src/lib/chatParser";
import { runPipeline } from "../src/lib/pipeline";
import { generateICS } from "../src/lib/icsGenerator";
import { SAMPLE_CHATS } from "../src/lib/sampleChats";
import { createClient } from "@supabase/supabase-js";
import { config } from "dotenv";

config({ path: new URL("../.env", import.meta.url).pathname });

const url = process.env.VITE_SUPABASE_URL!;
const anonKey = process.env.VITE_SUPABASE_ANON_KEY!;
const supabase = createClient(url, anonKey);

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

    check("pipeline returned messages", result.messages.length > 0);
    check("events extracted", result.events.length > 0);
    console.log(
      `  events: ${result.events.map((e) => `${e.title} [${e.kind}] ${e.startDate ?? "?"} ${e.startTime ?? ""} conf=${e.confidence.toFixed(2)} review=${e.needsReview}`).join("\n          ")}`
    );

    // Per-sample expectations
    if (sample.id === "rivera") {
      expectEventTitles(result.events, ["practice", "grandma", "dentist", "permission"], "Rivera");
      const nov = result.events.find((e) => e.datePhrase?.toLowerCase().includes("nov 14"));
      check("Rivera: Nov 14 resolved", nov?.startDate === "2026-11-14", `got ${nov?.startDate}`);
      const tuesday = result.events.find((e) => e.datePhrase?.toLowerCase().includes("next tuesday"));
      // Sat Oct 3 message + "next Tuesday" = Tuesday Oct 6 (following calendar week)
      check("Rivera: next Tuesday resolved to 2026-10-06", tuesday?.startDate === "2026-10-06", `got ${tuesday?.startDate}`);
      const dentist = result.events.find((e) => e.title.toLowerCase().includes("dentist") && e.startTime);
      check("Rivera: dentist has a 9:30 time", dentist?.startTime === "09:30:00", `got ${dentist?.startTime}`);
    }
    if (sample.id === "lake") {
      expectEventTitles(result.events, ["deposit", "lake"], "Lake");
      const deposit = result.events.find((e) => e.title.toLowerCase().includes("deposit"));
      check("Lake: deposit due Oct 20 with an assumption note", deposit?.startDate === "2026-10-20" && (deposit?.note ?? "").length > 0, `got ${deposit?.startDate} note=${deposit?.note}`);
    }
    if (sample.id === "room4b") {
      expectEventTitles(result.events, ["bake", "dismissal"], "Room4B");
      const pickup = result.events.find((e) => e.datePhrase?.toLowerCase().includes("3"));
      // "pickup at 3?" has no date — should land in review
      check("Room4B: 'pickup at 3' needs review (no date)", pickup?.needsReview === true || pickup === undefined, `needsReview=${pickup?.needsReview}`);
    }

    // --- approve + edit persistence ---
    const target = result.events.find((e) => e.startDate);
    if (!target) {
      failures++;
      console.log("FAIL  no event with a startDate to approve");
      continue;
    }
    const { error: apErr } = await supabase
      .from("events")
      .update({ status: "approved" })
      .eq("uid", target.uid ?? "");
    check("approve persisted to DB", !apErr, apErr?.message);

    const { error: edErr } = await supabase
      .from("events")
      .update({ title: `${target.title} (edited)`, start_time: "18:00:00" })
      .eq("uid", target.uid ?? "");
    check("edit persisted to DB", !edErr, edErr?.message);

    const { data: reread, error: rrErr } = await supabase
      .from("events")
      .select("status, title, start_time")
      .eq("uid", target.uid ?? "")
      .maybeSingle();
    check("re-read after approve+edit", !rrErr && reread?.status === "approved" && reread!.title.includes("(edited)"), rrErr?.message ?? JSON.stringify(reread));

    // revert the edit so the ICS/feed checks see the real title
    await supabase
      .from("events")
      .update({ title: target.title, start_time: target.startTime, status: "pending" })
      .eq("uid", target.uid ?? "");

    // --- ICS generation ---
    const approvedEvents = result.events.map((e) => ({ ...e, status: "approved" as const }));
    const ics = generateICS(approvedEvents, sample.name);
    check("ICS starts VCALENDAR", ics.startsWith("BEGIN:VCALENDAR"));
    check("ICS has CRLF endings", ics.includes("\r\n"));
    check("ICS has VEVENTs", (ics.match(/BEGIN:VEVENT/g) ?? []).length >= 1);
    check("ICS lines ≤ 75 octets", ics.split("\r\n").every((l) => new TextEncoder().encode(l).length <= 75));

    // --- ics-feed function ---
    const feedResp = await fetch(`${url}/functions/v1/ics-feed?slug=${result.feedSlug}`, {
      headers: { Authorization: `Bearer ${anonKey}` },
    });
    check("ics-feed returns 200", feedResp.ok, `status ${feedResp.status}`);
    const feedText = await feedResp.text();
    check("ics-feed content-type is text/calendar", (feedResp.headers.get("content-type") ?? "").includes("text/calendar"), feedResp.headers.get("content-type") ?? "");
    check("ics-feed body is VCALENDAR", feedText.startsWith("BEGIN:VCALENDAR"), feedText.slice(0, 120));
  }

  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("E2E crashed:", err instanceof Error ? err.message : err);
  process.exit(1);
});

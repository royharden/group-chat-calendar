// @ts-nocheck
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 200, headers: corsHeaders });

  try {
    if (req.method !== "GET") {
      return new Response(JSON.stringify({ error: "Method not allowed" }), {
        status: 405,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const slug = new URL(req.url).searchParams.get("slug");
    if (!slug) {
      return new Response(JSON.stringify({ error: "slug is required" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { createClient } = await import("npm:@supabase/supabase-js@2.57.4");
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { data: chat, error: chatErr } = await supabase
      .from("chats")
      .select("id, title, timezone")
      .eq("feed_slug", slug)
      .maybeSingle();
    if (chatErr) throw chatErr;
    if (!chat) {
      return new Response(JSON.stringify({ error: "Feed not found" }), {
        status: 404,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { data: events, error: eventsErr } = await supabase
      .from("events")
      .select(
        "title, kind, start_date, start_time, all_day, location, attendees, source_message_ids, status, uid, confidence, note, user_note"
      )
      .eq("chat_id", chat.id)
      .in("status", ["approved", "cancelled"]);
    if (eventsErr) throw eventsErr;

    const esc = (s: string) =>
      s.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");

    const fmtDate = (d: string) => d.replace(/-/g, "");
    const fmtTime = (t: string | null) => (t ?? "00:00:00").slice(0, 8).replace(/:/g, "");

    // Mirror the download path: timed events carry the chat's timezone via
    // TZID (with a VTIMEZONE block) so 4 PM stays 4 PM in any calendar app.
    const tz: string | undefined =
      typeof chat.timezone === "string" && chat.timezone.trim() && chat.timezone !== "UTC"
        ? chat.timezone.trim()
        : undefined;

    const lines: string[] = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Group Chat to Calendar//EN",
      "CALSCALE:GREGORIAN",
      "METHOD:PUBLISH",
      `X-WR-CALNAME:${esc(chat.title)}`,
    ];

    if (tz) lines.push(...vtimezoneBlock(tz, new Date().getUTCFullYear()));

    const now = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
    for (const ev of events ?? []) {
      const uid =
        ev.uid ??
        `gc-${slug}-${(ev.source_message_ids ?? []).join("-")}@groupchat.calendar`;
      const isCancelled = ev.status === "cancelled";
      const isDeadline = ev.kind === "deadline" || ev.all_day;

      lines.push("BEGIN:VEVENT");
      lines.push(`UID:${uid}`);
      lines.push(`DTSTAMP:${now}`);
      if (isCancelled) lines.push("STATUS:CANCELLED");

      if (isDeadline || !ev.start_time) {
        lines.push(`DTSTART;VALUE=DATE:${fmtDate(ev.start_date)}`);
      } else if (tz) {
        lines.push(`DTSTART;TZID=${tz}:${fmtDate(ev.start_date)}T${fmtTime(ev.start_time)}`);
        lines.push(`DTEND;TZID=${tz}:${fmtDate(ev.start_date)}T${fmtTime(shiftHour(ev.start_time))}`);
      } else {
        lines.push(`DTSTART:${fmtDate(ev.start_date)}T${fmtTime(ev.start_time)}Z`);
        lines.push(`DTEND:${fmtDate(ev.start_date)}T${fmtTime(shiftHour(ev.start_time))}Z`);
      }

      lines.push(`SUMMARY:${esc(isDeadline && ev.kind === "deadline" ? `Due: ${ev.title}` : ev.title)}`);
      const descParts: string[] = [];
      if (ev.location) descParts.push(`Where: ${ev.location}`);
      const going = (ev.attendees ?? []).filter((a: any) => a.status === "going").map((a: any) => a.name);
      const maybe = (ev.attendees ?? []).filter((a: any) => a.status === "maybe").map((a: any) => a.name);
      if (going.length) descParts.push(`Going: ${going.join(", ")}`);
      if (maybe.length) descParts.push(`Maybe: ${maybe.join(", ")}`);
      if (ev.user_note) descParts.push(ev.user_note);
      if (descParts.length) lines.push(`DESCRIPTION:${esc(descParts.join("\n"))}`);

      if (ev.kind === "deadline") {
        lines.push("BEGIN:VALARM");
        lines.push("ACTION:DISPLAY");
        lines.push("TRIGGER:-P1D");
        lines.push(`DESCRIPTION:${esc(`Due tomorrow: ${ev.title}`)}`);
        lines.push("END:VALARM");
      }

      lines.push("END:VEVENT");
    }
    lines.push("END:VCALENDAR");

    const ics = lines.map((l) => foldLine(l)).join("\r\n") + "\r\n";
    return new Response(ics, {
      headers: {
        ...corsHeaders,
        "Content-Type": "text/calendar; charset=utf-8",
        "Content-Disposition": `inline; filename="${slug}.ics"`,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ error: message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});

function shiftHour(t: string): string {
  const h = Number(String(t).slice(0, 2));
  return `${String((h + 1) % 24).padStart(2, "0")}${String(t).slice(2)}`;
}

// RFC 5545 requires a VTIMEZONE definition for every TZID referenced.
// Emits a standard/daylight pair when the zone observes DST in the current year.
function vtimezoneBlock(tz: string, year: number): string[] {
  const block: string[] = ["BEGIN:VTIMEZONE", `TZID:${tz}`];
  try {
    const fmt = (opts: Intl.DateTimeFormatOptions) =>
      new Intl.DateTimeFormat("en-US", { timeZone: tz, ...opts });
    const offsetMinutes = (instant: Date) => {
      const parts = fmt({
        timeZoneName: "longOffset",
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", hour12: false,
      }).formatToParts(instant);
      const name = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT+00:00";
      const m = name.match(/GMT([+-])(\d{2}):(\d{2})/);
      if (!m) return 0;
      const sign = m[1] === "-" ? -1 : 1;
      return sign * (Number(m[2]) * 60 + Number(m[3]));
    };

    const midYear = new Date(Date.UTC(year, 6, 1, 12));
    const winter = new Date(Date.UTC(year, 0, 1, 12));
    const summerOffset = offsetMinutes(midYear);
    const winterOffset = offsetMinutes(winter);

    const fmtOffset = (min: number) => {
      const sign = min < 0 ? "-" : "+";
      const abs = Math.abs(min);
      const h = String(Math.floor(abs / 60)).padStart(2, "0");
      const m = String(abs % 60).padStart(2, "0");
      return `${sign}${h}${m}`;
    };

    if (summerOffset === winterOffset) {
      block.push("BEGIN:STANDARD", `DTSTART:${year}0101T000000`, `TZOFFSETFROM:${fmtOffset(winterOffset)}`, `TZOFFSETTO:${fmtOffset(winterOffset)}`, "END:STANDARD");
    } else {
      const dstOffset = Math.max(summerOffset, winterOffset);
      const stdOffset = Math.min(summerOffset, winterOffset);
      block.push(
        "BEGIN:DAYLIGHT",
        `DTSTART:${year}0315T030000`,
        `TZOFFSETFROM:${fmtOffset(stdOffset)}`,
        `TZOFFSETTO:${fmtOffset(dstOffset)}`,
        "END:DAYLIGHT",
        "BEGIN:STANDARD",
        `DTSTART:${year}1115T030000`,
        `TZOFFSETFROM:${fmtOffset(dstOffset)}`,
        `TZOFFSETTO:${fmtOffset(stdOffset)}`,
        "END:STANDARD"
      );
    }
  } catch {
    block.push("BEGIN:STANDARD", `DTSTART:${year}0101T000000`, "TZOFFSETFROM:+0000", "TZOFFSETTO:+0000", "END:STANDARD");
  }
  block.push("END:VTIMEZONE");
  return block;
}

function foldLine(line: string): string {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(line);
  if (bytes.length <= 75) return line;

  const out: string[] = [];
  let remaining = line;
  let first = true;
  while (remaining.length > 0) {
    let width = first ? 75 : 74;
    let chunk = remaining.slice(0, width);
    while (encoder.encode(chunk).length > width && chunk.length > 0) {
      chunk = chunk.slice(0, chunk.length - 1);
      width = chunk.length;
    }
    out.push(first ? chunk : ` ${chunk}`);
    remaining = remaining.slice(chunk.length);
    first = false;
    if (remaining.length === 0) break;
  }
  return out.join("\r\n");
}

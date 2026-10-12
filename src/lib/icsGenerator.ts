import type { ChatEvent } from "./types";

const CRLF = "\r\n";

function escapeText(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");
}

// RFC 5545: content lines SHOULD NOT be longer than 75 octets; fold with CRLF + space.
function fold(line: string): string[] {
  const encoded = new TextEncoder();
  const bytes = encoded.encode(line);
  if (bytes.length <= 75) return [line];

  const parts: string[] = [];
  let rest = line;
  let isFirst = true;
  while (rest.length > 0) {
    const limit = isFirst ? 75 : 74; // continuation lines carry a leading space
    let chunk = rest;
    while (encoded.encode(chunk).length > limit && chunk.length > 0) {
      chunk = chunk.slice(0, -1);
    }
    parts.push(isFirst ? chunk : " " + chunk);
    rest = rest.slice(chunk.length);
    isFirst = false;
  }
  return parts;
}

function utcStamp(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function dateStamp(yyyyMmDd: string): string {
  return yyyyMmDd.replace(/-/g, "");
}

function timeStr(hhmmss: string): string {
  return hhmmss.replace(/:/g, "").slice(0, 6);
}

// RFC 5545 requires a VTIMEZONE definition for every TZID referenced.
// Emits a standard/daylight pair when the zone observes DST in the event year.
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

export function generateICS(
  events: ChatEvent[],
  chatTitle: string,
  now: Date = new Date(),
  timezone?: string
): string {
  const lines: string[] = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Group Chat to Calendar//EN",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${escapeText(chatTitle)}`,
  ];

  const timedEvents = events.filter((e) => !e.allDay && e.startTime && e.startDate);
  const tz = timezone?.trim() || timedEvents[0]?.timezone;
  const useTzid = !!tz && tz !== "UTC";
  if (useTzid && tz) {
    const year = new Date(timedEvents[0]?.startDate ?? now).getUTCFullYear();
    lines.push(...vtimezoneBlock(tz, year));
  }

  for (const ev of events) {
    const isCancelled = ev.status === "cancelled";
    const isDeadline = ev.kind === "deadline";

    lines.push("BEGIN:VEVENT");
    lines.push(`UID:${ev.uid ?? `${ev.id}@groupchat.calendar`}`);
    lines.push(`DTSTAMP:${utcStamp(now)}`);
    if (isCancelled) lines.push("STATUS:CANCELLED");
    lines.push(`SUMMARY:${escapeText(isDeadline ? `Due: ${ev.title}` : ev.title)}`);

    if (ev.startDate) {
      // Only events without a time are all-day. A timed deadline keeps its
      // time and has no DTEND (a moment, not a block).
      if (ev.allDay || !ev.startTime) {
        lines.push(`DTSTART;VALUE=DATE:${dateStamp(ev.startDate)}`);
      } else if (useTzid && tz) {
        // Local wall-clock time with an explicit timezone — 4 PM stays 4 PM.
        lines.push(`DTSTART;TZID=${tz}:${dateStamp(ev.startDate)}T${timeStr(ev.startTime)}`);
        if (!isDeadline) lines.push(`DTEND;TZID=${tz}:${dateStamp(ev.startDate)}T${timeStr(shiftHour(ev.startTime))}`);
      } else {
        lines.push(`DTSTART:${dateStamp(ev.startDate)}T${timeStr(ev.startTime)}Z`);
        if (!isDeadline) lines.push(`DTEND:${dateStamp(ev.startDate)}T${timeStr(shiftHour(ev.startTime))}Z`);
      }
    }

    const descParts: string[] = [];
    if (ev.location) descParts.push(`Where: ${ev.location}`);
    const going = ev.attendees.filter((a) => a.status === "going").map((a) => a.name);
    const maybe = ev.attendees.filter((a) => a.status === "maybe").map((a) => a.name);
    if (going.length) descParts.push(`Going: ${going.join(", ")}`);
    if (maybe.length) descParts.push(`Maybe: ${maybe.join(", ")}`);
    // Only user-facing notes go into DESCRIPTION; internal resolution notes
    // (e.g. "bare time — assumed PM") stay in the app.
    if (ev.userNote) descParts.push(ev.userNote);
    if (descParts.length) lines.push(`DESCRIPTION:${escapeText(descParts.join(CRLF))}`);

    if (isDeadline && ev.startDate) {
      lines.push("BEGIN:VALARM");
      lines.push("ACTION:DISPLAY");
      lines.push("TRIGGER:-P1D");
      lines.push(`DESCRIPTION:${escapeText(`Due tomorrow: ${ev.title}`)}`);
      lines.push("END:VALARM");
    }

    lines.push("END:VEVENT");
  }

  lines.push("END:VCALENDAR");

  const flat = lines.map(fold).map((chunks) => chunks.join(CRLF));
  return flat.join(CRLF) + CRLF;
}

function shiftHour(hhmmss: string): string {
  const h = Number(hhmmss.slice(0, 2));
  return `${String((h + 1) % 24).padStart(2, "0")}${hhmmss.slice(2)}`;
}

// Stable UID from source message ids, chat id, and title (simple FNV-1a hash).
export function stableUid(sourceMessageIds: string[], chatId: string, title = ""): string {
  const input = `${chatId}|${[...sourceMessageIds].sort().join(",")}|${title.toLowerCase()}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return `gc-${hash.toString(16).padStart(8, "0")}@groupchat.calendar`;
}

export interface ParsedMessage {
  id: string;
  sent_at: string; // ISO string
  sender: string;
  text: string;
}

interface HeaderMatch {
  sentAt: Date;
  rest: string;
}

// [10/3/26, 7:41 PM] Mom: ...
const BRACKET_RE = /^\[(\d{1,2})\/(\d{1,2})\/(\d{2,4}),\s+(\d{1,2}):(\d{2})\s*([APap]\.?[Mm]\.?)?\]\s*/;
// 10/3/26, 19:41 - Mom: ...
const DASH_RE = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4}),?\s+(\d{1,2}):(\d{2})\s*([APap]\.?[Mm]\.?)?\s*[-–]\s*/;

function getZoneOffsetMinutes(date: Date, tz: string): number {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = dtf.formatToParts(date);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
  const asUTC = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
  return (asUTC - date.getTime()) / 60_000;
}

// Interpret a wall-clock time in `tz`, returning the UTC instant it refers to.
export function wallClockToInstant(
  year: number, month: number, day: number,
  hour: number, minute: number,
  meridiem: string | undefined,
  tz: string
): Date {
  let h = hour;
  const m = (meridiem ?? "").toUpperCase().replace(/\./g, "");
  if (m === "PM" && h < 12) h += 12;
  if (m === "AM" && h === 12) h = 0;

  const yyyy = year < 100 ? 2000 + year : year;
  const pad = (n: number) => String(n).padStart(2, "0");
  let utc = new Date(Date.UTC(yyyy, month - 1, day, h, minute, 0));
  if (tz && tz !== "UTC") {
    try {
      const offsetMin = getZoneOffsetMinutes(utc, tz);
      utc = new Date(utc.getTime() - offsetMin * 60_000);
    } catch {
      // invalid zone name: fall back to UTC
    }
  }
  return utc;
}

// The calendar day an instant falls on in `tz`, normalized to UTC noon so
// downstream UTC-date math (e.g. "tomorrow" = +1 day) uses the chat's local day.
export function zonedCalendarNoon(instant: Date, tz: string): Date {
  try {
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    const parts = dtf.formatToParts(instant);
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? "0");
    return new Date(Date.UTC(get("year"), get("month") - 1, get("day"), 12));
  } catch {
    return new Date(Date.UTC(instant.getUTCFullYear(), instant.getUTCMonth(), instant.getUTCDate(), 12));
  }
}

function matchHeader(line: string, tz: string, fallbackYear: number): HeaderMatch | null {
  const bracket = line.match(BRACKET_RE);
  if (bracket) {
    return {
      // WhatsApp uses M/D/Y
      sentAt: wallClockToInstant(+bracket[3], +bracket[1], +bracket[2], +bracket[4], +bracket[5], bracket[6], tz),
      rest: line.slice(bracket[0].length),
    };
  }
  const dash = line.match(DASH_RE);
  if (dash) {
    return {
      sentAt: wallClockToInstant(+dash[3], +dash[1], +dash[2], +dash[4], +dash[5], dash[6], tz),
      rest: line.slice(dash[0].length),
    };
  }
  void fallbackYear;
  return null;
}

export interface ParseResult {
  messages: ParsedMessage[];
  members: string[];
  format: "whatsapp-bracket" | "whatsapp-dash" | "plain" | "empty";
}

export function parseChat(
  raw: string,
  opts: { timezone?: string; firstMessageDate?: string; defaultSender?: string } = {}
): ParseResult {
  const tz = opts.timezone || "UTC";
  const firstDate = opts.firstMessageDate ? new Date(opts.firstMessageDate + "T12:00:00Z") : null;

  const lines = raw.replace(/\r\n/g, "\n").replace(/[\u200e\u200f\u202a-\u202e]/g, "").split("\n");

  let format: ParseResult["format"] = "empty";
  for (const line of lines) {
    if (BRACKET_RE.test(line)) {
      format = "whatsapp-bracket";
      break;
    }
    if (DASH_RE.test(line)) {
      format = "whatsapp-dash";
      break;
    }
    if (/^[^:\n]{1,40}:\s/.test(line.trim())) {
      format = "plain";
      break;
    }
  }
  if (format === "empty") return { messages: [], members: [], format };

  const messages: ParsedMessage[] = [];
  let current: ParsedMessage | null = null;
  let seq = 0;

  const pushCurrent = () => {
    if (current && current.text.trim()) {
      current.text = current.text.trim();
      messages.push(current);
    }
    current = null;
  };

  for (const line of lines) {
    const trimmed = line.replace(/\s+$/, "");
    if (!trimmed.trim()) {
      if (current) current.text += "\n";
      continue;
    }

    if (format === "plain") {
      const m = trimmed.match(/^([^:\n]{1,40}):\s?([\s\S]*)$/);
      if (m) {
        pushCurrent();
        const sentAt = firstDate
          ? new Date(firstDate.getTime() + seq * 60_000)
          : new Date();
        current = {
          id: `M${String(++seq).padStart(3, "0")}`,
          sent_at: sentAt.toISOString(),
          sender: m[1].trim(),
          text: m[2],
        };
      } else if (current) {
        current.text += "\n" + trimmed;
      }
      continue;
    }

    const header = matchHeader(trimmed, tz, firstDate ? firstDate.getUTCFullYear() : new Date().getUTCFullYear());
    if (header) {
      const senderMatch = header.rest.match(/^([^:]{1,60}):\s?([\s\S]*)$/);
      pushCurrent();
      current = {
        id: `M${String(++seq).padStart(3, "0")}`,
        sent_at: header.sentAt.toISOString(),
        sender: senderMatch ? senderMatch[1].trim() : (opts.defaultSender ?? "Unknown"),
        text: senderMatch ? senderMatch[2] : header.rest,
      };
    } else if (current) {
      current.text += "\n" + trimmed;
    }
  }
  pushCurrent();

  const members = Array.from(new Set(messages.map((m) => m.sender))).sort();

  return { messages, members, format };
}

import { type ReactNode } from "react";
import type { Attendee } from "../lib/types";

export function ConfidenceChip({ value }: { value: number }) {
  const tone =
    value >= 0.8
      ? "bg-emerald-100 text-emerald-800 ring-emerald-600/20"
      : value >= 0.6
        ? "bg-amber-100 text-amber-800 ring-amber-600/20"
        : "bg-red-100 text-red-700 ring-red-600/20";
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${tone}`}>
      {Math.round(value * 100)}%
    </span>
  );
}

export function KindChip({ kind }: { kind: string | null }) {
  if (!kind || kind === "none") return null;
  const tones: Record<string, string> = {
    new_event: "bg-sky-100 text-sky-800 ring-sky-600/20",
    deadline: "bg-orange-100 text-orange-800 ring-orange-600/20",
    change: "bg-violet-100 text-violet-800 ring-violet-600/20",
    cancellation: "bg-red-100 text-red-800 ring-red-600/20",
    rsvp: "bg-teal-100 text-teal-800 ring-teal-600/20",
  };
  const label = (kind ?? "").replace("_", " ");
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${tones[kind] ?? "bg-stone-100 text-stone-700 ring-stone-500/20"}`}>
      {label}
    </span>
  );
}

export function AttendeeList({ attendees }: { attendees: Attendee[] }) {
  if (!attendees.length) return null;
  const going = attendees.filter((a) => a.status === "going");
  const maybe = attendees.filter((a) => a.status === "maybe");
  return (
    <div className="flex flex-wrap gap-1.5">
      {going.map((a) => (
        <span key={a.name} className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-xs text-emerald-800 ring-1 ring-inset ring-emerald-600/20">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
          {a.name}
        </span>
      ))}
      {maybe.map((a) => (
        <span key={a.name} className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-xs text-amber-800 ring-1 ring-inset ring-amber-600/20">
          <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
          {a.name}?
        </span>
      ))}
    </div>
  );
}

const RULE_LABELS: Record<string, string> = {
  today: "today",
  tomorrow: "tomorrow",
  day_after_tomorrow: "day after tomorrow",
  yesterday: "yesterday",
  weekday: "next matching weekday",
  next_weekday: "weekday in the following week",
  month_day: "month + day",
  numeric_date: "numeric date",
  day_of_month: "day of the month",
  none: "unresolved",
};

// How the code resolver read the date (rule, reference day, time source).
function ResolverDetails({ parts }: { parts: Record<string, unknown> }) {
  const rows: [string, string][] = [];
  if (typeof parts.rule === "string") rows.push(["rule", RULE_LABELS[parts.rule] ?? parts.rule]);
  if (typeof parts.reference_date === "string") rows.push(["sent on", parts.reference_date]);
  if (typeof parts.time_source === "string") {
    rows.push(["time from", parts.time_source === "time_phrase" ? "extracted time" : "message text"]);
  }
  if (typeof parts.end_time === "string") rows.push(["ends", parts.end_time.slice(0, 5)]);
  return (
    <div className="space-y-1">
      {rows.map(([k, v]) => (
        <div key={k} className="flex items-center gap-2 text-xs">
          <span className="w-20 shrink-0 text-stone-500">{k}</span>
          <span className="rounded bg-stone-800/5 px-1.5 py-0.5 text-stone-700">{v}</span>
        </div>
      ))}
    </div>
  );
}

export function ProbabilityBars({ parts }: { parts: Record<string, unknown> | null }) {
  if (!parts) return null;
  if (parts.resolver === "code") return <ResolverDetails parts={parts} />;
  const interest = ["mode", "day_anchor", "weekday", "month", "day", "week_offset", "meridiem", "year"];
  const rows: { q: string; probs: [string, number][] }[] = [];
  for (const q of interest) {
    const a = parts[q] as { probabilities?: Record<string, number>; choice: string; confidence: number } | undefined;
    if (!a?.probabilities) continue;
    const probs = Object.entries(a.probabilities)
      .filter(([, v]) => typeof v === "number" && v > 0.01)
      .sort((x, y) => y[1] - x[1])
      .slice(0, 3) as [string, number][];
    if (probs.length) rows.push({ q, probs });
  }
  if (!rows.length) return null;
  return (
    <div className="space-y-1">
      {rows.map(({ q, probs }) => (
        <div key={q} className="flex items-center gap-2 text-xs">
          <span className="w-20 shrink-0 text-stone-500">{q}</span>
          <div className="flex flex-1 flex-wrap gap-1">
            {probs.map(([opt, p]) => (
              <span
                key={opt}
                className={`rounded px-1.5 py-0.5 tabular-nums ${
                  opt === "none" || opt === "uncertain"
                    ? "bg-stone-100 text-stone-600"
                    : "bg-stone-800/5 text-stone-700"
                }`}
              >
                {opt}: {Math.round(p * 100)}%
              </span>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

export function SectionCard({
  title,
  icon,
  actions,
  children,
  className = "",
}: {
  title: string;
  icon?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`rounded-2xl border border-stone-200/80 bg-white shadow-sm ${className}`}>
      <header className="flex items-center justify-between gap-2 border-b border-stone-100 px-4 py-3">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-stone-800">
          {icon}
          {title}
        </h2>
        {actions}
      </header>
      <div className="p-4">{children}</div>
    </section>
  );
}

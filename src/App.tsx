import { useMemo, useState } from "react";
import {
  CalendarClock, CheckCircle2, Clock, FileText, Filter, Link2,
  Loader2, MessageSquare, RefreshCw, Sparkles, ThumbsDown, ThumbsUp, TriangleAlert, Wand2, XCircle,
} from "lucide-react";
import { SAMPLE_CHATS } from "./lib/sampleChats";
import { runPipeline, type PipelineResult, type RunOptions } from "./lib/pipeline";
import { generateICS, stableUid } from "./lib/icsGenerator";
import { ConfidenceChip, KindChip, AttendeeList, ProbabilityBars } from "./components/common";
import type { PipelineStats } from "./lib/types";
import type { ChatEvent } from "./lib/types";

const STAGES = [
  { id: "parse", label: "Parse", icon: FileText },
  { id: "filter", label: "Jev filter", icon: Filter },
  { id: "extract", label: "LLM extract", icon: Sparkles },
  { id: "date-parts", label: "Jev date parts", icon: CalendarClock },
  { id: "attendees", label: "Attendees", icon: MessageSquare },
  { id: "done", label: "Review", icon: CheckCircle2 },
];

function stageIndex(id: string) {
  return STAGES.findIndex((s) => s.id === id);
}

export default function App() {
  const [raw, setRaw] = useState("");
  const [chatTitle, setChatTitle] = useState("");
  const [timezone, setTimezone] = useState(
    Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
  );
  const [mode, setMode] = useState<"live" | "mock">("live");
  const [reviewBelow, setReviewBelow] = useState(0.6);
  const [running, setRunning] = useState(false);
  const [currentStage, setCurrentStage] = useState<string | null>(null);
  const [progressLog, setProgressLog] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PipelineResult | null>(null);
  const [events, setEvents] = useState<ChatEvent[]>([]);
  const [highlightIds, setHighlightIds] = useState<Set<string>>(new Set());
  const [timeFilter, setTimeFilter] = useState("all");

  const offlineNotice = result?.offlineReason ?? null;

  const needsReview = events.filter((e) => e.needsReview && e.status === "pending");
  const ready = events.filter((e) => !e.needsReview && e.status === "pending");
  const approved = events.filter((e) => e.status === "approved");

  const updateEvent = (id: string, patch: Partial<ChatEvent>) => {
    setEvents((prev) => prev.map((e) => (e.id === id ? { ...e, ...patch } : e)));
  };

  const setEventStatus = async (ev: ChatEvent, status: ChatEvent["status"]) => {
    updateEvent(ev.id, { status });
    const { supabase } = await import("./lib/supabase");
    const { error } = await supabase
      .from("events")
      .update({ status })
      .eq("chat_id", ev.chatId)
      .eq("uid", ev.uid ?? "");
    if (error) setError(`Could not save that change: ${error.message}`);
  };

  const approveAllHigh = async () => {
    const batch = events.filter((e) => e.status === "pending" && !e.needsReview && e.confidence >= 0.8);
    for (const ev of batch) await setEventStatus(ev, "approved");
  };

  const persistEventEdits = async (ev: ChatEvent, patch: Record<string, unknown>) => {
    const { supabase } = await import("./lib/supabase");
    const { error } = await supabase
      .from("events")
      .update(patch)
      .eq("chat_id", ev.chatId)
      .eq("uid", ev.uid ?? "");
    if (error) setError(`Could not save that edit: ${error.message}`);
  };

  const loadSample = (sampleId: string) => {
    const sample = SAMPLE_CHATS.find((s) => s.id === sampleId);
    if (!sample) return;
    setRaw(sample.raw);
    setChatTitle(sample.name);
    setTimezone(sample.timezone);
    setResult(null);
    setEvents([]);
    setError(null);
  };

  const run = async () => {
    setRunning(true);
    setError(null);
    setProgressLog([]);
    setResult(null);
    setEvents([]);
    const opts: RunOptions = {
      chatTitle: chatTitle || "Pasted chat",
      rawChat: raw,
      timezone,
      mode,
      reviewBelow,
      onStage: (stage) => setCurrentStage(stage),
      onProgress: (msg) => setProgressLog((p) => [...p, msg]),
    };
    try {
      const res = await runPipeline(opts);
      setResult(res);
      setEvents(res.events);
      setCurrentStage("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setCurrentStage(null);
    } finally {
      setRunning(false);
    }
  };

  const onUpload = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      setRaw(String(reader.result ?? ""));
      setChatTitle(file.name.replace(/\.[^.]+$/, ""));
    };
    reader.readAsText(file);
  };

  const downloadICS = () => {
    const approvedEvents = events.filter((e) => e.status === "approved" || e.status === "cancelled");
    const ics = generateICS(
      approvedEvents,
      result?.title ?? chatTitle ?? "Calendar",
      new Date(),
      result?.timezone ?? timezone
    );
    const blob = new Blob([ics], { type: "text/calendar" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${(result?.feedSlug ?? "calendar")}.ics`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const feedUrl = result
    ? `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/ics-feed?slug=${result.feedSlug}`
    : null;

  const previewMonth = useMemo(() => new Date(), []);

  return (
    <div className="min-h-screen bg-[#faf8f5] text-stone-900">
      {/* Header */}
      <header className="border-b border-stone-200/70 bg-white/80 backdrop-blur sticky top-0 z-20">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-3">
          <div className="flex items-center gap-2">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-stone-900 text-white">
              <CalendarClock className="h-4.5 w-4.5" size={18} />
            </div>
            <span className="font-semibold tracking-tight">Group Chat → Calendar</span>
          </div>
          <div className="flex items-center gap-2 text-xs">
            <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-1 font-medium ring-1 ring-inset ${
              mode === "live"
                ? "bg-emerald-50 text-emerald-700 ring-emerald-600/20"
                : "bg-amber-50 text-amber-700 ring-amber-600/20"
            }`}>
              <span className={`h-1.5 w-1.5 rounded-full ${mode === "live" ? "bg-emerald-500" : "bg-amber-500"}`} />
              {mode === "live" ? "Live extractor" : "Mock extractor"}
            </span>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 pb-16">
        {/* Hero */}
        <section className="py-10 text-center sm:py-14">
          <h1 className="mx-auto max-w-2xl text-balance text-3xl font-bold tracking-tight sm:text-4xl">
            Never miss the thing buried in 400 messages.
          </h1>
          <p className="mx-auto mt-3 max-w-xl text-pretty text-stone-600">
            Paste a family or friends group chat. Jev filters the noise, an LLM pulls out the
            events, and code turns “next Tuesday” into a real date you approve.
          </p>

          <div className="mx-auto mt-8 max-w-3xl rounded-2xl border border-stone-200/80 bg-white p-4 shadow-sm text-left">
            <textarea
              value={raw}
              onChange={(e) => setRaw(e.target.value)}
              placeholder={"Paste your chat export here…\n\n[10/3/26, 7:41 PM] Mom: Practice moved to next Tuesday at 5!\n…or\nMom: Practice moved to next Tuesday at 5!"}
              className="h-40 w-full resize-y rounded-xl border border-stone-200 bg-stone-50/60 p-3 font-mono text-xs text-stone-800 placeholder:text-stone-400 focus:border-stone-400 focus:outline-none focus:ring-2 focus:ring-stone-900/10"
            />
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <input
                value={chatTitle}
                onChange={(e) => setChatTitle(e.target.value)}
                placeholder="Chat name"
                className="w-36 rounded-lg border border-stone-200 bg-stone-50/60 px-2.5 py-1.5 text-sm focus:border-stone-400 focus:outline-none"
              />
              <select
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
                className="rounded-lg border border-stone-200 bg-stone-50/60 px-2 py-1.5 text-sm focus:border-stone-400 focus:outline-none"
              >
                {["UTC", Intl.DateTimeFormat().resolvedOptions().timeZone, "America/Los_Angeles", "America/Denver", "America/Chicago", "America/New_York", "Europe/London", "Europe/Berlin"].filter((v, i, a) => v && a.indexOf(v) === i).map((tz) => (
                  <option key={tz} value={tz}>{tz}</option>
                ))}
              </select>
              <label className="flex cursor-pointer items-center gap-1.5 rounded-lg border border-stone-200 bg-stone-50/60 px-2.5 py-1.5 text-sm">
                <input type="file" accept=".txt,text/plain" className="hidden" onChange={(e) => e.target.files?.[0] && onUpload(e.target.files[0])} />
                <FileText className="h-4 w-4 text-stone-500" />
                Upload
              </label>
              <div className="ml-auto flex items-center gap-2">
                <div className="flex rounded-lg border border-stone-200 bg-stone-50/60 p-0.5 text-xs font-medium">
                  {(["live", "mock"] as const).map((m) => (
                    <button
                      key={m}
                      onClick={() => setMode(m)}
                      className={`rounded-md px-2.5 py-1 capitalize transition ${
                        mode === m ? "bg-stone-900 text-white" : "text-stone-600 hover:text-stone-900"
                      }`}
                    >
                      {m === "live" ? "Live" : "Mock extractor"}
                    </button>
                  ))}
                </div>
                <button
                  onClick={run}
                  disabled={running || !raw.trim()}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-stone-900 px-4 py-1.5 text-sm font-medium text-white transition hover:bg-stone-700 disabled:opacity-40"
                >
                  {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />}
                  {running ? "Working…" : "Extract events"}
                </button>
              </div>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-stone-100 pt-3">
              <span className="text-xs text-stone-500">Try a sample:</span>
              {SAMPLE_CHATS.map((s) => (
                <button
                  key={s.id}
                  onClick={() => loadSample(s.id)}
                  className="rounded-full border border-stone-200 bg-stone-50 px-3 py-1 text-xs font-medium text-stone-700 transition hover:border-stone-400 hover:bg-white"
                  title={s.description}
                >
                  {s.name}
                </button>
              ))}
              <label className="ml-auto flex items-center gap-2 text-xs text-stone-500">
                Review below
                <input
                  type="range" min={0.3} max={0.9} step={0.05}
                  value={reviewBelow}
                  onChange={(e) => setReviewBelow(Number(e.target.value))}
                  className="w-24 accent-stone-900"
                />
                <span className="w-8 tabular-nums">{reviewBelow.toFixed(2)}</span>
              </label>
            </div>
          </div>
        </section>

        {/* Pipeline strip */}
        <section className="mb-8">
          <div className="flex flex-wrap items-center gap-1.5">
            {STAGES.map((s, i) => {
              const idx = stageIndex(s.id);
              const cur = currentStage ? stageIndex(currentStage) : -1;
              const state = running && idx === cur ? "active" : idx < cur || (!running && result && idx <= STAGES.length - 1 && result) ? "done" : "idle";
              void state;
              const active = running && currentStage === s.id;
              const passed = result !== null || (running && currentStage !== null && stageIndex(currentStage) > idx);
              return (
                <div key={s.id} className="flex items-center gap-1.5">
                  {i > 0 && <div className={`h-px w-4 sm:w-6 ${passed ? "bg-stone-400" : "bg-stone-200"}`} />}
                  <div className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${
                    active
                      ? "border-stone-900 bg-stone-900 text-white"
                      : passed
                        ? "border-stone-300 bg-white text-stone-700"
                        : "border-stone-200 bg-stone-50 text-stone-400"
                  }`}>
                    {active ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <s.icon className="h-3.5 w-3.5" />}
                    {s.label}
                  </div>
                </div>
              );
            })}
          </div>
          {progressLog.length > 0 && (
            <div className="mt-2 space-y-0.5 font-mono text-xs text-stone-500">
              {progressLog.map((l, i) => <div key={i}>· {l}</div>)}
            </div>
          )}
          {error && (
            <div className="mt-3 flex items-center gap-2 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
              <XCircle className="h-4 w-4 shrink-0" />
              {error}
            </div>
          )}
          {offlineNotice && (
            <div className="mt-3 flex items-start gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
              <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
              <div>
                <p className="font-medium">Running in offline mode</p>
                <p className="mt-0.5 text-amber-800">{offlineNotice}</p>
                <p className="mt-0.5 text-amber-700">
                  Dates were resolved with the built-in rules instead of Jev — everything is
                  flagged for your review, so nothing slips through unverified.
                </p>
              </div>
            </div>
          )}
        </section>

        {result && (
          <>
            {/* Review board */}
            <section className="mb-8">
              <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-lg font-semibold tracking-tight">Review board</h2>
                <div className="flex gap-2">
                  <button
                    onClick={approveAllHigh}
                    className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-1.5 text-sm font-medium text-emerald-800 transition hover:bg-emerald-100"
                  >
                    <ThumbsUp className="h-4 w-4" />
                    Approve all ≥ 0.8
                  </button>
                  <button
                    onClick={downloadICS}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-stone-900 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-stone-700"
                  >
                    Download .ics
                  </button>
                </div>
              </div>
              <div className="grid gap-4 lg:grid-cols-2">
                <Lane
                  title={`Needs review (${needsReview.length})`}
                  tone="amber"
                  emptyText="Nothing waiting — nice."
                  events={needsReview}
                  onStatus={setEventStatus}
                  onUpdate={updateEvent}
                  onPersistEdits={persistEventEdits}
                  onHighlight={setHighlightIds}
                />
                <Lane
                  title={`Ready (${ready.length})`}
                  tone="emerald"
                  emptyText="No confident events yet."
                  events={ready}
                  onStatus={setEventStatus}
                  onUpdate={updateEvent}
                  onPersistEdits={persistEventEdits}
                  onHighlight={setHighlightIds}
                />
              </div>
            </section>

            <div className="grid gap-4 lg:grid-cols-5">
              {/* Chat pane */}
              <div className="lg:col-span-3">
                <ChatPane messages={result.messages} highlightIds={highlightIds} chatTimezone={result.timezone} />
              </div>
              <div className="space-y-4 lg:col-span-2">
                <CalendarPreview events={approved} month={previewMonth} />
                <ExportPanel
                  feedUrl={feedUrl}
                  stats={result.stats}
                  totalMessages={result.messages.length}
                  keptMessages={result.stats.keptMessages}
                />
              </div>
            </div>
          </>
        )}

        {!result && !running && (
          <section className="grid gap-4 sm:grid-cols-3">
            {SAMPLE_CHATS.map((s) => (
              <button
                key={s.id}
                onClick={() => loadSample(s.id)}
                className="rounded-2xl border border-stone-200/80 bg-white p-5 text-left shadow-sm transition hover:-translate-y-0.5 hover:shadow-md"
              >
                <h3 className="font-semibold">{s.name}</h3>
                <p className="mt-1 text-sm text-stone-600">{s.description}</p>
                <span className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-stone-500">
                  Load sample <RefreshCw className="h-3 w-3" />
                </span>
              </button>
            ))}
          </section>
        )}
      </main>
    </div>
  );
}

function Lane({
  title, tone, emptyText, events, onStatus, onUpdate, onPersistEdits, onHighlight,
}: {
  title: string;
  tone: "amber" | "emerald";
  emptyText: string;
  events: ChatEvent[];
  onStatus: (ev: ChatEvent, status: ChatEvent["status"]) => void;
  onUpdate: (id: string, patch: Partial<ChatEvent>) => void;
  onPersistEdits: (ev: ChatEvent, patch: Record<string, unknown>) => void;
  onHighlight: (ids: Set<string>) => void;
}) {
  return (
    <div className={`rounded-2xl border p-3 ${
      tone === "amber" ? "border-amber-200/70 bg-amber-50/40" : "border-emerald-200/70 bg-emerald-50/40"
    }`}>
      <h3 className={`mb-2 px-1 text-sm font-semibold ${tone === "amber" ? "text-amber-900" : "text-emerald-900"}`}>
        {title}
      </h3>
      {events.length === 0 ? (
        <p className="px-1 py-6 text-center text-sm text-stone-500">{emptyText}</p>
      ) : (
        <div className="max-h-[480px] space-y-2 overflow-y-auto pr-1">
          {events.map((ev) => (
            <EventCard key={ev.id} ev={ev} onStatus={onStatus} onUpdate={onUpdate} onPersistEdits={onPersistEdits} onHighlight={onHighlight} />
          ))}
        </div>
      )}
    </div>
  );
}

function EventCard({
  ev, onStatus, onUpdate, onPersistEdits, onHighlight,
}: {
  ev: ChatEvent;
  onStatus: (ev: ChatEvent, status: ChatEvent["status"]) => void;
  onUpdate: (id: string, patch: Partial<ChatEvent>) => void;
  onPersistEdits: (ev: ChatEvent, patch: Record<string, unknown>) => void;
  onHighlight: (ids: Set<string>) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [titleDraft, setTitleDraft] = useState(ev.title);
  const [dateDraft, setDateDraft] = useState(ev.startDate ?? "");
  const [timeDraft, setTimeDraft] = useState(ev.startTime ? ev.startTime.slice(0, 5) : "");

  const saveEdits = () => {
    onUpdate(ev.id, {
      title: titleDraft.trim() || ev.title,
      startDate: dateDraft || null,
      startTime: timeDraft ? `${timeDraft}:00` : null,
      allDay: !timeDraft,
      needsReview: false,
    });
    setEditing(false);
    onPersistEdits(ev, {
      title: titleDraft.trim() || ev.title,
      start_date: dateDraft || null,
      start_time: timeDraft ? `${timeDraft}:00` : null,
      all_day: !timeDraft,
      needs_review: false,
    });
  };

  return (
    <div
      className="rounded-xl border border-stone-200/80 bg-white p-3 shadow-sm transition hover:shadow"
      onMouseEnter={() => onHighlight(new Set(ev.sourceMessageIds))}
      onMouseLeave={() => onHighlight(new Set())}
    >
      <div className="flex items-start justify-between gap-2">
        {editing ? (
          <input
            value={titleDraft}
            onChange={(e) => setTitleDraft(e.target.value)}
            className="w-full rounded border border-stone-300 px-2 py-1 text-sm font-semibold focus:border-stone-500 focus:outline-none"
          />
        ) : (
          <h4 className="text-sm font-semibold leading-snug">{ev.title}</h4>
        )}
        <ConfidenceChip value={ev.confidence} />
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-stone-700">
        {editing ? (
          <>
            <input type="date" value={dateDraft} onChange={(e) => setDateDraft(e.target.value)} className="rounded border border-stone-300 px-1.5 py-0.5 text-xs" />
            <input type="time" value={timeDraft} onChange={(e) => setTimeDraft(e.target.value)} className="rounded border border-stone-300 px-1.5 py-0.5 text-xs" />
          </>
        ) : (
          <>
            <Clock className="h-3.5 w-3.5 text-stone-400" />
            <span className="font-medium">
              {ev.startDate
                ? new Date(ev.startDate + "T12:00:00").toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })
                : "Date unresolved"}
              {ev.startTime ? ` · ${ev.startTime.slice(0, 5)}` : ev.allDay ? " · all day" : ""}
            </span>
          </>
        )}
        <KindChip kind={ev.kind} />
      </div>

      {ev.datePhrase && (
        <p className="mt-1 text-xs text-stone-500">
          “{ev.datePhrase}”{ev.timePhrase ? ` · “${ev.timePhrase}”` : ""}
        </p>
      )}
      {ev.location && <p className="mt-1 text-xs text-stone-500">📍 {ev.location}</p>}
      {ev.userNote && (
        <p className="mt-1 text-xs text-stone-600">{ev.userNote}</p>
      )}
      {ev.note && (
        <p className="mt-1.5 inline-flex items-center gap-1 rounded-md bg-amber-50 px-2 py-0.5 text-xs text-amber-800 ring-1 ring-inset ring-amber-600/20">
          <TriangleAlert className="h-3 w-3" /> {ev.note}
        </p>
      )}
      <AttendeeList attendees={ev.attendees} />

      <details className="mt-2">
        <summary className="cursor-pointer text-xs text-stone-400 hover:text-stone-600">Probabilities</summary>
        <div className="mt-1.5">
          <ProbabilityBars parts={ev.parts as Record<string, unknown> | null} />
        </div>
      </details>

      <div className="mt-2.5 flex flex-wrap items-center gap-1.5 border-t border-stone-100 pt-2.5">
        {editing ? (
          <>
            <button onClick={saveEdits} className="rounded-md bg-stone-900 px-2.5 py-1 text-xs font-medium text-white hover:bg-stone-700">Save</button>
            <button onClick={() => setEditing(false)} className="rounded-md px-2 py-1 text-xs text-stone-500 hover:text-stone-800">Cancel</button>
          </>
        ) : (
          <>
            <button onClick={() => onStatus(ev, "approved")} className="inline-flex items-center gap-1 rounded-md bg-emerald-600 px-2.5 py-1 text-xs font-medium text-white hover:bg-emerald-500">
              <ThumbsUp className="h-3 w-3" /> Approve
            </button>
            <button onClick={() => setEditing(true)} className="rounded-md border border-stone-200 px-2.5 py-1 text-xs font-medium text-stone-700 hover:bg-stone-50">Edit</button>
            <button onClick={() => onStatus(ev, "rejected")} className="inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-xs text-stone-500 hover:text-red-700">
              <ThumbsDown className="h-3 w-3" /> Reject
            </button>
            {ev.sourceMessageIds.length > 0 && (
              <span className="ml-auto inline-flex items-center gap-1 text-xs text-stone-400">
                <Link2 className="h-3 w-3" /> {ev.sourceMessageIds.join(", ")}
              </span>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function formatChatTimestamp(sentAt: string, tz: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(new Date(sentAt));
  } catch {
    return new Date(sentAt).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
  }
}

function ChatPane({
  messages, highlightIds, chatTimezone,
}: {
  messages: PipelineResult["messages"];
  highlightIds: Set<string>;
  chatTimezone: string;
}) {
  return (
    <div className="rounded-2xl border border-stone-200/80 bg-white shadow-sm">
      <header className="border-b border-stone-100 px-4 py-3 text-sm font-semibold text-stone-800">
        Chat
      </header>
      <div className="max-h-[560px] space-y-1.5 overflow-y-auto p-4">
        {messages.map((m) => {
          const isEvent = (m.isEvent ?? 0) >= 0.5;
          const dim = !isEvent;
          const hot = highlightIds.has(m.id);
          return (
            <div
              key={m.id}
              className={`max-w-[85%] rounded-2xl px-3.5 py-2 transition-all ${
                hot
                  ? "bg-stone-900 text-white ring-2 ring-stone-900/20"
                  : isEvent
                    ? "bg-stone-100 text-stone-800"
                    : "bg-stone-50 text-stone-400"
              } ${hot ? "" : dim ? "opacity-60" : ""}`}
            >
              <div className="flex items-center gap-2 text-[11px]">
                <span className={`font-semibold ${hot ? "text-stone-300" : "text-stone-500"}`}>{m.sender}</span>
                <span className={hot ? "text-stone-400" : "text-stone-400"}>
                  {formatChatTimestamp(m.sent_at, chatTimezone)}
                </span>
                {isEvent && <span className="rounded bg-emerald-600 px-1.5 py-px text-[10px] font-semibold text-white">event</span>}
              </div>
              <p className="mt-0.5 whitespace-pre-wrap text-sm">{m.text}</p>
              {isEvent && (
                <div className="mt-1 flex items-center gap-1.5">
                  <div className="h-1 w-16 overflow-hidden rounded-full bg-stone-300">
                    <div
                      className="h-full rounded-full bg-emerald-500"
                      style={{ width: `${Math.round((m.isEvent ?? 0) * 100)}%` }}
                    />
                  </div>
                  <KindChip kind={m.kind} />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function CalendarPreview({ events, month }: { events: ChatEvent[]; month: Date }) {
  const year = month.getFullYear();
  const mon = month.getMonth();
  const first = new Date(year, mon, 1);
  const startDow = first.getDay();
  const daysInMonth = new Date(year, mon + 1, 0).getDate();
  const cells: (number | null)[] = [
    ...Array.from({ length: startDow }, () => null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];
  while (cells.length % 7 !== 0) cells.push(null);

  const byDay = new Map<number, ChatEvent[]>();
  for (const ev of events) {
    if (!ev.startDate) continue;
    const d = new Date(ev.startDate + "T12:00:00");
    if (d.getFullYear() === year && d.getMonth() === mon) {
      const day = d.getDate();
      byDay.set(day, [...(byDay.get(day) ?? []), ev]);
    }
  }

  return (
    <div className="rounded-2xl border border-stone-200/80 bg-white shadow-sm">
      <header className="border-b border-stone-100 px-4 py-3 text-sm font-semibold text-stone-800">
        {month.toLocaleString(undefined, { month: "long", year: "numeric" })} · approved
      </header>
      <div className="p-3">
        <div className="grid grid-cols-7 gap-1 text-center text-[10px] font-medium uppercase text-stone-400">
          {["S", "M", "T", "W", "T", "F", "S"].map((d, i) => <div key={i} className="py-1">{d}</div>)}
        </div>
        <div className="grid grid-cols-7 gap-1">
          {cells.map((day, i) => (
            <div key={i} className={`min-h-12 rounded-lg p-1 text-xs ${
              day === null ? "" : byDay.has(day) ? "bg-stone-100" : ""
            }`}>
              {day !== null && (
                <>
                  <div className={`tabular-nums ${byDay.has(day) ? "font-semibold" : "text-stone-400"}`}>{day}</div>
                  {(byDay.get(day) ?? []).slice(0, 2).map((ev) => (
                    <div key={ev.id} className="mt-0.5 truncate rounded bg-emerald-600 px-1 py-px text-[9px] text-white" title={ev.title}>
                      {ev.title}
                    </div>
                  ))}
                </>
              )}
            </div>
          ))}
        </div>
        {byDay.size === 0 && (
          <p className="py-4 text-center text-xs text-stone-400">
            Approve events to see them here.
          </p>
        )}
      </div>
    </div>
  );
}

function ExportPanel({
  feedUrl, stats, totalMessages, keptMessages,
}: {
  feedUrl: string | null;
  stats: PipelineStats;
  totalMessages: number;
  keptMessages: number;
}) {
  const [copied, setCopied] = useState(false);
  const [jevPerMsgUsd, setJevPerMsgUsd] = useState(0.000_010_5); // editable constant
  const [llmPerMsgUsd, setLlmPerMsgUsd] = useState(0.001_2);

  const allLlmCost = totalMessages * llmPerMsgUsd;
  const actualCost = stats.jevCostUsd + stats.datePartsCostUsd + stats.attendeesCostUsd + keptMessages * llmPerMsgUsd;

  return (
    <div className="rounded-2xl border border-stone-200/80 bg-white shadow-sm">
      <header className="border-b border-stone-100 px-4 py-3 text-sm font-semibold text-stone-800">
        Export &amp; stats
      </header>
      <div className="space-y-3 p-4 text-sm">
        <div>
          <div className="mb-1 text-xs font-medium text-stone-500">Live ICS feed</div>
          {feedUrl ? (
            <div className="flex items-center gap-1.5">
              <input
                readOnly
                value={feedUrl.replace(/^https:\/\//, "webcal://")}
                className="w-full rounded-lg border border-stone-200 bg-stone-50 px-2 py-1.5 font-mono text-xs text-stone-600"
              />
              <button
                onClick={() => {
                  navigator.clipboard?.writeText(feedUrl.replace(/^https:\/\//, "webcal://"));
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                }}
                className="shrink-0 rounded-lg border border-stone-200 px-2 py-1.5 text-xs font-medium hover:bg-stone-50"
              >
                {copied ? "Copied" : "Copy"}
              </button>
            </div>
          ) : (
            <p className="text-xs text-stone-400">Run the pipeline to get a feed URL.</p>
          )}
        </div>

        <dl className="grid grid-cols-2 gap-2 text-xs">
          <div className="rounded-lg bg-stone-50 p-2">
            <dt className="text-stone-500">Messages filtered out</dt>
            <dd className="font-semibold tabular-nums">{totalMessages - keptMessages}</dd>
          </div>
          <div className="rounded-lg bg-stone-50 p-2">
            <dt className="text-stone-500">Jev latency</dt>
            <dd className="font-semibold tabular-nums">{(stats.jevLatencyMs / 1000).toFixed(1)}s</dd>
          </div>
          <div className="rounded-lg bg-stone-50 p-2">
            <dt className="text-stone-500">Jev cost</dt>
            <dd className="font-semibold tabular-nums">${(stats.jevCostUsd + stats.datePartsCostUsd + stats.attendeesCostUsd).toFixed(4)}</dd>
          </div>
          <div className="rounded-lg bg-stone-50 p-2">
            <dt className="text-stone-500">vs. all-LLM est.</dt>
            <dd className="font-semibold tabular-nums">${allLlmCost.toFixed(4)}</dd>
          </div>
        </dl>

        <details>
          <summary className="cursor-pointer text-xs text-stone-400 hover:text-stone-600">Cost assumptions</summary>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <label className="text-xs text-stone-500">
              Jev $/msg
              <input
                type="number" step={0.000001} value={jevPerMsgUsd}
                onChange={(e) => setJevPerMsgUsd(Number(e.target.value))}
                className="mt-0.5 w-full rounded border border-stone-200 px-1.5 py-1 font-mono text-xs"
              />
            </label>
            <label className="text-xs text-stone-500">
              LLM $/msg
              <input
                type="number" step={0.0001} value={llmPerMsgUsd}
                onChange={(e) => setLlmPerMsgUsd(Number(e.target.value))}
                className="mt-0.5 w-full rounded border border-stone-200 px-1.5 py-1 font-mono text-xs"
              />
            </label>
          </div>
        </details>
      </div>
    </div>
  );
}

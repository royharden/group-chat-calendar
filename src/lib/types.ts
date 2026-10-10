import type { ParsedMessage } from "./chatParser";

export interface PartAnswer {
  type?: string;
  choice: string;
  confidence: number;
  probabilities?: Record<string, number>;
}

export interface NoulAnswer {
  type: "noul";
  noul: number;
}

export type JevAnswer = PartAnswer | NoulAnswer | string | number;

export interface DatePartsAnswers {
  [question: string]: JevAnswer | undefined;
}

export interface ChatEvent {
  id: string;
  chatId: string;
  title: string;
  kind: string;
  datePhrase: string | null;
  timePhrase: string | null;
  startDate: string | null; // yyyy-mm-dd
  startTime: string | null; // HH:mm:ss
  allDay: boolean;
  location: string | null;
  attendees: Attendee[];
  sourceMessageIds: string[];
  parts: DatePartsAnswers | null;
  confidence: number;
  needsReview: boolean;
  note: string | null; // internal resolution notes
  userNote: string | null; // user-facing notes (ICS DESCRIPTION)
  status: "pending" | "approved" | "rejected" | "cancelled";
  uid: string | null;
  timezone?: string;
}

export interface Attendee {
  name: string;
  status: "going" | "maybe" | "not_listed";
}

export interface PipelineStats {
  totalMessages: number;
  keptMessages: number;
  jevCostUsd: number;
  jevLatencyMs: number;
  extractLatencyMs: number;
  datePartsCostUsd: number;
  datePartsLatencyMs: number;
  attendeesCostUsd: number;
  attendeesLatencyMs: number;
  model: string;
  extractor: string;
}

export type { ParsedMessage };

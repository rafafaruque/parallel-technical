export const SEARCH_MODES = ["turbo", "fast", "basic", "advanced"] as const;
export type SearchMode = (typeof SEARCH_MODES)[number];
export type Rating = "correct" | "incorrect";

export type SearchResult = { title: string; url: string; snippet: string };
export type AnswerPart = { text: string; sourceUrl: string };
export type SearchSnapshot = {
  executionId: string;
  searchedAt: string;
  query: string;
  mode: SearchMode;
  searchId: string | null;
  latencyMs: number;
  answer: string;
  answerParts: AnswerPart[];
  results: SearchResult[];
};
export type ResearchResponse = SearchSnapshot & { feedbackToken: string };
export type Evaluation = {
  id: string;
  timestamp: string;
  executionId: string;
  searchedAt: string;
  query: string;
  answer: string;
  rating: Rating;
  notes: string;
  mode: SearchMode;
  searchId: string | null;
  sourceUrls: string[];
  latencyMs: number;
};

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isSearchMode(value: unknown): value is SearchMode {
  return SEARCH_MODES.some((mode) => mode === value);
}

export function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isDate(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

export function isSearchSnapshot(value: unknown): value is SearchSnapshot {
  return isRecord(value) &&
    typeof value.executionId === "string" && !!value.executionId &&
    isDate(value.searchedAt) && typeof value.query === "string" &&
    !!value.query.trim() && isSearchMode(value.mode) &&
    (value.searchId === null || typeof value.searchId === "string") &&
    typeof value.latencyMs === "number" && Number.isFinite(value.latencyMs) && value.latencyMs >= 0 &&
    typeof value.answer === "string" &&
    Array.isArray(value.answerParts) && value.answerParts.every((part) =>
      isRecord(part) && typeof part.text === "string" && isHttpUrl(part.sourceUrl)) &&
    Array.isArray(value.results) && value.results.every((result) =>
      isRecord(result) && typeof result.title === "string" &&
      isHttpUrl(result.url) && typeof result.snippet === "string");
}

export function isResearchResponse(value: unknown): value is ResearchResponse {
  return isSearchSnapshot(value) && "feedbackToken" in value && typeof value.feedbackToken === "string";
}

export function isEvaluation(value: unknown): value is Evaluation {
  return isRecord(value) && typeof value.id === "string" &&
    isDate(value.timestamp) && typeof value.executionId === "string" &&
    isDate(value.searchedAt) && typeof value.query === "string" &&
    typeof value.answer === "string" && (value.rating === "correct" || value.rating === "incorrect") &&
    typeof value.notes === "string" && isSearchMode(value.mode) &&
    (value.searchId === null || typeof value.searchId === "string") &&
    Array.isArray(value.sourceUrls) && value.sourceUrls.every(isHttpUrl) &&
    typeof value.latencyMs === "number" && Number.isFinite(value.latencyMs) && value.latencyMs >= 0;
}

export function errorMessage(value: unknown, fallback: string): string {
  return isRecord(value) && typeof value.error === "string" ? value.error : fallback;
}

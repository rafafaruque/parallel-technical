import { createHmac, timingSafeEqual } from "node:crypto";
import { isSearchSnapshot, type SearchSnapshot } from "./types";

function sign(payload: string) {
  const key = process.env.PARALLEL_API_KEY?.trim();
  if (!key) throw new Error("Parallel API key is not configured.");
  return createHmac("sha256", key).update(`parallel-evaluation-v1:${payload}`).digest("base64url");
}

// Sign the exact server-produced answer so feedback cannot silently attach to
// another query, mode, or execution. The key never leaves the server.
export function createFeedbackToken(snapshot: SearchSnapshot): string {
  const payload = Buffer.from(JSON.stringify(snapshot)).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

export function readFeedbackToken(token: string): SearchSnapshot | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payload, signature] = parts;
  const expected = Buffer.from(sign(payload));
  const actual = Buffer.from(signature);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  try {
    const snapshot: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return isSearchSnapshot(snapshot) ? snapshot : null;
  } catch {
    return null;
  }
}

import { readFeedbackToken } from "../../lib/feedback-token";
import { readEvaluations, saveEvaluation } from "../../lib/evaluation-store";
import { isRecord } from "../../lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return Response.json({ evaluations: await readEvaluations() }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "Unable to read saved evaluations. Check data/evaluations.json and its permissions." }, { status: 500 });
  }
}

export async function POST(request: Request) {
  let body: unknown;
  try {
    const text = await request.text();
    if (text.length > 100_000) {
      return Response.json({ error: "Feedback request is too large." }, { status: 413 });
    }
    body = JSON.parse(text);
  } catch {
    return Response.json({ error: "Please send a valid JSON body." }, { status: 400 });
  }

  if (!isRecord(body) || typeof body.feedbackToken !== "string" ||
      (body.rating !== "correct" && body.rating !== "incorrect") ||
      (body.notes !== undefined && typeof body.notes !== "string")) {
    return Response.json({ error: "Include a search feedback token, a correct/incorrect rating, and optional text notes." }, { status: 400 });
  }
  const notes = typeof body.notes === "string" ? body.notes.trim() : "";
  if (notes.length > 2000) {
    return Response.json({ error: "Feedback notes must be 2,000 characters or fewer." }, { status: 400 });
  }

  try {
    const snapshot = readFeedbackToken(body.feedbackToken);
    if (!snapshot || !snapshot.answer) {
      return Response.json({ error: "This answer could not be verified. Please run a new search before saving feedback." }, { status: 400 });
    }
    const result = await saveEvaluation(snapshot, body.rating, notes);
    return Response.json(result, { status: result.alreadySaved ? 200 : 201 });
  } catch {
    return Response.json({ error: "Unable to save feedback. Check the server configuration and data folder permissions, then retry." }, { status: 500 });
  }
}

import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { isEvaluation, type Evaluation, type Rating, type SearchSnapshot } from "./types";

const directory = path.join(process.cwd(), "data");
const file = path.join(directory, "evaluations.json");

// Keep the write queue across development hot reloads. It serializes writes in
// this Node process only; multiple processes need a database or file locking.
const store = globalThis as typeof globalThis & { evaluationWriteQueue?: Promise<unknown> };

export async function readEvaluations(): Promise<Evaluation[]> {
  let contents: string;
  try {
    contents = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const data: unknown = JSON.parse(contents);
  // Never overwrite an unreadable or invalid existing file with an empty list.
  if (!Array.isArray(data) || !data.every(isEvaluation)) {
    throw new Error("Invalid evaluations file.");
  }
  return data;
}

export async function saveEvaluation(snapshot: SearchSnapshot, rating: Rating, notes: string) {
  const operation = (store.evaluationWriteQueue ?? Promise.resolve()).then(async () => {
    const evaluations = await readEvaluations();
    // An execution can be evaluated once. Retrying after a lost response is safe.
    const existing = evaluations.find((item) => item.executionId === snapshot.executionId);
    if (existing) return { evaluation: existing, alreadySaved: true };

    const evaluation: Evaluation = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      executionId: snapshot.executionId,
      searchedAt: snapshot.searchedAt,
      query: snapshot.query,
      answer: snapshot.answer,
      rating,
      notes,
      mode: snapshot.mode,
      searchId: snapshot.searchId,
      sourceUrls: [...new Set(snapshot.results.map((result) => result.url))],
      latencyMs: snapshot.latencyMs,
    };
    await mkdir(directory, { recursive: true });
    const temporaryFile = path.join(directory, `${randomUUID()}.tmp`);
    try {
      await writeFile(temporaryFile, `${JSON.stringify([evaluation, ...evaluations], null, 2)}\n`, { flag: "wx", mode: 0o600 });
      // Readers see either the old complete file or the new complete file.
      await rename(temporaryFile, file);
    } finally {
      await unlink(temporaryFile).catch(() => {});
    }
    return { evaluation, alreadySaved: false };
  });
  store.evaluationWriteQueue = operation.catch(() => {});
  return operation;
}

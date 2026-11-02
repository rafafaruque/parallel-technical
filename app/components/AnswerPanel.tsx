"use client";

import { useRef, useState } from "react";
import type { FormEvent } from "react";
import { errorMessage, isEvaluation, isRecord } from "../lib/types";
import type { Evaluation, Rating, ResearchResponse } from "../lib/types";

// Each execution owns its feedback state, including when modes are compared.
export default function AnswerPanel({ results, onSaved, onSavingChange }: {
  results: ResearchResponse;
  onSaved: (evaluation: Evaluation) => void;
  onSavingChange: (saving: boolean) => void;
}) {
  const [rating, setRating] = useState<Rating | null>(null);
  const [notes, setNotes] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState<Evaluation | null>(null);
  const [feedbackError, setFeedbackError] = useState("");
  const saveInFlight = useRef(false);

  async function handleSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!rating || saved || saveInFlight.current) return;
    // Capture this execution before awaiting. New searches stay disabled until
    // the save completes, so old feedback cannot be shown on a new answer.
    const evaluated = results;
    saveInFlight.current = true;
    setSaving(true);
    onSavingChange(true);
    setFeedbackError("");
    try {
      const response = await fetch("/api/evaluations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ feedbackToken: evaluated.feedbackToken, rating, notes }),
      });
      const data: unknown = await response.json();
      if (!response.ok) throw new Error(errorMessage(data, "Unable to save feedback."));
      if (!isRecord(data) || !isEvaluation(data.evaluation) || data.evaluation.executionId !== evaluated.executionId) {
        throw new Error("The feedback response did not match this answer. Please retry.");
      }
      const evaluation = data.evaluation;
      setSaved(evaluation);
      setRating(evaluation.rating);
      setNotes(evaluation.notes);
      onSaved(evaluation);
    } catch (error) {
      setFeedbackError(error instanceof Error ? error.message : "Unable to save feedback. Please retry.");
    } finally {
      saveInFlight.current = false;
      setSaving(false);
      onSavingChange(false);
    }
  }

  return (
    <>
      <div className="summary">
        <p className="query">Results for “{results.query}” · {results.mode} · {results.latencyMs.toLocaleString()} ms</p>
      </div>
      {results.answer && (
        <div className="answer-panel">
          <h3>Extractive answer</h3>
          <p className="answer-label">Short excerpts selected for relevance to your question, with source links. Review the evidence for accuracy.</p>
          {results.answerParts.map((part, index) => (
            <blockquote key={index}>
              <p>{part.text}</p>
              <a href={part.sourceUrl} target="_blank" rel="noreferrer">Source {index + 1} ↗</a>
            </blockquote>
          ))}
        </div>
      )}
      {results.results.length > 0 && !results.answer && (
        <p className="placeholder">There isn’t enough relevant information in these results to answer your question. Try a more specific query.</p>
      )}
      {results.results.length > 0 && <h3>Supporting sources</h3>}
      {results.results.length === 0 && (
        <p className="placeholder">No results found. There isn’t enough information to answer your question. Try a different query.</p>
      )}
      <ul className="result-list">
        {results.results.map((result) => ( // .map creates a new item for each item in results array
        // so if parallel returned 3 results, map would create 3 <li> items, one for each result
          <li key={result.url}>
            <h3><a href={result.url} target="_blank" rel="noreferrer">{result.title} ↗</a></h3>
            <p className="result-url">{result.url}</p>
            <p>{result.snippet || "No readable excerpt available."}</p>
            {result.fullExcerpt && result.fullExcerpt !== result.snippet && (
              <details>
                <summary>Show longer excerpts</summary>
                <p className="saved-answer">{result.fullExcerpt}</p>
              </details>
            )}
          </li>
        ))}
      </ul>
      {results.answer && (
        <form className="feedback" onSubmit={handleSave}>
          <fieldset disabled={saving || !!saved}>
            <legend>Was this answer correct?</legend>
            <div className="rating-row">
              <button type="button" aria-pressed={rating === "correct"} onClick={() => setRating("correct")}>Correct</button>
              <button type="button" aria-pressed={rating === "incorrect"} onClick={() => setRating("incorrect")}>Incorrect</button>
            </div>
            <label htmlFor={`notes-${results.executionId}`}>Optional feedback notes</label>
            <textarea id={`notes-${results.executionId}`} value={notes} onChange={(event) => setNotes(event.target.value)} maxLength={2000} rows={3} placeholder="What did this answer get right or miss?" />
            <button type="submit" disabled={!rating || saving || !!saved}>{saving ? "Saving…" : saved ? "Feedback saved" : "Save feedback"}</button>
          </fieldset>
          {feedbackError && <p className="error" role="alert">{feedbackError}</p>}
          {saved && <p className="confirmation" role="status">Saved as {saved.rating}. This answer’s feedback is stored for future use.</p>}
        </form>
      )}
    </>
  );
}

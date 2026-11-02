"use client";

// This page needs browser interactivity: state, input changes, and form submission.
// "use client" lets this component use React hooks and event handlers.
import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";

import { errorMessage, isEvaluation, isRecord, isResearchResponse } from "./lib/types";
import type { Evaluation, ResearchResponse, SearchMode } from "./lib/types";
import { SEARCH_MODES } from "./lib/types";
import AnswerPanel from "./components/AnswerPanel";

type SearchOutcome = { mode: SearchMode; data: ResearchResponse | null; error: string };

export default function Home() {
  // useState remembers values between renders. Each setter updates a value
  // and asks React to render the page again with that new value.
  const [query, setQuery] = useState("");
  // query: stores the current value, such as 'what is Parallel AI?'
  // setQuery: a function to update the value, such as setQuery('what is Parallel AI?')
        // basically, i type anything, onChange fires, setQuery updates the state, and 
        // React re-renders the component, and then the input displays what i typed.
  // useState("") initializes the value to an empty string. The type is inferred as string.
  const [loading, setLoading] = useState(false);
  // whether a research request is in progress. This disables the input and button while waiting for a response.
  const [error, setError] = useState("");
  // an error message to display if the research request fails. This is empty when there is no error.
  const [results, setResults] = useState<SearchOutcome[] | null>(null);
  // the research results returned from the backend. This is null when there are no results.

  const [evaluations, setEvaluations] = useState<Evaluation[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyError, setHistoryError] = useState("");
  // Refs guard rapid clicks before React has rendered the disabled buttons.
  const searchInFlight = useRef(false);
  const saveInFlight = useRef(false);
  const savesInFlight = useRef(0);
  const historyRequest = useRef(0);
  const [saving, setSaving] = useState(false);
  const [mode, setMode] = useState<SearchMode>("fast");
  const [compare, setCompare] = useState(false);
  const [secondMode, setSecondMode] = useState<SearchMode>("basic");

  function handleSavingChange(active: boolean) {
    savesInFlight.current += active ? 1 : -1;
    saveInFlight.current = savesInFlight.current > 0;
    setSaving(saveInFlight.current);
  }

  function handleSaved(evaluation: Evaluation) {
    // Invalidate older history responses so they cannot hide a just-saved row.
    historyRequest.current += 1;
    setHistoryLoading(false);
    setEvaluations((previous) => [evaluation, ...previous.filter((item) => item.id !== evaluation.id)]);
  }

  async function loadEvaluations() {
    const requestId = ++historyRequest.current;
    setHistoryLoading(true);
    setHistoryError("");
    try {
      const response = await fetch("/api/evaluations", { cache: "no-store" });
      const data: unknown = await response.json();
      if (!response.ok) throw new Error(errorMessage(data, "Unable to load saved evaluations."));
      if (!isRecord(data) || !Array.isArray(data.evaluations) || !data.evaluations.every(isEvaluation)) {
        throw new Error("The saved evaluations response was invalid.");
      }
      if (requestId === historyRequest.current) setEvaluations(data.evaluations);
    } catch (error) {
      if (requestId === historyRequest.current) setHistoryError(error instanceof Error ? error.message : "Unable to load saved evaluations.");
    } finally {
      if (requestId === historyRequest.current) setHistoryLoading(false);
    }
  }

  useEffect(() => { void loadEvaluations(); }, []);

  // async allows await, which waits for a promise without blocking the browser.
  // this function runs when we submit a search
  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    // A normal form reloads the page. We handle its submission ourselves instead.
    event.preventDefault(); // stops browser default form reload, bc we want to update the page
    // without resetting the current state
    if (searchInFlight.current || saveInFlight.current) return;
    setError(""); // clears previous error messages

    if (!query.trim()) {
      // query.trim() removes whitespace from the beginning and end of the query. If the query is empty, we show an error message and return early.
      // !query.trim() checks whether the query input is empty after trimming
      setError("Please enter a research query.");
      return; // stops the function if the input is invalid
    }

    if (compare && mode === secondMode) {
      setError("Choose two different modes to compare.");
      return;
    }
    searchInFlight.current = true;
    const modes = compare ? [mode, secondMode] : [mode];
    setResults(modes.map((selected) => ({ mode: selected, data: null, error: "" })));
    setLoading(true); // tells React the search is in progress, which disables the input and button
    // remember the useState variable? 

    async function runSearch(selectedMode: SearchMode) {
      try {
        // fetch sends a POST request to our own backend. JSON.stringify turns
        // the JavaScript object into JSON text for the request body.
        const response = await fetch("/api/research", {
          // await means we wait for the fetch to finsih getting the response before continuing
          // fetch makes an http request to the given url (endpoint), which here is /api/research,
          // this endpoint is defined in app/api/research/route.ts, and it handles the request and returns a response.
          // we do this handling in the backend instead of the frontend here for security
              // page.tsx is the browser or frontend, route.ts is the backend which reads the key and calls Parallel
          method: "POST", // means we are sending information to the server
          headers: { "Content-Type": "application/json" },
          // the headers tell the server that we are sending JSON data in the request body
          body: JSON.stringify({ query: query.trim(), mode: selectedMode }),
          // converts the javascript object into a json string, which is sent to the server as the request body. The server will parse this json string back into a javascript object.
        });

        // response.json() parses the backend's JSON text into a JavaScript object.
        // await waits until the response body has been read and parsed
        // Treat JSON as unknown until its runtime shape has been checked.
        const data: unknown = await response.json();

        if (!response.ok) {
          throw new Error(errorMessage(data, "Something went wrong. Please try again."));
        }
        if (!isResearchResponse(data)) throw new Error("The search response was invalid. Please retry."); // if backend reports a failure, code throws an error
        // response.ok is true for HTTP status codes from 200 to 299

        // otherwise, setResults(data) updates the results state with the research results 
        // returned from the backend, which triggers a re-render of the page to display the results.
        // Updating state makes React render the results below.
        setResults((previous) => previous?.map((outcome) => outcome.mode === selectedMode ? { ...outcome, data } : outcome) ?? null);
      } catch (error) { // handles errors such as network failures or backend errors. The error is caught and displayed to the user.
        const message = error instanceof Error ? error.message : "Something went wrong. Please try again.";
        setResults((previous) => previous?.map((outcome) => outcome.mode === selectedMode ? { ...outcome, error: message } : outcome) ?? null);
      }
    }
    try {
      // Each request handles its own failure so another mode's answer survives.
      await Promise.all(modes.map(runSearch));
    } finally {
      // the finally block runs regardless of either success or failure.
      searchInFlight.current = false;
      setLoading(false); // returns the button to its normal state
    }
  }

  return (
    <main>
      <header>
        <h1>Search Evaluation Playground</h1>
        <p>Research answers and collect human feedback.</p>
      </header>

      <form onSubmit={handleSubmit}> {/* // this line connects the form to the function */}
        {/* // when we click the Search button, the form submits and React runs handleSubmit() */}
        <label htmlFor="query">Research query</label>
        <div className="search-row">
          <input
            id="query"
            name="query"
            type="text"
            placeholder="What would you like to research?"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            // when we type a character, the input's value changes, which calls setQuery 
            // to update the query state, which re-renders the input with the new query value.
            disabled={loading || saving}
            maxLength={200}
            required
          />
          <button type="submit" disabled={loading || saving}>
            {loading ? "Searching…" : "Search"}
            {/* // basically means if loading is true, show "Searching…", else show "Search" */}
          </button>
        </div>
        <div className="mode-controls">
          <div>
            <label htmlFor="mode">Search mode</label>
            <select id="mode" value={mode} onChange={(event) => setMode(event.target.value as SearchMode)} disabled={loading || saving}>
              {SEARCH_MODES.map((item) => <option key={item} value={item}>{item}</option>)}
            </select>
          </div>
          <label className="compare-toggle"><input type="checkbox" checked={compare} onChange={(event) => setCompare(event.target.checked)} disabled={loading || saving} /> Compare two modes</label>
          {compare && <div>
            <label htmlFor="second-mode">Second mode</label>
            <select id="second-mode" value={secondMode} onChange={(event) => setSecondMode(event.target.value as SearchMode)} disabled={loading || saving}>
              {SEARCH_MODES.map((item) => <option key={item} value={item}>{item}</option>)}
            </select>
          </div>}
        </div>
      </form>

      {error && <p className="error" role="alert">{error}</p>}

      {!results && <section className="results" aria-labelledby="results-heading">
        <h2 id="results-heading">Answer</h2>
        <p className="placeholder">Your answer and supporting sources will appear here.</p>
      </section>}
      {results && <div className={results.length === 2 ? "search-outcomes comparison" : "search-outcomes"}>
        {results.map((outcome) => (
          <section className="results" key={outcome.mode} aria-labelledby={`answer-${outcome.mode}`} aria-busy={!outcome.data && !outcome.error}>
            <h2 id={`answer-${outcome.mode}`}>{results.length === 2 ? `${outcome.mode} answer` : "Answer"}</h2>
            <div aria-live="polite">
              {!outcome.data && !outcome.error && <p className="placeholder">Searching in {outcome.mode} mode…</p>}
              {outcome.error && <p className="error" role="alert">{outcome.error}</p>}
              {outcome.data && <AnswerPanel key={outcome.data.executionId} results={outcome.data} onSaved={handleSaved} onSavingChange={handleSavingChange} />}
            </div>
          </section>
        ))}
      </div>}

      <section className="results" aria-labelledby="saved-heading" aria-busy={historyLoading}>
        <div className="section-heading">
          <h2 id="saved-heading">Saved Evaluations</h2>
          <button className="secondary" type="button" onClick={() => void loadEvaluations()} disabled={historyLoading || saving}>{historyLoading ? "Loading…" : "Refresh"}</button>
        </div>
        {historyError && <p className="error" role="alert">{historyError}</p>}
        {!historyLoading && !historyError && evaluations.length === 0 && <p className="placeholder">No evaluations yet. Search, review an answer, and save your feedback.</p>}
        <ul className="result-list">
          {evaluations.map((evaluation) => (
            <li key={evaluation.id}>
              <h3>{evaluation.query}</h3>
              <p className="query"><strong>{evaluation.rating === "correct" ? "Correct" : "Incorrect"}</strong> · {evaluation.mode} · {new Date(evaluation.timestamp).toLocaleString()}</p>
              <p className="saved-answer">{evaluation.answer}</p>
              {evaluation.notes && <p className="saved-notes"><strong>Notes:</strong> {evaluation.notes}</p>}
              <details>
                <summary>Supporting sources and search details</summary>
                <p className="result-url">Execution: {evaluation.executionId}<br />Search: {evaluation.searchId ?? "Not provided"}<br />Latency: {evaluation.latencyMs} ms</p>
                <ul>{evaluation.sourceUrls.map((url) => <li key={url}><a href={url} target="_blank" rel="noreferrer">{url}</a></li>)}</ul>
              </details>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}

# Search Evaluation Playground

A local Parallel technical interview demo built with the starter’s Next.js App Router, React, TypeScript, native `fetch`, and CSS. The original `/Users/rafafaruque/Desktop/parallel-starter` was used as a read-only reference.

## Run locally

Use Node.js 22.18+ (also required by the tests).

```sh
npm ci
# If .env.local is missing, copy .env.example to .env.local and add your key.
npm run dev
```

Open http://localhost:3000. A configured local `.env.local` was copied without displaying its contents. `PARALLEL_API_KEY` stays on the server. `.env.local`, runtime evaluations, dependencies, and build outputs are ignored by Git.

```sh
npm test
npm run typecheck
npm run build
npm start
```

## Workflow and answer derivation

Enter a question, inspect the extractive answer and supporting source links, choose **Correct** or **Incorrect**, optionally enter notes, and select **Save feedback**. Saved Evaluations loads persisted records on page load; Refresh reloads the history.

The optional comparison is complete: select any two different modes from `turbo`, `fast`, `basic`, and `advanced`, enable **Compare two modes**, and search. Both requests use the same question. Results appear side by side on desktop and stack on mobile, with separate ratings, notes, save confirmations, search IDs, and latency. A failure in one mode leaves the other answer available. Comparison makes two Search calls.

The browser calls `POST /api/research`; that route calls `https://api.parallel.ai/v1/search` with the server-side key. Search returns sources and excerpts, not a synthesized answer. The app quotes the first nonblank excerpt from each of the first two results that contain usable excerpts, in Parallel’s relevance order. Each quote is limited to 1,000 characters (an ellipsis marks truncation) and links to its source. The displayed answer is those exact quotes joined by two newlines. No language model generates or verifies the answer. Relevance ordering alone may not produce a complete answer; that is what the human evaluator reviews.

Search defaults to explicit `fast` mode, requests five results with a 2,000-character excerpt budget per result, and times out after 30 seconds. The backend validates input, returned results, and HTTP(S) source URLs. See the [official Parallel Search documentation](https://docs.parallel.ai/api-reference/search/search) for request fields and modes.

## Feedback API and storage

- `GET /api/evaluations` returns `{ evaluations: [...] }` with `Cache-Control: no-store`.
- `POST /api/evaluations` takes `{ feedbackToken, rating, notes? }`. `rating` is `correct` or `incorrect`; notes are limited to 2,000 characters. A successful new save returns HTTP 201 and `{ evaluation, alreadySaved: false }`.
- The server signs each exact search snapshot using an HMAC derived from the server-side key. Feedback is reconstructed from that signed snapshot, rather than trusting separately submitted query/answer fields. Rotating the key invalidates unsaved snapshots; previously saved history remains readable.
- Each evaluation stores its ID, timestamp, execution ID, search time, query, exact displayed answer, rating, notes, mode, Parallel search ID when provided, source URLs, and latency.
- Each execution can be evaluated once. Retries return the existing record with HTTP 200. Run another search to collect a separate evaluation. New searches clear old form state and stay disabled while feedback is saving.

Records are stored in **`data/evaluations.json`**, relative to the project folder. A missing file is created on the first save. Records survive browser refreshes and local server restarts. The file starts empty and is excluded from Git; `data/.gitkeep` preserves the folder.

This is a local demo persistence solution. It uses a write queue within one Node process and atomic file replacement to avoid partial JSON files and lost updates between requests in that process. Invalid existing data is reported instead of overwritten. It is **not suitable for serverless production, multiple server processes, or concurrent writers outside this process** without a shared durable database or additional locking. The local app has no authentication and should not be exposed publicly with personal feedback.

## Files

- `app/page.tsx`: query/mode controls, independent comparison requests, saved history.
- `app/components/AnswerPanel.tsx`: extractive answer/source rendering and feedback state for one execution.
- `app/api/research/route.ts`: adapted starter’s server-side Parallel integration.
- `app/api/evaluations/route.ts`: feedback POST and history GET.
- `app/lib/types.ts`: shared types and runtime validation.
- `app/lib/feedback-token.ts`: signed execution snapshots.
- `app/lib/evaluation-store.ts`: persistent file access and idempotent writes.
- `app/globals.css`: original starter CSS, followed by evaluation-specific additions.
- `app/layout.tsx`: updated title and description, preserving the starter layout.
- `tests/api.test.cjs`: isolated route tests with mocked upstream responses; no live API usage or writes to the demo’s data file.

## Verification

The automated suite covers validation, exact extractive evidence and citations, missing credentials, both ratings and notes, duplicate concurrent submissions, altered answer snapshots, empty results, malformed upstream results, upstream authentication/rate-limit/network errors, disk retrieval, and corrupt-file recovery. Run `npm test` to repeat it.

Verified locally during implementation:

- `npm test`: all 11 checks passed (including the containing workflow test); provider responses are mocked and filesystem data is isolated in a temporary directory.
- `npm run typecheck` and `npm run build`: passed.
- Chrome browser, using the production build: real questions returned live Parallel Search results; displayed quotes matched the returned answer; a supporting source opened successfully; both ratings saved; notes persisted; a new search cleared old feedback; duplicate saves were disabled.
- Browser refresh and an actual local server stop/restart preserved the complete saved records in both the API and UI.
- Live `fast`/`basic` comparison returned independent results for one question; independent concurrent feedback saved the correct answer, mode, rating, notes, and execution ID.
- Browser checks with intercepted error responses: a failed comparison mode preserved the successful answer; no results hid feedback controls; a failed feedback save preserved the form for retry.
- Mobile layouts at 375px did not overflow horizontally; desktop comparison appeared in two columns.
- Original starter file hashes matched before and after implementation. Its CSS remains an exact prefix of the new stylesheet. The configured secret was absent from application source, tests, and generated browser assets.

Some live source URLs returned HTTP 403 or 404 during testing; another source returned HTTP 200. Sources are returned by Parallel and linked directly. The app does not verify publisher availability or bypass access restrictions.

Temporary test feedback is removed before handoff, leaving `data/evaluations.json` empty. Tests do not seed the app with example evaluations.

To manually repeat restart persistence: save feedback, reload the browser, stop the app, restart it from this project folder, and confirm the same record appears under Saved Evaluations. No synthesized-answer model or production database is included; all required core features and the two-mode bonus are implemented.

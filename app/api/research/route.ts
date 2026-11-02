import { randomUUID } from "node:crypto";
import { createFeedbackToken } from "../../lib/feedback-token";
import { isHttpUrl, isSearchMode, type AnswerPart, type SearchSnapshot } from "../../lib/types";

export const runtime = "nodejs";

// Next.js calls this function when a POST request reaches /api/research.
// This code runs on the server, separate from the page in the browser.
export async function POST(request: Request) {
  let body: unknown; // declares a variable named body
  // unknown is a TypeScript type that means "we don't know what this is yet." 
  // It is safer than any because it forces us to check the type before using it.

  try {
    // Wait for the incoming JSON body and parse it into a JavaScript value.
    body = await request.json();
  } catch { // if request.json() fails if the body is not valid JSON
    return Response.json({ error: "Please send a valid JSON body." }, { status: 400 }); // 400 means invalid/bad request
    // return immediately ends the function
  }

  // Check the input on the server too: callers can bypass the frontend form.
  if (
    typeof body !== "object" || // checks whether its an object
    body === null || // ensures its not null (bc JS considers null to be an object)
    !("query" in body) || // is there a query field in the body? (bc we expect a query field)
    typeof body.query !== "string" || // is the query field a string? (bc we expect a string)
    !body.query.trim() // is the query field empty or whitespace? (bc we expect a non-empty string)
  ) {
    return Response.json({ error: "Please enter a research query." }, { status: 400 });
    // 400 means invalid/bad request, throws this error if the input is invalid, and return immediately ends the function
  }

  // if checks pass, we can safely use body.query as a string and trim it
  const query = body.query.trim();
  // we trim it in the back and frontend because the backend can't assume every
  // request comes from the frontend, called defense in depth

  if (query.length > 200) {
    return Response.json({ error: "Please keep your query to 200 characters or fewer." }, { status: 400 });
  }
  const mode = "mode" in body ? body.mode : "fast";
  if (!isSearchMode(mode)) {
    return Response.json({ error: "Choose turbo, fast, basic, or advanced mode." }, { status: 400 });
  }

  const apiKey = process.env.PARALLEL_API_KEY?.trim();

  if (!apiKey) {
    return Response.json(
      { error: "Parallel API key is not configured. Add PARALLEL_API_KEY to .env.local and restart the server." },
      { status: 500 },
    );
  }

  let parallelData: unknown;
  const startedAt = Date.now();

  try {
    // Our backend makes a second HTTP request, this time to Parallel Search.
    // notice how the frontends fetch calls our own backend, and our backend fetch calls Parallel's API. This is called a proxy.
    const parallelResponse = await fetch("https://api.parallel.ai/v1/search", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // The key stays on the server; it is never sent to our browser code.
        "x-api-key": apiKey,
      },
      body: JSON.stringify({
        search_queries: [query], // list of strings, in an array, because Parallel can handle multiple queries
        //  at once. each item is a sep stirng and theyre all sent together as 1 JSON request
        // objective tells Parallel what the user is trying to do, which helps
        // it return better results. Here we use the same value as the query.
        objective: query,
        mode, // Pin the mode explicitly rather than relying on Parallel's default.
        advanced_settings: { max_results: 5, excerpt_settings: { max_chars_per_result: 2000 } },
      }),
      signal: AbortSignal.timeout(30_000),
      cache: "no-store",
    });

    // if is for when the request completes but something is wrong
    // catch is for when the request fails to complete, such as a network failure or invalid JSON
    // fetch does not throw for HTTP errors, so check the status ourselves.
    // Return our own messages rather than forwarding Parallel's error body.
    if (!parallelResponse.ok) {
      if (parallelResponse.status === 401 || parallelResponse.status === 403) {
        return Response.json(
          { error: "Parallel authentication failed. Check PARALLEL_API_KEY on the server." },
          { status: 502 },
        );
      }

      if (parallelResponse.status === 429) {
        return Response.json(
          { error: "Parallel's rate limit was reached. Please try again later." },
          { status: 429 },
        );
      }

      return Response.json(
        { error: "Parallel Search returned an error. Please try again later." },
        { status: 502 },
      );
    }

    // Read Parallel's JSON text and parse it into a JavaScript value.
    parallelData = await parallelResponse.json();
    // parallel response is the HTTP response object recieved from Parallel 
  } catch {
    // Network failures and unreadable JSON both produce a safe error message.
    return Response.json(
      { error: "Unable to complete Parallel Search. Please try again." },
      { status: 502 },
    );
  }

  // Check external data before using it, just as we check the incoming query.
  // ensures response is a non-null object, contains a results property, and that property is an array
  if (
    typeof parallelData !== "object" ||
    parallelData === null ||
    !("results" in parallelData) ||
    !Array.isArray(parallelData.results)
  ) {
    return Response.json({ error: "Parallel returned an invalid search response." }, { status: 502 });
  }

  // creates an empty array
  const results = [];
  const answerParts: AnswerPart[] = [];

  for (const result of parallelData.results) {
    if (
      typeof result !== "object" ||
      result === null ||
      typeof result.url !== "string" ||
      !isHttpUrl(result.url) || // Only allow valid HTTP(S) source links.
      (result.title != null && typeof result.title !== "string") || // checks whether title is either null or a string
      !Array.isArray(result.excerpts) || // checks whether excerpts is an array
      !result.excerpts.every((excerpt: unknown) => typeof excerpt === "string") // checks whether every item in the excerpts array is a string
    ) {
      return Response.json({ error: "Parallel returned an invalid search result." }, { status: 502 });
    }

    // Keep only the fields our page expects. Join excerpts into one snippet.
    // Parallel may omit a title, so use that result's URL as its link text.
    results.push({ // .push adds a new item to the end of an array
      title: result.title ?? result.url, // use left value unless its null otherwise use right
      url: result.url,
      snippet: result.excerpts.join(" ").slice(0, 2000), // joins excerpts within a display budget
    });
    // Parallel orders results by relevance. Quote the first nonempty excerpt
    // from each of the first two usable results, with its own source link.
    const excerpt = result.excerpts.find((text: string) => text.trim());
    if (excerpt && answerParts.length < 2) {
      const text = excerpt.trim();
      answerParts.push({ text: text.length > 1000 ? `${text.slice(0, 1000)}…` : text, sourceUrl: result.url });
    }
  }

  // Response.json converts this object into a JSON response for the frontend.
  // The query comes from the request; research results come from Parallel Search.
  const snapshot: SearchSnapshot = {
    executionId: randomUUID(),
    searchedAt: new Date().toISOString(),
    query,
    mode,
    searchId: "search_id" in parallelData && typeof parallelData.search_id === "string" ? parallelData.search_id : null,
    latencyMs: Date.now() - startedAt,
    answer: answerParts.map((part) => part.text).join("\n\n"),
    answerParts,
    results,
  };
  return Response.json({ ...snapshot, feedbackToken: createFeedbackToken(snapshot) });
}

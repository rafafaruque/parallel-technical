// Run the actual route handlers against a mocked Parallel response and an
// isolated temporary data directory. No live API calls or user data are used.
const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { registerHooks } = require('node:module');

// Node 22.18+ strips TypeScript; resolve the extensionless imports used by Next.
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    try { return nextResolve(specifier, context); }
    catch (error) {
      if (specifier.startsWith('.') && !path.extname(specifier)) {
        return nextResolve(`${specifier}.ts`, context);
      }
      throw error;
    }
  },
});

const project = process.cwd();
const originalFetch = global.fetch;
const originalKey = process.env.PARALLEL_API_KEY;
let temporary;
let research;
let evaluations;
let snapshot;
const request = (body) => new Request('http://localhost/api', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
const sources = [
  { title: 'First source', url: 'https://example.com/first', excerpts: ['The first exact evidence excerpt.'] },
  { title: null, url: 'https://example.com/second', excerpts: ['', 'The second exact evidence excerpt.'] },
];
function mockParallel(data, status = 200) {
  global.fetch = async (url, init) => {
    assert.equal(url, 'https://api.parallel.ai/v1/search');
    assert.equal(init.headers['x-api-key'], 'test-only-secret');
    return Response.json(data, { status });
  };
}

after(async () => {
  hooks.deregister();
  global.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.PARALLEL_API_KEY;
  else process.env.PARALLEL_API_KEY = originalKey;
  process.chdir(project);
  if (temporary) await fs.rm(temporary, { recursive: true, force: true });
});

test('API workflow and persistence safeguards', async (t) => {
  temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'parallel-evaluation-test-'));
  process.chdir(temporary);
  process.env.PARALLEL_API_KEY = 'test-only-secret';
  research = require(path.join(project, 'app/api/research/route.ts'));
  evaluations = require(path.join(project, 'app/api/evaluations/route.ts'));

  await t.test('rejects malformed JSON, empty/oversized queries, and invalid modes', async () => {
    assert.equal((await research.POST(new Request('http://localhost', { method: 'POST', body: '{' }))).status, 400);
    for (const body of [{}, { query: '  ' }, { query: 1 }, { query: 'x'.repeat(201) }, { query: 'question', mode: 'invalid' }]) {
      assert.equal((await research.POST(request(body))).status, 400);
    }
  });

  await t.test('handles missing credentials without calling Parallel', async () => {
    delete process.env.PARALLEL_API_KEY;
    assert.equal((await research.POST(request({ query: 'question' }))).status, 500);
    process.env.PARALLEL_API_KEY = 'test-only-secret';
  });

  await t.test('extracts exact evidence, citations, mode, search ID, and a distinct execution ID', async () => {
    mockParallel({ results: sources, search_id: 'search_fixture' });
    const response = await research.POST(request({ query: '  Evidence question  ', mode: 'fast' }));
    assert.equal(response.status, 200);
    snapshot = await response.json();
    assert.equal(snapshot.query, 'Evidence question');
    assert.equal(snapshot.mode, 'fast');
    assert.equal(snapshot.searchId, 'search_fixture');
    assert.equal(snapshot.answer, 'The first exact evidence excerpt.\n\nThe second exact evidence excerpt.');
    assert.equal(snapshot.answerParts[0].sourceUrl, sources[0].url);
    assert.equal(snapshot.results[1].title, sources[1].url);
    assert.ok(snapshot.feedbackToken);
    assert.ok(!JSON.stringify(snapshot).includes('test-only-secret'));
    const next = await (await research.POST(request({ query: 'Evidence question' }))).json();
    assert.notEqual(next.executionId, snapshot.executionId);
  });

  await t.test('saves correct feedback and deduplicates concurrent retries', async () => {
    const submissions = await Promise.all(Array.from({ length: 8 }, () => evaluations.POST(request({ feedbackToken: snapshot.feedbackToken, rating: 'correct' }))));
    assert.equal(submissions.filter((response) => response.status === 201).length, 1);
    assert.equal(submissions.filter((response) => response.status === 200).length, 7);
    const saved = await (await evaluations.GET()).json();
    assert.equal(saved.evaluations.length, 1);
    assert.equal(saved.evaluations[0].answer, snapshot.answer);
    assert.equal(saved.evaluations[0].executionId, snapshot.executionId);
    assert.equal(saved.evaluations[0].rating, 'correct');
    assert.deepEqual(saved.evaluations[0].sourceUrls, sources.map((source) => source.url));
  });

  await t.test('saves incorrect feedback with notes independently for another execution', async () => {
    const next = await (await research.POST(request({ query: 'Other question', mode: 'basic' }))).json();
    const response = await evaluations.POST(request({ feedbackToken: next.feedbackToken, rating: 'incorrect', notes: '  Missing context.  ' }));
    assert.equal(response.status, 201);
    const { evaluation } = await response.json();
    assert.equal(evaluation.notes, 'Missing context.');
    assert.equal(evaluation.mode, 'basic');
    const disk = JSON.parse(await fs.readFile(path.join(temporary, 'data/evaluations.json'), 'utf8'));
    assert.equal(disk.length, 2);
    assert.equal(disk[0].rating, 'incorrect');
    // Reload the storage module to verify retrieval is from disk, not memory.
    const storePath = require.resolve(path.join(project, 'app/lib/evaluation-store.ts'));
    delete require.cache[storePath];
    assert.equal((await require(storePath).readEvaluations()).length, 2);
  });

  await t.test('rejects tampering, invalid ratings, invalid notes, and oversized bodies', async () => {
    const [payload, signature] = snapshot.feedbackToken.split('.');
    const modified = JSON.parse(Buffer.from(payload, 'base64url').toString());
    modified.answer = 'An invented answer';
    const tampered = `${Buffer.from(JSON.stringify(modified)).toString('base64url')}.${signature}`;
    for (const body of [
      { feedbackToken: tampered, rating: 'correct' },
      { feedbackToken: snapshot.feedbackToken, rating: 'maybe' },
      { feedbackToken: snapshot.feedbackToken, rating: 'correct', notes: 12 },
      { feedbackToken: snapshot.feedbackToken, rating: 'correct', notes: 'x'.repeat(2001) },
    ]) assert.equal((await evaluations.POST(request(body))).status, 400);
    assert.equal((await evaluations.POST(request({ notes: 'x'.repeat(100001) }))).status, 413);
  });

  await t.test('returns no answer for zero results or empty excerpts and disallows rating it', async () => {
    for (const results of [[], [{ title: 'Empty', url: 'https://example.com', excerpts: ['   '] }]]) {
      mockParallel({ results });
      const response = await research.POST(request({ query: 'No evidence' }));
      assert.equal(response.status, 200);
      const data = await response.json();
      assert.equal(data.answer, '');
      assert.equal((await evaluations.POST(request({ feedbackToken: data.feedbackToken, rating: 'correct' }))).status, 400);
    }
  });

  await t.test('handles upstream authentication, rate limit, server, network, and response errors safely', async () => {
    for (const [status, expected] of [[401, 502], [403, 502], [429, 429], [500, 502]]) {
      mockParallel({ error: 'sensitive provider details' }, status);
      const response = await research.POST(request({ query: 'question' }));
      assert.equal(response.status, expected);
      assert.ok(!JSON.stringify(await response.json()).includes('sensitive provider details'));
    }
    for (const data of [{}, { results: [null] }, { results: [{ ...sources[0], url: 'javascript:alert(1)' }] }, { results: [{ ...sources[0], excerpts: [12] }] }]) {
      mockParallel(data);
      assert.equal((await research.POST(request({ query: 'question' }))).status, 502);
    }
    global.fetch = async () => { throw new Error('network error'); };
    assert.equal((await research.POST(request({ query: 'question' }))).status, 502);
    global.fetch = async () => new Response('{', { status: 200 });
    assert.equal((await research.POST(request({ query: 'question' }))).status, 502);
  });

  await t.test('supports all four modes and saves distinct executions concurrently without lost updates', async () => {
    let calls = [];
    global.fetch = async (_url, init) => {
      calls.push(JSON.parse(init.body).mode);
      return Response.json({ results: sources, search_id: 'mode_search' });
    };
    const snapshots = await Promise.all(['turbo', 'fast', 'basic', 'advanced'].map(async mode => {
      const response = await research.POST(request({ query: 'Comparison question', mode }));
      assert.equal(response.status, 200);
      const data = await response.json();
      assert.equal(data.mode, mode);
      return data;
    }));
    assert.deepEqual(calls.sort(), ['advanced', 'basic', 'fast', 'turbo']);
    const responses = await Promise.all(snapshots.map(data => evaluations.POST(request({ feedbackToken: data.feedbackToken, rating: 'correct' }))));
    assert.ok(responses.every(response => response.status === 201));
    const { evaluations: saved } = await (await evaluations.GET()).json();
    assert.equal(saved.length, 6);
    assert.equal(new Set(saved.map(item => item.executionId)).size, 6);
  });

  await t.test('does not overwrite corrupt storage and can recover after the file is restored', async () => {
    const file = path.join(temporary, 'data/evaluations.json');
    const original = await fs.readFile(file, 'utf8');
    await fs.writeFile(file, '{broken');
    assert.equal((await evaluations.GET()).status, 500);
    assert.equal((await evaluations.POST(request({ feedbackToken: snapshot.feedbackToken, rating: 'correct' }))).status, 500);
    assert.equal(await fs.readFile(file, 'utf8'), '{broken');
    await fs.writeFile(file, original);
    assert.equal((await evaluations.GET()).status, 200);
    assert.equal((await evaluations.POST(request({ feedbackToken: snapshot.feedbackToken, rating: 'correct' }))).status, 200);
  });
});

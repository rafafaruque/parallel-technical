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

  await t.test('ranks later relevant excerpts over navigation and unrelated first sources', async () => {
    mockParallel({ results: [
      { title: 'Unrelated', url: 'https://example.com/weather', excerpts: ['Today the weather is rainy and the roads are wet.'] },
      { title: 'Plants', url: 'https://example.com/plants', excerpts: [
        'Home | Products | Menu\nSign up for photosynthesis news.\n[Home](/) [Menu](/menu) [Pricing](/pricing)',
        'Plants use **sunlight** to convert water and carbon dioxide into sugar through [photosynthesis](https://example.com/process). Photosynthesis releases oxygen as plants use sunlight to produce sugar.',
      ] },
    ] });
    const data = await (await research.POST(request({ query: 'How do plants use sunlight for photosynthesis?' }))).json();
    assert.equal(data.answerParts.length, 2);
    assert.ok(data.answer.includes('Plants use sunlight to convert water and carbon dioxide into sugar through photosynthesis.'));
    assert.ok(data.answerParts.every(part => part.sourceUrl === 'https://example.com/plants'));
    assert.ok(!/Home|Sign up|rainy|\*\*|\]\(/.test(data.answer));
    assert.equal(data.answer, data.answerParts.map(part => part.text).join('\n\n'));
    assert.ok(data.results.every(result => result.snippet.length <= 220));
  });

  await t.test('answers recommendation queries with descriptive evidence rather than article headings', async () => {
    const recommendation = 'Example Pizzeria serves some of the best pizza in NYC, with a crisp crust and fresh tomato sauce.';
    mockParallel({ results: [{
      title: 'The 26 Best Pizza Places In NYC', url: 'https://example.com/pizza',
      excerpts: [
        'The 26 Best Pizza Places In NYC\nAn expert\'s guide to the best pizza in NYC\nThe Best Pizza In Brooklyn\nThe 26 Best Pizza Places In NYC.',
        'Below, see our list of the best pizza in NYC.', 'The top pizzas in NYC, according to us.', recommendation,
      ],
    }] });
    const data = await (await research.POST(request({ query: 'best pizza in nyc' }))).json();
    assert.equal(data.answer, recommendation);
    assert.deepEqual(data.answerParts, [{ text: recommendation, sourceUrl: 'https://example.com/pizza' }]);
    assert.equal(data.results[0].snippet, recommendation);
  });

  await t.test('does not present a page title as an answer when it is the only matching evidence', async () => {
    mockParallel({ results: [{ title: 'The Best Pizza In NYC', url: 'https://example.com/pizza', excerpts: ['The Best Pizza In NYC\nThe Best Pizza In NYC.'] }] });
    const data = await (await research.POST(request({ query: 'best pizza in nyc' }))).json();
    assert.equal(data.answer, '');
    assert.deepEqual(data.answerParts, []);
  });

  await t.test('caps answers at three short quotes, deduplicates, and keeps long source details', async () => {
    const quotes = [
      'Photosynthesis converts light energy into chemical energy in plants.',
      'Photosynthesis supplies the sugars that support plant growth and development.',
      'Photosynthesis releases oxygen into the surrounding atmosphere during daylight.',
      'Photosynthesis depends on pigments that absorb incoming light energy.',
    ];
    mockParallel({ results: [{ title: 'Photosynthesis', url: 'https://example.com/plants', excerpts: [quotes.join(' '), quotes[0]] }] });
    const data = await (await research.POST(request({ query: 'What is photosynthesis?' }))).json();
    assert.equal(data.answerParts.length, 3);
    assert.equal(new Set(data.answerParts.map(part => part.text)).size, 3);
    assert.ok(data.answer.length <= 724);
    assert.ok(data.answerParts.every(part => part.text.length <= 280 && quotes.includes(part.text)));
    assert.ok(data.results[0].snippet.length <= 220);
    assert.ok(data.results[0].fullExcerpt.includes(quotes[3]));
  });

  await t.test('deduplicates near-identical quotes within and across sources while retaining attribution', async () => {
    const quotes = [
      'Photosynthesis converts light energy into chemical energy in plants.',
      'Photosynthesis converts light energy into chemical energy within plants.',
      'Photosynthesis releases oxygen into the surrounding atmosphere during daylight.',
    ];
    const results = [
      { title: 'First', url: 'https://example.com/first', excerpts: [quotes[0], quotes[1]] },
      { title: 'Second', url: 'https://example.com/second', excerpts: [quotes[1], quotes[2]] },
    ];
    mockParallel({ results });
    const data = await (await research.POST(request({ query: 'What is photosynthesis?' }))).json();
    assert.equal(data.answerParts.length, 2);
    assert.equal(data.answerParts.filter(part => /converts light energy/.test(part.text)).length, 1);
    assert.ok(data.answerParts.some(part => part.text === quotes[2]));
    for (const part of data.answerParts) {
      assert.ok(results.find(source => source.url === part.sourceUrl).excerpts.includes(part.text));
    }
    assert.equal(data.results.length, 2);
    assert.equal(data.answer, data.answerParts.map(part => part.text).join('\n\n'));
  });

  await t.test('keeps near-identical quotes with different numbers or qualifications', async () => {
    for (const quotes of [
      ['Plants produce 10 grams of sugar during photosynthesis each day.', 'Plants produce 20 grams of sugar during photosynthesis each day.'],
      ['Photosynthesis may produce sugar in plants during daylight hours.', 'Photosynthesis must produce sugar in plants during daylight hours.'],
    ]) {
      mockParallel({ results: quotes.map((text, index) => ({ title: 'Evidence', url: `https://example.com/${index}`, excerpts: [text] })) });
      const data = await (await research.POST(request({ query: 'What is photosynthesis?' }))).json();
      assert.equal(data.answerParts.length, 2);
      assert.deepEqual(new Set(data.answerParts.map(part => part.text)), new Set(quotes));
    }
  });

  await t.test('returns no answer for unrelated or boilerplate-only evidence, without allowing feedback', async () => {
    for (const excerpts of [
      ['A tomato is a fruit commonly used in cooking and salads.'],
      ['Sign up for vaccine updates.\nHome | Menu | Vaccines\nWe use cookies to improve vaccine information.'],
    ]) {
      mockParallel({ results: [{ title: 'Vaccines', url: 'https://example.com/health', excerpts }] });
      const data = await (await research.POST(request({ query: 'How do vaccines prevent infections?' }))).json();
      assert.equal(data.answer, '');
      assert.deepEqual(data.answerParts, []);
      assert.equal((await evaluations.POST(request({ feedbackToken: data.feedbackToken, rating: 'correct' }))).status, 400);
    }
  });

  await t.test('preserves negations and differing claims instead of merging similar sentences', async () => {
    const quotes = ['Vaccines do not cause the infections they are designed to prevent.', 'Vaccines cause the infections they are designed to prevent.'];
    mockParallel({ results: quotes.map((quote, i) => ({ title: 'Evidence', url: `https://example.com/${i}`, excerpts: [quote] })) });
    const data = await (await research.POST(request({ query: 'Do vaccines cause infections?' }))).json();
    assert.equal(data.answerParts.length, 2);
    assert.deepEqual(new Set(data.answerParts.map(part => part.text)), new Set(quotes));
    assert.ok(data.answerParts.every(part => quotes[Number(part.sourceUrl.split('/').pop())] === part.text));
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
    mockParallel({ results: sources, search_id: 'search_fixture' });
    const next = await (await research.POST(request({ query: 'Exact evidence question', mode: 'basic' }))).json();
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
      const response = await research.POST(request({ query: 'Exact evidence comparison question', mode }));
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

  await t.test('persists the exact concise cleaned answer rather than the noisy source excerpt', async () => {
    mockParallel({ results: [{ title: 'Plants', url: 'https://example.com/plants', excerpts: [
      'Home | Menu | Photosynthesis\nSign up for photosynthesis news.\nPhotosynthesis uses **sunlight** to make sugar in plants.',
    ] }] });
    const data = await (await research.POST(request({ query: 'What is photosynthesis?' }))).json();
    assert.equal(data.answer, 'Photosynthesis uses sunlight to make sugar in plants.');
    const response = await evaluations.POST(request({ feedbackToken: data.feedbackToken, rating: 'correct' }));
    assert.equal(response.status, 201);
    const { evaluation } = await response.json();
    assert.equal(evaluation.answer, data.answerParts.map(part => part.text).join('\n\n'));
    const disk = JSON.parse(await fs.readFile(path.join(temporary, 'data/evaluations.json'), 'utf8'));
    assert.equal(disk.find(item => item.id === evaluation.id).answer, data.answer);
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

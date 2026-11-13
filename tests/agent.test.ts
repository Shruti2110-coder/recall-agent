import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { APICallError, simulateReadableStream } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import type { AgentEvent, StepEvent } from '../src/lib/agent';
import type { Candidate } from '../src/lib/models';
import { getModels } from '../src/lib/models';

// db.ts opens `data/agent.db` under the current folder the first time it is used.
// Each test file runs in its own process, so moving into a temporary folder before
// anything touches the database keeps the real data/ folder out of these tests.
const realCwd = process.cwd();
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'recall-agent-test-'));
process.chdir(tempDir);

// Fake Tavily: every query returns one result whose URL contains the query.
let searchRequests = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (_url: unknown, init?: { body?: string }) => {
  searchRequests++;
  const { query } = JSON.parse(init?.body ?? '{}');
  const slug = String(query).toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return new Response(JSON.stringify({ results: [{ title: query, url: `https://example.com/${slug}`, content: 'price' }] }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}) as typeof fetch;

let runAgent: typeof import('../src/lib/agent').runAgent;
before(async () => {
  ({ runAgent } = await import('../src/lib/agent'));
});
after(() => {
  globalThis.fetch = realFetch;
  process.chdir(realCwd);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

// ---------- helpers for building fake model replies ----------

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};
const finish = (unified: 'stop' | 'tool-calls') => ({ type: 'finish' as const, finishReason: { unified, raw: undefined }, usage });

function stream(chunks: unknown[]) {
  return { stream: simulateReadableStream({ chunks: chunks as never[] }) };
}
const textReply = (...pieces: string[]) =>
  stream([
    { type: 'text-start', id: 't' },
    ...pieces.map((delta) => ({ type: 'text-delta', id: 't', delta })),
    { type: 'text-end', id: 't' },
    finish('stop'),
  ]);
const searchReply = (...queries: string[]) =>
  stream([
    { type: 'tool-call', toolCallId: 'call-1', toolName: 'webSearch', input: JSON.stringify({ queries }) },
    finish('tool-calls'),
  ]);
const rateLimit = (message = 'Rate limit reached') =>
  new APICallError({
    message,
    url: 'https://api.example.com',
    requestBodyValues: {},
    statusCode: 429,
    isRetryable: true,
  });

// A fake model that gives one reply per step, in order. A function reply is called instead (to throw).
function fakeModel(name: string, replies: Array<ReturnType<typeof stream> | (() => never)>) {
  let call = 0;
  const model = new MockLanguageModelV4({
    doStream: async () => {
      const reply = replies[Math.min(call++, replies.length - 1)];
      return typeof reply === 'function' ? reply() : reply;
    },
  });
  return { candidate: { name, model } as Candidate, model };
}

async function run(question: string, models: Candidate[]) {
  const events: AgentEvent[] = [];
  // The wait before a second round: recorded instead of really waiting, so the tests stay fast.
  const waits: number[] = [];
  const wait = async (ms: number) => {
    waits.push(ms);
  };
  await runAgent({ message: question, tzOffsetMinutes: 0 }, (event) => events.push(event), models, 2000, wait);
  const steps = events.filter((e): e is StepEvent => e.type === 'step');
  // The last state of each step, as the page would show it.
  const finalSteps = new Map(steps.map((s) => [s.key, s]));
  return {
    events,
    waits,
    steps,
    finalSteps,
    text: events.flatMap((e) => (e.type === 'text' ? [e.delta] : [])).join(''),
    done: events.find((e) => e.type === 'done'),
    error: events.find((e) => e.type === 'error'),
  };
}

// ---------- the fallback rules ----------

describe('runAgent fallback', () => {
  test('a) first model fails before anything (HTTP 429) -> second model answers, no retry', async () => {
    const first = fakeModel('first', [
      () => {
        throw rateLimit();
      },
    ]);
    const second = fakeModel('second', [textReply('Paris is the capital.')]);

    const result = await run('What is the capital of France?', [first.candidate, second.candidate]);

    assert.equal(first.model.doStreamCalls.length, 1, 'a rate limit must not be retried on the same model');
    assert.equal(result.text, 'Paris is the capital.');
    assert.ok(result.done, 'the answer is saved and sent');
    assert.equal(result.error, undefined);
    assert.equal(result.finalSteps.get('think')?.label, 'Thinking (switched to backup)');
  });

  test('b) first model searches, then fails on its next step -> second model answers from the start', async () => {
    const first = fakeModel('first', [
      searchReply('neon pricing', 'supabase pricing'),
      () => {
        throw rateLimit();
      },
    ]);
    const second = fakeModel('second', [searchReply('neon pricing'), textReply('Neon: UNCHANGED.')]);
    searchRequests = 0;

    const result = await run('Has Neon or Supabase pricing changed since then?', [first.candidate, second.candidate]);

    assert.equal(result.error, undefined, 'the user gets an answer, not an error');
    assert.equal(result.text, 'Neon: UNCHANGED.');
    assert.equal(second.model.doStreamCalls.length, 2, 'the backup searched, then answered');
    assert.equal(searchRequests, 2, 'the repeated "neon pricing" search came from the cache');

    // The backup searched, so only its sources are kept (the failed attempt's supabase result is dropped).
    assert.ok(result.done && result.done.type === 'done');
    assert.deepEqual(
      result.done.message.sources.map((s) => s.url),
      ['https://example.com/neon-pricing'],
    );

    // The step list was reset cleanly: nothing is left running.
    assert.equal(result.finalSteps.get('think')?.label, 'Thinking (switched to backup)');
    for (const s of result.finalSteps.values()) assert.equal(s.done, true, `step "${s.key}" is still running`);
  });

  test('b2) backup answers without searching -> sources from the failed attempt are kept, without duplicates', async () => {
    const first = fakeModel('first', [
      searchReply('render pricing', 'render pricing'),
      () => {
        throw rateLimit();
      },
    ]);
    const second = fakeModel('second', [textReply('Render: UNCHANGED.')]);

    const result = await run('Has Render pricing changed since then?', [first.candidate, second.candidate]);

    assert.ok(result.done && result.done.type === 'done');
    assert.deepEqual(
      result.done.message.sources.map((s) => s.url),
      ['https://example.com/render-pricing'],
    );
  });

  test('c) first model streams some text, then fails -> no restart, partial text kept, error reported', async () => {
    const first = fakeModel('first', [
      stream([
        { type: 'text-start', id: 't' },
        { type: 'text-delta', id: 't', delta: 'Half an ans' },
        { type: 'error', error: new Error('connection dropped') },
      ]),
    ]);
    const second = fakeModel('second', [textReply('should never be used')]);

    const result = await run('What is the latest version of Node.js?', [first.candidate, second.candidate]);

    assert.equal(second.model.doStreamCalls.length, 0, 'no restart once text was sent');
    assert.deepEqual(result.waits, [], 'no second round once text was sent');
    assert.equal(result.text, 'Half an ans');
    assert.ok(result.error, 'an error is reported');
    assert.equal(result.done, undefined, 'a cut-off answer is not saved');
    for (const s of result.finalSteps.values()) assert.equal(s.done, true, `step "${s.key}" is still running`);
  });

  test('every model fails in both rounds -> one "busy" error, never a third round', async () => {
    const fail = () => {
      throw rateLimit();
    };
    const first = fakeModel('first', [fail]);
    const second = fakeModel('second', [fail]);
    const result = await run('Any news today?', [first.candidate, second.candidate]);
    assert.equal(result.text, '');
    assert.match(result.error && result.error.type === 'error' ? result.error.message : '', /busy or unavailable/);
    assert.equal(first.model.doStreamCalls.length, 2, 'two rounds');
    assert.equal(second.model.doStreamCalls.length, 2, 'two rounds');
    assert.deepEqual(result.waits, [4000], 'one wait, between the rounds');
    assert.equal(result.finalSteps.get('think')?.detail, 'No model responded');
    for (const s of result.finalSteps.values()) assert.equal(s.done, true, `step "${s.key}" is still running`);
  });
});

// ---------- the second round ----------

describe('runAgent second round', () => {
  test('both models fail in round one, the first answers in round two', async () => {
    const fail = () => {
      throw rateLimit('Rate limit reached for model. Please try again in 7.5s.');
    };
    const first = fakeModel('first', [fail, textReply('Here is the answer.')]);
    const second = fakeModel('second', [fail]);

    const result = await run('What is the capital of Peru?', [first.candidate, second.candidate]);

    assert.equal(result.error, undefined, 'the user gets an answer, not the busy message');
    assert.equal(result.text, 'Here is the answer.');
    assert.ok(result.done, 'the answer is saved and sent');
    assert.equal(first.model.doStreamCalls.length, 2);
    assert.equal(second.model.doStreamCalls.length, 1, 'round two stops as soon as a model answers');
    assert.deepEqual(result.waits, [7500], 'the wait follows the "try again in 7.5s" hint');

    // While waiting, the screen says so; afterwards that step is finished.
    const retry = result.steps.filter((s) => s.key === 'retry');
    assert.equal(retry[0]?.label, 'All models are busy, trying once more');
    assert.equal(retry[0]?.done, false);
    assert.equal(result.finalSteps.get('retry')?.done, true);
    for (const s of result.finalSteps.values()) assert.equal(s.done, true, `step "${s.key}" is still running`);
  });

  test('a search repeated in round two comes from the 10-minute cache', async () => {
    const fail = () => {
      throw rateLimit();
    };
    const first = fakeModel('first', [searchReply('turso pricing'), fail, searchReply('turso pricing'), textReply('Turso: UNCHANGED.')]);
    const second = fakeModel('second', [fail]);
    searchRequests = 0;

    const result = await run('Has Turso pricing changed since then?', [first.candidate, second.candidate]);

    assert.equal(result.text, 'Turso: UNCHANGED.');
    assert.equal(searchRequests, 1, 'Tavily was asked once; round two used the cache');
  });
});

describe('retryDelayMs', () => {
  test('uses the provider hint, capped at 8 seconds, else 4 seconds', async () => {
    const { retryDelayMs } = await import('../src/lib/agent');
    assert.equal(retryDelayMs('Rate limit reached. Please try again in 7.5s. Visit ...'), 7500);
    assert.equal(retryDelayMs('Please try again in 450ms'), 450);
    assert.equal(retryDelayMs('Please retry in 2s'), 2000);
    assert.equal(retryDelayMs('Please try again in 20s'), 8000);
    assert.equal(retryDelayMs('Please try again in 1m2.5s'), 8000);
    assert.equal(retryDelayMs('The model is experiencing high demand'), 4000);
    assert.equal(retryDelayMs(''), 4000);
  });
});

// ---------- less search text for the model ----------

describe('search size', () => {
  test('at most 3 results per query and 400 characters per snippet; the model sees only title, url, snippet', async () => {
    // Tavily returns 5 long results with extra fields.
    const fakeFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          results: [1, 2, 3, 4, 5].map((n) => ({
            title: `Result ${n}`,
            url: `https://example.com/long-${n}`,
            content: 'x'.repeat(2000),
            score: 0.9,
            raw_content: 'y'.repeat(5000),
          })),
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )) as typeof fetch;

    try {
      const { webSearch } = await import('../src/lib/search');
      const [outcome] = await webSearch(['long results test']);
      assert.equal(outcome.results.length, 3);
      for (const r of outcome.results) {
        assert.equal(r.snippet.length, 400);
        assert.deepEqual(Object.keys(r).sort(), ['snippet', 'title', 'url']);
      }

      // What actually goes back to the model on its next step.
      const model = fakeModel('only', [searchReply('long results test'), textReply('Done.')]);
      const result = await run('What is the latest on long results?', [model.candidate]);
      assert.equal(result.text, 'Done.');
      const toolMessage = JSON.stringify(model.model.doStreamCalls[1].prompt.filter((m) => m.role === 'tool'));
      assert.ok(toolMessage.includes('https://example.com/long-1'));
      assert.ok(!toolMessage.includes('long-4'), 'no 4th result');
      assert.ok(!toolMessage.includes('raw_content') && !toolMessage.includes('score'), 'no extra fields');
      assert.ok(!toolMessage.includes('x'.repeat(401)), 'no snippet longer than 400 characters');

      // The source list is still built from the tool result, exactly as before:
      // nothing was cited by URL, so it shows the top result of the one query.
      assert.ok(result.done && result.done.type === 'done');
      assert.deepEqual(
        result.done.message.sources.map((s) => s.url),
        ['https://example.com/long-1'],
      );
    } finally {
      globalThis.fetch = fakeFetch;
    }
  });
});

// ---------- model order ----------

describe('getModels', () => {
  const both = { GROQ_API_KEY: 'x', GOOGLE_GENERATIVE_AI_API_KEY: 'y' };
  const order = (env: Record<string, string>) => getModels(env).map((c) => c.name.split('/')[0]);

  test('Groq first by default, with medium reasoning', () => {
    assert.deepEqual(order(both), ['groq', 'google']);
    assert.equal(getModels(both)[0].providerOptions?.groq?.reasoningEffort, 'medium');
  });

  test('PRIMARY_MODEL=google puts Gemini first', () => {
    assert.deepEqual(order({ ...both, PRIMARY_MODEL: 'google' }), ['google', 'groq']);
  });

  test('PRIMARY_MODEL is ignored when that provider has no key', () => {
    assert.deepEqual(order({ GROQ_API_KEY: 'x', PRIMARY_MODEL: 'google' }), ['groq']);
  });
});

// ---------- prompt ----------

describe('buildInstructions', () => {
  test('gives the model a ready-to-copy date and the label rule', async () => {
    const { buildInstructions } = await import('../src/lib/prompt');
    const text = buildInstructions('Fri 13 Nov 2026, 14:05', '(memory)', 'Fri 13 Nov 2026');
    assert.match(text, /TODAY: Fri 13 Nov 2026/);
    assert.match(text, /"checked today, Fri 13 Nov 2026"/);
    assert.match(text, /copy the date exactly as it is written in MEMORY/);
    assert.match(text, /CHANGED if the two values differ in any way/);
    assert.match(text, /COULD NOT VERIFY if the search results do not state a current value/);
  });
});

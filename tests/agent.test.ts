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
const rateLimit = () =>
  new APICallError({
    message: 'Rate limit reached',
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
  await runAgent({ message: question, tzOffsetMinutes: 0 }, (event) => events.push(event), models, 2000);
  const steps = events.filter((e): e is StepEvent => e.type === 'step');
  // The last state of each step, as the page would show it.
  const finalSteps = new Map(steps.map((s) => [s.key, s]));
  return {
    events,
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
    assert.equal(result.text, 'Half an ans');
    assert.ok(result.error, 'an error is reported');
    assert.equal(result.done, undefined, 'a cut-off answer is not saved');
    for (const s of result.finalSteps.values()) assert.equal(s.done, true, `step "${s.key}" is still running`);
  });

  test('every model fails -> one "busy" error', async () => {
    const fail = () => {
      throw rateLimit();
    };
    const result = await run('Any news today?', [fakeModel('first', [fail]).candidate, fakeModel('second', [fail]).candidate]);
    assert.equal(result.text, '');
    assert.match(result.error && result.error.type === 'error' ? result.error.message : '', /busy or unavailable/);
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

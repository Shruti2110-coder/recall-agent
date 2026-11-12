import { isStepCount, streamText, tool } from 'ai';
import { z } from 'zod';
import { buildMemoryContext, recentMessages, saveMessage, type Source, type StoredMessage } from './memory';
import { getModels, type Candidate } from './models';
import { buildInstructions } from './prompt';
import { webSearch, type SearchOutcome } from './search';
import { formatLocal } from './time';

// Everything the server can tell the browser while it works.
// A `step` with a key that was already sent updates that step. `ms` = time since the request started.
export type StepEvent = { type: 'step'; key: string; label: string; detail?: string; done: boolean; ms: number };
export type AgentEvent =
  | StepEvent
  | { type: 'text'; delta: string }
  | { type: 'error'; message: string }
  | { type: 'done'; message: StoredMessage };

// If a model sends nothing at all for this long, we stop waiting for it.
const SILENCE_LIMIT_MS = 15000;

// True when the user only wants to be reminded of something already said.
// For those questions the search tool is switched off, so the model cannot wander.
export function isRecallOnly(text: string): boolean {
  const asksAboutPast =
    /\bwhat (did|have) (i|we) (ask|asked|say|said|talk|discuss)|\bwhat (was|were) (it|they|that|those)\b|\bwhat did you (say|tell|answer)|\bremind me what/i.test(text);
    const wantsFreshCheck = /\b(chang|still|correct|update|latest|current|now|since|verify|check)/i.test(text);
  return asksAboutPast && !wantsFreshCheck;
}

export async function runAgent(
  input: { message: string; tzOffsetMinutes: number },
  send: (event: AgentEvent) => void,
  models: Candidate[] = getModels(),
  silenceLimitMs: number = SILENCE_LIMIT_MS,
): Promise<void> {
  const started = Date.now();
  const log = (label: string) => console.log(`[chat] ${label} at ${Date.now() - started}ms`);
  const now = new Date();

  // Live activity steps shown above the answer. `open` remembers steps that are still running.
  const open = new Map<string, { label: string; detail?: string }>();
  const step = (key: string, label: string, done: boolean, detail?: string) => {
    if (done) open.delete(key);
    else open.set(key, { label, detail });
    send({ type: 'step', key, label, detail, done, ms: Date.now() - started });
  };
  const finish = (key: string) => {
    const running = open.get(key);
    if (running) step(key, running.label, true, running.detail);
  };

  // 1) Look up old messages BEFORE saving the new one, so it cannot recall itself.
  //    Topic search only looks further back than the live conversation (the last 9 messages).
  const live = recentMessages(9);
  const liveFrom = live.length ? live[0].createdAt : now.toISOString();
  const memory = buildMemoryContext(input.message, now, input.tzOffsetMinutes, liveFrom);
  log('memory lookup finished');
  step('memory', 'Checked memory', true, memory.note ?? 'Nothing earlier on this topic');

  // 2) Save the question. Even if everything after this fails, it is remembered.
  saveMessage('user', input.message, [], now);

  // 3) The last 10 messages, minus old questions that never got an answer.
  const recent = recentMessages(10);
  const messages = recent
    .filter((m, i) => m.role === 'assistant' || i === recent.length - 1 || recent[i + 1].role === 'assistant')
    .map((m) => ({ role: m.role, content: m.content }));

  const nowLocal = formatLocal(now, input.tzOffsetMinutes);
  const instructions = buildInstructions(nowLocal, memory.text, nowLocal.split(', ')[0]);
  const recallOnly = isRecallOnly(input.message);

  let answer = ''; // answer text already sent to the browser
  let searched = false; // has the current attempt searched?
  let failure = ''; // why the last attempt failed, if it did
  let sources = new Map<string, Source>(); // every result, keyed by URL so nothing is listed twice
  let topPerQuery = new Map<string, Source>(); // the best result for each query

  if (models.length === 0) {
    send({ type: 'error', message: 'No model key is set. Add GROQ_API_KEY or GOOGLE_GENERATIVE_AI_API_KEY to .env.local.' });
    return;
  }

  // 4) Try each model in order. Move to the next one if this one fails or stays silent,
  //    as long as NO answer text has reached the browser yet. A search does not block this:
  //    the next model starts the question again, and repeated searches come from the 10-minute cache.
  //    A rate limit (HTTP 429) is a failure like any other: maxRetries is 0, so we never wait on the same model.
  let failedName = ''; // the model that failed before this one, if any
  for (const candidate of models) {
    searched = false;
    step(
      'think',
      failedName ? 'Thinking (switched to backup)' : 'Thinking',
      false,
      failedName ? `${failedName} failed, trying ${candidate.name}` : candidate.name,
    );
    const abort = new AbortController();
    let timer = setTimeout(() => abort.abort(), silenceLimitMs);
    const stillAlive = () => {
      clearTimeout(timer);
      timer = setTimeout(() => abort.abort(), silenceLimitMs);
    };

    try {
      const result = streamText({
        model: candidate.model,
        instructions,
        messages,
        maxRetries: 0,
        abortSignal: abort.signal,
        providerOptions: candidate.providerOptions as never,
        tools: {
          webSearch: tool({
            description: 'Search the live web. Pass every query you need in one call; they run in parallel.',
            inputSchema: z.object({
              queries: z.array(z.string()).min(1).max(6),
            }),
            execute: async ({ queries }) => webSearch(queries),
          }),
        },
        toolChoice: recallOnly ? 'none' : 'auto',
        stopWhen: isStepCount(5),
        // Errors also arrive as 'error' parts below, where we log one line and switch models.
        // Without this the SDK prints a full stack trace for every failure.
        onError: () => {},
      });

      for await (const part of result.stream) {
        stillAlive();

        if (part.type === 'text-delta') {
          if (!answer) {
            log(`first words (${candidate.name})`);
            finish('think');
            finish('read');
            step('write', 'Writing the answer', false);
          }
          answer += part.text;
          send({ type: 'text', delta: part.text });
        } else if (part.type === 'tool-call') {
          const { queries } = part.input as { queries: string[] };
          log('search requested: ' + queries.join(' | '));
          finish('think');
          finish('read');
          step('search', 'Searching the web', false, queries.join(' · '));
        } else if (part.type === 'tool-result') {
          log('search finished');
          // This attempt searched, so its sources replace any from a failed earlier attempt.
          if (!searched) {
            searched = true;
            sources = new Map();
            topPerQuery = new Map();
          }
          const outcomes = part.output as SearchOutcome[];
          const found = outcomes.reduce((sum, outcome) => sum + outcome.results.length, 0);
          const searches = outcomes.length === 1 ? '1 search' : `${outcomes.length} searches at once`;
          step('search', 'Searched the web', true, `${searches}, ${found} result${found === 1 ? '' : 's'}`);
          step('read', 'Reading the results', false);
          for (const outcome of outcomes) {
            for (const r of outcome.results) sources.set(r.url, { title: r.title, url: r.url });
            const best = outcome.results[0];
            if (best) topPerQuery.set(best.url, { title: best.title, url: best.url });
          }
        } else if (part.type === 'error') {
          throw part.error;
        }
      }

      clearTimeout(timer);
      if (abort.signal.aborted) throw new Error('the model stayed silent for too long');
      if (answer) {
        failure = '';
        break; // success: stop trying models
      }
      throw new Error('the model returned no text');
    } catch (error) {
      clearTimeout(timer);
      failure = abort.signal.aborted ? 'the model stayed silent for too long' : error instanceof Error ? error.message : String(error);
      log(`${candidate.name} failed: ${failure.slice(0, 120)}`);
      failedName = candidate.name;
      // Close this attempt's running steps, so nothing spins forever.
      for (const key of ['think', 'search', 'read']) finish(key);
      if (answer) break; // answer text already reached the browser, so we cannot start over with another model
    }
  }

  // 5) Save and finish. Close any step that is still running.
  if (!answer && failedName) step('think', 'Thinking', true, 'No model responded');
  for (const key of [...open.keys()]) finish(key);

  if (answer && failure) {
    // The model stopped part-way through its answer. The partial text stays on screen,
    // but it is not saved, so it is never recalled later as if it were a full answer.
    send({ type: 'error', message: 'The answer was cut off because the AI model stopped responding. Please try again.' });
  } else if (answer) {
    const all = [...sources.values()];
    const cited = all.filter((s) => answer.includes(s.url));
    const shown = cited.length ? cited : [...topPerQuery.values()];
    const saved = saveMessage('assistant', answer, shown);
    send({ type: 'done', message: saved });
  } else {
    send({ type: 'error', message: 'The AI model is busy or unavailable right now. Please try again in a moment.' });
  }

  log('done');
}

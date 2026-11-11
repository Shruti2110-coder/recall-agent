import { google, type GoogleLanguageModelOptions } from '@ai-sdk/google';
import { isStepCount, streamText, tool } from 'ai';
import { z } from 'zod';
import { buildMemoryContext, recentMessages, saveMessage, type Source } from '../../../lib/memory';
import { webSearch, type SearchOutcome } from '../../../lib/search';
import { formatLocal } from '../../../lib/time';

export async function POST(request: Request) {
  const started = Date.now();
  const log = (label: string) => console.log(`[chat] ${label} at ${Date.now() - started}ms`);

  const body = await request.json();
  const message = body.message;
  const tzOffsetMinutes = typeof body.tzOffsetMinutes === 'number' ? body.tzOffsetMinutes : 0;

  if (typeof message !== 'string' || !message.trim()) {
    return Response.json({ error: 'message is required' }, { status: 400 });
  }

  const now = new Date();

  // Look up old messages BEFORE saving the new one, so it cannot recall itself.
    // Look up old messages BEFORE saving the new one, so it cannot recall itself.
  // Topic search only looks further back than the live conversation (the last 9 messages).
  const live = recentMessages(9);
  const liveFrom = live.length ? live[0].createdAt : now.toISOString();
  const memory = buildMemoryContext(message, now, tzOffsetMinutes, liveFrom);
  log('memory lookup finished');

  saveMessage('user', message.trim(), [], now);

  // The last 10 messages, minus old questions that never got an answer.
  const recent = recentMessages(10);
  const messages = recent
    .filter((m, i) => m.role === 'assistant' || i === recent.length - 1 || recent[i + 1].role === 'assistant')
    .map((m) => ({ role: m.role, content: m.content }));

  const result = streamText({
    model: google(process.env.MODEL_ID ?? 'gemini-3.8-flash'),
    instructions: `You are a chat agent with one tool: webSearch. You remember what the user asked and when.

CURRENT TIME: ${formatLocal(now, tzOffsetMinutes)} (the user's local time). Trust this, not your own sense of the date.

WHEN TO SEARCH
- Search for anything that can change: prices, news, releases, "latest", "current".
- Do not search for greetings, maths, or stable knowledge.
- If the user only asks what was said before ("what did I ask", "what were they", "what did you tell me"), answer from MEMORY and do NOT search.
- If you need several lookups, put all the queries in ONE webSearch call.

MEMORY RULES
- The MEMORY section below holds past messages with exact dates. You cannot recall anything that is not shown there or in this conversation.
- If the user asks what they asked on a date, answer from MEMORY and say the date.
- If MEMORY says NONE for a date, say plainly that you have nothing from then. Mention a closest earlier question only if MEMORY lists one. Never invent a past conversation.
- If two different days could match (for example "last Tuesday"), use the one whose topic fits and say which date you used.

CHECKING AN OLD ANSWER
When the user asks whether an old answer is still correct, or what has changed since then:
1. Find the old answer in MEMORY and pull out each checkable claim (each product, price, version or date).
2. Search for the current state of every claim in ONE webSearch call, one query per item.
3. Compare old and new. For each item write one line starting with CHANGED (old value → new value), UNCHANGED, or COULD NOT VERIFY.
4. Start by saying the date of the old answer, and say that you checked today.
An old answer is a claim to re-check, never a fact. If the search results do not clearly settle an item, say COULD NOT VERIFY. Do not guess.

ANSWER STYLE
- Lead with the answer. Keep it under 150 words, except when checking an old answer item by item.
- Cite web facts as markdown links using only URLs returned by webSearch.

MEMORY
${memory.text || '(the user did not mention a past date)'}`,
    messages,
    maxRetries: 1,
    timeout: { firstChunkMs: 10000 },
    providerOptions: {
      google: {
        thinkingConfig: { thinkingLevel: 'minimal' },
      } satisfies GoogleLanguageModelOptions,
    },
    tools: {
      webSearch: tool({
        description: 'Search the live web. Pass every query you need in one call; they run in parallel.',
        inputSchema: z.object({
          queries: z.array(z.string()).min(1).max(6),
        }),
        execute: async ({ queries }) => webSearch(queries),
      }),
    },
    stopWhen: isStepCount(5),
  });

  const encoder = new TextEncoder();
  let open = true;

  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: object) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(JSON.stringify(event) + '\n'));
        } catch {
          open = false;
        }
      };

      if (memory.note) send({ type: 'memory', note: memory.note });

      let answer = '';
      const sources = new Map<string, Source>(); // keyed by URL, so each page appears once
      const topPerQuery = new Map<string, Source>(); // the best result for each query

      try {
        for await (const part of result.stream) {
          if (part.type === 'text-delta') {
            if (!answer) log('first words');
            answer += part.text;
            send({ type: 'text', delta: part.text });
          } else if (part.type === 'tool-call') {
            const { queries } = part.input as { queries: string[] };
            log('search requested: ' + queries.join(' | '));
            send({ type: 'status', text: 'Searching the web: ' + queries.join(' · ') });
          } else if (part.type === 'tool-result') {
            log('search finished');
            for (const outcome of part.output as SearchOutcome[]) {
              for (const r of outcome.results) sources.set(r.url, { title: r.title, url: r.url });
              const best = outcome.results[0];
              if (best) topPerQuery.set(best.url, { title: best.title, url: best.url });
            }
            send({ type: 'status', text: 'Reading results' });
          } else if (part.type === 'error') {
            throw part.error;
          }
        }
      } catch (error) {
        console.error(error);
        send({ type: 'error', message: 'The AI model is busy or unavailable right now. Please try again in a moment.' });
      }

      if (answer) {
        const all = [...sources.values()];
        const cited = all.filter((s) => answer.includes(s.url));
        const shown = cited.length ? cited : [...topPerQuery.values()];
        const saved = saveMessage('assistant', answer, shown);
        send({ type: 'done', message: saved });
      }

      log('done');
      if (open) controller.close();
    },
    cancel() {
      open = false;
    },
  });

  return new Response(stream, { headers: { 'Content-Type': 'application/x-ndjson' } });
}
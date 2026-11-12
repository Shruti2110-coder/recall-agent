# Recall

Recall is a chat agent with one tool, web search, that remembers what you asked and when. Every message is saved in a local SQLite database with its exact time. When you say "last Tuesday", "3 November" or "yesterday", Recall turns that into an exact date range in your timezone and loads what was said then. So you can ask "Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?" and it finds the old answer, searches the web for every item in it at once, and marks each one CHANGED, UNCHANGED or COULD NOT VERIFY. While it works, the page shows each step live (checking memory, thinking, searching, reading, writing).

Built with Next.js (App Router) and TypeScript, the Vercel AI SDK, SQLite through Node's built-in `node:sqlite`, and Tavily for search.

## How to run

You need **Node.js 22.5 or newer** (for `node:sqlite`).

```bash
npm install
cp .env.example .env.local   # then open .env.local and add your keys
npm run dev
```

Open http://localhost:3000.

## Keys

Put these in `.env.local`. Never commit that file.

| Variable | Required? | What it is for |
|---|---|---|
| `GROQ_API_KEY` | One of these two | Groq, the first model tried by default (fast) |
| `GOOGLE_GENERATIVE_AI_API_KEY` | One of these two | Google Gemini, the backup model by default |
| `TAVILY_API_KEY` | Yes | Web search |
| `GROQ_MODEL_ID` | No | Groq model, default `openai/gpt-oss-120b` |
| `MODEL_ID` | No | Gemini model, default `gemini-3.5-flash-lite` |
| `PRIMARY_MODEL` | No | `groq` (default) or `google`: which one answers first when both keys are set |

If both model keys are set, Groq answers first and Gemini is the backup. Set `PRIMARY_MODEL=google` to swap them.

The backup takes over if the first model fails, hits its rate limit (HTTP 429) or stays silent for 15 seconds, as long as no answer text has appeared yet. This still works after a web search has started: the backup starts the question again, and repeated searches come straight from the 10-minute cache. A rate limit is never retried on the same model; it switches at once. Once answer text has appeared, the model is never switched: if it then stops, you keep the partial text, it is marked as failed, and it is not saved.

Groq's model runs with reasoning set to `medium`. On `low` it was the fastest, but it sometimes got dates wrong or labelled a changed price as UNCHANGED. `medium` is a little slower and more careful. If accuracy still matters more than speed, use `PRIMARY_MODEL=google`.

## Try it with demo data

```bash
npm run seed
```

This adds two demo conversations to your local database: a CRM shortlist on the most recent Monday, and a Postgres hosting question on Tuesday of last week. The prices are placeholders. Running it again does nothing.

Then try these questions:

1. **On Monday we shortlisted 5 CRM tools. Has any of them changed pricing since?**
2. **Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?**
3. **What did I ask you last week?** (answered from memory only, with no web search)

You can also open the history panel (top left), open an old question and click **Check again today**.

## Tests

```bash
npm test
```

The tests use Node's built-in test runner (run through `tsx`). They check the date logic with a fixed "now" and timezone: explicit dates, weekdays, "last Tuesday", "yesterday", "3 days ago", "last week", dates without a year, plus keyword extraction and memory-only question detection. They need no API keys and do not touch the database.

## Where things are

| File | What it does |
|---|---|
| `src/lib/agent.ts` | Answers one question: memory lookup, model fallback, silence timer, live step events |
| `src/lib/memory.ts` | Saves messages and recalls them by date and by topic (SQLite full-text search) |
| `src/lib/time.ts` | Turns "last Tuesday" or "3 November" into exact date ranges in the user's timezone |
| `src/lib/search.ts` | Tavily search: several queries in parallel, each cached for 10 minutes |
| `src/lib/models.ts` | Which models to try, in order, based on the keys you set |
| `src/lib/prompt.ts` | The instructions sent to the model, including the current time and the recalled memory |
| `src/lib/db.ts` | Opens `data/agent.db` and creates the tables |
| `src/app/api/chat/route.ts` | Streams the agent's events to the browser, one JSON line each |
| `src/app/api/history/route.ts` | Returns saved messages for the history panel |
| `src/app/page.tsx`, `src/app/globals.css` | The chat page |
| `scripts/seed.ts` | Demo data |
| `tests/time.test.ts` | Tests |

The database lives in `data/agent.db` and is not committed. Delete the `data` folder to start fresh.

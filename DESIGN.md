# DESIGN

Recall is a chat agent with one tool, web search, and a memory that knows when things were said.

## How it works

Every question goes through the same steps (`src/lib/agent.ts`):

1. **Recall.** Before the model is called, plain code looks for relevant old messages in SQLite. `time.ts` turns phrases like "last Tuesday" or "3 November" into exact day ranges in the user's timezone, and `memory.ts` loads the messages from those days. If the question has no date, SQLite full-text search (FTS5) finds older conversations on the same topic.
2. **Save.** The question is stored with a UTC timestamp, after the lookup, so it can never recall itself.
3. **Prompt.** The model gets the current local time, the recalled messages with their dates, and the last 10 messages.
4. **Answer.** The model either answers or calls `webSearch` with up to 6 queries. They run in parallel on Tavily and are cached for 10 minutes.
5. **Stream.** The server sends one JSON line per event, so the screen shows live steps (memory, thinking, searching, writing) and then the text.
6. **Save the answer** with its sources, so it can be recalled and re-checked later.

For "has it changed since?" questions, the old answer arrives in the prompt with its date. The model treats it as a list of claims, searches for all of them in one call, and labels each one CHANGED, UNCHANGED or COULD NOT VERIFY.

## Why it is built this way

- **Memory is code, not a second tool.** The brief allows one tool. A database lookup also takes milliseconds, while a tool call costs a full round trip to the model.
- **Code decides what code can decide.** Dates and timezones are worked out in code because models get them wrong. Memory-only questions ("what did I ask yesterday?") have the search tool switched off in code, because a prompt rule alone was not enough.
- **Ambiguity is settled with data.** On a Wednesday, "last Tuesday" can mean two different days. Both are loaded, and the agent says which date it used.
- **Honest when empty.** If nothing was stored on a date, the prompt says NONE, so the model has nothing to invent from.
- **Fast, with a backup.** Models are tried in order: Groq first because it is fastest, then Gemini. If a model fails, hits a rate limit, or is silent for 15 seconds, the next one takes over, as long as no answer text has been shown yet. Restarting is cheap because searches are cached.
- **Easy to run.** One Next.js app and one SQLite file, using Node's built-in `node:sqlite`. `npm run seed` adds back-dated conversations so memory can be tested on day one.

## Considered and rejected

| Option | Why not |
|---|---|
| A vector database | The questions are about dates and named topics. A date index and keyword search answer those exactly, with no extra service. |
| Sending the whole history to the model | It gets slower and more expensive with every message, and old answers crowd out the question. |
| An extra model call to classify each message | It adds delay to every message. A date parser and one small rule do the same job in code. |
| Retrying the same model on errors | When a provider is overloaded, retrying wastes time. Switching to the backup is faster. |
| An agent framework | It would hide the decisions this challenge is about. |

## What I learned from testing

- **The free model I started with was unreliable.** It was sometimes busy and once stayed silent for over 90 seconds. That is why there is a silence timer and a second provider.
- **Failed questions leaked into later ones.** Unanswered questions stayed in the history, and the model searched for them when I asked about something else. Unanswered turns are now left out of the context.
- **A prompt rule was not enough.** I asked "what did I ask yesterday?" and the model searched the web for my previous topic. Switching the tool off in code fixed it.
- **Busy days broke recall.** After a day with many questions, the agent listed only three of them. Busy days are now sent as a list of every question, plus the full exchanges that match the current one.
- **The fastest model was sometimes careless.** It wrote the wrong date and called a changed price UNCHANGED. I raised its reasoning one level, put today's date in the prompt ready to copy, and added a strict rule: if the old and new values differ, it is CHANGED.

## With another week

- **Store claims, not only text:** save each checkable fact (item, value, source, date) so "what changed?" becomes an exact comparison.
- **Semantic recall:** add embeddings so "that database question" finds the Postgres conversation with no shared words.
- **Official sources first:** prefer a vendor's own pricing page over third-party articles.
- **More users and a hosted version:** today it is one user and one local database file.
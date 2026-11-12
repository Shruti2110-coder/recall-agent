# Design notes

> **DRAFT.** Written from what the code does. Rewrite it in your own words before submitting, and replace the "What I learned from testing" section with what you actually saw.

## How it works

1. **Look back first.** When a question arrives, `time.ts` finds every past date in it ("last Tuesday", "3 November", "yesterday", "last week") and turns each into an exact range in the user's timezone. `memory.ts` loads every message in those ranges. If no date matched, it searches older messages by topic with SQLite full-text search (FTS5, ranked by bm25) and brings back each question together with its answer.
2. **Save the question.** The question is saved before the model is called, so it is remembered even if the answer fails. The memory lookup happens before this save, so a question can never "recall" itself.
3. **Build the prompt.** The model gets the last 10 messages, the current local time, and a MEMORY section with the recalled messages, each stamped with its date. Questions that never got an answer are left out.
4. **Answer, maybe search.** The model has one tool, `webSearch`, which takes up to 6 queries and runs them in parallel on Tavily. Results are cached for 10 minutes. For "what did I ask?" questions the tool is switched off.
5. **Fallback.** Models are tried in order: Groq, then Gemini (`PRIMARY_MODEL=google` swaps them). If one fails, hits a rate limit (HTTP 429) or sends nothing for 15 seconds, the next one is tried, as long as *no answer text has reached the browser yet*. A search does not block the switch: the backup starts the question again from the beginning, which is cheap because repeated searches come from the 10-minute cache. The step list shows "Thinking (switched to backup)", and any search step left over from the failed attempt is closed. If the backup searches, only its sources are shown; if not, the earlier attempt's sources are kept. Once answer text has appeared, the model is never switched: if it then fails, the partial text stays on screen marked as failed and is not saved, so it is never recalled later as a full answer.
6. **Stream and save.** The server sends one JSON line per event: live steps (memory, thinking, searching, reading, writing), text pieces, and the final saved answer with its sources.

## Why it is built this way

- **Dates are worked out in code, not by the model.** Date maths and timezones are exact rules, and models get them wrong. The model only sees results like "Messages from Tue 3 Nov 2026".
- **"Last Tuesday" returns both possible Tuesdays.** On a Wednesday it could mean yesterday or the week before. Both are loaded and the prompt tells the model to pick the one whose topic fits and to say which date it used.
- **A date without a year means the past.** "20 December" said in November means last December.
- **An old answer is a claim to re-check, not a fact.** The prompt makes the model list each item as CHANGED, UNCHANGED or COULD NOT VERIFY, and the page shows these as badges.
- **SQLite with no setup.** `node:sqlite` is built into Node, so there is no database server or extra package. `npm install && npm run dev` is enough.
- **One search call with many queries.** Re-checking 5 products is 5 queries at once, not 5 round trips.
- **Fast and reliable, with an honest trade-off.** Groq is the fastest free option, but on `low` reasoning it was sometimes careless: it wrote the wrong date for "today" or for an old message, and labelled a price that had moved as UNCHANGED. So its reasoning was raised one level to `medium` (a little slower), and the order can be swapped with `PRIMARY_MODEL=google`. The prompt also leaves less to the model: it is given today's date ready to copy, told to copy old dates exactly from MEMORY, and given a strict rule that any difference between the old and new value means CHANGED.

## Considered and rejected

| Option | Why not |
|---|---|
| Let the model read the whole history | Grows without limit and costs more. A targeted lookup by date and topic is smaller and more accurate. |
| Let the model work out dates itself | Unreliable with timezones and phrases like "last Tuesday". Code is exact and testable. |
| Embeddings / a vector database for topic recall | Needs another service or key. Product names and prices are exact words, which full-text search handles well. |
| A separate database (Postgres) | Extra setup for a single-user local app. |
| Retrying the same model on errors | Slower when a provider is overloaded or rate-limited. Switching to the backup model is faster (`maxRetries: 0`), including for HTTP 429. |
| Only switching models before any search | A rate limit often hits on the model's *second* call, after the search, which left the user with a "busy" error. Restarting on the backup is cheap thanks to the search cache. |
| Asking the prompt alone to not search for memory questions | A model can ignore an instruction. Switching the tool off in code (`toolChoice: 'none'`) guarantees no search. |

## What I learned from testing

*(Replace this with your own experience. These are the problems the code clearly guards against.)*

- A short greeting matched old conversations by topic, so topic search only runs for questions of three words or more, and only when no date matched.
- A day with many questions made the prompt too long, so busy days (more than 12 messages) are sent as a list of every question plus the full exchanges that match.
- A model could hang without sending anything, so a 15-second silence timer moves on to the backup.
- Topic search kept finding the current conversation, so it only looks at messages older than the live conversation.
- Old questions with no saved answer confused the model, so they are left out of the recent messages.

## With another week

- Tests for `memory.ts` using a temporary database. (`agent.ts` fallback is now tested with `MockLanguageModelV4` and a fake search API in `tests/agent.test.ts`.)
- Save the user's timezone with each message. Today the current offset is used for every message, so travelling or a daylight-saving change can shift old dates.
- Support more than one user (the database is shared by everyone using one server).
- Have the model return the re-check as structured data (item, old value, new value, verdict) instead of free text.
- Deployment: `node:sqlite` needs a server with a persistent disk, so it would not work on a serverless host as-is.

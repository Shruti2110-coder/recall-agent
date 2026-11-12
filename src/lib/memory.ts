import { getDb } from './db';
import { formatLocal, resolveTimeRanges, todayRange, type TimeRange } from './time';

export type Source = { title: string; url: string };

export type StoredMessage = {
  id: number;
  role: 'user' | 'assistant';
  content: string;
  sources: Source[];
  createdAt: string;
};

type Row = { id: number; role: 'user' | 'assistant'; content: string; sources: string | null; created_at: string };

function toMessage(row: Row): StoredMessage {
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    sources: row.sources ? JSON.parse(row.sources) : [],
    createdAt: row.created_at,
  };
}

export function saveMessage(
  role: 'user' | 'assistant',
  content: string,
  sources: Source[] = [],
  when: Date = new Date(),
): StoredMessage {
  const createdAt = when.toISOString();
  const result = getDb()
    .prepare('INSERT INTO messages (role, content, sources, created_at) VALUES (?, ?, ?, ?)')
    .run(role, content, sources.length ? JSON.stringify(sources) : null, createdAt);

  return { id: Number(result.lastInsertRowid), role, content, sources, createdAt };
}

export function recentMessages(limit: number): StoredMessage[] {
  const rows = getDb()
    .prepare('SELECT * FROM messages ORDER BY created_at DESC, id DESC LIMIT ?')
    .all(limit) as Row[];
  return rows.reverse().map(toMessage);
}

// Every message inside a time range, oldest first.
export function messagesBetween(range: TimeRange): StoredMessage[] {
  const rows = getDb()
    .prepare('SELECT * FROM messages WHERE created_at >= ? AND created_at < ? ORDER BY created_at, id LIMIT 300')
    .all(range.from.toISOString(), range.to.toISOString()) as Row[];
  return rows.map(toMessage);
}

// The closest question before a moment. Used when a date has no messages.
function lastQuestionBefore(moment: Date): StoredMessage | undefined {
  const row = getDb()
    .prepare("SELECT * FROM messages WHERE created_at < ? AND role = 'user' ORDER BY created_at DESC LIMIT 1")
    .get(moment.toISOString()) as Row | undefined;
  return row ? toMessage(row) : undefined;
}

// Words too common to help find a topic.
const STOP_WORDS = new Set(
  `the a an and or but if then than that this these those is are was were be been am do does did have has had
   i you we they he she it my your our me us what when where which who how why any some all about with from
   for of on in at to by as not no yes its their now there here please tell can could would should will just
   also still since ever asked ask told said say talked talk discussed discuss last past ago today yesterday
   week month monday tuesday wednesday thursday friday saturday sunday answer question correct changed change
   something anything`.split(/\s+/),
);

// Pick the meaningful words out of a sentence.
export function extractKeywords(text: string): string[] {
  const words = (text.toLowerCase().match(/[a-z0-9][a-z0-9.+#-]{2,}/g) ?? []).map((word) => word.replace(/[.-]+$/, ''));
  return [...new Set(words.filter((word) => word.length > 2 && !STOP_WORDS.has(word)))].slice(0, 8);
}

// Find older conversations about the same topic. Returns questions with their answers.
// `before` skips messages that are already in the live conversation.
export function searchByTopic(text: string, before: string, limit = 2): StoredMessage[] {
  const keywords = extractKeywords(text);
  if (keywords.length === 0) return [];

  const db = getDb();
  // Each word goes in double quotes so punctuation cannot break the search syntax.
  // OR means "any of these words". bm25 ranks the best matches first.
  const query = keywords.map((word) => '"' + word.replace(/"/g, '') + '"').join(' OR ');

  const hits = db
    .prepare(
      `SELECT m.* FROM messages_fts
       JOIN messages m ON m.id = messages_fts.rowid
       WHERE messages_fts MATCH ? AND m.created_at < ?
       ORDER BY bm25(messages_fts) LIMIT 10`,
    )
    .all(query, before) as Row[];

  const found = new Map<number, StoredMessage>(); // keyed by id, so nothing is listed twice

  for (const hit of hits) {
    // Bring the other half of the exchange: the answer to a question, or the question for an answer.
    const partner =
      hit.role === 'user'
        ? (db.prepare('SELECT * FROM messages WHERE created_at > ? ORDER BY created_at, id LIMIT 1').get(hit.created_at) as Row | undefined)
        : (db.prepare('SELECT * FROM messages WHERE created_at < ? ORDER BY created_at DESC, id DESC LIMIT 1').get(hit.created_at) as Row | undefined);

    const question = hit.role === 'user' ? hit : partner;
    const answer = hit.role === 'user' ? partner : hit;
    if (question && question.role === 'user') found.set(question.id, toMessage(question));
    if (answer && answer.role === 'assistant') found.set(answer.id, toMessage(answer));

    if (found.size >= limit * 2) break;
  }

  return [...found.values()];
}

// One stored message, written out for the model with its local date and time.
function describe(message: StoredMessage, tzOffsetMinutes: number): string {
  const who = message.role === 'user' ? 'USER ASKED' : 'YOU ANSWERED';
  const text = message.content.length > 1800 ? message.content.slice(0, 1800) + ' …[cut]' : message.content;
  const links = message.sources.length ? `\n  (sources used then: ${message.sources.map((s) => s.url).join(', ')})` : '';
  return `[${formatLocal(new Date(message.createdAt), tzOffsetMinutes)}] ${who}: ${text}${links}`;
}

// A day with only a few messages is shown in full. A busy day is shown as a
// list of its questions, plus the full exchanges that match the current question.
const FULL_DAY_LIMIT = 12;

function describeRange(range: TimeRange, messages: StoredMessage[], userText: string, tzOffsetMinutes: number): string {
  if (messages.length <= FULL_DAY_LIMIT) {
    return `Messages from ${range.label}:\n${messages.map((m) => describe(m, tzOffsetMinutes)).join('\n')}`;
  }

  // 1) Every question, once each, with the time it was first asked.
  const asked = new Map<string, { time: string; count: number }>();
  for (const m of messages) {
    if (m.role !== 'user') continue;
    const entry = asked.get(m.content);
    if (entry) entry.count++;
    else asked.set(m.content, { time: formatLocal(new Date(m.createdAt), tzOffsetMinutes), count: 1 });
  }
  const list = [...asked.entries()].map(
    ([text, info], i) => `${i + 1}. [${info.time}] ${text}${info.count > 1 ? ` (asked ${info.count} times)` : ''}`,
  );

  // 2) Up to three full exchanges that share words with the current question.
  const keywords = extractKeywords(userText);
  const matching: StoredMessage[] = [];
  for (let i = 0; i < messages.length - 1 && matching.length < 6; i++) {
    const question = messages[i];
    const answer = messages[i + 1];
    if (question.role !== 'user' || answer.role !== 'assistant') continue;
    const text = (question.content + ' ' + answer.content).toLowerCase();
    if (keywords.some((word) => text.includes(word))) matching.push(question, answer);
  }

  return (
    `Messages from ${range.label}: a busy day. The user asked ${asked.size} different questions. ALL of them, in order:\n` +
    list.join('\n') +
    (matching.length
      ? `\n\nFull exchanges from ${range.label} that match the current question:\n` +
        matching.map((m) => describe(m, tzOffsetMinutes)).join('\n')
      : '')
  );
}

// Build the MEMORY section of the prompt for one new question.
export function buildMemoryContext(
  userText: string,
  now: Date,
  tzOffsetMinutes: number,
  liveFrom: string,
): { text: string; note: string | null } {
  const sections: string[] = [];
  const notes: string[] = [];

  const ranges = resolveTimeRanges(userText, now, tzOffsetMinutes);
  // "What did I ask earlier today?" is a memory question too.
  const asksAboutToday =
    /\b(today|this morning|this afternoon|this evening|earlier)\b/i.test(userText) &&
    /\b(ask|asked|say|said|told|tell|talk|talked|discuss|discussed|question|questions)\b/i.test(userText);
  if (asksAboutToday) ranges.push(todayRange(now, tzOffsetMinutes));

  for (const range of ranges) {
    const messages = messagesBetween(range);

    if (messages.length > 0) {
      sections.push(describeRange(range, messages, userText, tzOffsetMinutes));
      notes.push(`${messages.length} message${messages.length === 1 ? '' : 's'} from ${range.label}`);
    } else {
      const nearest = lastQuestionBefore(range.from);
      sections.push(
        `Messages from ${range.label}: NONE. Nothing was stored in that period.` +
          (nearest ? `\nThe closest earlier question was:\n${describe(nearest, tzOffsetMinutes)}` : ''),
      );
    }
  }

  // By topic: only when the date lookup found nothing, and only for a real
  // question (three words or more), so a greeting never triggers it.
  const isRealQuestion = userText.trim().split(/\s+/).length >= 3;
  const related = notes.length === 0 && isRealQuestion ? searchByTopic(userText, liveFrom) : [];
  if (related.length > 0) {
    sections.push(
      'Earlier conversations that mention similar words (use only if relevant):\n' +
        related.map((m) => describe(m, tzOffsetMinutes)).join('\n'),
    );
    notes.push('an earlier conversation on this topic');
  }

  return {
    text: sections.join('\n\n'),
    note: notes.length ? 'Recalled ' + notes.join(' and ') : null,
  };
}
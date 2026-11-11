import { getDb } from '../src/lib/db';
import { saveMessage } from '../src/lib/memory';

// A moment `daysAgo` days back, at the given time on this computer's clock.
function at(daysAgo: number, hour: number, minute: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  d.setHours(hour, minute, 0, 0);
  return d;
}

// How many days ago the most recent <weekday> was (never today). 0 = Sunday.
function daysSince(weekday: number): number {
  const back = (new Date().getDay() - weekday + 7) % 7;
  return back === 0 ? 7 : back;
}

function addTurn(when: Date, question: string, answer: string) {
  saveMessage('user', question, [], when);
  saveMessage('assistant', answer, [], new Date(when.getTime() + 4000));
}

const db = getDb();

// Do nothing if demo conversations are already there.
const already = db.prepare("SELECT COUNT(*) AS n FROM messages WHERE content LIKE '(Demo data%'").get() as { n: number };
if (already.n > 0) {
  console.log('Demo conversations are already in the database. Nothing added.');
  process.exit(0);
}

// The most recent Monday: a CRM shortlist.
addTurn(
  at(daysSince(1), 10, 15),
  'We need a CRM for a 20-person sales team. Can you shortlist 5 tools with pricing?',
  `(Demo data, prices are placeholders.) Shortlist for a 20-person sales team:
- HubSpot Sales Hub Professional: $90 per user per month
- Pipedrive Advanced: $34 per user per month
- Zoho CRM Professional: $23 per user per month
- Salesforce Pro Suite: $100 per user per month
- Freshsales Pro: $39 per user per month`,
);

// Tuesday of LAST week: Postgres hosting.
let tuesday = daysSince(2);
const daysIntoWeek = (new Date().getDay() + 6) % 7; // Monday = 0
if (tuesday <= daysIntoWeek) tuesday += 7;
addTurn(
  at(tuesday, 14, 5),
  'What are good managed Postgres hosting options for a small startup, and what do they cost?',
  `(Demo data, prices are placeholders.) Managed Postgres options:
- Neon: Launch plan from $19 per month
- Supabase: Pro plan $25 per month
- Render: Starter from $7 per month
- AWS RDS: a db.t4g.micro is roughly $13 per month`,
);

console.log('Added 2 demo conversations (4 messages).');
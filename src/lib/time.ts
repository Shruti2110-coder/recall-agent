import * as chrono from 'chrono-node';

export type TimeRange = { from: Date; to: Date; label: string };

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const SHORT_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// A calendar day in the user's timezone, counted as "days since 1 Jan 1970".
function localDayNumber(instant: Date, tzOffsetMinutes: number): number {
  return Math.floor((instant.getTime() + tzOffsetMinutes * 60_000) / DAY_MS);
}

// The day number for a year / month (1-12) / day.
function dayNumberOf(year: number, month: number, day: number): number {
  return Math.floor(Date.UTC(year, month - 1, day) / DAY_MS);
}

// 0 = Sunday ... 6 = Saturday
function weekdayOf(dayNumber: number): number {
  return new Date(dayNumber * DAY_MS).getUTCDay();
}

// The Monday that starts the week containing this day.
function mondayOf(dayNumber: number): number {
  return dayNumber - ((weekdayOf(dayNumber) + 6) % 7);
}

// "Tue 3 Nov 2026"
function formatDay(dayNumber: number): string {
  const d = new Date(dayNumber * DAY_MS);
  return `${SHORT_DAYS[d.getUTCDay()]} ${d.getUTCDate()} ${SHORT_MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

// "Tue 3 Nov 2026, 14:05" in the user's local time.
export function formatLocal(instant: Date, tzOffsetMinutes: number): string {
  const shifted = new Date(instant.getTime() + tzOffsetMinutes * 60_000);
  const hh = String(shifted.getUTCHours()).padStart(2, '0');
  const mm = String(shifted.getUTCMinutes()).padStart(2, '0');
  return `${formatDay(localDayNumber(instant, tzOffsetMinutes))}, ${hh}:${mm}`;
}

// Find every past day or period mentioned in the text.
export function resolveTimeRanges(text: string, now: Date, tzOffsetMinutes: number): TimeRange[] {
  const today = localDayNumber(now, tzOffsetMinutes);
  const lower = text.toLowerCase();
  const found = new Map<string, TimeRange>();

  // Add a run of local days. Anything that reaches today or the future is cut off.
  const add = (firstDay: number, dayCount: number) => {
    const lastDay = Math.min(firstDay + dayCount - 1, today - 1);
    if (lastDay < firstDay) return;
    const from = new Date(firstDay * DAY_MS - tzOffsetMinutes * 60_000);
    const to = new Date((lastDay + 1) * DAY_MS - tzOffsetMinutes * 60_000);
    const label = lastDay === firstDay ? formatDay(firstDay) : `${formatDay(firstDay)} to ${formatDay(lastDay)}`;
    found.set(label, { from, to, label });
  };

  // 1) "last week" = Monday to Sunday of the previous week.
  if (/\blast week\b/.test(lower)) add(mondayOf(today) - 7, 7);

  // 2) Weekday names: "on Monday", "last Tuesday".
  for (const match of lower.matchAll(/\b(last\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/g)) {
    const saidLast = Boolean(match[1]);
    const target = WEEKDAYS.indexOf(match[2]);
    let daysBack = (weekdayOf(today) - target + 7) % 7;
    if (daysBack === 0) daysBack = 7;
    const mostRecent = today - daysBack;
    add(mostRecent, 1);
    // "last Tuesday" can also mean the Tuesday of the week before. Include both.
    if (saidLast && mostRecent >= mondayOf(today)) add(mostRecent - 7, 1);
  }

  // 3) Everything else: "3 November", "yesterday", "3 days ago", "2026-11-03".
  const parsed = chrono.parse(text, { instant: now, timezone: tzOffsetMinutes }, { forwardDate: false });
  for (const result of parsed) {
    const start = result.start;
    if (!start.isCertain('day')) continue; // weekday-only and vague results were handled above
    if (/week/i.test(result.text)) continue;

    let year = start.get('year')!;
    const month = start.get('month')!;
    const day = start.get('day')!;
    // "20 December" said in November means last December.
    if (dayNumberOf(year, month, day) > today && !start.isCertain('year')) year--;
    add(dayNumberOf(year, month, day), 1);
  }

  return [...found.values()].sort((a, b) => a.from.getTime() - b.from.getTime()).slice(0, 4);
}
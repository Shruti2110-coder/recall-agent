import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { isRecallOnly } from '../src/lib/agent';
import { extractKeywords } from '../src/lib/memory';
import { formatLocal, resolveTimeRanges } from '../src/lib/time';

// A fixed "now": Wednesday 11 November 2026, 12:20 in India (UTC+5:30 = 330 minutes).
const NOW = new Date('2026-11-11T06:50:00.000Z');
const IST = 330;

// Shortcut: the labels of every range found in a sentence.
const labels = (text: string) => resolveTimeRanges(text, NOW, IST).map((range) => range.label);

describe('resolveTimeRanges', () => {
  test('an explicit date becomes that whole local day, stored in UTC', () => {
    const ranges = resolveTimeRanges('What did I ask on 3 November?', NOW, IST);
    assert.equal(ranges.length, 1);
    assert.equal(ranges[0].label, 'Tue 3 Nov 2026');
    // Local midnight in India is 18:30 UTC on the day before.
    assert.equal(ranges[0].from.toISOString(), '2026-11-02T18:30:00.000Z');
    assert.equal(ranges[0].to.toISOString(), '2026-11-03T18:30:00.000Z');
  });

  test('a plain weekday means the most recent one', () => {
    assert.deepEqual(labels('On Monday we shortlisted 5 CRM tools'), ['Mon 9 Nov 2026']);
  });

  test('"last Tuesday" on a Wednesday returns both candidate Tuesdays', () => {
    assert.deepEqual(labels('Last Tuesday I asked about Postgres hosting'), ['Tue 3 Nov 2026', 'Tue 10 Nov 2026']);
  });

  test('yesterday', () => {
    assert.deepEqual(labels('What did I ask you yesterday?'), ['Tue 10 Nov 2026']);
  });

  test('3 days ago', () => {
    assert.deepEqual(labels('What did we discuss 3 days ago?'), ['Sun 8 Nov 2026']);
  });

  test('last week is Monday to Sunday of the previous week', () => {
    const ranges = resolveTimeRanges('What did I ask last week?', NOW, IST);
    assert.deepEqual(
      ranges.map((range) => range.label),
      ['Mon 2 Nov 2026 to Sun 8 Nov 2026'],
    );
    assert.equal(ranges[0].from.toISOString(), '2026-11-01T18:30:00.000Z');
    assert.equal(ranges[0].to.toISOString(), '2026-11-08T18:30:00.000Z');
  });

  test('a date without a year never points to the future', () => {
    // Said in November 2026, "20 December" must mean December 2025.
    assert.deepEqual(labels('What did I ask on 20 December?'), ['Sat 20 Dec 2025']);
  });

  test('no ranges for messages without a past date', () => {
    assert.deepEqual(labels('What is the latest version of Node.js?'), []);
    assert.deepEqual(labels('hi'), []);
    assert.deepEqual(labels('Remind me tomorrow'), []); // the future is cut off
  });
});

describe('formatLocal', () => {
  test('shows the local weekday, date and time', () => {
    assert.equal(formatLocal(NOW, IST), 'Wed 11 Nov 2026, 12:20');
    assert.equal(formatLocal(NOW, 0), 'Wed 11 Nov 2026, 06:50');
  });
});

describe('extractKeywords', () => {
  test('keeps topic words and drops common and time words', () => {
    assert.deepEqual(
      extractKeywords('Last Tuesday I asked you about Postgres hosting. Has any pricing changed since then?'),
      ['postgres', 'hosting', 'pricing'],
    );
  });

  test('keeps names with dots and removes duplicates', () => {
    assert.deepEqual(extractKeywords('Node.js version? node.js release'), ['node.js', 'version', 'release']);
  });
});

describe('isRecallOnly', () => {
  test('true when the user only wants to be reminded', () => {
    assert.equal(isRecallOnly('What did I ask you yesterday?'), true);
    assert.equal(isRecallOnly('Remind me what we talked about on Monday'), true);
  });

  test('false when the user wants a fresh check', () => {
    assert.equal(isRecallOnly('What did I ask you on Monday? Has anything changed since?'), false);
    assert.equal(isRecallOnly('What did you tell me about Postgres? Is it still correct?'), false);
    assert.equal(isRecallOnly('What is the latest version of Node.js?'), false);
  });
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { extractAssignments, parseICSDate, splitTitle } from '../src/ics.js';

const SAMPLE = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'BEGIN:VEVENT',
  'DTSTART:20261125T155900Z',
  'DTEND:20261125T155900Z',
  'SUMMARY:Lab Report 3\\, Final [CPECOG2 - S1',
  ' 1]',
  'UID:event-assignment-123456',
  'URL;VALUE=URI:https://school.instructure.com/courses/1/assignments/123456',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'DTSTART;VALUE=DATE:20261126',
  'SUMMARY:Essay [ENGL101]',
  'UID:event-assignment-777',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'DTSTART:20261127T010000Z',
  'SUMMARY:Club meeting',
  'UID:event-calendar-event-99',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

test('extracts assignments only, with unfolded and unescaped titles', async () => {
  const items = await extractAssignments(SAMPLE, 'Asia/Manila');
  assert.equal(items.length, 2);
  assert.equal(items[0].title, 'Lab Report 3, Final');
  assert.equal(items[0].course, 'CPECOG2 - S11');
  assert.equal(items[0].due, Date.UTC(2026, 10, 25, 15, 59));
  assert.match(items[0].url, /^https:\/\//);
  assert.match(items[0].id, /^[0-9a-f]{16}$/);
  assert.equal(items[1].url, '');
});

test('date-only due dates mean 11:59 PM local time', () => {
  const t = parseICSDate({ value: '20261126', params: { VALUE: 'DATE' } }, 'Asia/Manila');
  assert.equal(t, Date.UTC(2026, 10, 26, 15, 59)); // 23:59 at UTC+8
});

test('TZID times are converted to UTC', () => {
  const t = parseICSDate({ value: '20260715T090000', params: { TZID: 'America/New_York' } }, 'Asia/Manila');
  assert.equal(t, Date.UTC(2026, 6, 15, 13, 0)); // EDT is UTC-4
});

test('titles without a course keep the whole summary', () => {
  assert.deepEqual(splitTitle('Quiz 1'), { title: 'Quiz 1', course: '' });
});

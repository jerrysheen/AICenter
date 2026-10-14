import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  clockLabel,
  dateKey,
  inclusiveWindowInstant,
  monthDayLabel,
  normalizeHour,
  zonedCalendarParts,
} from '../apps/web/public/shanghai-time.js';
import { newsTimeLabel } from '../apps/web/public/news-list.js';

const calendarSource = readFileSync(new URL('../apps/web/public/shanghai-time.js', import.meta.url), 'utf8')
  .match(/export function zonedCalendarParts[\s\S]*?\n\}/)[0];

test('Shanghai calendar day does not share a formatter with the clock', () => {
  assert.equal(normalizeHour('24'), 0);
  assert.equal(normalizeHour(8), 8);
  assert.doesNotMatch(calendarSource, /hour/);
  const midnight = Date.parse('2026-10-09T16:00:00.000Z');
  assert.equal(dateKey(midnight), '2026-10-10');
  assert.equal(clockLabel(midnight), '00:00');
  assert.equal(monthDayLabel(midnight), '10月10日');
  assert.equal(zonedCalendarParts(Date.parse('2026-10-09T00:00:00.000Z')).day, 9);
  assert.equal(monthDayLabel(inclusiveWindowInstant(midnight)), '10月9日');
  assert.equal(monthDayLabel(inclusiveWindowInstant(Date.parse('2026-10-10T16:00:00.000Z'))), '10月10日');
  assert.equal(monthDayLabel(inclusiveWindowInstant(Date.parse('2026-10-09T00:00:00.000Z'))), '10月9日');
  const row = newsTimeLabel(midnight, { now: Date.parse('2026-10-12T04:00:00.000Z') });
  assert.equal(row.text, '10月10日 00:00');
  const shanghaiMidnight = Date.parse('2026-10-13T16:00:00.000Z');
  assert.equal(dateKey(shanghaiMidnight), '2026-10-14');
  assert.equal(clockLabel(shanghaiMidnight), '00:00');
  assert.equal(zonedCalendarParts(shanghaiMidnight).weekday, 'Wed');
  const Original = Intl.DateTimeFormat;
  Intl.DateTimeFormat = class extends Original {
    formatToParts(date) {
      return new Original(this.resolvedOptions().locale, this.resolvedOptions()).formatToParts(new Date(date.getTime() - 86_400_000));
    }
  };
  try {
    assert.equal(dateKey(Date.parse('2026-10-14T03:00:00.000Z')), '2026-10-14');
    assert.equal(clockLabel(Date.parse('2026-10-13T16:00:00.000Z')), '00:00');
    assert.equal(monthDayLabel(Date.parse('2026-10-13T16:00:00.000Z')), '10月14日');
  } finally {
    Intl.DateTimeFormat = Original;
  }
});

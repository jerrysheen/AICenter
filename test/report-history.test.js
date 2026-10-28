import test from 'node:test';
import assert from 'node:assert/strict';
import { commitReportHistory, reportHistoryAction, reportListHash, reportModeHash, reportViewOwnsScroll, stackReportNode } from '../apps/web/public/report-history.js';

test('daily and discussion modes stay in the report hash', () => {
  assert.equal(reportModeHash('#report', 'daily'), '#report?mode=daily');
  assert.equal(reportModeHash('#report?hour=20', 'discussion'), '#report?mode=discussion');
  assert.equal(reportModeHash('#report/2026-10-28?hour=07', 'daily'), '#report/2026-10-28?mode=daily');
  assert.equal(reportModeHash('#feed', 'hourly'), '#report?mode=hourly');
});

test('report scroll stays with the hourly page once that hour has a saved position', () => {
  assert.equal(reportViewOwnsScroll('report', true), true);
  assert.equal(reportViewOwnsScroll('report', false), false);
  assert.equal(reportViewOwnsScroll('page', true), false);
});

test('hour or daily changes push, and the first node in that hour pushes too', () => {
  assert.equal(reportHistoryAction({ hour: null, date: '', node: '' }, { hour: 20, date: '', node: '' }), 'push');
  assert.equal(reportHistoryAction({ hour: 20, date: '', node: '' }, { hour: 21, date: '', node: '' }), 'push');
  assert.equal(reportHistoryAction({ hour: 20, date: '', node: '' }, { hour: null, date: '', node: '' }), 'push');
  assert.equal(reportHistoryAction({ hour: 20, date: '', node: '' }, { hour: 20, date: '2026-10-15', node: '' }), 'push');
  assert.equal(reportHistoryAction({ hour: 20, date: '', node: '' }, { hour: 20, date: '', node: 'node-1' }), 'push');
  assert.equal(reportHistoryAction({ hour: 20, date: '', node: 'node-1' }, { hour: 20, date: '', node: '' }), 'replace');
  assert.equal(reportHistoryAction({ hour: 20, date: '', node: 'node-1' }, { hour: 20, date: '', node: 'node-1' }), 'skip');
});

test('history is pushed for an hour and again for the first node in that hour', () => {
  const location = { pathname: '/app', search: '', hash: '#report' };
  const urls = [];
  const history = {
    state: null,
    pushState(state, _title, url) { this.state = state; urls.push(['push', url]); location.hash = String(url).slice(String(url).indexOf('#')); },
    replaceState(state, _title, url) { this.state = state; urls.push(['replace', url]); location.hash = String(url).slice(String(url).indexOf('#')); },
  };
  const previous = { hour: null, date: '', node: '' };
  const hourly = { hour: 20, date: '', node: '' };
  assert.equal(commitReportHistory({
    previous, next: hourly, hash: '#report?hour=20', location, history,
  }), 'push');
  assert.equal(commitReportHistory({
    previous: hourly, next: hourly, hash: '#report?hour=20', location, history,
  }), 'skip');
  assert.equal(commitReportHistory({
    previous: hourly, next: { hour: 20, date: '', node: 'node-1' }, hash: '#report?hour=20&node=node-1', location, history,
  }), 'push');
  assert.deepEqual(urls, [
    ['push', '/app#report?hour=20'],
    ['push', '/app#report?hour=20&node=node-1'],
  ]);
  assert.equal(history.state.aiCenterReportList, true);
  assert.equal(history.state.aiCenterPrevious, '#report?hour=20');
});

test('a direct detail link keeps the briefing list underneath', () => {
  assert.equal(reportListHash('#report?hour=20&node=node-1'), '#report?hour=20');
  assert.equal(reportListHash('#report/2026-10-20?node=node-1'), '#report/2026-10-20');
  const location = { pathname: '/', search: '', hash: '#report?hour=20&node=node-1' };
  const entries = [];
  const history = {
    state: { aiCenterPrevious: '#sources' },
    replaceState(state, _title, url) { this.state = state; entries.push(['replace', url, state]); location.hash = String(url).slice(String(url).indexOf('#')); },
    pushState(state, _title, url) { this.state = state; entries.push(['push', url, state]); location.hash = String(url).slice(String(url).indexOf('#')); },
  };
  assert.equal(stackReportNode({
    history, location, listHash: '#report?hour=20', detailHash: '#report?hour=20&node=node-1',
  }), 'stacked');
  assert.equal(stackReportNode({
    history, location, listHash: '#report?hour=20', detailHash: '#report?hour=20&node=node-1',
  }), 'skip');
  assert.equal(entries[0][2].aiCenterPrevious, '#sources');
  assert.equal(entries[1][2].aiCenterReportList, true);
  assert.equal(entries[1][2].aiCenterPrevious, '#report?hour=20');
  assert.equal(location.hash, '#report?hour=20&node=node-1');
});

test('leaving the briefing does not rewrite the detail history entry', () => {
  const location = { pathname: '/', search: '', hash: '#article/post-1' };
  let writes = 0;
  const history = { pushState() { writes += 1; }, replaceState() { writes += 1; } };
  assert.equal(commitReportHistory({
    previous: { hour: null, date: '', node: '' },
    next: { hour: 20, date: '', node: '' },
    hash: '#report?hour=20',
    location,
    history,
  }), 'skip');
  assert.equal(writes, 0);
});

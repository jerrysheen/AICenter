import test from 'node:test';
import assert from 'node:assert/strict';
import { commitReportHistory, reportHistoryAction, reportViewOwnsScroll } from '../apps/web/public/report-history.js';

test('report scroll stays with the hourly page once that hour has a saved position', () => {
  assert.equal(reportViewOwnsScroll('report', true), true);
  assert.equal(reportViewOwnsScroll('report', false), false);
  assert.equal(reportViewOwnsScroll('page', true), false);
});

test('hour or daily changes push, and the same hour only replaces the node', () => {
  assert.equal(reportHistoryAction({ hour: null, date: '', node: '' }, { hour: 20, date: '', node: '' }), 'push');
  assert.equal(reportHistoryAction({ hour: 20, date: '', node: '' }, { hour: 21, date: '', node: '' }), 'push');
  assert.equal(reportHistoryAction({ hour: 20, date: '', node: '' }, { hour: null, date: '', node: '' }), 'push');
  assert.equal(reportHistoryAction({ hour: 20, date: '', node: '' }, { hour: 20, date: '2026-10-15', node: '' }), 'push');
  assert.equal(reportHistoryAction({ hour: 20, date: '', node: '' }, { hour: 20, date: '', node: 'node-1' }), 'replace');
  assert.equal(reportHistoryAction({ hour: 20, date: '', node: 'node-1' }, { hour: 20, date: '', node: '' }), 'replace');
  assert.equal(reportHistoryAction({ hour: 20, date: '', node: 'node-1' }, { hour: 20, date: '', node: 'node-1' }), 'skip');
});

test('history is pushed once per hour and replaced for a node in that hour', () => {
  const location = { pathname: '/app', search: '', hash: '#report' };
  const urls = [];
  const history = {
    pushState(_state, _title, url) { urls.push(['push', url]); location.hash = String(url).slice(String(url).indexOf('#')); },
    replaceState(_state, _title, url) { urls.push(['replace', url]); location.hash = String(url).slice(String(url).indexOf('#')); },
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
  }), 'replace');
  assert.deepEqual(urls, [
    ['push', '/app#report?hour=20'],
    ['replace', '/app#report?hour=20&node=node-1'],
  ]);
});

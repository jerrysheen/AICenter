import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { briefVisibleAnchor } from '../apps/web/public/information-tree.js';

function row(id, top, bottom) {
  return {
    dataset: { nodeId: id },
    getBoundingClientRect: () => ({ top, bottom }),
  };
}

test('a brief row tucked under the sticky bar is not the scroll anchor', () => {
  const tucked = row('under', 20, 180);
  const visible = row('below', 70, 230);
  assert.equal(briefVisibleAnchor([tucked, visible], 0).anchorId, 'under');
  const saved = briefVisibleAnchor([tucked, visible], 58);
  assert.equal(saved.anchorId, 'below');
  assert.equal(saved.anchorOffset, 70);
  assert.deepEqual(briefVisibleAnchor([tucked], 58), { anchorId: '', anchorOffset: 0 });
  assert.equal(briefVisibleAnchor([row('clear', 58, 218)], 58).anchorId, 'clear');
});

test('the brief list keeps a skeleton until the rows exist', () => {
  const tree = readFileSync(new URL('../apps/web/public/information-tree.js', import.meta.url), 'utf8');
  const brief = readFileSync(new URL('../apps/web/public/brief-page.js', import.meta.url), 'utf8');
  assert.match(tree, /briefVisibleAnchor\(list\?\.querySelectorAll\?\.\('\[data-node-id\]'\)/);
  assert.match(tree, /stickyCoverBottom\(\)/);
  assert.match(tree, /preferSavedY/);
  assert.match(tree, /captureScroll\(\)\{rememberPosition\(\);\}/);
  assert.match(tree, /host\.active\(\)\) return/);
  assert.match(brief, /captureScroll\(\)\{tree\.captureScroll\?\.\(\);\}/);
  const app = readFileSync(new URL('../apps/web/public/app.js', import.meta.url), 'utf8');
  const boot = readFileSync(new URL('../apps/web/public/ui-boot.js', import.meta.url), 'utf8');
  const setView = app.slice(app.indexOf('function setView'), app.indexOf('function updateHeaderAction'));
  const captureAt = setView.indexOf('briefPage.captureScroll()');
  const swapAt = setView.indexOf('document.body.dataset.view = view');
  assert.ok(captureAt > 0 && captureAt < swapAt);
  assert.match(boot, /history\.scrollRestoration = 'manual'/);
  assert.equal(boot.includes("if (bootHash === '#feed') history.scrollRestoration"), false);
  assert.equal(tree.includes("list.textContent='读取中…'"), false);
  assert.match(tree, /paintListSkeleton\(list,\{rows:6,label:'正在读取简报…',variant:'feed'\}/);
  assert.match(tree, /if\(dailyFeed && !openedId && !openedDirection\) ensureSouthboundSlot\(skeleton \|\| list\)/);
  const dailyFeed = tree.slice(tree.indexOf('async function renderDailyFeed'), tree.indexOf('function directSouthbound'));
  const showAt = dailyFeed.indexOf('showPosition(`daily-feed:');
  assert.ok(dailyFeed.indexOf('ensureSouthboundSlot(list)') >= 0 && dailyFeed.indexOf('ensureSouthboundSlot(list)') < showAt);
  assert.match(tree, /current\.textContent = data\.line/);
  assert.match(tree, /box\.classList\.add\('is-page'\)/);
  assert.match(tree, /if\(mode==='hourly'\)list\.append\(hourSkeleton\(\)\)/);
  assert.match(brief, /tree-hour-skeleton is-page/);
  assert.match(brief, /hourChromeSkeleton\(\), layout\)/);
  const html = readFileSync(new URL('../apps/web/public/index.html', import.meta.url), 'utf8');
  assert.match(html, /\[\?&\]hour=\\d/);
  assert.match(html, /tree-hour-skeleton is-page/);
  assert.match(tree, /el\('p','\\u00a0','news-day-label'\)/);
  assert.match(tree, /reading-direction news-section-title/);
  assert.match(brief, /readingSkeleton\(root\)/);
  assert.equal(brief.includes('正在读取简报…'), true);
  assert.equal(brief.includes("node('p','brief-empty','正在读取简报…')"), false);
});

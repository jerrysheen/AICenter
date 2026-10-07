import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { emptyTokenUsage } from '../packages/contracts/src/model-usage.js';
if (!process.env.UIUX_RUNTIME_PACKAGE || !process.env.UIUX_BROWSER) throw Error('Set UIUX_RUNTIME_PACKAGE and UIUX_BROWSER to the Host runtime and browser.');
const require = createRequire(process.env.UIUX_RUNTIME_PACKAGE), { chromium } = require('playwright');
const server = createServer(async (request, response) => {
  if (request.url === '/model-usage.js') {
    response.writeHead(200, { 'Content-Type': 'text/javascript' });
    response.end(await readFile(new URL('../apps/web/public/model-usage.js', import.meta.url))); return;
  }
  if (request.url === '/styles.css') {
    response.writeHead(200, { 'Content-Type': 'text/css' });
    response.end(await readFile(new URL('../apps/web/public/styles.css', import.meta.url))); return;
  }
  response.writeHead(200, { 'Content-Type': 'text/html' }); response.end('<link rel="stylesheet" href="/styles.css"><body></body>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const browser = await chromium.launch({ headless: true, executablePath: process.env.UIUX_BROWSER });
try {
  for (const width of [375, 768, 1440]) {
    const page = await browser.newPage({ viewport: { width, height: 900 } });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.evaluate(async usage => {
      const { openModelUsageDialog } = await import('/model-usage.js');
      window.usageUrls = [];
      openModelUsageDialog({ api: async url => {
        window.usageUrls.push(url);
        return { records: [{ kind: 'request', id: 'id', stage: '<script>bad()</script>', status: 'failed', completeness: 'missing',
          occurredAt: 1, jobId: 'a'.repeat(128), jobAttempt: 1, applicationSessionId: '', executionId: 'b'.repeat(128), turn: 1, step: 1, attempt: 1,
          usage, estimate: null, supplierAmount: null }] };
      } });
    }, emptyTokenUsage());
    await page.locator('summary').click();
    assert.match(await page.locator('.model-usage-detail').textContent(), /供应商金额：未知/);
    assert.match(await page.locator('summary').textContent(), /统计不完整/);
    assert.equal(await page.locator('script').count(), 0);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.ok(await page.locator('dialog').evaluate(node => node.scrollWidth <= node.clientWidth + 1));
    await page.getByRole('textbox', { name: '任务 ID' }).fill('fixture-job');
    await page.getByRole('button', { name: '查询', exact: true }).click();
    assert.match(await page.evaluate(() => window.usageUrls.at(-1)), /jobId=fixture-job/);
    await page.getByRole('button', { name: '关闭' }).click(); await page.locator('dialog').waitFor({ state: 'detached' });
    await page.close();
  }
  console.log('Model usage UI verified at 375/768/1440px: unknowns, safe text, query and dialog closure.');
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }

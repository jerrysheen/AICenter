import { filterAnomalousGpuPrices, GPU_PRICE_FLOORS, gpuPriceFamily } from './compute-prices.js';

export const CCIR_RATES_URL = 'https://ccir.io/rates';
export const CCIR_PARSER_VERSION = 'ccir-rates-1';
export const BARGO_PRICES_URL = 'https://www.bargo.ai/gpu-prices';
export const BARGO_PARSER_VERSION = 'bargo-averages-1';
export const GPUECONOMY_PARSER_VERSION = 'gpueconomy-median-1';
export const GPUECONOMY_GPU_URLS = Object.freeze([
  'https://gpueconomy.com/gpu/h100-sxm',
  'https://gpueconomy.com/gpu/h100-pcie',
  'https://gpueconomy.com/gpu/h100-nvl',
  'https://gpueconomy.com/gpu/h200',
  'https://gpueconomy.com/gpu/h200-nvl',
  'https://gpueconomy.com/gpu/b200',
  'https://gpueconomy.com/gpu/b300',
  'https://gpueconomy.com/gpu/a100-80',
  'https://gpueconomy.com/gpu/a100-40',
]);

const USER_AGENT = 'AICenter/0.2 (GPU price snapshot; attribution)';
const GPU_LABELS = Object.freeze({
  'h100-sxm': 'H100 SXM',
  'h100-pcie': 'H100 PCIe',
  'h100-nvl': 'H100 NVL',
  h200: 'H200',
  'h200-nvl': 'H200 NVL',
  b200: 'B200',
  b300: 'B300',
  'a100-80': 'A100 80GB',
  'a100-40': 'A100 40GB',
  h100: 'H100',
  a100: 'A100',
});
const CCIR_TIERS = Object.freeze([
  ['hyperscaler', /hyperscaler/i],
  ['neocloud', /neocloud/i],
  ['marketplace', /marketplace/i],
]);

function stripTags(value) {
  return String(value || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tableRows(tableHtml) {
  return [...String(tableHtml).matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map((match) => (
    [...match[1].matchAll(/<t[dh]\b([^>]*)>([\s\S]*?)<\/t[dh]>/gi)].map((cell) => ({
      attrs: cell[1] || '',
      text: stripTags(cell[2]),
    }))
  ));
}

function positiveCount(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function money(value) {
  const text = String(value || '').trim();
  return /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text) ? text : null;
}

function slugFromUrl(url) {
  try {
    const path = new URL(url).pathname.replace(/\/+$/, '');
    return path.split('/').pop() || '';
  } catch {
    return '';
  }
}

function isoDate(value) {
  const match = String(value || '').match(/(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : null;
}

function finishRows(entries) {
  const pending = [];
  const filtered = [];
  for (const entry of entries) {
    const usdPerHour = money(entry.usdPerHour);
    if (!usdPerHour || usdPerHour === '0') {
      if (usdPerHour === '0') filtered.push({ label: entry.label, lane: entry.lane, usdPerHour, reason: '价格为 0' });
      continue;
    }
    const family = entry.family || gpuPriceFamily(entry.label);
    if (!family || !GPU_PRICE_FLOORS[family]) continue;
    pending.push({ ...entry, usdPerHour, family, floor: GPU_PRICE_FLOORS[family] });
  }
  const priced = filterAnomalousGpuPrices(pending);
  return {
    rows: priced.kept.map((row, sortIndex) => ({
      sortIndex,
      gpuKey: row.gpuKey,
      label: row.label,
      lane: row.lane,
      usdPerHour: row.usdPerHour,
      sampleCount: positiveCount(row.sampleCount),
    })),
    filtered: [...filtered, ...priced.filtered],
  };
}

function emptyCell(cell) {
  if (/\bempty\b/i.test(cell.attrs)) return true;
  return !cell.text.replace(/[—–\-]/g, '').trim();
}

export function selectCcirGpuRates(html) {
  const warnings = [];
  const source = String(html || '');
  const quoteDate = isoDate((source.match(/AS OF\s+(\d{4}-\d{2}-\d{2})/i) || source.match(/(\d{4}-\d{2}-\d{2})\s+print/i) || [])[1]);
  const sections = [...source.matchAll(/On-demand,\s*(guaranteed|interruptible)\b([\s\S]*?)(?=On-demand,\s*(?:guaranteed|interruptible)\b|$)/gi)];
  const entries = [];
  for (const section of sections) {
    const grade = section[1].toLowerCase() === 'interruptible' ? 'interruptible' : 'guaranteed';
    const table = section[2].match(/<table\b[\s\S]*?<\/table>/i)?.[0];
    if (!table) continue;
    const rows = tableRows(table);
    const header = rows.find((row) => row.some((cell) => /hyperscaler|neocloud|marketplace/i.test(cell.text)));
    if (!header) continue;
    const tiers = header.map((cell) => CCIR_TIERS.find((item) => item[1].test(cell.text))?.[0] || null);
    for (const row of rows) {
      if (row === header || row.length < 2) continue;
      const label = row[0].text.replace(/\s+/g, ' ').trim();
      const family = gpuPriceFamily(label);
      if (!family) continue;
      const gpuKey = family;
      row.slice(1).forEach((cell, index) => {
        const tier = tiers[index + 1];
        if (!tier || emptyCell(cell)) return;
        const usdPerHour = money(cell.text.replace(/[$,]/g, ''));
        if (!usdPerHour) return;
        const sampleCount = positiveCount((cell.attrs.match(/n=(\d+)/i) || [])[1]);
        entries.push({ gpuKey, label, lane: `${tier}-${grade}`, usdPerHour, sampleCount, family });
      });
    }
  }
  const priced = finishRows(entries);
  if (!priced.rows.length) warnings.push('CCIR 阶梯表里没有可保存的 H100、H200、B200、B300 或 A100 小时价');
  return { ...priced, warnings, quoteDate };
}

function comparisonEntries(html) {
  const entries = [];
  for (const table of String(html).matchAll(/<table\b[\s\S]*?<\/table>/gi)) {
    const rows = tableRows(table[0]);
    const median = rows.find((row) => /median rate card/i.test(row[0]?.text || ''));
    if (!median) continue;
    const providers = rows.find((row) => /providers listing it/i.test(row[0]?.text || ''));
    median.slice(1).forEach((cell, index) => {
      const label = (cell.attrs.match(/data-label="([^"]+)"/i)?.[1] || cell.text || '').replace(/^NVIDIA\s+/i, '').trim();
      const family = gpuPriceFamily(label);
      const gpuKey = Object.entries(GPU_LABELS).find((item) => item[1].toLowerCase() === label.toLowerCase())?.[0];
      const usdPerHour = money(cell.text.replace(/[$,]/g, ''));
      if (!family || !gpuKey || !usdPerHour) return;
      const providerCell = providers?.[index + 1];
      entries.push({
        gpuKey,
        label,
        lane: 'median',
        usdPerHour,
        sampleCount: positiveCount(providerCell?.text),
        family,
      });
    });
  }
  return entries;
}

export function selectGpuEconomyRates(html, pageUrl = '') {
  const source = String(html || '');
  const slug = slugFromUrl(pageUrl);
  const sentence = source.match(/Across\s+(\d+)\s+providers,[\s\S]{0,500}?\$([0-9]+(?:\.[0-9]+)?)\s+per GPU-hour/);
  const entries = [];
  if (sentence && GPU_LABELS[slug]) {
    entries.push({
      gpuKey: slug,
      label: GPU_LABELS[slug],
      lane: 'median',
      usdPerHour: sentence[2],
      sampleCount: positiveCount(sentence[1]),
      family: gpuPriceFamily(GPU_LABELS[slug]),
    });
  } else {
    entries.push(...comparisonEntries(source));
  }
  const priced = finishRows(entries);
  const warnings = priced.rows.length ? [] : ['GPU Economy 页面没有可保存的多供应商中位价'];
  return { ...priced, warnings, quoteDate: isoDate(source.match(/datetime="(\d{4}-\d{2}-\d{2})/)?.[1]) };
}

export function selectBargoGpuRates(html) {
  const source = String(html || '');
  const quoteDate = isoDate(source.match(/updated\s*<b>\s*(\d{4}-\d{2}-\d{2})\s*<\/b>/i)?.[1]);
  const entries = [];
  for (const chunk of source.split(/<a href="\/gpu\//i).slice(1)) {
    const head = chunk.match(/^([a-z0-9-]+)">(.*?)<\/a>/i);
    if (!head) continue;
    const label = stripTags(head[2]).replace(/→/g, '').trim();
    const family = gpuPriceFamily(label) || gpuPriceFamily(head[1]);
    if (!family || !GPU_LABELS[head[1]]) continue;
    const sampleCount = positiveCount((chunk.match(/(\d+)\s+providers/i) || [])[1]);
    for (const price of chunk.matchAll(/\$([0-9]+(?:\.[0-9]+)?)(?:<\/div>)?\s*<span[^>]*>\s*(on-demand|spot|reserved)\s*\/hr/gi)) {
      const lane = price[2].toLowerCase() === 'on-demand' ? 'ondemand' : price[2].toLowerCase();
      entries.push({
        gpuKey: head[1],
        label: GPU_LABELS[head[1]],
        lane,
        usdPerHour: price[1],
        sampleCount,
        family,
      });
    }
  }
  const priced = finishRows(entries);
  const warnings = priced.rows.length ? [] : ['Bargo 页面没有可保存的 H100、H200、B200、B300 或 A100 均价'];
  return { ...priced, warnings, quoteDate };
}

async function readText(fetchImpl, url) {
  const response = await fetchImpl(url, {
    headers: { accept: 'text/html,application/xhtml+xml', 'user-agent': USER_AGENT },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    const host = new URL(url).host;
    throw new Error(`${host} ${response.status}`);
  }
  const html = await response.text();
  if (/Just a moment|cf-challenge|challenge-platform\/scripts/i.test(html) && !/<table|\/gpu\/h100|Across\s+\d+\s+providers/i.test(html)) {
    throw new Error(`${new URL(url).host} 返回了拦截页`);
  }
  return html;
}

export async function fetchCcirGpuRates({ fetch: fetchImpl = fetch } = {}) {
  return selectCcirGpuRates(await readText(fetchImpl, CCIR_RATES_URL));
}

export async function fetchBargoGpuRates({ fetch: fetchImpl = fetch } = {}) {
  return selectBargoGpuRates(await readText(fetchImpl, BARGO_PRICES_URL));
}

async function mapLimited(items, limit, visit) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await visit(items[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}

export async function fetchGpuEconomyRates({ fetch: fetchImpl = fetch, urls = GPUECONOMY_GPU_URLS } = {}) {
  const warnings = [];
  const entries = [];
  const filtered = [];
  const dates = [];
  const results = await mapLimited(urls, 3, async (url) => {
    try {
      return { url, html: await readText(fetchImpl, url) };
    } catch (error) {
      return { url, error };
    }
  });
  for (const result of results) {
    if (result.error) {
      warnings.push(`${result.url} ${result.error.message || result.error}`);
      continue;
    }
    const parsed = selectGpuEconomyRates(result.html, result.url);
    if (parsed.quoteDate) dates.push(parsed.quoteDate);
    filtered.push(...parsed.filtered);
    if (!parsed.rows.length) warnings.push(`${result.url} 没有中位价`);
    entries.push(...parsed.rows.map((row) => ({ ...row, family: gpuPriceFamily(row.label) })));
  }
  const priced = finishRows(entries);
  const uniqueDates = [...new Set(dates)].sort();
  if (uniqueDates.length > 1) warnings.push(`GPU Economy 报价日不一致：${uniqueDates.join('、')}`);
  if (!priced.rows.length) warnings.push('GPU Economy 没有可保存的中位价');
  if (!priced.rows.length && results.some((item) => item.error)) throw results.find((item) => item.error).error;
  return {
    rows: priced.rows,
    filtered: [...filtered, ...priced.filtered],
    warnings: warnings.map((item) => item.slice(0, 300)).slice(0, 20),
    quoteDate: uniqueDates.at(-1) || null,
  };
}

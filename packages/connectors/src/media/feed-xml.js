import { XMLParser } from 'fast-xml-parser';
import { MediaConfigSchema } from '../../../contracts/src/media.js';
import { normalizeArticleUrl, originLinksFromHtml, stableArticleId } from './article-url.js';
import { parseFeedDate } from './dates.js';

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  processEntities: false,
  htmlEntities: false,
  trimValues: true,
  parseTagValue: false,
  parseAttributeValue: false,
  allowBooleanAttributes: true,
  isArray: (name) => name === 'item' || name === 'entry' || name === 'link',
});
const MEDIA_BUDGET = MediaConfigSchema.parse({ version: 1, sources: [] }).budget;

function textOf(value) {
  if (value == null) return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return textOf(value[0]);
  if (typeof value === 'object') {
    if (value['#text'] != null) return textOf(value['#text']);
    if (value['@_href'] && !value['#text']) return '';
  }
  return '';
}

function decodeXmlText(value) {
  return textOf(value)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .trim();
}

function nodeCount(value) {
  const matches = String(value || '').match(/<[A-Za-z!?/]/g);
  return matches ? matches.length : 0;
}

function linkFrom(node) {
  const links = Array.isArray(node?.link) ? node.link : (node?.link ? [node.link] : []);
  const alternate = links.find((link) => String(link?.['@_rel'] || 'alternate') === 'alternate' && link?.['@_href']);
  const href = alternate?.['@_href'] || links.find((link) => link?.['@_href'])?.['@_href'] || '';
  return href || decodeXmlText(node?.link);
}

function asArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function hrefsFromNode(value, found = []) {
  if (!value || typeof value !== 'object') return found;
  if (typeof value['@_href'] === 'string') found.push(value['@_href']);
  for (const child of Object.values(value)) {
    if (Array.isArray(child)) child.forEach((item) => hrefsFromNode(item, found));
    else hrefsFromNode(child, found);
  }
  return found;
}

export function parseFeedXml(xml, source) {
  const raw = String(xml || '');
  const bytes = Buffer.byteLength(raw);
  if (bytes > MEDIA_BUDGET.maxFeedBytes) {
    return { ok: false, health: 'oversized', items: [], bytes, note: '订阅响应超过字节上限' };
  }
  if (nodeCount(raw) > MEDIA_BUDGET.maxFeedNodes) {
    return { ok: false, health: 'oversized', items: [], bytes, note: '订阅节点超过上限' };
  }
  if (/^\s*(?:<!doctype\s+html|<html[\s>])/i.test(raw)) {
    return { ok: false, health: 'not_a_feed', items: [], bytes, note: '响应是 HTML，不是 RSS 或 Atom' };
  }
  if (/<!DOCTYPE|<!ENTITY/i.test(raw)) {
    return { ok: false, health: 'rejected_dtd', items: [], bytes, note: '拒绝带 DTD 或外部实体的 XML' };
  }
  let document;
  try {
    document = parser.parse(raw);
  } catch (error) {
    return {
      ok: false,
      health: 'parse_failed',
      items: [],
      bytes,
      note: error instanceof Error ? error.message : 'RSS 解析失败',
    };
  }
  const rssItems = asArray(document?.rss?.channel?.item);
  const atomEntries = asArray(document?.feed?.entry);
  const nodes = rssItems.length ? rssItems : atomEntries;
  const format = rssItems.length ? 'rss' : (atomEntries.length || document?.feed ? 'atom' : '');
  if (!document?.rss && !document?.feed) {
    return { ok: false, health: 'parse_failed', items: [], bytes, note: '没有 rss/channel/item 或 Atom feed/entry' };
  }
  const items = nodes.map((node, listPosition) => {
    const rawLink = linkFrom(node);
    let link = rawLink;
    try {
      link = normalizeArticleUrl(rawLink, {
        trackingParams: source.trackingParams,
        identityParams: source.identityParams,
      }).toString();
    } catch {
      link = rawLink;
    }
    const guid = decodeXmlText(node.guid || node.id);
    const title = decodeXmlText(node.title).slice(0, 1000);
    const summarySource = node.description ?? node.summary ?? '';
    const summary = decodeXmlText(summarySource).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 2000);
    const when = parseFeedDate(textOf(node.pubDate || node.published || node.updated));
    const externalId = stableArticleId(source.sourceKey, {
      guid,
      link,
      trackingParams: source.trackingParams,
      identityParams: source.identityParams,
    });
    const originHtml = [
      typeof summarySource === 'string' ? summarySource : '',
      ...hrefsFromNode(summarySource).map((href) => `<a href="${href}">link</a>`),
    ].join(' ');
    const origins = source.sourceKey === 'techmeme'
      ? originLinksFromHtml(originHtml, { publisherHosts: source.allowedHosts })
      : [];
    return {
      externalId,
      listPosition,
      title,
      summary,
      feedBodyHtml: decodeXmlText(node['content:encoded'] ?? node.content ?? '').length <= 200_000 ? decodeXmlText(node['content:encoded'] ?? node.content ?? '') : '',
      sourceUrl: link,
      guid,
      authorName: decodeXmlText(node['dc:creator'] || node.author?.name || node.author || '').slice(0, 512),
      publishedAt: when.publishedAt,
      publishedAtRaw: when.publishedAtRaw,
      originUrl: origins[0] || '',
      discoveredVia: source.sourceKey === 'techmeme' ? { sourceKey: source.sourceKey, url: link } : null,
    };
  }).filter((item) => item.externalId && item.sourceUrl);
  return {
    ok: true,
    health: items.length ? 'ready' : 'empty',
    format,
    items,
    bytes,
    note: items.length ? '' : '订阅没有有效条目',
  };
}

import { parseDocument, DomUtils } from 'htmlparser2';

export const EXTRACTOR_VERSION = 'media-dom-2';
const WALL = /subscribe to read|sign in to continue|for subscribers only|this article is available to|付费阅读|会员专享/i;
const CHROME = /(?:^|[-_\s])(related|recommended|comments?|share|social|newsletter|advertisement|subscribe|subscription|font-size|fontsize|sidebar|promo)(?:$|[-_\s])/i;
const DROP = new Set(['script', 'style', 'nav', 'footer', 'aside', 'form', 'button', 'noscript', 'svg', 'iframe']);
const BODY_HINT = /article[-_]?body|article[-_]?content|entry[-_]?content|post[-_]?content|news[-_]?body|rich[-_]?text|wysiwyg|body-copy|story-body|bodytext|content-wrapper/i;
const all = (node, predicate) => DomUtils.findAll(predicate, node.children || []);
function excluded(node) {
  return DROP.has(node.name) || CHROME.test(`${node.attribs?.class || ''} ${node.attribs?.id || ''}`) || /NewsletterSignup|Callout|Advert/i.test(node.attribs?.['data-spacefinder-type'] || '') || /auto_featured_content|articleFooter|not-prose|RelatedTopics|RelatedContent/i.test(node.attribs?.class || '') || node.attribs?.hidden != null || /display\s*:\s*none/.test(node.attribs?.style || '');
}
function inline(node) {
  if (node.type === 'text') return node.data || '';
  if (excluded(node)) return '';
  if (node.name === 'a' && /^(?:Return to text|Accessible Version)$/i.test(DomUtils.textContent(node).trim())) return '';
  if (node.name === 'br') return '\n';
  return (node.children || []).map(inline).join('');
}
const clean = text => text.replace(/[\t \r]+/g, ' ').replace(/ *\n */g, '\n').trim();
function blocks(node, result = []) {
  if (excluded(node)) return result;
  if (node.name === 'table') {
    const rows = all(node, n => n.name === 'tr').map(r => (r.children || []).filter(c => ['td','th'].includes(c.name)).map(c => clean(inline(c))).join(' | '));
    if (rows.length) result.push({ kind: 'table', text: rows.join('\n') });
  } else if (['p','li','blockquote','h1','h2','h3','h4','h5','h6'].includes(node.name)) {
    const text = clean(inline(node));
    if (text) result.push({ kind: /^h\d$/.test(node.name) ? 'heading' : node.name === 'li' ? 'list' : node.name === 'blockquote' ? 'quote' : 'paragraph', text });
  } else for (const child of node.children || []) blocks(child, result);
  return result;
}
function ldNodes(dom) {
  const found = [];
  for (const node of all(dom, n => n.name === 'script' && /application\/ld\+json/i.test(n.attribs?.type || ''))) {
    try {
      const walk = value => {
        if (Array.isArray(value)) value.forEach(walk);
        else if (value && typeof value === 'object') { if (/Article|Report/i.test(String(value['@type'] || ''))) found.push(value); if (value['@graph']) walk(value['@graph']); }
      };
      walk(JSON.parse(DomUtils.textContent(node)));
    } catch { /* Malformed metadata is not evidence. */ }
  }
  return found;
}
export function jsonLdArticle(html) {
  const a = ldNodes(parseDocument(String(html || ''))).sort((a,b) => String(b.articleBody || '').length - String(a.articleBody || '').length)[0];
  return a ? { canonical: String(a.url || a.mainEntityOfPage?.['@id'] || ''), author: typeof a.author === 'string' ? a.author : Array.isArray(a.author) ? a.author.map(x => x.name || '').join(', ') : a.author?.name || '', publishedAtRaw: String(a.datePublished || ''), updatedAtRaw: String(a.dateModified || ''), body: String(a.articleBody || '') } : null;
}
export function clipUtf8(text, maxBytes) {
  const buffer = Buffer.from(text);
  if (buffer.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (buffer[end] & 0xc0) === 0x80) end -= 1;
  return buffer.subarray(0, end).toString('utf8');
}
export function extractArticleText(html, { status = 200, title = '', summary = '', sourceKey = '', publisherKey = sourceKey, maxBytes = 100_000, fragment = false } = {}) {
  const dom = parseDocument(String(html || ''));
  const ld = jsonLdArticle(html);
  const pageTitle = DomUtils.textContent(all(dom, n => n.name === 'title')[0] || dom).slice(0,300);
  const visible = clean(inline(dom));
  const failed = reason => ({ ok: false, contentLevel: 'summary_only', reason, text: '', paragraphs: [], truncated: false, extractorVersion: EXTRACTOR_VERSION, extractionMethod: '', visualEvidenceRequired: false });
  const bbc = publisherKey === 'bbc' || ['bbc','bbcworld'].includes(sourceKey);
  const guardian = publisherKey === 'guardian';
  const canonicalUrl = all(dom,n=>n.name==='link' && n.attribs?.rel==='canonical')[0]?.attribs?.href || ld?.canonical || '';
  if (bbc && /^(?:Watch|Listen|Video):/i.test(title || pageTitle)) return failed('non_article');
  if ((bbc || guardian) && /\/(?:video|av)\//.test(canonicalUrl)) return failed('non_article');
  if (guardian && /\/live\//.test(canonicalUrl)) return failed('live_template_unverified');
  if (bbc && (ldNodes(dom).some(a => /LiveBlogPosting/i.test(String(a['@type'] || ''))) || all(dom,n=>n.name==='link' && n.attribs?.rel==='canonical' && /\/news\/live\//.test(n.attribs?.href || '')).length)) return failed('live_template_unverified');
  if ([401,402,403].includes(status)) return failed(status === 402 ? 'paywall' : 'blocked');
  const challengeContainer = all(dom, n => n.name === 'form' && /challenge|captcha|verification/i.test(`${n.attribs?.id || ''} ${n.attribs?.action || ''}`)).length;
  const titleNode = all(dom, n => n.name === 'title')[0];
  const challengeTitle = titleNode && /just a moment|access denied|verify (?:you are|your)|security check/i.test(pageTitle);
  if (challengeTitle || (challengeContainer && visible.length < 1000) || (visible.length < 500 && /enable javascript and cookies|verify you are human/i.test(visible))) return failed('blocked');
  const paywallFlag = ldNodes(dom).some(a => [false,'False','false'].includes(a.isAccessibleForFree));
  const wallContainers = all(dom,n => /paywall|premium-content|subscription-wall/i.test(`${n.attribs?.class || ''} ${n.attribs?.id || ''}`));
  if (paywallFlag || WALL.test(visible) || wallContainers.length) return failed('paywall');
  const candidates = [];
  let nodes = all(dom, n => n.type === 'tag' && (['article','main'].includes(n.name) || BODY_HINT.test(`${n.attribs?.class || ''} ${n.attribs?.id || ''}`) || n.attribs?.itemprop === 'articleBody'));
  const siteNodes = nodes.filter(n => sourceKey === 'dcd' ? n.attribs?.itemprop === 'articleBody' : sourceKey === 'nextplatform' ? /\bbodytext\b/.test(n.attribs?.class || '') : sourceKey === 'decoder' ? /\bcontent-wrapper\b/.test(n.attribs?.class || '') : false);
  if (siteNodes.length) nodes = siteNodes;
  if (sourceKey === 'fed') {
    const article = all(dom,n => n.attribs?.id === 'article')[0];
    const body = article && all(article,n => /^col-xs-12 col-sm-8 col-md-8$/.test(n.attribs?.class || ''))[0];
    if (body) nodes = [{ ...body, attribs: { ...body.attribs, itemprop: 'articleBody' } }];
  }
  if (sourceKey === 'microsoftai') {
    const main = all(dom,n=>n.name==='main' && n.attribs?.id==='main-content')[0];
    const sections = main ? all(main,n=>/\bwysiwyg\b/.test(n.attribs?.class || '')) : [];
    if (sections.length) nodes=[{name:'article',attribs:{itemprop:'articleBody'},children:sections}];
  }
  if (sourceKey === 'govcn' || sourceKey === 'govnews') {
    // Policy pages repeat the same body for desktop/mobile. Keep one editor body,
    // excluding the document metadata, print/share controls and footer.
    const editors = all(dom, n => /\btrs_editor_view\b/.test(n.attribs?.class || ''));
    const content = editors[0] || all(dom, n => n.attribs?.id === 'UCAP-CONTENT')[0];
    if (content) nodes = [{ ...content, attribs: { ...content.attribs, itemprop: 'articleBody' } }];
  }
  if (sourceKey === 'pboc') {
    const content = all(dom, n => n.attribs?.id === 'zoom')[0];
    if (content) nodes = [{ ...content, attribs: { ...content.attribs, itemprop: 'articleBody' } }];
  }
  if (sourceKey === 'whitehouse') {
    const content = all(dom, n => /\bwp-block-post-content\b/.test(n.attribs?.class || ''))[0];
    if (content) nodes = [{ ...content, attribs: { ...content.attribs, itemprop: 'articleBody' } }];
  }
  if (sourceKey === 'cryptography') {
    const bodies=all(dom,n=>/\bentry-content\b/.test(n.attribs?.class || ''));
    if (bodies.length) nodes=bodies.map(n=>({...n,children:(n.children || []).filter(c=>!/sharedaddy|jp-relatedposts/.test(`${c.attribs?.class || ''} ${c.attribs?.id || ''}`))}));
  }
  if (bbc) {
    const article = all(dom,n => n.name === 'article')[0];
    const textBlocks = article ? all(article,n => n.name === 'p' && /Paragraph/.test(n.attribs?.class || '') && !/Follow BBC|Send your story|BBC Sounds|Tell us which stories|Sign up for.*newsletter|Sign up here|newsletter to follow/i.test(inline(n))) : [];
    if (textBlocks.length) nodes = [{ name: 'article', children: textBlocks, attribs: { itemprop: 'articleBody' } }];
  }
  if (guardian && !fragment) {
    const body = all(dom,n=>/\barticle-body-commercial-selector\b/.test(n.attribs?.class || ''))[0];
    if (!body) return failed('unsupported_template');
    nodes = [{ ...body, attribs: { ...body.attribs, itemprop: 'articleBody' } }];
  }
  if (publisherKey === 'eia' && !fragment) {
    const body = all(dom,n=>/\btie-article\b/.test(n.attribs?.class || ''))[0];
    if (!body) return failed('unsupported_template');
    // Preserve the article, data-source captions, charts and lists; exclude topic navigation.
    nodes = [{ ...body, attribs: { itemprop: 'articleBody' }, children: (body.children || []).filter(n=>!/do-not-print/.test(n.attribs?.class || '')).map(n=>/\bsource\b/.test(n.attribs?.class || '') ? { ...n, name:'p' } : n) }];
  }
  if (publisherKey === 'thelec' && !fragment) {
    const body = all(dom,n=>n.attribs?.id==='article-view-content-div')[0];
    if (!body) return failed('unsupported_template');
    nodes = [{ ...body, attribs: { ...body.attribs, itemprop: 'articleBody' } }];
  }
  if (fragment) nodes.unshift(dom);
  for (const node of nodes) {
    let paragraphs = blocks(node);
    if (!paragraphs.length) { const text = clean(inline(node)); if (text) paragraphs = [{ kind: 'paragraph', text }]; }
    const text = paragraphs.map(p => p.text).join('\n\n');
    const links = all(node, n => n.name === 'a').reduce((sum,n) => sum + inline(n).length, 0);
    const density = text.length ? links / text.length : 1;
    const specific = BODY_HINT.test(`${node.attribs?.class || ''} ${node.attribs?.id || ''}`) || node.attribs?.itemprop === 'articleBody';
    candidates.push({ text, paragraphs, density, specific, method: fragment ? 'rss-content' : specific ? `site:${sourceKey || 'generic'}` : node.name, score: text.length * (1 - Math.min(0.95,density)) + (specific ? 200 : 0) });
  }
  if (ld?.body && !(guardian && !fragment)) {
    const text = clean(ld.body);
    const paragraphs = text.split(/\n\s*\n/).filter(Boolean).map(text => ({ kind: 'paragraph', text }));
    candidates.push({ text, paragraphs, density: 0, specific: true, method: 'json-ld', score: text.length });
  }
  const chosen = candidates.sort((a,b) => b.score - a.score)[0];
  if (!chosen?.text) return failed('unsupported_template');
  const prose = chosen.paragraphs.filter(p => p.kind === 'paragraph' || p.kind === 'quote');
  const summaryMatch = summary && chosen.text.replace(/\s+/g,' ').trim() === summary.replace(/\s+/g,' ').trim();
  const teaser = /(?:only a summary|read (?:the full|more)|continue reading|\.\.\.\s*$|…\s*$)/i.test(chosen.text);
  const boundaryEvidence = chosen.specific && prose.length >= 2 && chosen.text.length >= 300 || (chosen.method === 'json-ld' && chosen.text.length >= 300 && /[.!?。]$/.test(chosen.text)) || (!sourceKey && chosen.text.length >= 300 && /[.!?。]$/.test(chosen.text));
  let level = summaryMatch || teaser || chosen.density > 0.4 ? 'summary_only' : boundaryEvidence ? 'full' : 'partial';
  if (fragment && prose.length < 2) level = 'partial';
  const truncated = Buffer.byteLength(chosen.text) > maxBytes;
  if (truncated) level = 'partial';
  const text = clipUtf8(chosen.text, maxBytes);
  const paragraphs = [];
  let remaining = Buffer.byteLength(text);
  for (const p of chosen.paragraphs) {
    if (remaining <= 0) break;
    const kept = clipUtf8(p.text, remaining);
    if (kept) paragraphs.push({ id: `p${String(paragraphs.length + 1).padStart(4,'0')}`, kind: p.kind, text: kept });
    remaining -= Buffer.byteLength(kept) + 2;
  }
  const canonicalNode = all(dom, n => n.name === 'link' && n.attribs?.rel === 'canonical')[0];
  const meta = key => all(dom,n => n.name === 'meta' && [n.attribs?.name,n.attribs?.property].includes(key))[0]?.attribs?.content || '';
  const fedAuthor = sourceKey === 'fed' ? clean(inline(all(dom,n=>n.name==='p' && /\bspeaker\b/.test(n.attribs?.class || ''))[0] || {children:[]})) : '';
  const fedDate = sourceKey === 'fed' ? clean(inline(all(dom,n=>n.name==='p' && /\barticle__time\b/.test(n.attribs?.class || ''))[0] || {children:[]})) : '';
  const eiaDate = publisherKey === 'eia' ? clean(inline(all(nodes[0] || dom,n=>/\bdate\b/.test(n.attribs?.class || ''))[0] || {children:[]})) : '';
  const eiaAuthor = publisherKey === 'eia' ? prose.find(p=>/^Principal contributors?:/i.test(p.text))?.text.replace(/^Principal contributors?:\s*/i,'') || '' : '';
  const visualEvidenceRequired = all(nodes[0] || dom, n => n.name === 'img' && (sourceKey === 'ftav' && fragment || publisherKey === 'eia' || /chart|graph|figure/i.test(n.attribs?.alt || ''))).length > 0;
  return { ok: ['full','partial'].includes(level), contentLevel: level, reason: truncated ? 'byte_limit' : summaryMatch ? 'rss_summary_match' : teaser ? 'preview' : level === 'full' ? 'structured_body' : 'coverage_unverified',
    text, paragraphs, truncated, extractionMethod: chosen.method, extractorVersion: EXTRACTOR_VERSION, visualEvidenceRequired,
    author: (ld?.author || meta('author') || meta('article:author') || fedAuthor || eiaAuthor).slice(0,512), canonical: (canonicalNode?.attribs?.href || ld?.canonical || '').slice(0,2048), publishedAtRaw: (ld?.publishedAtRaw || meta('article:published_time') || fedDate || eiaDate).slice(0,128), updatedAtRaw: (ld?.updatedAtRaw || meta('article:modified_time')).slice(0,128), title: title || pageTitle };
}

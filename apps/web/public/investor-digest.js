const SHANGHAI = 'Asia/Shanghai';

function el(tag, text = '', className = '') {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (className) node.className = className;
  return node;
}

function shanghaiDate(now = Date.now()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: SHANGHAI, year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(now));
}

function clock(at) {
  const value = Number(at);
  if (!Number.isFinite(value) || value <= 0) return '';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: SHANGHAI, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(new Date(value));
}

const STATUS = {
  ready: '已生成',
  partial: '部分完成',
  failed: '生成失败',
  login_required: '雪球未登录',
  verification_required: '雪球验证页',
  running: '正在生成',
};

function coverageText(coverage) {
  if (!coverage) return '';
  const targets = Number(coverage.targets) || 0;
  const succeeded = Number(coverage.succeeded) || 0;
  const posts = Number(coverage.postCount) || 0;
  const comments = Number(coverage.commentCount) || 0;
  const parts = [`覆盖率 ${succeeded}/${targets}`, `帖子 ${posts}`, `评论 ${comments}`];
  if (coverage.commentNote) {
    const fetched = Number(coverage.commentFetched ?? coverage.commentCount) || 0;
    const claimed = Number(coverage.commentClaimed) || 0;
    parts.push(`评论拿到 ${fetched} / 帖子标称 reply_count ${claimed}`);
    parts.push(coverage.commentNote);
  }
  if (coverage.postsTruncatedNote) parts.push(coverage.postsTruncatedNote);
  else if (coverage.truncated) parts.push('帖子可能未抓全（到达页数上限）');
  return parts.join(' · ');
}

function paint(target, data, { date, onDate, onGenerate, busy }) {
  target.replaceChildren();
  const page = el('div', '', 'investor-digest');
  const bar = el('div', '', 'investor-digest-bar');
  const dateInput = el('input');
  dateInput.type = 'date';
  dateInput.value = date;
  dateInput.setAttribute('aria-label', '日摘日期');
  dateInput.addEventListener('change', () => onDate(dateInput.value));
  const button = el('button', busy ? '正在生成' : '生成这一天', 'tree-refresh');
  button.type = 'button';
  button.disabled = busy;
  button.addEventListener('click', onGenerate);
  bar.append(dateInput, button);
  page.append(bar);

  const digest = data?.digest;
  const pending = Boolean(data?.pending || digest?.status === 'running');
  if (!digest && !pending) {
    page.append(el('p', '这一天还没有股民讨论日摘。', 'investor-digest-meta'));
    target.append(page);
    return;
  }
  if (pending && (!digest || digest.status === 'running')) {
    page.append(el('p', '正在生成，完成后会显示在这里。', 'investor-digest-meta'));
  }
  if (digest?.generatedAt) page.append(el('p', `生成时间 ${clock(digest.generatedAt)}`, 'investor-digest-meta'));
  if (digest?.status && digest.status !== 'running') {
    page.append(el('p', STATUS[digest.status] || digest.status, 'investor-digest-meta'));
  }
  if (digest?.error) page.append(el('p', digest.error, 'investor-digest-meta'));
  if (digest?.coverage) page.append(el('p', coverageText(digest.coverage), 'investor-digest-meta'));
  const missing = digest?.coverage?.missing || [];
  if (missing.length) {
    page.append(el('p', `缺失：${missing.map((item) => `${item.name}（${item.reason}）`).join('、')}`, 'investor-digest-meta'));
  }
  for (const section of digest?.sections || []) {
    const card = el('article', '', 'source-card');
    const head = el('div', '', 'source-card-head');
    head.append(el('strong', section.name || section.key));
    if (section.sentiment) head.append(el('span', section.sentiment));
    card.append(head);
    card.append(el('p', section.summary || section.reason || '没有总结'));
    const heat = section.heat || {};
    card.append(el('p', `热度 ${heat.posts || 0} 帖 · ${heat.comments || 0} 评论`, 'investor-digest-meta'));
    if (section.commentNote) {
      card.append(el('p', `评论拿到 ${heat.comments || 0} / 帖子标称 reply_count ${heat.replyCount || 0} · ${section.commentNote}`, 'investor-digest-meta'));
    }
    if (section.repeatedTopics?.length) {
      card.append(el('p', `反复提到：${section.repeatedTopics.join('、')}`));
    }
    if (section.reason && section.fetchStatus !== 'failed' && section.fetchStatus !== 'summary_failed') {
      card.append(el('p', section.reason, 'investor-digest-meta'));
    }
    if (section.links?.length) {
      const links = el('div', '', 'investor-digest-links');
      for (const link of section.links) {
        const anchor = el('a', link.title || '原帖');
        anchor.href = link.url;
        anchor.target = '_blank';
        anchor.rel = 'noreferrer';
        links.append(anchor);
      }
      card.append(links);
    }
    page.append(card);
  }
  target.append(page);
}

export function mountInvestorDigest(target, { api, active = () => true } = {}) {
  let generation = 0;
  let timer = 0;
  let date = shanghaiDate();
  const stop = () => {
    generation += 1;
    if (timer) window.clearTimeout(timer);
    timer = 0;
  };
  async function load({ quiet = false } = {}) {
    const ticket = ++generation;
    if (!active() || !target.isConnected) return;
    if (!quiet) target.replaceChildren(el('p', '读取中…', 'investor-digest-meta'));
    let data = null;
    let error = '';
    try {
      data = await api(`/api/v1/investor-discussion?date=${encodeURIComponent(date)}`);
    } catch (caught) {
      if (caught?.name === 'AbortError' || !active()) return;
      error = caught?.message || '读取失败';
    }
    if (ticket !== generation || !active() || !target.isConnected) return;
    if (error) {
      target.replaceChildren(el('p', error, 'investor-digest-meta'));
      return;
    }
    const busy = Boolean(data?.pending || data?.digest?.status === 'running');
    paint(target, data, {
      date,
      busy,
      onDate(next) {
        if (!next || next === date) return;
        date = next;
        load();
      },
      onGenerate() { generate(); },
    });
    if (busy) timer = window.setTimeout(() => load({ quiet: true }), 4000);
  }
  async function generate() {
    const ticket = generation;
    try {
      await api('/api/v1/investor-discussion', { method: 'POST', body: JSON.stringify({ date }) });
    } catch (caught) {
      if (caught?.name === 'AbortError' || !active()) return;
      if (ticket !== generation || !target.isConnected) return;
      target.replaceChildren(el('p', caught?.message || '生成失败', 'investor-digest-meta'));
      return;
    }
    if (ticket !== generation || !active()) return;
    load({ quiet: true });
  }
  load();
  return stop;
}

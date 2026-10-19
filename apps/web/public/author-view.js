const PLATFORM_LABEL = { all: '全部', x: 'X', xueqiu: '雪球', bilibili: 'B站', youtube: 'YouTube', official: '官方', media: '媒体' };
const PLATFORM_ORDER = ['all', 'x', 'xueqiu', 'bilibili', 'youtube', 'official', 'media'];
const PLATFORM_COLOR = { x: '#111111', xueqiu: '#c0392b', bilibili: '#fb7299', youtube: '#cc0000', official: '#0A59F7', media: '#0f6b4c' };
const PAGE_SIZE = 30;

const pages = new Map();
let listPlatform = 'all';
let listCache = null;

function platformLabel(platform) {
  return PLATFORM_LABEL[platform] || platform || '';
}

function initial(name) {
  const text = String(name || '').trim();
  return text ? text.slice(0, 1) : '作';
}

function clock(at) {
  const time = Number(at) || 0;
  if (!time) return '';
  const date = new Date(time);
  const now = new Date();
  const sameDay = date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate();
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  if (sameDay) return `${hh}:${mm}`;
  return `${date.getMonth() + 1}月${date.getDate()}日 ${hh}:${mm}`;
}

function avatar(author) {
  const node = document.createElement(author.avatarUrl ? 'img' : 'span');
  node.className = 'author-avatar';
  if (author.avatarUrl) {
    node.alt = '';
    node.src = author.avatarUrl;
    node.addEventListener('error', () => {
      const fallback = document.createElement('span');
      fallback.className = 'author-avatar';
      fallback.textContent = initial(author.name);
      fallback.style.background = PLATFORM_COLOR[author.platform] || '#5c6b7a';
      node.replaceWith(fallback);
    });
  } else {
    node.textContent = initial(author.name);
    node.style.background = PLATFORM_COLOR[author.platform] || '#5c6b7a';
  }
  return node;
}

function followButton(author, onToggle) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `author-follow${author.followed ? ' is-on' : ''}`;
  button.textContent = author.followed ? '已关注' : '关注';
  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    onToggle(author);
  });
  return button;
}

function authorRow(author, { onOpen, onFollow }) {
  const row = document.createElement('article');
  row.className = `author-row${author.unreadCount ? '' : ' is-quiet'}`;
  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'author-row-main';
  open.append(avatar(author));
  const copy = document.createElement('span');
  copy.className = 'author-row-copy';
  const title = document.createElement('span');
  title.className = 'author-row-title';
  const name = document.createElement('strong');
  name.textContent = author.name || author.handle || '未命名作者';
  const badge = document.createElement('span');
  badge.className = 'author-platform';
  badge.textContent = platformLabel(author.platform);
  title.append(name, badge);
  if (author.unreadCount > 0) {
    const unread = document.createElement('span');
    unread.className = 'author-unread';
    unread.textContent = String(author.unreadCount);
    title.append(unread);
  }
  const preview = document.createElement('span');
  preview.className = 'author-row-preview';
  const when = clock(author.latestUnreadAt || author.latestItemAt);
  preview.textContent = [when, author.latestTitleZh].filter(Boolean).join('  ');
  copy.append(title, preview);
  open.append(copy);
  open.addEventListener('click', () => onOpen(author));
  row.append(open, followButton(author, onFollow));
  return row;
}

export function createAuthorView({ api, openAuthor, openArticle }) {
  async function loadList(platform, cursor = '') {
    const query = new URLSearchParams({ platform: platform || 'all' });
    if (cursor) query.set('cursor', cursor);
    return api(`/api/v1/authors?${query}`, { fresh: true });
  }

  async function renderList(root) {
    root.replaceChildren();
    const shell = document.createElement('div');
    shell.className = 'author-screen';
    const loading = document.createElement('p');
    loading.className = 'feed-empty';
    loading.textContent = '正在读取作者…';
    shell.append(loading);
    root.append(shell);
    let payload = listCache && listCache.platform === listPlatform ? listCache.payload : null;
    try {
      if (!payload) {
        payload = await loadList(listPlatform);
        listCache = { platform: listPlatform, payload };
      }
    } catch (error) {
      loading.textContent = error?.message || '作者列表读取失败';
      return;
    }
    if (!root.isConnected) return;
    paintList(shell, payload);
  }

  function paintList(shell, payload) {
    shell.replaceChildren();
    const counts = payload.counts || {};
    const switcher = document.createElement('div');
    switcher.className = 'author-switch';
    // 列表左右滑会和 iOS 边缘返回、Android 返回手势抢水平滑动，所以只让这一行标签自己横滑。
    switcher.setAttribute('role', 'tablist');
    switcher.setAttribute('aria-label', '作者平台');
    for (const id of PLATFORM_ORDER) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `author-switch-item${id === listPlatform ? ' is-active' : ''}`;
      button.textContent = `${platformLabel(id)} ${Number(counts[id]) || 0}`;
      button.addEventListener('click', () => {
        if (id === listPlatform) return;
        listPlatform = id;
        listCache = null;
        const host = shell.parentElement;
        if (host) renderList(host);
      });
      switcher.append(button);
    }
    shell.append(switcher);
    const active = switcher.querySelector('.is-active');
    if (active) active.scrollIntoView({ inline: 'nearest', block: 'nearest' });
    const rows = document.createElement('div');
    rows.className = 'author-list-rows';
    const followed = Array.isArray(payload.followed) ? payload.followed : [];
    const others = Array.isArray(payload.others) ? payload.others : [];
    if (followed.length) {
      const label = document.createElement('h3');
      label.className = 'author-group';
      label.textContent = '已关注';
      rows.append(label);
      for (const author of followed) rows.append(authorRow(author, { onOpen: openRow, onFollow: toggleFollow }));
    }
    if (others.length) {
      const label = document.createElement('h3');
      label.className = 'author-group';
      label.textContent = followed.length ? '其他' : '作者';
      rows.append(label);
      for (const author of others) rows.append(authorRow(author, { onOpen: openRow, onFollow: toggleFollow }));
    }
    if (!followed.length && !others.length) {
      const empty = document.createElement('p');
      empty.className = 'feed-empty';
      empty.textContent = '这里还没有符合条件的作者。';
      rows.append(empty);
    }
    shell.append(rows);
    if (payload.nextCursor) {
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'author-more';
      more.textContent = '继续加载';
      more.addEventListener('click', async () => {
        more.disabled = true;
        more.textContent = '正在读取…';
        try {
          const next = await loadList(listPlatform, payload.nextCursor);
          payload.others = others.concat(next.others || []);
          payload.nextCursor = next.nextCursor || '';
          listCache = { platform: listPlatform, payload };
          paintList(shell, payload);
        } catch (error) {
          more.disabled = false;
          more.textContent = error?.message || '继续加载失败';
        }
      });
      shell.append(more);
    }
  }

  function openRow(author) {
    openAuthor(author.authorId);
  }

  async function toggleFollow(author) {
    try {
      const method = author.followed ? 'DELETE' : 'PUT';
      await api(`/api/v1/authors/${encodeURIComponent(author.authorId)}/follow`, { method });
      listCache = null;
      pages.delete(author.authorId);
      const root = document.querySelector('#feed');
      if (root && document.body.dataset.view === 'feed') renderList(root);
    } catch {
      listCache = null;
    }
  }

  function remember(authorId) {
    const page = pages.get(authorId) || { justRead: new Set() };
    page.scrollY = window.scrollY;
    pages.set(authorId, page);
  }

  function noteRead(authorId, itemId) {
    if (!authorId || !itemId) return;
    const page = pages.get(authorId) || { justRead: new Set() };
    page.justRead = page.justRead || new Set();
    page.justRead.add(itemId);
    page.scrollY = window.scrollY;
    pages.set(authorId, page);
  }

  async function loadItems(authorId, read, cursor = '') {
    const query = new URLSearchParams({ read, limit: String(PAGE_SIZE) });
    if (cursor) query.set('cursor', cursor);
    return api(`/api/v1/authors/${encodeURIComponent(authorId)}/items?${query}`, { fresh: true });
  }

  async function renderPage(root, authorId) {
    const cached = pages.get(authorId);
    if (cached?.author && cached.unread) {
      paintPage(root, authorId, cached);
      return;
    }
    root.replaceChildren();
    const loading = document.createElement('p');
    loading.className = 'feed-empty';
    loading.textContent = '正在读取作者…';
    root.append(loading);
    try {
      const detail = await api(`/api/v1/authors/${encodeURIComponent(authorId)}`, { fresh: true });
      const unread = await loadItems(authorId, 'unread');
      const page = {
        author: detail.author,
        unread,
        read: null,
        justRead: cached?.justRead || new Set(),
        scrollY: cached?.scrollY || 0,
      };
      if ((unread.items || []).length < PAGE_SIZE) page.read = await loadItems(authorId, 'read');
      pages.set(authorId, page);
      if (root.isConnected) paintPage(root, authorId, page);
    } catch (error) {
      loading.textContent = error?.message || '作者不存在';
    }
  }

  function paintPage(root, authorId, page) {
    const author = page.author;
    root.replaceChildren();
    const shell = document.createElement('article');
    shell.className = 'author-page';
    const head = document.createElement('header');
    head.className = 'author-page-head';
    const back = document.createElement('button');
    back.type = 'button';
    back.className = 'author-back';
    back.textContent = '返回';
    back.addEventListener('click', () => {
      if (history.state?.aiCenterPrevious) history.back();
      else location.hash = '#feed?tab=author';
    });
    const title = document.createElement('div');
    title.className = 'author-page-title';
    const name = document.createElement('strong');
    name.textContent = author.name || author.handle || '未命名作者';
    const badge = document.createElement('span');
    badge.className = 'author-platform';
    badge.textContent = platformLabel(author.platform);
    title.append(name, badge);
    const actions = document.createElement('div');
    actions.className = 'author-page-actions';
    actions.append(followButton(author, async (row) => {
      const method = row.followed ? 'DELETE' : 'PUT';
      const result = await api(`/api/v1/authors/${encodeURIComponent(author.authorId)}/follow`, { method });
      page.author = result.author || { ...row, followed: !row.followed };
      listCache = null;
      paintPage(root, authorId, page);
    }));
    const readAll = document.createElement('button');
    readAll.type = 'button';
    readAll.className = 'author-read-all';
    readAll.textContent = '全部已读';
    readAll.addEventListener('click', async () => {
      readAll.disabled = true;
      const result = await api(`/api/v1/authors/${encodeURIComponent(author.authorId)}/read-all`, { method: 'POST' });
      pages.delete(authorId);
      listCache = null;
      if (result) renderPage(root, authorId);
    });
    actions.append(readAll);
    head.append(back, title, actions);
    shell.append(head);
    const meta = document.createElement('div');
    meta.className = 'author-page-meta';
    if (author.bio) {
      const bio = document.createElement('p');
      bio.textContent = author.bio;
      meta.append(bio);
    }
    const facts = document.createElement('p');
    const bits = [];
    if (author.followers != null) bits.push(`${author.followers} 关注者`);
    facts.textContent = bits.join(' · ');
    if (author.profileUrl) {
      const home = document.createElement('a');
      home.href = author.profileUrl;
      home.target = '_blank';
      home.rel = 'noreferrer';
      home.textContent = '打开主页↗';
      facts.append(document.createTextNode(facts.textContent ? ' · ' : ''), home);
    }
    if (facts.textContent || facts.childElementCount) meta.append(facts);
    shell.append(meta);
    shell.append(section(author, page, 'unread', `未读 · ${author.unreadCount || 0}`));
    if (page.read) shell.append(section(author, page, 'read', `已读 · ${Math.max(0, (author.totalCount || 0) - (author.unreadCount || 0))}`, true));
    root.append(shell);
    const y = page.scrollY || 0;
    requestAnimationFrame(() => window.scrollTo(0, y));
  }

  function section(author, page, key, label, quiet = false) {
    const block = document.createElement('section');
    block.className = `author-items${quiet ? ' is-quiet' : ''}`;
    const heading = document.createElement('h3');
    heading.textContent = label;
    block.append(heading);
    const list = document.createElement('div');
    const bundle = page[key] || { items: [], nextCursor: '' };
    for (const item of bundle.items || []) {
      const readHere = key === 'unread' && page.justRead?.has(item.id);
      list.append(itemRow(author, item, readHere));
    }
    if (!(bundle.items || []).length) {
      const empty = document.createElement('p');
      empty.className = 'feed-empty';
      empty.textContent = key === 'unread' ? '没有未读' : '没有已读';
      list.append(empty);
    }
    block.append(list);
    if (bundle.nextCursor) {
      const more = document.createElement('button');
      more.type = 'button';
      more.className = 'author-more';
      more.textContent = '继续加载';
      more.addEventListener('click', async () => {
        more.disabled = true;
        const next = await loadItems(author.authorId, key, bundle.nextCursor);
        bundle.items = (bundle.items || []).concat(next.items || []);
        bundle.nextCursor = next.nextCursor || '';
        const root = block.closest('.page-root, #page-root') || document.getElementById('page-root');
        if (root) paintPage(root, author.authorId, page);
      });
      block.append(more);
    } else if (key === 'unread' && !page.read) {
      loadItems(author.authorId, 'read').then((read) => {
        page.read = read;
        const root = block.closest('#page-root') || document.getElementById('page-root');
        if (root) paintPage(root, author.authorId, page);
      }).catch(() => {});
    }
    return block;
  }

  function itemRow(author, item, grey) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = `author-item${grey || item.isRead ? ' is-quiet' : ''}`;
    const when = document.createElement('time');
    when.textContent = clock(item.publishedAt);
    const title = document.createElement('strong');
    title.textContent = item.preview || item.title || '无标题';
    row.append(when, title);
    row.addEventListener('click', () => {
      remember(author.authorId);
      noteRead(author.authorId, item.id);
      openArticle({
        id: item.provider && item.externalId ? `${item.provider}:${item.externalId}` : item.id,
        resourceId: item.id,
        authorId: author.authorId,
        author: author.name,
        platform: item.provider || author.platform,
        title: item.title,
        sourceUrl: item.sourceUrl,
        publishedAt: item.publishedAt,
        kind: 'social',
      });
    });
    return row;
  }

  return { renderList, renderPage, noteRead, remember };
}

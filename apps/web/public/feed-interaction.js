const messages = {
  liked: '已在 X 点赞，并重新打开原帖核验',
  'already-liked': '这条推文在 X 已经点赞',
  'login-required': 'X 登录已失效，请在电脑上的采集浏览器登录后重试',
  blocked: 'X 页面有验证或弹窗，请在电脑上处理后重试',
  unavailable: '未能连接已登录的 X 页面，或页面按钮暂不可用',
  'not-found': '未能准确定位这条原帖，可能已删除或无权访问',
  unconfirmed: '尚未确认点赞结果，请先打开 X 原帖查看',
};

export function createFeedLikeAction({ api, showToast, createAction, session = () => null, wait = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  const pending = new Map();
  return function likeButton(post) {
    if (session()?.role !== 'desktop') return null;
    if (post?.platform !== 'x' || !/^[0-9a-f-]{36}$/i.test(post.resourceId || '')) return null;
    const scope = `${session()?.role || ''}:${session()?.device?.id || 'desktop'}`;
    const key = `${scope}:${post.resourceId}`;
    const record = pending.get(key);
    const paint = state => {
      const label = state.busy ? '点赞处理中' : state.liked ? '已在 X 点赞' : state.jobId ? '查询点赞结果' : '在 X 点赞';
      for (const target of new Set([button, ...document.querySelectorAll('[data-x-like-key]')])) {
        if (target.dataset.xLikeKey !== key) continue;
        target.disabled = Boolean(state.busy || state.liked);
        target.textContent = label;
      }
    };
    const button = createAction({ iconName: 'heart', label: record?.busy ? '点赞处理中' : record?.liked ? '已在 X 点赞' : '在 X 点赞', onClick: async () => {
      if (pending.get(key)?.busy) return;
      const state = { busy: true, liked: false, jobId: pending.get(key)?.jobId || '' };
      pending.set(key, state);
      paint(state);
      try {
        const path = `/api/v1/content-items/${encodeURIComponent(post.resourceId)}/x-like`;
        if (!state.jobId) state.jobId = (await api(path, { method: 'POST', body: JSON.stringify({ confirmed: true }) })).jobId;
        for (let i = 0; i < 180; i++) {
          if (`${session()?.role || ''}:${session()?.device?.id || 'desktop'}` !== scope) return;
          const { job } = await api(`${path}/${encodeURIComponent(state.jobId)}`);
          if (`${session()?.role || ''}:${session()?.device?.id || 'desktop'}` !== scope) return;
          if (job.status === 'completed') {
            state.liked = ['liked', 'already-liked'].includes(job.result?.status);
            state.jobId = '';
            showToast(`${messages[job.result?.status] || messages.unconfirmed}${job.result?.accountHandle ? `（@${job.result.accountHandle}）` : ''}`);
            return;
          }
          if (['failed', 'cancelled'].includes(job.status)) {
            state.jobId = '';
            throw new Error('点赞任务未完成，请先打开 X 原帖核对');
          }
          await wait(1000);
        }
        showToast('点赞任务仍在处理。再次点击会查询同一任务，不会重复派发。');
      } catch (error) {
        showToast(error.message || messages.unconfirmed);
      } finally {
        state.busy = false;
        paint(state);
      }
    } });
    button.classList.add('text-button');
    button.dataset.xLikeKey = key;
    button.disabled = Boolean(record?.busy || record?.liked);
    return button;
  };
}

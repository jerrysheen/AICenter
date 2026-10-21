const number = value => value === null || value === undefined ? '未知' : value.toLocaleString('zh-CN');
const labels = { pending: '等待补全', succeeded: '完成', failed: '失败', interrupted: '中断' };

function bambooDayLabel(day) {
  if (!/^\d{8}$/.test(String(day))) return '未知日期';
  return `${Number(String(day).slice(4, 6))}月${Number(String(day).slice(6, 8))}日`;
}

// Newest Shanghai day is first. The count is feed admission only; the cap defaults to 7000.
export function formatBambooDailySummary(days) {
  if (!Array.isArray(days) || days.length === 0) return '';
  const lines = ['Bamboo 每天调用（信息流准入）'];
  days.forEach((row, index) => {
    const day = String(row?.day || '');
    const label = index === 0 ? '今天' : bambooDayLabel(day);
    const count = row?.count === null || row?.count === undefined ? '无法读取' : number(row.count);
    const limit = Number.isFinite(Number(row?.limit)) ? number(Number(row.limit)) : number(7000);
    lines.push(`${label} ${count} / ${limit}`);
  });
  return lines.join('\n');
}

export function openModelUsageDialog({ api, document = globalThis.document }) {
  const dialog = document.createElement('dialog');
  dialog.className = 'model-usage-dialog';
  const heading = document.createElement('h2'); heading.textContent = '模型用量账本';
  const note = document.createElement('p');
  note.textContent = '请求明细与原生整轮汇总分别展示。未知用量和费用不补零；失败与重试保留。';
  const bamboo = document.createElement('p');
  bamboo.className = 'model-usage-bamboo';
  const close = document.createElement('button'); close.textContent = '关闭'; close.type = 'button';
  close.onclick = () => dialog.close();
  const body = document.createElement('div'); body.textContent = '正在读取…';
  const actions = document.createElement('div'); actions.className = 'model-usage-actions';
  const previous = document.createElement('button'), next = document.createElement('button');
  previous.textContent = '上一页'; next.textContent = '下一页'; previous.type = next.type = 'button';
  const filter = document.createElement('input'); filter.placeholder = '按任务 ID 查询'; filter.setAttribute('aria-label', '任务 ID');
  const search = document.createElement('button'); search.textContent = '查询'; search.type = 'button';
  actions.append(filter, search, previous, next);
  dialog.append(heading, note, bamboo, close, actions, body); document.body.append(dialog);
  dialog.addEventListener('close', () => dialog.remove(), { once: true }); dialog.showModal();
  let offset = 0, version = 0;
  async function load() {
    const current = ++version; body.textContent = '正在读取…';
    previous.disabled = next.disabled = true;
    try {
      const query = new URLSearchParams({ limit: '50', offset: String(offset) });
      if (filter.value.trim()) query.set('jobId', filter.value.trim());
      const payload = await api(`/api/v1/runtime/model-usage?${query}`);
      const records = payload.records || [];
      if (current !== version || !dialog.isConnected) return;
      bamboo.textContent = formatBambooDailySummary(payload.bambooDays);
      body.replaceChildren();
      if (!records.length) body.textContent = '暂无记录。接入前的历史请求不会自动归因。';
      for (const row of records) {
        const item = document.createElement('details'); item.className = 'task-item';
        const summary = document.createElement('summary');
        summary.textContent = `${row.kind === 'turn' ? '整轮汇总' : '请求'} · ${row.stage} · ${labels[row.status]} · ${row.completeness === 'complete' ? '已确认' : '统计不完整'} · ${number(row.usage.totalTokens)} tokens`;
        const detail = document.createElement('p');
        detail.className = 'model-usage-detail';
        detail.textContent = `时间：${new Date(row.occurredAt).toLocaleString('zh-CN')}\n任务：${row.jobId || '未关联任务'} / 执行尝试 ${number(row.jobAttempt)}\n阶段：${row.stage}\n会话：${row.applicationSessionId || '独立调用'}\n执行：${row.executionId || '直连请求'} / turn ${number(row.turn)} / step ${number(row.step)} / attempt ${number(row.attempt)}\nHTTP：${row.httpStatus == null ? '未知' : row.httpStatus}\n未缓存输入：${number(row.usage.inputTokens)}；输出：${number(row.usage.outputTokens)}\n缓存读取：${number(row.usage.cacheReadTokens)}；缓存写入：${number(row.usage.cacheWriteTokens)}；推理：${number(row.usage.reasoningTokens)}\n供应商金额：${row.supplierAmount === null ? '未知' : `${row.supplierAmount} ${row.supplierCurrency || ''}`}\n费率估算：${row.estimate ? `${row.estimate.amount.toFixed(6)} ${row.estimate.currency}（${row.estimate.rateVersion}）` : '未知'}\n记录：${row.id}`;
        item.append(summary, detail); body.append(item);
      }
      previous.disabled = offset === 0; next.disabled = records.length < 50;
    } catch (error) { if (current === version) body.textContent = `无法读取用量：${error.message || '请稍后重试'}`; }
  }
  previous.onclick = () => { offset = Math.max(0, offset - 50); load(); };
  next.onclick = () => { offset += 50; load(); };
  search.onclick = () => { offset = 0; load(); };
  load();
  return dialog;
}

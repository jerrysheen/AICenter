function field(label, value) {
  const wrap = document.createElement('div');
  const name = document.createElement('dt');
  name.textContent = label;
  const body = document.createElement('dd');
  body.textContent = value == null || value === '' ? '缺失' : String(value);
  wrap.append(name, body);
  return wrap;
}

function button(label, onClick) {
  const node = document.createElement('button');
  node.type = 'button';
  node.className = 'text-button';
  node.textContent = label;
  node.addEventListener('click', onClick);
  return node;
}

function metricText(metric) {
  if (!metric) return '缺失';
  if (metric.value == null) return `缺失：${metric.meaning || '没有这项输出'}`;
  return `${metric.value}（${metric.meaning}）`;
}

export async function renderQuantLab(root, { api, showToast, onLive }) {
  const payload = await api('/api/v1/quant/lab');
  const lab = payload.lab;
  const overview = lab.overview;
  root.replaceChildren();

  const intro = document.createElement('section');
  intro.className = 'strategy-inspect';
  intro.innerHTML = '<div class="strategy-inspect-head"><h2>环境与数据</h2><span></span></div>';
  intro.querySelector('span').textContent = overview.ready ? '数据已准备' : '尚未准备数据';
  const note = document.createElement('p');
  note.className = 'strategy-inspect-note';
  note.textContent = `${overview.sampleLabel}。${overview.sampleNote}`;
  const facts = document.createElement('dl');
  facts.className = 'strategy-inspect-metrics';
  const segments = overview.segments;
  facts.append(
    field('数据来源', overview.source),
    field('覆盖区间', overview.dateRange ? `${overview.dateRange.start} 至 ${overview.dateRange.end}` : null),
    field('股票数量', overview.stockCount),
    field('基准', overview.benchmark),
    field('训练', segments ? segments.train.join(' 至 ') : null),
    field('验证', segments ? segments.valid.join(' 至 ') : null),
    field('测试', segments ? segments.test.join(' 至 ') : null),
    field('特征 / 模型 / 组合', 'Alpha158 / LightGBM / TopkDropout'),
  );
  intro.append(note, facts);
  if (overview.adjustment) {
    const adjust = document.createElement('p');
    adjust.className = 'strategy-inspect-note';
    adjust.textContent = `${overview.adjustment} ${overview.units || ''}`;
    intro.append(adjust);
  }
  root.append(intro);

  const controls = document.createElement('section');
  controls.className = 'strategy-inspect';
  controls.innerHTML = '<div class="strategy-inspect-head"><h2>基线实验</h2></div>';
  const form = document.createElement('form');
  form.className = 'quant-form';
  form.innerHTML = `<label>topk <input name="topk" type="number" min="1" max="20" value="5"></label>
    <label>n_drop <input name="nDrop" type="number" min="0" max="19" value="1"></label>`;
  const actions = document.createElement('div');
  actions.className = 'detail-actions is-inline';
  actions.append(
    button('准备数据', async () => {
      try {
        await api('/api/v1/quant/prepare', { method: 'POST' });
        showToast('已提交数据准备，刷新后看状态');
        await renderQuantLab(root, { api, showToast, onLive });
      } catch (error) {
        showToast(error.message);
      }
    }),
    button('运行实验', async () => {
      const data = new FormData(form);
      try {
        await api('/api/v1/quant/experiments', {
          method: 'POST',
          body: JSON.stringify({ topk: Number(data.get('topk')), nDrop: Number(data.get('nDrop')) }),
        });
        showToast('已建立一次新实验');
        await renderQuantLab(root, { api, showToast, onLive });
      } catch (error) {
        showToast(error.message);
      }
    }),
  );
  form.append(actions);
  controls.append(form);
  root.append(controls);

  const prepareNote = lab.prepareJobs?.[0];
  if (prepareNote) {
    const prepare = document.createElement('p');
    prepare.className = 'strategy-inspect-note';
    prepare.textContent = `最近一次准备数据：${prepareNote.status}${prepareNote.error ? `，${prepareNote.error}` : ''}`;
    root.append(prepare);
  }

  const list = document.createElement('section');
  list.className = 'strategy-inspect';
  list.innerHTML = '<div class="strategy-inspect-head"><h2>实验</h2></div>';
  if (!lab.experiments.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-state';
    empty.textContent = '还没有实验。';
    list.append(empty);
  }
  for (const experiment of lab.experiments) {
    const card = document.createElement('article');
    card.className = 'quant-experiment';
    const title = document.createElement('strong');
    const chartNote = experiment.graphErrors?.length ? '回测完成，部分图表失败' : experiment.status;
    title.textContent = `${experiment.experimentId.slice(0, 8)} · ${chartNote} · topk ${experiment.topk ?? '-'} / n_drop ${experiment.nDrop ?? '-'}`;
    card.append(title);
    if (experiment.graphErrors?.length) {
      const charts = document.createElement('p');
      charts.textContent = experiment.graphErrors.join(' ');
      card.append(charts);
    }
    if (experiment.error) {
      const error = document.createElement('p');
      error.textContent = String(experiment.error).slice(0, 500);
      card.append(error);
    }
    const metrics = (experiment.metrics || []).slice(0, 6);
    if (metrics.length) {
      const line = document.createElement('p');
      line.textContent = metrics.map((item) => `${item.name}: ${item.value == null ? '缺失' : item.value}`).join('；');
      card.append(line);
    }
    const row = document.createElement('div');
    row.className = 'detail-actions is-inline';
    if (experiment.hasReport) {
      const report = document.createElement('a');
      report.className = 'text-button';
      report.href = `/api/v1/quant/experiments/${experiment.experimentId}/report`;
      report.target = '_blank';
      report.rel = 'noopener';
      report.textContent = '打开报告';
      row.append(report);
    }
    const dates = experiment.testDates || [];
    if (dates.length) {
      const select = document.createElement('select');
      for (const date of dates) {
        const option = document.createElement('option');
        option.value = date;
        option.textContent = date;
        select.append(option);
      }
      const day = document.createElement('div');
      day.className = 'quant-day';
      row.append(select, button('查看分数和持仓', async () => {
        try {
          const result = await api(`/api/v1/quant/experiments/${experiment.experimentId}/days/${select.value}`);
          renderDay(day, result.day);
        } catch (error) {
          showToast(error.message);
        }
      }));
      card.append(row, day);
    } else {
      card.append(row);
    }
    if (experiment.assumptions) {
      const assumptions = document.createElement('p');
      assumptions.className = 'strategy-inspect-note';
      assumptions.textContent = `成交 ${experiment.assumptions.deal_price}；${experiment.assumptions.signal_shift}。未模拟：${experiment.assumptions.not_simulated}`;
      card.append(assumptions);
    }
    list.append(card);
  }
  root.append(list);
  const live = lab.experiments.some((item) => item.status === 'queued' || item.status === 'running')
    || lab.prepareJobs?.some((item) => item.status === 'queued' || item.status === 'running');
  onLive?.(live);
}

function renderDay(container, day) {
  container.replaceChildren();
  const scores = document.createElement('p');
  scores.textContent = day.scores.length
    ? `${day.signalDate} 的分数：${day.scores.map((row) => `${row.rank}. ${row.instrument} 分数 ${row.score}`).join('；')}`
    : day.missing.scores;
  const holdings = document.createElement('p');
  holdings.textContent = day.holdings.length
    ? `${day.date} 持仓（Qlib 复权数量，不是券商股数）：${day.holdings.map((row) => `${row.instrument} ${row.amount}`).join('；')}`
    : day.missing.holdings;
  const timing = document.createElement('p');
  timing.textContent = day.timing || '';
  container.append(timing, scores, holdings);
}

export { metricText };

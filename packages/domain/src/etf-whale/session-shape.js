function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function indexSessionShape({ prevClose, close, bars = [] } = {}) {
  const previous = finite(prevClose);
  const settled = finite(close);
  if (!bars.length || previous == null || previous === 0 || settled == null) {
    return { lowTime: null, lowDropPct: null, reboundPct: null, tailPct: null };
  }
  let lowBar = null;
  for (const bar of bars) {
    const low = finite(bar.low);
    if (low == null) continue;
    if (!lowBar || low < lowBar.low) lowBar = { ...bar, low };
  }
  if (!lowBar) return { lowTime: null, lowDropPct: null, reboundPct: null, tailPct: null };
  const tail = bars.find((bar) => String(bar.barTime || '').slice(11, 16) === '14:30') || null;
  const tailClose = finite(tail?.close);
  return {
    lowTime: lowBar.barTime || null,
    lowDropPct: lowBar.low / previous - 1,
    reboundPct: lowBar.low ? settled / lowBar.low - 1 : null,
    tailPct: tailClose ? settled / tailClose - 1 : null,
  };
}

export function indexShapeHit({ lowDropPct, reboundPct, tailPct } = {}) {
  const drop = finite(lowDropPct);
  const rebound = finite(reboundPct);
  const tail = finite(tailPct);
  const washed = drop != null && rebound != null && drop < -0.01 && rebound >= 0.01;
  const tailUp = tail != null && tail >= 0.01;
  return washed || tailUp;
}

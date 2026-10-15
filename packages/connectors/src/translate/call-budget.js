import { AsyncLocalStorage } from 'node:async_hooks';

const budgetContext = new AsyncLocalStorage();

// One job attempt. Unset or 0 follows items × (keys + retries). A positive integer is the absolute ceiling.
export function translationAttemptCallLimit({ itemCount = 1, keyCount = 1, maxRetries = 0, configured } = {}) {
  const items = Math.max(1, Math.trunc(Number(itemCount) || 1));
  const keys = Math.max(1, Math.trunc(Number(keyCount) || 1));
  const retries = Math.max(0, Math.trunc(Number(maxRetries) || 0));
  const auto = items * (keys + retries);
  const rawText = configured == null ? '' : String(configured).trim();
  if (!rawText || rawText === '0') return auto;
  const raw = Number(rawText);
  if (!Number.isInteger(raw) || raw < 1) return auto;
  return Math.min(500, raw);
}

export function withTranslationCallBudget(limit, action) {
  const cap = Math.max(1, Math.trunc(Number(limit) || 1));
  return budgetContext.run({ limit: cap, used: 0 }, action);
}

export function chargeTranslationCall() {
  const budget = budgetContext.getStore();
  if (!budget) return;
  if (budget.used >= budget.limit) {
    throw Object.assign(new Error('翻译调用次数已达本次尝试上限'), { code: 'translation-call-cap' });
  }
  budget.used += 1;
}

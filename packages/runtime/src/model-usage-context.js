import { AsyncLocalStorage } from 'node:async_hooks';
const context = new AsyncLocalStorage();
export const withModelUsageContext = (value, action) => context.run(value, action);
export const modelUsageContext = () => context.getStore() || {};
export async function observeModelUsage(value, observer) {
  let timer;
  try {
    const result = (observer || context.getStore()?.observe)?.(value);
    if (result?.then) await Promise.race([result, new Promise(resolve => { timer = setTimeout(resolve, 1500); })]);
  } catch { /* Ledger failure cannot affect execution. */ }
  finally { clearTimeout(timer); }
}

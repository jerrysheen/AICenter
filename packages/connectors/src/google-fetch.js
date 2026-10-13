import { Agent } from 'undici';

const agents = new Map();

export function googleConnectTimeoutMs(env = process.env) {
  const raw = env.AI_CENTER_GOOGLE_CONNECT_TIMEOUT_MS;
  if (raw == null || String(raw).trim() === '') return 8000;
  const value = Number(String(raw).trim());
  if (!Number.isInteger(value) || value < 1000 || value > 30000) {
    throw new Error('AI_CENTER_GOOGLE_CONNECT_TIMEOUT_MS must be an integer from 1000 to 30000');
  }
  return value;
}

export function googleConnectDispatcher(env = process.env) {
  const timeout = googleConnectTimeoutMs(env);
  let agent = agents.get(timeout);
  if (!agent) {
    agent = new Agent({ connect: { timeout } });
    agents.set(timeout, agent);
  }
  return agent;
}

export async function closeGoogleConnectDispatchers() {
  const open = [...agents.values()];
  agents.clear();
  await Promise.all(open.map((agent) => agent.close()));
}

export function isGoogleConnectTimeout(error) {
  return error?.code === 'UND_ERR_CONNECT_TIMEOUT'
    || error?.name === 'ConnectTimeoutError'
    || /UND_ERR_CONNECT_TIMEOUT|Connect Timeout/i.test(String(error?.message || ''));
}

export function withGoogleConnect(init = {}, env = process.env) {
  if (init.dispatcher) return init;
  return { ...init, dispatcher: googleConnectDispatcher(env) };
}

// Injected fetch stays untouched so tests and proxies do not inherit undici's dispatcher.
// Production global fetch gets a short TCP connect budget, separate from AbortSignal response timeouts.
export function googleFetch(fetchImpl = fetch, env = process.env) {
  const base = fetchImpl || fetch;
  if (base !== fetch) return base;
  return (url, init) => base(url, withGoogleConnect(init || {}, env));
}

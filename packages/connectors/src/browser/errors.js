export class BrowserError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'BrowserError';
    this.details = details;
  }
}

export class BrowserUnavailableError extends BrowserError {
  constructor(message, details = {}) {
    super(message, details);
    this.name = 'BrowserUnavailableError';
  }
}

export class BrowserCommandError extends BrowserError {
  constructor(message, details = {}) {
    super(message, details);
    this.name = 'BrowserCommandError';
  }
}

export function isBrowserUnavailable(error) {
  if (error instanceof BrowserUnavailableError) return true;
  const code = String(error?.details?.code || '').toLowerCase();
  return code === 'no_browser_connected' || code === 'daemon_unavailable';
}

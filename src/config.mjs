import path from 'node:path';

function positive(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid ${name}`);
  return value;
}

export const config = {
  host: '127.0.0.1',
  port: positive('PORT', 8787),
  stateDir: path.resolve(process.env.GROK_STATE_DIR || '.state'),
  logFile: path.resolve(process.env.GROK_LOG_FILE || 'log.json'),
  channel: process.env.GROK_CHROME_CHANNEL || 'chrome',
  grokMode: process.env.GROK_MODE || 'fast',
  headless: process.env.GROK_HEADLESS === 'true',
  locale: process.env.GROK_LOCALE || undefined,
  timezoneId: process.env.GROK_TIMEZONE || undefined,
  timeout: positive('GROK_TIMEOUT_MS', 180000),
  cooldown: positive('GROK_COOLDOWN_MS', 300000),
  doneEvents: (process.env.GROK_DONE_EVENT || 'response.done,response.completed').split(','),
  maxBody: 32 * 1024 * 1024,
  maxImages: 8,
  maxImageBytes: 10 * 1024 * 1024,
};

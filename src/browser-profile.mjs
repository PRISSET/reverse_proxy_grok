import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { atomicJson, privateDir } from './store.mjs';
import { ProxyError } from './errors.mjs';

function validate(profile) {
  if (profile.version !== 1 || profile.engine !== 'patchright' || profile.viewport !== null
      || profile.headless !== false || typeof profile.channel !== 'string'
      || typeof profile.locale !== 'string' || typeof profile.timezoneId !== 'string') {
    throw new ProxyError('Invalid browser-profile.json; restore its original settings', 500, 'browser_profile_invalid');
  }
  try {
    Intl.getCanonicalLocales(profile.locale);
    new Intl.DateTimeFormat(profile.locale, { timeZone: profile.timezoneId }).format();
  } catch {
    throw new ProxyError('Invalid browser locale or timezone', 400, 'browser_profile_invalid');
  }
}

export async function browserProfile(store, id, config, headless = false) {
  // Saved settings describe interactive login; background requests reuse them headlessly.
  const file = path.join(store.dir(id), 'browser-profile.json');
  let profile;
  try { profile = JSON.parse(await readFile(file, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw new ProxyError('Could not read browser-profile.json', 500, 'browser_profile_invalid');
  }
  if (!profile) {
    const host = Intl.DateTimeFormat().resolvedOptions();
    profile = {
      version: 1, engine: 'patchright', channel: config.channel,
      headless: false, viewport: null,
      locale: config.locale || host.locale,
      timezoneId: config.timezoneId || host.timeZone,
      platform: process.platform, arch: process.arch,
    };
    validate(profile);
    await privateDir(store.dir(id));
    await atomicJson(file, profile);
  }
  validate(profile);
  if (profile.channel !== config.channel || profile.platform !== process.platform || profile.arch !== process.arch
      || (config.locale && config.locale !== profile.locale)
      || (config.timezoneId && config.timezoneId !== profile.timezoneId)) {
    throw new ProxyError('Browser settings differ from the saved account profile. Use its original channel, locale, timezone and OS', 400, 'browser_profile_mismatch');
  }
  return profile;
}

export function launchOptions(profile, headless = false) {
  return {
    channel: profile.channel, headless, viewport: null,
    locale: profile.locale, timezoneId: profile.timezoneId,
    timeout: 30000, chromiumSandbox: true,
    ignoreDefaultArgs: ['--password-store=basic', '--use-mock-keychain'],
    acceptDownloads: false,
  };
}

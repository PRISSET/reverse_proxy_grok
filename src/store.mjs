import { mkdir, chmod, readFile, writeFile, rename, readdir, rm, open, readlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { ProxyError } from './errors.mjs';

export function accountId(id) {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(id)) {
    throw new ProxyError('Account ID must contain 1–64 letters, digits, _ or -', 400, 'invalid_account');
  }
  return id;
}

export async function privateDir(dir) {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await chmod(dir, 0o700);
}

export async function atomicJson(file, data) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

export class Store {
  constructor(root) { this.root = root; }
  dir(id) { return path.join(this.root, 'accounts', accountId(id)); }
  profile(id) { return path.join(this.dir(id), 'profile'); }
  async init() {
    await privateDir(this.root);
    await privateDir(path.join(this.root, 'accounts'));
  }
  async read(id) {
    const value = JSON.parse(await readFile(path.join(this.dir(id), 'account.json'), 'utf8'));
    if (value.id !== id) throw new ProxyError('Invalid account metadata', 500, 'invalid_account');
    return value;
  }
  async list() {
    await this.init();
    const result = [];
    for (const entry of await readdir(path.join(this.root, 'accounts'), { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      try { result.push(await this.read(entry.name)); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return result.sort((a, b) => a.id.localeCompare(b.id));
  }
  async save(account) {
    await privateDir(this.dir(account.id));
    await atomicJson(path.join(this.dir(account.id), 'account.json'), account);
  }
  async lock(id) {
    await privateDir(this.dir(id));
    const file = path.join(this.dir(id), 'in-use.lock');
    let handle;
    try { handle = await open(file, 'wx', 0o600); }
    catch (error) {
      if (error.code === 'EEXIST') throw new ProxyError(`Account ${id} is in use; check accounts/server processes`, 409, 'account_busy');
      throw error;
    }
    const owner = `${JSON.stringify({ pid: process.pid, hostname: os.hostname(), namespace: await readlink('/proc/self/ns/pid').catch(() => null), token: randomUUID() })}\n`;
    try { await handle.writeFile(owner); }
    finally { await handle.close(); }
    return async () => {
      try { if (await readFile(file, 'utf8') === owner) await rm(file); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    };
  }
  async apiKey() {
    if (process.env.GROK_PROXY_KEY) return process.env.GROK_PROXY_KEY;
    const file = path.join(this.root, 'api-key');
    try {
      await writeFile(file, `${randomBytes(32).toString('hex')}\n`, { flag: 'wx', mode: 0o600 });
    } catch (error) { if (error.code !== 'EEXIST') throw error; }
    await chmod(file, 0o600);
    return (await readFile(file, 'utf8')).trim();
  }
}

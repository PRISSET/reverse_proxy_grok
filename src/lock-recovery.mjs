import { readFile, readlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ProxyError } from './errors.mjs';

function running(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

export async function recoverLock(store, id, {
  isRunning = running, hostname = os.hostname(),
  namespace = () => readlink('/proc/self/ns/pid').catch(() => null),
} = {}) {
  const file = path.join(store.dir(id), 'in-use.lock');
  let contents;
  try { contents = await readFile(file, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
  const owner = /^\d+\s*$/.test(contents) ? { pid: Number(contents.trim()) } : JSON.parse(contents);
  const busy = message => { throw new ProxyError(message, 409, 'account_busy'); };
  if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0) busy('Invalid lock owner; automatic recovery refused');
  if (owner.hostname && owner.hostname !== hostname) busy('Lock belongs to another host; recovery refused');
  if (owner.namespace && owner.namespace !== await namespace()) busy('Lock belongs to another process namespace; run recovery in the original terminal environment');
  if (isRunning(owner.pid)) busy(`Account ${id}: its accounts/server process is still running. Stop it before recovery`);
  let chromeLock;
  try { chromeLock = await readlink(path.join(store.profile(id), 'SingletonLock')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (chromeLock) {
    const match = /^(.*)-(\d+)$/.exec(chromeLock);
    if (!match || match[1] !== hostname) busy('Chrome profile lock could not be verified on this host');
    if (isRunning(Number(match[2]))) busy(`Account ${id}: Chrome is still running. Close its window before recovery`);
  }
  if (await readFile(file, 'utf8') !== contents) busy('Account lock changed during recovery; retry');
  // Only remove our application lock, never Chromium locks or session data.
  await rm(file);
  return true;
}

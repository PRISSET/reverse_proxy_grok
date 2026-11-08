import { setTimeout as delay } from 'node:timers/promises';
import { bounded } from './deadline.mjs';
import { ProxyError, checkAbort } from './errors.mjs';
import { evaluateMain } from './browser-evaluate.mjs';

// Main-world access to the site's initialized SDK provider. No token forging or UI interaction.
export function discoverCastle() {
  if (typeof globalThis.__grokProxyMint === 'function') return true;
  const roots = [];
  for (const element of document.querySelectorAll('body,body > *,main')) {
    for (const key of Object.getOwnPropertyNames(element)) {
      if (!key.startsWith('__reactFiber$') && !key.startsWith('__reactContainer$')) continue;
      let root = element[key];
      while (root?.return) root = root.return;
      root = root?.stateNode?.current || root?.current || root;
      if (root) roots.push(root);
    }
  }
  const seen = new Set();
  while (roots.length && seen.size < 50000) {
    const node = roots.pop();
    if (!node || seen.has(node)) continue;
    seen.add(node);
    const value = node.memoizedProps?.value;
    const mint = value?.createRequestToken;
    if (typeof mint === 'function' && mint.length > 0) {
      const source = Function.prototype.toString.call(mint);
      if (source.includes('mint_start') && source.includes('createRequestToken')) {
        globalThis.__grokProxyMint = () => mint.call(value, { method: 'chat' });
        return true;
      }
    }
    if (node.child) roots.push(node.child);
    if (node.sibling) roots.push(node.sibling);
  }
  return false;
}

export async function prepareCastle(page, signal, { timeout = 30000 } = {}) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    checkAbort(signal);
    const ready = await bounded(() => evaluateMain(page, discoverCastle), {
      timeout: Math.min(5000, Math.max(1, until - Date.now())), signal,
      code: 'castle_sdk_unavailable', message: 'Grok Castle SDK provider did not initialize',
    });
    if (ready) return;
    await delay(300, undefined, { signal });
  }
  throw new ProxyError('Grok Castle SDK provider was not found in the background context', 502, 'castle_sdk_unavailable');
}

/**
 * Replace Node 25's built-in localStorage with an in-memory shim.
 *
 * Node 25 ships an experimental Web Storage polyfill that warns
 * loudly on every access when no --localstorage-file argument was
 * provided:
 *
 *   Warning: `--localstorage-file` was provided without a valid path
 *
 * @bsv/sdk's HostReputationTracker touches globalThis.localStorage
 * at import time, so every vitest run and every `pnpm agents:swarm`
 * invocation prints 10+ of these warnings before anything useful
 * happens. We fix this by installing an in-memory shim that
 * satisfies the Web Storage interface the SDK expects but never
 * touches Node's polyfill.
 *
 * Side-effect module — import for the side effect at the top of
 * any entry point that loads @bsv/sdk (runners, tests, etc).
 *
 *   import './lib/node-localstorage-shim.js';  // must be first
 *   import { Transaction } from '@bsv/sdk';
 */

const store = new Map<string, string>();

const shim: Storage = {
  get length() {
    return store.size;
  },
  clear() {
    store.clear();
  },
  getItem(key: string) {
    return store.has(key) ? (store.get(key) as string) : null;
  },
  key(index: number) {
    return Array.from(store.keys())[index] ?? null;
  },
  removeItem(key: string) {
    store.delete(key);
  },
  setItem(key: string, value: string) {
    store.set(key, String(value));
  },
};

// Remove Node's built-in before installing our shim. `delete` is
// necessary because Node defines localStorage as a configurable
// getter; plain assignment would otherwise be ignored.
try {
  delete (globalThis as { localStorage?: Storage }).localStorage;
} catch {
  /* already gone */
}

Object.defineProperty(globalThis, 'localStorage', {
  value: shim,
  writable: true,
  configurable: true,
  enumerable: false,
});

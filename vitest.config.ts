import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    testTimeout: 30_000,
    // Replace Node 25's built-in localStorage polyfill with an
    // in-memory shim BEFORE @bsv/sdk loads. Without this every
    // test run prints a blizzard of warnings from the SDK's
    // HostReputationTracker hitting Node's polyfill without a
    // configured --localstorage-file path.
    setupFiles: ['./src/lib/node-localstorage-shim.ts'],
  },
});

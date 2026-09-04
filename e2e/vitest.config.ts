import { defineConfig } from 'vitest/config'

// Every test here talks to live mainnet infrastructure or an anvil fork of it. Files run one at a
// time so public RPC rate limits and the single anvil process are not contended.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    setupFiles: ['./src/support/setup.ts'],
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 10 * 60_000,
    hookTimeout: 10 * 60_000,
    teardownTimeout: 60_000,
    reporters: ['default'],
    passWithNoTests: false,
  },
})

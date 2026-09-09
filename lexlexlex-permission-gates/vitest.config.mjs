import { fileURLToPath } from 'node:url';

// Reuse the pi@0.85.1 package tree already installed for lexlexlex-multicodex.
// Plain .mjs (no `vitest/config` import) so vitest can load this file from a
// directory that does not itself have vitest installed.
const mc = fileURLToPath(new URL('../lexlexlex-multicodex/node_modules/', import.meta.url));

export default {
  test: {
    environment: 'node',
    include: ['index.test.ts'],
  },
  resolve: {
    alias: {
      '@earendil-works/pi-coding-agent': mc + '@earendil-works/pi-coding-agent',
      '@earendil-works/pi-tui': mc + '@earendil-works/pi-tui',
      typebox: mc + 'typebox',
    },
  },
};

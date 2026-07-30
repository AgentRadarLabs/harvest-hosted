#!/usr/bin/env node

import { build } from 'esbuild';
import { resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
await build({
  entryPoints: [resolve(root, 'scripts', 'channel-bridge.mjs')],
  outfile: resolve(root, 'scripts', 'channel-bridge.bundle.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node18',
  legalComments: 'none',
  sourcemap: false,
  banner: {
    js: "import { createRequire as __harvestCreateRequire } from 'node:module'; "
      + 'const require = __harvestCreateRequire(import.meta.url);',
  },
});

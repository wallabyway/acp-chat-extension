// Build: vendor Alpine (CSP build) and compile Tailwind for the panel.
// MV3 forbids remotely hosted code, so everything ships inside extension/.
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ext = join(root, 'extension');

mkdirSync(join(ext, 'vendor'), { recursive: true });
mkdirSync(join(ext, 'dist'), { recursive: true });

copyFileSync(
  join(root, 'node_modules/@alpinejs/csp/dist/module.esm.min.js'),
  join(ext, 'vendor/alpine-csp.esm.js'),
);
console.log('vendored  extension/vendor/alpine-csp.esm.js');

execFileSync(
  join(root, 'node_modules/.bin/tailwindcss'),
  ['-i', join(ext, 'panel.src.css'), '-o', join(ext, 'dist/panel.css'), '--minify'],
  { stdio: 'inherit', cwd: root },
);
console.log('built     extension/dist/panel.css');

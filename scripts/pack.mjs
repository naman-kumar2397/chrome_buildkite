// Build the zip that gets uploaded to the Chrome Web Store.
// Ships only what the extension runs — no tests, scripts, docs or CI config.

import { mkdir, readFile, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import path from 'node:path';

const run = promisify(execFile);
const ROOT = fileURLToPath(new URL('..', import.meta.url));

// Everything the extension loads at runtime, and nothing else.
const SHIPPED = [
  'manifest.json',
  'background.js',
  'status.js',
  'discovery.js',
  'content.js',
  'offscreen.html',
  'offscreen.js',
  'popup.html',
  'popup.css',
  'popup.js',
  'vendor/apple.css',
  'vendor/motion.css',
  'icons/icon16.png',
  'icons/icon48.png',
  'icons/icon128.png',
];

const manifest = JSON.parse(await readFile(path.join(ROOT, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));

if (manifest.version !== pkg.version) {
  console.error(`version mismatch: manifest.json ${manifest.version} vs package.json ${pkg.version}`);
  process.exit(1);
}

// Every shipped file must exist, and every local file the manifest names must ship.
for (const file of SHIPPED) {
  try {
    await stat(path.join(ROOT, file));
  } catch {
    console.error(`missing file listed in pack.mjs: ${file}`);
    process.exit(1);
  }
}

const referenced = new Set();
const walk = (node) => {
  if (typeof node === 'string') {
    if (/\.(js|css|html|png)$/.test(node) && !node.startsWith('http')) referenced.add(node);
  } else if (Array.isArray(node)) node.forEach(walk);
  else if (node && typeof node === 'object') Object.values(node).forEach(walk);
};
walk(manifest);
const missing = [...referenced].filter((f) => !SHIPPED.includes(f));
if (missing.length) {
  console.error(`manifest references files that pack.mjs does not ship: ${missing.join(', ')}`);
  process.exit(1);
}

const outDir = path.join(ROOT, 'dist');
await mkdir(outDir, { recursive: true });
const zipName = `buildkite-build-watcher-${manifest.version}.zip`;
const outPath = path.join(outDir, zipName);

await run('rm', ['-f', outPath]);
await run('zip', ['-q', '-X', outPath, ...SHIPPED], { cwd: ROOT });

const { size } = await stat(outPath);
console.log(`${zipName}  ${(size / 1024).toFixed(1)} KB`);
for (const file of SHIPPED) console.log(`  ${file}`);
export { SHIPPED };

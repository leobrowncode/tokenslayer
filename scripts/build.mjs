import { build } from 'esbuild';
import { cpSync, mkdirSync, rmSync } from 'node:fs';

rmSync('dist', { recursive: true, force: true });
mkdirSync('dist/renderer', { recursive: true });

const common = { bundle: true, sourcemap: true, target: 'es2022', logLevel: 'warning' };

await Promise.all([
  build({ ...common, entryPoints: ['src/main/main.ts'], outfile: 'dist/main.js', platform: 'node', format: 'cjs', external: ['electron'] }),
  build({ ...common, entryPoints: ['src/main/preload.ts'], outfile: 'dist/preload.js', platform: 'node', format: 'cjs', external: ['electron'] }),
  build({ ...common, entryPoints: ['src/renderer/renderer.ts'], outfile: 'dist/renderer/renderer.js', platform: 'browser', format: 'iife' }),
  build({ ...common, entryPoints: ['src/tools/probe.ts'], outfile: 'dist/probe.js', platform: 'node', format: 'cjs' }),
  build({ ...common, entryPoints: ['src/tools/make-icon.ts'], outfile: 'dist/make-icon.js', platform: 'node', format: 'cjs' }),
  build({ ...common, entryPoints: ['src/tools/demo.ts'], outfile: 'dist/demo.js', platform: 'node', format: 'cjs', external: ['electron'] }),
]);

cpSync('src/renderer/index.html', 'dist/renderer/index.html');
cpSync('src/renderer/styles.css', 'dist/renderer/styles.css');
console.log('built dist/');

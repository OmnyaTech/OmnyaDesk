import { copyFile, mkdir, cp } from 'node:fs/promises';
await mkdir('dist/apps/web', { recursive: true });
await copyFile('apps/web/index.html', 'dist/apps/web/index.html');
await cp('infra/migrations', 'dist/infra/migrations', { recursive: true });
await mkdir('dist/scripts', { recursive: true });
await copyFile('scripts/remote-tool-files.py', 'dist/scripts/remote-tool-files.py');
await import('../apps/web/build.mjs');
console.log('Static web + authenticated React operator, S13 file helper and migrations copied');

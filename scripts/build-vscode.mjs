import {build} from '../apps/web/node_modules/esbuild/lib/main.js';
import {mkdir} from 'node:fs/promises';
const out='apps/vscode/dist';
await mkdir(out,{recursive:true});
await build({entryPoints:['apps/vscode/src/extension.ts'],outfile:out+'/extension.cjs',
 platform:'node',format:'cjs',target:'node22',bundle:true,external:['vscode'],
 legalComments:'none',logLevel:'warning'});
await build({entryPoints:['apps/vscode/src/webview.jsx'],outdir:out,
 entryNames:'webview',platform:'browser',format:'iife',bundle:true,target:['es2022'],
 jsx:'automatic',loader:{'.jsx':'jsx'},minify:true,legalComments:'none',logLevel:'warning'});
console.log('PASS: S26 VS Code extension host and local React/Phaser Webview assets built without remote CDN');

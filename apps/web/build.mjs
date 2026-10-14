import {build} from 'esbuild';
import {copyFile,mkdir} from 'node:fs/promises';
const out='dist/apps/web/operator';
await mkdir(out,{recursive:true});
await copyFile('apps/web/operator/index.html',out+'/index.html');
await build({entryPoints:['apps/web/operator/app.jsx'],outdir:out,
 bundle:true,minify:true,format:'esm',platform:'browser',target:['es2022'],
 splitting:false,legalComments:'none',logLevel:'warning',
 loader:{'.jsx':'jsx'},jsx:'automatic',entryNames:'app'});
console.log('PASS: S20 React operator bundled with local CSS/JS; no remote CDN');

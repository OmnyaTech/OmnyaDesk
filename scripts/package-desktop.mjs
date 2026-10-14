import {cp,mkdir,copyFile} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {tmpdir,homedir} from 'node:os';
import {spawnSync} from 'node:child_process';

if(process.platform!=='win32')throw Error('Windows desktop packaging requires a Windows host');
const stage=resolve(process.env.OMNYA_DESKTOP_STAGE||join(tmpdir(),'omnyadesk-tauri-stage'));
if(stage.includes("'"))throw Error('Choose OMNYA_DESKTOP_STAGE without an apostrophe (rc.exe limitation)');
if(stage.includes('node_modules')||stage.includes('.git'))throw Error('Unsafe desktop staging location');
const nativeSrc=resolve('apps/desktop/src-tauri');
const nativeDst=join(stage,'apps','desktop','src-tauri');
const resources=join(stage,'dist','apps','desktop');
await mkdir(nativeDst,{recursive:true});
await mkdir(resources,{recursive:true});
for(const path of ['Cargo.toml','Cargo.lock','build.rs','tauri.conf.json']){
 if(existsSync(join(nativeSrc,path)))await copyFile(join(nativeSrc,path),join(nativeDst,path));
}
for(const name of ['src','capabilities','icons']){
 await cp(join(nativeSrc,name),join(nativeDst,name),{recursive:true,force:true});
}
for(const name of ['index.html','app.js','app.css']){
 await copyFile(resolve('dist/apps/desktop',name),join(resources,name));
}
const cargo=process.env.CARGO||join(homedir(),'.cargo','bin','cargo.exe');
const profile=process.argv.includes('--debug')?'debug':'release';
const cmd=['build','--manifest-path',join(nativeDst,'Cargo.toml')];
if(profile==='release')cmd.push('--release');
console.log('Building Tauri '+profile+' in sanitized local staging directory');
const done=spawnSync(cargo,cmd,{stdio:'inherit',windowsHide:true,env:process.env});
if(done.status!==0)throw Error('Tauri '+profile+' build failed (exit '+done.status+')');
const from=join(nativeDst,'target',profile,'omnyadesk-desktop.exe');
const out=resolve('dist/apps/desktop-bin');
await mkdir(out,{recursive:true});
const target=join(out,'omnyadesk-desktop.exe');
await copyFile(from,target);
console.log('PASS: Windows executable available at dist/apps/desktop-bin/omnyadesk-desktop.exe');

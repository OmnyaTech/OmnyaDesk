#!/usr/bin/env node
/**
 * Publication boundary scanner. Conservative rules: checks tracked release
 * contents, disallows symlinks, known secret formats and workstation-specific
 * hostnames/paths. This is defense in depth, not a guarantee of no secrets.
 */
import {readFileSync,readdirSync,lstatSync} from 'node:fs';
import {join,relative,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root=resolve(fileURLToPath(new URL('..',import.meta.url)));
const excluded=new Set(['.git','node_modules','dist','coverage','.nox','.tmp','.worktrees']);
const flags=[
 ['pem_private_key',/-----BEGIN (?:OPENSSH|RSA|EC|DSA|PGP)? ?PRIVATE KEY-----/i],
 ['github_access_token',/(?:ghp_|gho_|ghu_|ghs_|github_pat_)[A-Za-z0-9_]{20,}/],
 ['aws_access_key',/\bAKIA[0-9A-Z]{16}\b/],
 ['openai_api_key',/\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/],
 ['google_api_key',/\bAIza[0-9A-Za-z_-]{32,}\b/],
 ['private_ipv4',/\b(?:10\.(?:\d{1,3}\.){2}\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/],
 ['private_workstation_path',/\b[A-Z]:\\(?:Users|OmnyaTech Project)[\\ \w'._-]*/i],
 ['private_unix_user_path',/\/home\/(?:yan|yanog)\//i],
 ['private_server_alias',new RegExp('omnyatech'+'-server','i')],
 ['private_pc_name',new RegExp('PCG'+'-Y','i')],
 ['private_email',new RegExp('(backupcellyan|yanoliveiragm)'+'@gmail\\.com','i')],
 ['runtime_state',/\/(?:pgdata|\.ssh|\.nox)\/(?:db-config\.json|pw\.secret|id_ed25519)/i],
 ['embedded_postgresql_credentials',/\bpostgres(?:ql)?:\/\/[^\s:/@]+:([^@\s/]+)@/i]
];
const allowPassword=new Set(['REPLACE_WITH_GENERATED_VALUE','ci_test_only']);
const issues=[];
let files=0,bytes=0;
function visit(dir){
 for(const ent of readdirSync(dir,{withFileTypes:true})){
  if(excluded.has(ent.name))continue;
  const full=join(dir,ent.name),rp=relative(root,full).replaceAll('\\','/');
  const st=lstatSync(full);
  if(st.isSymbolicLink()){issues.push(rp+': symlink in public snapshot');continue;}
  if(st.isDirectory()){visit(full);continue;}
  if(!st.isFile())continue;
  if(st.size>4*1024*1024){issues.push(rp+': file larger than 4MiB');continue;}
  const bytesFile=readFileSync(full);
  if(rp==='apps/desktop/src-tauri/icons/icon.ico' && st.size<100000 && bytesFile[0]===0 && bytesFile[1]===0 && bytesFile[2]===1 && bytesFile[3]===0){files++;bytes+=st.size;continue;}
  if(bytesFile.includes(0)){issues.push(rp+': binary file not allowlisted');continue;}
  let content;
  try{content=new TextDecoder('utf-8',{fatal:true}).decode(bytesFile);}
  catch{issues.push(rp+': non UTF-8 file');continue;}
  files++;bytes+=st.size;
  for(const [kind,pattern] of flags){
   const match=content.match(pattern);
   if(!match)continue;
   if(kind==='embedded_postgresql_credentials'&&allowPassword.has(match[1]))continue;
   const line=content.slice(0,match.index).split('\n').length;
   issues.push(rp+':'+line+': '+kind);
  }
 }
}
visit(root);
if(issues.length){
 console.error('PUBLICATION_AUDIT=FAIL ('+issues.length+' findings). Names only, no secret values:');
 for(const issue of issues)console.error(issue);
 process.exitCode=1;
}else console.log('PUBLICATION_AUDIT=PASS; files='+files+' bytes='+bytes+'; no matching sensitive patterns. Manual review still required.');

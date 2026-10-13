import {randomBytes} from 'node:crypto';
import {existsSync,openSync,writeFileSync,closeSync} from 'node:fs';
import {join,resolve} from 'node:path';

const root=resolve(import.meta.dirname,'..');
const env=join(root,'.env');
if(existsSync(env)){
 console.error('Local .env already exists; refusing to overwrite credentials.');
 process.exitCode=1;
}else{
 const password=randomBytes(24).toString('hex');
 const url=new URL('postgresql://omnyadesk@127.0.0.1:5433/omnyadesk');
 url.password=password;
 const vars=[
  '# AUTO-GENERATED local development ONLY — never commit or share this file.',
  'OMNYA_HOST=127.0.0.1',
  'OMNYA_PORT=4317',
  'POSTGRES_HOST=127.0.0.1',
  'POSTGRES_PORT=5433',
  'POSTGRES_USER=omnyadesk',
  'POSTGRES_DB=omnyadesk',
  'POSTGRES_PASSWORD='+password,
  'DATABASE_URL='+url.href,
  ''
 ].join('\n');
 const fd=openSync(env,'wx',0o600);
 try{writeFileSync(fd,vars,{encoding:'utf8'});}
 finally{closeSync(fd);}
 console.log('Created ignored .env with a new random local-only database password. Credentials were not printed.');
}

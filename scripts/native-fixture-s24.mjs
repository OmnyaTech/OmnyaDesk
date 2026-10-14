import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createPool,runMigrations} from '../packages/db/src/migrations.ts';
import {WorkstationRegistry} from '../packages/db/src/workstation.ts';
import {PostgresOfficeRepository} from '../packages/db/src/repository.ts';
import {buildPersistentApi} from '../apps/api/src/server.ts';

if(process.env.OMNYA_S24_SYNTHETIC_TEST!=='1'||!process.env.DATABASE_URL)throw Error('Synthetic test only');
const sessionFile=process.env.OMNYA_S24_SECRET_FILE;
if(!sessionFile)throw Error('Explicit temporary session file path required');
const root=await mkdtemp(join(tmpdir(),'s24-native-fixture-'));
process.env.OMNYA_WORKSTATION_ALLOWED_ROOTS=root;
const pool=createPool(process.env.DATABASE_URL);
await runMigrations(pool);
const registry=new WorkstationRegistry(pool),subjectId=randomUUID();
// Manual Windows QA may span several hours; never use this fixture outside the synthetic flag.
const session=await registry.issue(subjectId,24);
const repo=new PostgresOfficeRepository(pool);
for(const name of ['Synthetic Alpha','Synthetic Beta']){
 const dir=join(root,name);await mkdir(dir);
 const project=await registry.register({id:session.id,subjectId},{path:dir,name},root);
 const office=await pool.query('SELECT id FROM offices WHERE project_id=$1',[project.id]);
 await repo.createTask({projectId:project.id,officeId:office.rows[0].id,requestedBy:subjectId,
  title:'S24 '+name+' verified task',description:'Synthetic native integration; never production data'});
}
await writeFile(sessionFile,session.secret,{encoding:'utf8',mode:0o600,flag:'wx'});
const api=await buildPersistentApi(pool);
await api.listen({port:4317,host:'127.0.0.1'});
console.log('S24_NATIVE_FIXTURE_READY projectCount=2 host=127.0.0.1');
let closing=false;
const close=async()=>{if(closing)return;closing=true;await api.close();await pool.query('UPDATE workstation_sessions SET revoked_at=now() WHERE id=$1',[session.id]);
 await pool.end();await rm(root,{recursive:true,force:true});await rm(sessionFile,{force:true});process.exit(0);};
process.on('SIGINT',()=>{void close()});process.on('SIGTERM',()=>{void close()});
process.stdin.resume();

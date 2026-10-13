import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {createPool,runMigrations} from '../../../packages/db/src/migrations.ts';
import {WorkerQueue} from '../../../packages/db/src/worker-queue.ts';
import {WorkerRuntime,simulatedWork} from '../../../packages/db/src/worker-runtime.ts';

const databaseUrl=process.env.DATABASE_URL;
if(!databaseUrl)throw Error('DATABASE_URL required for local worker');
const leaseMs=Number(process.env.WORKER_LEASE_MS??1500);
const duration=Number(process.env.WORKER_SIMULATED_MS??100);
const projectId=process.env.WORKER_PROJECT_ID||undefined;
const once=process.argv.includes('--once');
const pool=createPool(databaseUrl);
await runMigrations(pool);
const id='worker-'+randomUUID();
const runtime=new WorkerRuntime(new WorkerQueue(pool),id,leaseMs,projectId);
let stopping=false;
process.once('SIGTERM',()=>{stopping=true;});
process.once('SIGINT',()=>{stopping=true;});
console.log('S06_WORKER_READY '+id);
try{
 do{
  const result=await runtime.once(
   (job,signal)=>simulatedWork(job,signal,duration),
   job=>console.log('S06_JOB_CLAIMED '+job.id));
  console.log('S06_RESULT '+result);
  if(once||stopping)break;
  if(result==='idle')await delay(200);
 }while(!stopping);
}finally{await pool.end();}

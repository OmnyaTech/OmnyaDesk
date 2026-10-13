import {readFileSync} from 'node:fs';
import {createPool,runMigrations} from '../../../packages/db/src/migrations.ts';
import {UbuntuSshTransport} from '../../../packages/db/src/remote-ubuntu.ts';
import {RemoteWorktreeManager} from '../../../packages/db/src/remote-worktrees.ts';

const [action,projectId,target,sha]=process.argv.slice(2).filter(v=>v!=='--');
const db=process.env.DATABASE_URL,configFile=process.env.OMNYA_S12_REMOTE_CONFIG;
if(!db||!configFile)throw Error('DATABASE_URL and OMNYA_S12_REMOTE_CONFIG required');
if(!['create','close','get'].includes(action??'')||!projectId||!target)
 throw Error('worktree create|get|close <project UUID> <task/run UUID> [commit SHA]. Execution ONLY via S13 authorized gateway.');
const ssh=new UbuntuSshTransport(JSON.parse(readFileSync(configFile,'utf8')));
const pool=createPool(db);
try{
 await runMigrations(pool);
 const manager=new RemoteWorktreeManager(pool,ssh);
 switch(action){
  case 'create':{
   if(!sha)throw Error('SHA40 required');
   const worktree=await manager.create({projectId,taskId:target,baseSha:sha});
   console.log(JSON.stringify({worktree}));break;
  }
  case 'get':console.log(JSON.stringify({worktree:await manager.get(projectId,target)}));break;
  case 'close':console.log(JSON.stringify({closed:await manager.close(projectId,target)}));break;
 }
}finally{ssh.close();await pool.end();}

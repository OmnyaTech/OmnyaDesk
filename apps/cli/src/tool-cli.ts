import {readFileSync} from 'node:fs';
import {createPool,runMigrations} from '../../../packages/db/src/migrations.ts';
import {UbuntuSshTransport} from '../../../packages/db/src/remote-ubuntu.ts';
import {RemoteWorktreeManager} from '../../../packages/db/src/remote-worktrees.ts';
import {UbuntuToolGateway,ToolRequestSchema} from '../../../packages/db/src/tool-gateway.ts';

const config=process.env.OMNYA_S12_REMOTE_CONFIG,database=process.env.DATABASE_URL;
const jsonFile=process.argv.slice(2).find(x=>x!=='--');
if(!config||!database||!jsonFile||process.argv.slice(2).filter(x=>x!=='--').length!==1)
 throw Error('Usage: pnpm run tool -- <local request.json>; DATABASE_URL and OMNYA_S12_REMOTE_CONFIG required');
const request=ToolRequestSchema.parse(JSON.parse(readFileSync(jsonFile,'utf8')));
const pool=createPool(database),ssh=new UbuntuSshTransport(JSON.parse(readFileSync(config,'utf8')));
try{
 await runMigrations(pool);
 const result=await new UbuntuToolGateway(pool,new RemoteWorktreeManager(pool,ssh)).run(request);
 console.log(JSON.stringify({tool:result.tool,success:result.success,durationMs:result.durationMs,
  result:result.result}));
 if(!result.success)process.exitCode=1;
}finally{ssh.close();await pool.end();}

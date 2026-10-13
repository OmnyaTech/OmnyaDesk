import {createPool,runMigrations} from '../../../packages/db/src/migrations.ts';
import {PostgresOfficeRepository} from '../../../packages/db/src/repository.ts';
import {UuidSchema} from '../../../packages/contracts/src/domain.ts';
if(!process.env.DATABASE_URL)throw Error('DATABASE_URL must be set in local terminal');
const [ownerId,name,template='startup']=process.argv.slice(2).filter((v,i)=>i!==0||v!=='--');
const owner=UuidSchema.parse(ownerId);
if(!name||name.trim().length>140)throw Error('Name required (max 140 chars)');
if(!['startup','accounting','custom'].includes(template))throw Error('Unknown office template');
const pool=createPool(process.env.DATABASE_URL);
try{
 await runMigrations(pool);
 const {project,office}=await new PostgresOfficeRepository(pool).createProject({
  ownerId:owner,name,repositoryRoot:null,template:template as 'startup'|'accounting'|'custom'
 });
 console.log(JSON.stringify({projectId:project.id,officeId:office.id,ownerId:owner}));
}finally{await pool.end();}

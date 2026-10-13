import {createPool,runMigrations} from '../../../packages/db/src/migrations.ts';
import {TokenStore,ApiScopeSchema,ClientOriginSchema,IntakeChannelSchema} from '../../../packages/db/src/tokens.ts';
import {UuidSchema} from '../../../packages/contracts/src/domain.ts';

// Trusted local CLI, not an HTTP issuance endpoint. The DB credential is necessary.
const [projectId,subjectId,kind,scopesText,hoursText,originText='cli',channelText='api']=process.argv.slice(2).filter((v,i)=>i!==0||v!=='--');
if(!process.env.DATABASE_URL)throw Error('DATABASE_URL must be configured locally');
const project=UuidSchema.parse(projectId),subject=UuidSchema.parse(subjectId);
if(kind!=='human'&&kind!=='integration')throw Error('Expected human or integration');
const scopes=String(scopesText??'').split(',').map(s=>ApiScopeSchema.parse(s));
const hours=Number(hoursText??24);
const pool=createPool(process.env.DATABASE_URL);
try{
 await runMigrations(pool);
 const token=await new TokenStore(pool).provision({
  projectId:project,subjectId:subject,kind,scopes,expiresInHours:hours,
  origin:ClientOriginSchema.parse(originText),channel:IntakeChannelSchema.parse(channelText)
 });
 console.log('Token ID: '+token.id);
 console.log('Expires: '+token.expiresAt);
 console.log('COPY ONCE, KEEP PRIVATE (secret is not recoverable):');
 console.log(token.secret);
}finally{await pool.end();}

import {createPool,runMigrations} from '../../../packages/db/src/migrations.ts';
import {TokenStore} from '../../../packages/db/src/tokens.ts';
import {UuidSchema} from '../../../packages/contracts/src/domain.ts';
if(!process.env.DATABASE_URL)throw Error('DATABASE_URL must be set in local terminal');
const id=UuidSchema.parse(process.argv.slice(2).find(x=>x!=='--'));
const pool=createPool(process.env.DATABASE_URL);
try{
 await runMigrations(pool);
 const revoked=await new TokenStore(pool).revoke(id);
 console.log(revoked?'Token revoked':'Token already revoked or not found');
 if(!revoked)process.exitCode=1;
}finally{await pool.end();}

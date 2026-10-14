import {createPool,runMigrations} from '../../../packages/db/src/migrations.ts';
import {WorkstationRegistry} from '../../../packages/db/src/workstation.ts';
import {UuidSchema} from '../../../packages/contracts/src/domain.ts';
const subjectId=UuidSchema.parse(process.argv[2]);
if(!process.env.DATABASE_URL)throw Error('DATABASE_URL required');
const pool=createPool(process.env.DATABASE_URL);
try {
 await runMigrations(pool);
 const issued=await new WorkstationRegistry(pool).issue(subjectId);
 // Deliberately print once to the local terminal only; never write secrets to git or .nox.
 console.log('Workstation identity: '+issued.id);
 console.log('Expires: '+issued.expiresAt);
 console.log('One-time enrollment key (do not log/share): '+issued.secret);
} finally {await pool.end();}

import { createPool, runMigrations } from './migrations.ts';
const pool=createPool(process.env.DATABASE_URL??'');
try {
  const applied=await runMigrations(pool);
  console.log(JSON.stringify({status:'PASS',applied,migrationsApplied:applied.length}));
} finally {await pool.end();}

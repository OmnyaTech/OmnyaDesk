import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { Pool } from 'pg';
const migrationsDir = fileURLToPath(new URL('../../../infra/migrations/',import.meta.url));
export async function runMigrations(pool: Pool): Promise<string[]> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Same lock across all instances of this application; releases on commit/rollback.
    await client.query('SELECT pg_advisory_xact_lock(711133, 4)');
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, sha256 char(64) NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const files=(await readdir(migrationsDir)).filter(x=>/^\d{3}_[a-z0-9_-]+\.sql$/.test(x)).sort();
    const applied:string[]=[];
    for (const name of files) {
      const sql=await readFile(join(migrationsDir,name),'utf8');
      // SQL is text: normalize platform CRLF/LF before hashing so checkout is reproducible.
      const checksum=createHash('sha256').update(sql.replace(/\r\n/g,'\n')).digest('hex');
      const previous=await client.query<{sha256:string}>('SELECT sha256 FROM schema_migrations WHERE name=$1',[name]);
      if (previous.rowCount) {
        if (previous.rows[0]?.sha256!==checksum) throw new Error('Migration checksum changed: '+name);
        continue;
      }
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name,sha256) VALUES ($1,$2)',[name,checksum]);
      applied.push(name);
    }
    await client.query('COMMIT');
    return applied;
  } catch(error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

export function createPool(connectionString:string): Pool {
  if (!connectionString) throw new Error('DATABASE_URL is required');
  return new Pool({connectionString,max:5,connectionTimeoutMillis:5000,idleTimeoutMillis:3000,statement_timeout:15000});
}

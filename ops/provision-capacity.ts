import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { normalizePlayerProfile } from '../src/shared/catalog.ts';

// Create test-only sessions on a dedicated, preinitialized capacity database.
const { LOAD_DATABASE_URL, LOAD_COOKIE_FILE } = process.env;
if (process.env.LOAD_ISOLATED !== '1' || !LOAD_DATABASE_URL || !LOAD_COOKIE_FILE || process.env.NODE_ENV === 'production') {
  throw new Error('Set LOAD_ISOLATED=1, LOAD_DATABASE_URL and LOAD_COOKIE_FILE on the isolated load test machine');
}
const size = Number(process.env.LOAD_USERS ?? 1000);
if (!Number.isInteger(size) || size < 6 || size > 2000) throw new Error('Invalid LOAD_USERS');
const run = randomUUID();
const pool = new Pool({ connectionString: LOAD_DATABASE_URL });
const client = await pool.connect();
const cookies: string[] = [];
try {
  await client.query('BEGIN');
  for (let i = 0; i < size; i++) {
    const id = randomUUID();
    const raw = randomBytes(32).toString('base64url');
    const password = randomBytes(16).toString('hex') + ':' + randomBytes(64).toString('hex');
    await client.query('INSERT INTO accounts(id,email,password_hash,verified,profile) VALUES ($1,$2,$3,true,$4)', [id,run+'-'+i+'@capacity.invalid',password,normalizePlayerProfile({ callsign:'Capacity '+i },id)]);
    await client.query("INSERT INTO sessions(digest,account_id,expires_at) VALUES ($1,$2,now()+interval '6 hours')", [createHash('sha256').update(raw).digest('hex'),id]);
    cookies.push('prism_session='+raw);
  }
  await client.query('COMMIT');
  await writeFile(LOAD_COOKIE_FILE, JSON.stringify(cookies), { mode: 0o600, flag: 'wx' });
} finally {
  client.release();
  await pool.end();
}

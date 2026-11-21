import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { link, open, readFile, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';

export interface Counts {
  accounts: string;
  verifiedAccounts: string;
  finishedMatches: string;
  committedPlayerResults: string;
  totalXp: string;
}
export interface Manifest {
  version: 1;
  format: 'postgres-custom';
  createdAt: string;
  database: string;
  sha256: string;
  bytes: number;
  pgDumpVersion: string;
  counts: Counts;
}

export function argumentsFor(allowed: string[]): Record<string, string> {
  const result: Record<string, string> = {};
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!allowed.includes(flag) || !value || value.startsWith('--') || result[flag]) throw new Error('Invalid arguments. Use --help for usage.');
    result[flag] = value;
  }
  return result;
}
export function databaseUrl(name: string): string {
  const raw = process.env[name];
  if (!raw) throw new Error(name + ' must point to the intended PostgreSQL database.');
  const url = new URL(raw);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.pathname.slice(1)) throw new Error(name + ' must be a PostgreSQL URL with an explicit database name.');
  return raw;
}

// Pass connection secrets through the environment, never through process argv or logs.
export function toolEnvironment(raw: string): NodeJS.ProcessEnv {
  const url = new URL(raw);
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('PG')));
  const env: NodeJS.ProcessEnv = { ...inherited,
    PGHOST: url.hostname.replace(/^\[|\]$/g, ''), PGPORT: url.port || '5432',
    PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: decodeURIComponent(url.pathname.slice(1)), PGCONNECT_TIMEOUT: '5',
  };
  const parameters: Record<string, string> = {
    host: 'PGHOST', port: 'PGPORT', user: 'PGUSER', password: 'PGPASSWORD', dbname: 'PGDATABASE',
    sslmode: 'PGSSLMODE', sslrootcert: 'PGSSLROOTCERT', sslcert: 'PGSSLCERT', sslkey: 'PGSSLKEY',
    sslpassword: 'PGSSLPASSWORD', channel_binding: 'PGCHANNELBINDING', options: 'PGOPTIONS', connect_timeout: 'PGCONNECT_TIMEOUT',
  };
  for (const [name, value] of url.searchParams) {
    if (!parameters[name]) throw new Error('Unsupported PostgreSQL URL option: ' + name);
    if (['host','port','user','password','dbname'].includes(name)) throw new Error('Use PostgreSQL URL authority/path for host, port, user, password and database.');
    env[parameters[name]] = value;
  }
  return env;
}
export async function pgTool(name: 'pg_dump' | 'pg_restore', args: string[], raw: string): Promise<string> {
  const executable = process.env.PG_BIN_DIR ? path.join(process.env.PG_BIN_DIR, name) : name;
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { env: toolEnvironment(raw), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    // Deliberately do not echo libpq diagnostics, which can include connection details.
    child.stdout.on('data', chunk => { stdout = (stdout + String(chunk)).slice(-8192); });
    child.stderr.resume();
    child.once('error', () => reject(new Error(name + ' could not start. Check PG_BIN_DIR, client libraries and permissions.')));
    child.once('close', code => code === 0 ? resolve(stdout.trim()) : reject(new Error(name + ' failed. Check client/server compatibility, connectivity, permissions and available disk space.')));
  });
}
export async function checksum(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}
export async function counts(client: Client): Promise<Counts> {
  const { rows } = await client.query<Counts>(
    'SELECT (SELECT count(*)::text FROM accounts) AS accounts,' +
    ' (SELECT count(*)::text FROM accounts WHERE verified) AS "verifiedAccounts",' +
    ' (SELECT count(*)::text FROM matches WHERE status=\'finished\') AS "finishedMatches",' +
    ' (SELECT count(*)::text FROM match_players p JOIN matches m ON m.id=p.match_id WHERE m.status=\'finished\' AND p.summary IS NOT NULL) AS "committedPlayerResults",' +
    ' (SELECT coalesce(sum((profile->\'stats\'->>\'xp\')::numeric),0)::text FROM accounts) AS "totalXp"',
  );
  return rows[0];
}
export function safeError(error: unknown): string {
  return error instanceof Error && !('code' in error) && !('severity' in error) && !error.message.includes('://') ? error.message : 'Database operation failed. Check connectivity, role permissions, configuration and the isolated database.';
}
export async function readManifest(file: string): Promise<Manifest> {
  const body = JSON.parse(await readFile(file, 'utf8')) as Manifest;
  if (body.version !== 1 || body.format !== 'postgres-custom' || typeof body.database !== 'string' || !/^[0-9a-f]{64}$/.test(body.sha256) || !Number.isSafeInteger(body.bytes) || body.bytes <= 0 ||
      !body.counts || !['accounts','verifiedAccounts','finishedMatches','committedPlayerResults','totalXp'].every(key => /^\d+$/.test(body.counts[key as keyof Counts]))) throw new Error('Invalid backup manifest.');
  return body;
}

async function main() {
  if (process.argv.includes('--help')) {
    console.log('DATABASE_URL=... [PG_BIN_DIR=...] npm run db:backup -- --out /secure/backups/prism.dump\nCreates a custom PostgreSQL archive and adjacent .json manifest. Existing files are never replaced.');
    return;
  }
  process.umask(0o077);
  const args = argumentsFor(['--out']);
  if (!args['--out']) throw new Error('--out is required. Store backups outside the repository.');
  const out = path.resolve(args['--out']);
  const manifestFile = out + '.json';
  for (const file of [out, manifestFile]) {
    const exists = await stat(file).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
    if (exists) throw new Error('Backup archive or manifest already exists. Choose a new output name.');
  }
  const raw = databaseUrl('DATABASE_URL');
  const version = await pgTool('pg_dump', ['--version'], raw);
  const temporary = out + '.' + randomUUID() + '.part';
  const descriptor = await open(temporary, 'wx', 0o600);
  await descriptor.close();
  const client = new Client({ connectionString: raw, connectionTimeoutMillis: 5000, application_name: 'prism-backup' });
  let archiveInstalled = false;
  try {
    await client.connect();
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const { rows } = await client.query<{ snapshot: string; database: string }>('SELECT pg_export_snapshot() AS snapshot, current_database() AS database');
    const snapshot = rows[0];
    const expected = await counts(client);
    await pgTool('pg_dump', ['--format=custom','--no-owner','--no-acl','--snapshot=' + snapshot.snapshot,'--file=' + temporary], raw);
    await client.query('COMMIT');
    const size = (await stat(temporary)).size;
    const manifest: Manifest = { version: 1, format: 'postgres-custom', createdAt: new Date().toISOString(), database: snapshot.database,
      sha256: await checksum(temporary), bytes: size, pgDumpVersion: version, counts: expected };
    await link(temporary, out);
    archiveInstalled = true;
    const metadata = await open(manifestFile, 'wx', 0o600);
    try { await metadata.writeFile(JSON.stringify(manifest, null, 2) + '\n'); await metadata.sync(); } finally { await metadata.close(); }
    console.log(JSON.stringify({ ok: true, archive: out, manifest: manifestFile, bytes: size, counts: expected }));
  } catch (error) {
    if (archiveInstalled) await unlink(out).catch(() => {});
    throw error;
  } finally {
    await client.end().catch(() => {});
    await unlink(temporary).catch(() => {});
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main().catch(error => { console.error(safeError(error)); process.exitCode = 1; });
}

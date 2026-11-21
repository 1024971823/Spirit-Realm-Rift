import { stat } from 'node:fs/promises';
import path from 'node:path';
import { Client } from 'pg';
import { argumentsFor, checksum, counts, databaseUrl, pgTool, readManifest, safeError } from './backup.ts';

async function main() {
  if (process.argv.includes('--help')) {
    console.log('RESTORE_ADMIN_URL=... [PG_BIN_DIR=...] npm run db:restore -- --from /secure/backups/prism.dump --database prism_restore_YYYYMMDD\nCreates a NEW database only. Refuses existing databases and the archive source database name. Restored sessions/tokens are removed; unfinished games are cancelled.');
    return;
  }
  process.umask(0o077);
  const args = argumentsFor(['--from','--database']);
  const targetName = args['--database'];
  if (!args['--from'] || !targetName || !/^prism_restore_[a-z0-9_]{1,49}$/.test(targetName)) throw new Error('Provide --from and a new --database named prism_restore_<name> (at most 63 characters).');
  const archive = path.resolve(args['--from']);
  const manifest = await readManifest(archive + '.json');
  if (manifest.database === targetName) throw new Error('Refusing to restore to the source database name.');
  if ((await stat(archive)).size !== manifest.bytes || await checksum(archive) !== manifest.sha256) throw new Error('Archive checksum or length does not match the manifest. No database was created.');
  const adminRaw = databaseUrl('RESTORE_ADMIN_URL');
  const adminUrl = new URL(adminRaw);
  // Validate libpq options before creating any database.
  await pgTool('pg_restore', ['--version'], adminRaw);
  const targetUrl = new URL(adminUrl);
  targetUrl.pathname = '/' + targetName;
  const admin = new Client({ connectionString: adminRaw, connectionTimeoutMillis: 5000, application_name: 'prism-restore-admin' });
  let created = false;
  try {
    await admin.connect();
    const existing = await admin.query('SELECT 1 FROM pg_database WHERE datname=$1', [targetName]);
    if (existing.rowCount) throw new Error('The isolated target database already exists. Choose a new name; it will never be overwritten.');
    // The strict identifier pattern above permits safe interpolation here.
    await admin.query('CREATE DATABASE "' + targetName + '" TEMPLATE template0');
    created = true;
    await pgTool('pg_restore', ['--dbname=' + targetName,'--no-owner','--no-acl','--exit-on-error','--single-transaction', archive], targetUrl.href);
    const restored = new Client({ connectionString: targetUrl.href, connectionTimeoutMillis: 5000, application_name: 'prism-restore-verify' });
    try {
      await restored.connect();
      await restored.query('BEGIN');
      await restored.query('DELETE FROM sessions; DELETE FROM account_tokens; UPDATE game_owners SET expires_at=now(); UPDATE matches SET status=\'cancelled\',ended_at=now() WHERE status=\'active\'');
      const actual = await counts(restored);
      for (const key of Object.keys(manifest.counts) as (keyof typeof actual)[]) {
        if (actual[key] !== manifest.counts[key]) throw new Error('Restored row counts or XP do not match the snapshot manifest. Do not use this isolated database.');
      }
      await restored.query('COMMIT');
      console.log(JSON.stringify({ ok: true, database: targetName, verified: actual, revokedRestoredSessions: true, cancelledUnfinishedMatches: true }));
    } finally { await restored.end().catch(() => {}); }
  } catch (error) {
    if (created) console.error('The isolated target database was retained for inspection. The source database was not modified.');
    throw error;
  } finally { await admin.end().catch(() => {}); }
}
void main().catch(error => { console.error(safeError(error)); process.exitCode = 1; });

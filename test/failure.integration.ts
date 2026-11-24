import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { api, connect, newAccount, readyPrivateRoom, sleep, startPrivateRoom } from './protocol.ts';

async function retry<T>(check: () => Promise<T | undefined>, message: string, timeout = 8000): Promise<T> {
  const until = performance.now() + timeout;
  do {
    const value = await check();
    if (value !== undefined) return value;
    await sleep(40);
  } while (performance.now() < until);
  throw new Error(message);
}

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  return port;
}

test('Real deadlines and failed settlement: 15s ready, 60s seat and invite expiry, atomic retry without duplicate XP', { timeout: 100_000 }, async t => {
  assert.ok(process.env.DATABASE_URL && process.env.REDIS_URL, 'Provide isolated PostgreSQL and Redis endpoints');
  const token = randomUUID();
  const suffix = token.replaceAll('-', '');
  const key = 'boundary-integration:' + token;
  const origin = 'http://127.0.0.1:' + await freePort();
  const gateway = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('../server.ts', import.meta.url))], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: {
      ...process.env, HOST: '127.0.0.1', PORT: new URL(origin).port, ORIGIN: origin, NODE_ENV: 'production', LOCAL_HTTP: '1', PUBLIC_ACCESS: '0',
      TEST_MAILBOX: '1', PLAYTEST_KEY: key, REDIS_NAMESPACE: 'boundary-integration:' + token, GAME_WORKERS: '2',
      GAME_WORKER_KEY: undefined, PRISM_SIM_WORKER: undefined, DRAIN_MATCHES: '0', ALLOW_SOLO_PLAYTEST: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  const append = (chunk: Buffer) => { logs = (logs + chunk.toString()).slice(-14000); };
  gateway.stdout.on('data', append);
  gateway.stderr.on('data', append);
  let spawnError: Error | undefined;
  gateway.once('error', err => { spawnError = err; });
  const clients = new Set<ReturnType<typeof connect>>();
  const db = new Pool({ connectionString: process.env.DATABASE_URL, max: 1, connectionTimeoutMillis: 5000, query_timeout: 5000 });
  const trigger = 'fail_settlement_' + suffix;
  const fault = 'fault_settlement_' + suffix;
  let functionInstalled = false;
  let triggerInstalled = false;
  async function clearFault() {
    if (triggerInstalled) { await db.query('DROP TRIGGER IF EXISTS ' + trigger + ' ON match_players'); triggerInstalled = false; }
    if (functionInstalled) { await db.query('DROP FUNCTION IF EXISTS ' + fault + '()'); functionInstalled = false; }
  }
  t.after(async () => {
    try { await clearFault(); } finally {
      for (const client of clients) client.ws.terminate();
      if (gateway.pid && gateway.exitCode === null && gateway.signalCode === null) {
        const exit = new Promise<void>(resolve => gateway.once('exit', () => resolve()));
        const guard = setTimeout(() => gateway.kill('SIGKILL'), 8000).unref();
        gateway.kill('SIGTERM');
        try { await exit; } finally { clearTimeout(guard); }
      }
      await db.end();
    }
  });
  try {
    await retry(async () => {
      if (spawnError) throw spawnError;
      if (gateway.exitCode !== null || gateway.signalCode !== null) throw new Error('Gateway exited');
      try {
        const response = await fetch(origin + '/api/health', { signal: AbortSignal.timeout(1000) });
        const data = await response.json();
        return response.ok && data.workers?.filter((w: { ready: boolean }) => w.ready).length === 2 ? true : undefined;
      } catch { return undefined; }
    }, 'Gateway was not ready', 18000);
    const accounts = await Promise.all(Array.from({ length: 8 }, (_, i) => newAccount(origin, key, 'Boundary ' + i)));
    const summaries = accounts.map(() => [] as any[]);
    async function open(i: number) {
      const client = connect(origin, accounts[i].cookie);
      clients.add(client);
      client.ws.on('message', bytes => {
        const packet = JSON.parse(bytes.toString());
        if (packet.type === 'match:summary') summaries[i].push(packet.payload);
      });
      const state = await client.find('session:state');
      assert.equal(state.playerId, accounts[i].playerId);
      return { client, state };
    }
    const players = (await Promise.all(accounts.map((_, i) => open(i)))).map(p => p.client);
    const result = (i: number, matchId: string) => api(origin, 'matches/' + matchId, { cookie: accounts[i].cookie });
    const profile = (i: number) => api(origin, 'profile', { cookie: accounts[i].cookie });

    // The seat clock runs concurrently with the ready check and database failure below.
    players[0].send('room:create', { mode: 'team_clash', fillBots: false });
    const { room } = await players[0].find('session:state', s => s.room?.phase === 'waiting');
    players[1].send('room:join', { roomId: room.roomId });
    const { room: seatedRoom } = await players[0].find('session:state', s => s.room?.members.length === 2);
    const { data: friend } = await api(origin, 'social', { cookie: accounts[7].cookie });
    assert.equal((await api(origin, 'social/request', { cookie: accounts[0].cookie, data: { friendCode: friend.friendCode } })).status, 200);
    assert.equal((await api(origin, 'social/respond', { cookie: accounts[7].cookie, data: { playerId: accounts[0].playerId, accept: true } })).status, 200);
    players[0].send('social:invite', { kind: 'room', playerId: accounts[7].playerId });
    const { invites: [invitation] } = await players[7].find('session:state', s => s.invites?.some((i: any) => i.kind === 'room'));
    assert.ok(invitation.expiresAt - Date.now() > 59_000, 'The invitation must have the full sixty-second window');
    const readyRoom = await readyPrivateRoom(players.slice(0, 2), seatedRoom);
    const seatedMatch = await startPrivateRoom(players[0], readyRoom);
    const detachedAt = performance.now();
    players[0].ws.close();
    await players[1].find('session:state', s => s.room?.phase === 'active' && s.room.members.some((m: any) => m.id === accounts[0].playerId && !m.online));

    const publicPlayers = [2, 3, 4, 5, 6, 7];
    const readyStart = performance.now();
    for (const [index, i] of publicPlayers.entries()) {
      players[i].clear();
      players[i].send('queue:join');
      await players[i].find('queue:state', q => q.status === 'queued' && q.position === index + 1);
    }
    const ready = await players[2].find('queue:state', q => q.status === 'ready');
    const readyReceived = performance.now();
    assert.ok(ready.deadline - Date.now() > 14000, 'The normal fifteen-second ready window should be used');
    for (const i of publicPlayers.slice(0, 5)) {
      players[i].send('queue:confirm', { readyId: ready.readyId, accept: true });
      await players[i].find('queue:state', q => q.readyId === ready.readyId && q.accepted);
    }
    for (const i of publicPlayers) players[i].clear();
    const requeued = await players[2].find('queue:state', q => q.status === 'queued', 18000);
    assert.ok(performance.now() - readyReceived >= 14800, 'Ready check expired before fifteen seconds');
    assert.ok(performance.now() - readyStart < 18000, 'Ready timeout did not resolve promptly');
    assert.equal(requeued.position, 1);
    await Promise.all(publicPlayers.slice(0, 5).map((i, index) => players[i].find('queue:state', q => q.status === 'queued' && q.position === index + 1)));
    await players[7].find('queue:state', q => q.status === 'idle');
    assert.equal((await fetch(origin + '/api/health').then(r => r.json())).activeRooms, 1, 'A timed-out ready check must not start a public match');

    players[7].send('queue:join');
    const retryReady = await players[2].find('queue:state', q => q.status === 'ready' && q.readyId !== ready.readyId);
    for (const i of publicPlayers) players[i].send('queue:confirm', { readyId: retryReady.readyId, accept: true });
    const publicMatch = (await players[2].find('room:joined')).snapshot;
    const amber = publicPlayers.filter(i => publicMatch.players.find((p: any) => p.id === accounts[i].playerId)?.team === 'amber');
    const winners = publicPlayers.filter(i => !amber.includes(i));
    const lastResultPlayer = publicMatch.players.map((p: { id: string }) => p.id).sort((a: string, b: string) => a.localeCompare(b)).at(-1);
    assert.equal(amber.length, 3);

    // This trigger rejects only this match's result writes, after any account updates
    // in that transaction. Other gateways and matches keep using the same database.
    await db.query('CREATE FUNCTION ' + fault + "() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected isolated settlement failure'; END $$");
    functionInstalled = true;
    await db.query('CREATE TRIGGER ' + trigger + ' BEFORE UPDATE OF summary ON match_players FOR EACH ROW WHEN (NEW.match_id = ' + "'" + publicMatch.matchId + "'::uuid AND NEW.player_id = '" + lastResultPlayer + "'::uuid AND NEW.summary IS NOT NULL) EXECUTE FUNCTION " + fault + '()');
    triggerInstalled = true;
    for (const i of amber) players[i].send('room:leave');
    await players[winners[0]].find('session:state', s => s.room?.phase === 'ended' && s.room.matchId === publicMatch.matchId);
    await retry(async () => {
      const metrics = await fetch(origin + '/metrics').then(r => r.text());
      return /prism_settlement_failures_total ([1-9]\d*)/.test(metrics) ? true : undefined;
    }, 'Settlement fault did not reach the transaction');
    assert.ok(logs.includes('injected isolated settlement failure'));
    assert.equal((await result(winners[0], publicMatch.matchId)).data.status, 'active');
    const rollback = await db.query('SELECT a.profile,p.summary FROM accounts a JOIN match_players p ON p.player_id=a.id WHERE p.match_id=$1', [publicMatch.matchId]);
    assert.equal(rollback.rowCount, 6);
    for (const row of rollback.rows) {
      assert.equal(row.summary, null, 'A failed transaction must not leave a partial summary');
      assert.equal(row.profile.stats.xp, 0, 'A failed transaction must roll back XP');
      assert.equal(row.profile.stats.matchesPlayed, 0);
    }
    for (const i of winners) assert.equal(summaries[i].length, 0, 'Uncommitted results must not be published');
    await clearFault();
    const recovered = await players[winners[0]].find('match:summary', s => s.matchId === publicMatch.matchId, 10000);
    assert.equal(recovered.result, 'win');
    assert.ok(recovered.xpEarned > 0);
    for (const i of publicPlayers) {
      const saved = await result(i, publicMatch.matchId);
      const p = (await profile(i)).data;
      assert.equal(saved.data.status, 'finished');
      assert.equal(p.stats.xp, saved.data.summary.xpEarned);
      assert.equal(p.stats.matchesPlayed, amber.includes(i) ? 0 : 1);
      assert.equal(p.stats.recentMatches.filter((m: any) => m.id === publicMatch.matchId).length, amber.includes(i) ? 0 : 1);
      if (!amber.includes(i)) assert.deepEqual(saved.data.summary, await players[i].find('match:summary', s => s.matchId === publicMatch.matchId));
    }
    // Allow another retry boundary to pass and confirm that committed XP is stable.
    await sleep(2200);
    for (const i of winners) {
      assert.equal(summaries[i].filter(s => s.matchId === publicMatch.matchId).length, 1);
      const saved = await result(i, publicMatch.matchId);
      assert.equal((await profile(i)).data.stats.xp, saved.data.summary.xpEarned);
    }

    const beforeExpiry = 55000 - (performance.now() - detachedAt);
    if (beforeExpiry > 0) await sleep(beforeExpiry);
    const guest = await open(1);
    players[1] = guest.client;
    assert.equal(guest.state.room.matchId, seatedMatch.matchId);
    assert.equal(guest.state.room.hostId, accounts[0].playerId, 'Host seat must survive before sixty seconds');
    assert.ok(guest.state.room.members.some((m: any) => m.id === accounts[0].playerId && !m.online));
    const expired = await players[1].find('session:state', s => s.room?.matchId === seatedMatch.matchId && s.room.hostId === accounts[1].playerId, 10000);
    assert.ok(performance.now() - detachedAt >= 59900, 'Disconnected host seat expired early');
    assert.equal(expired.room.members.length, 1);
    await players[7].find('session:state', s => s.serverTime >= invitation.expiresAt && !s.invites?.length);
    players[7].send('social:respond', { inviteId: invitation.id, accept: true });
    await players[7].find('session:error', e => e.action === 'social:respond' && e.code === 'invite_expired');
    const returning = await open(0);
    players[0] = returning.client;
    assert.equal(returning.state.room, null, 'An expired account must not resume the active match');
    assert.equal(returning.state.queue.status, 'idle');
    players[0].send('room:join', { roomId: room.roomId });
    await players[0].find('session:error', e => e.code === 'match_locked');
    players[1].send('room:leave');
    await retry(async () => (await result(0, seatedMatch.matchId)).data.status === 'cancelled' ? true : undefined, 'Empty expired room did not cancel');
  } catch (cause) {
    throw new Error('Boundary/failure integration failed. Gateway output:\n' + logs, { cause });
  }
});

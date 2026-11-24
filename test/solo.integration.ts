import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { test, type TestContext } from 'node:test';
import { fileURLToPath } from 'node:url';
import { connect, newAccount, readyPrivateRoom, sleep, startPrivateRoom, waitFor } from './protocol.ts';

async function startGateway(t: TestContext, allowSolo: boolean) {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => probe.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => probe.close(err => err ? reject(err) : resolve()));
  const origin = 'http://127.0.0.1:' + port;
  const id = randomUUID();
  const key = 'solo-integration:' + id;
  const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('../server.ts', import.meta.url))], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: {
      ...process.env, PORT: String(port), HOST: '127.0.0.1', ORIGIN: origin, NODE_ENV: 'production',
      PUBLIC_ACCESS: '0', LOCAL_HTTP: '1', TEST_MAILBOX: '1', PLAYTEST_KEY: key,
      REDIS_NAMESPACE: 'solo-integration:' + id, GAME_WORKERS: '1', DRAIN_MATCHES: '0',
      GAME_WORKER_KEY: undefined, PRISM_SIM_WORKER: undefined,
      ALLOW_SOLO_PLAYTEST: allowSolo ? '1' : '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  const append = (chunk: Buffer) => { log = (log + chunk.toString()).slice(-8000); };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  let spawnError: Error | undefined;
  child.once('error', err => { spawnError = err; });
  const clients = new Set<ReturnType<typeof connect>>();
  t.after(async () => {
    for (const client of clients) client.ws.terminate();
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      const exit = new Promise<void>(resolve => child.once('exit', () => resolve()));
      const guard = setTimeout(() => child.kill('SIGKILL'), 8000).unref();
      child.kill('SIGTERM');
      try { await exit; } finally { clearTimeout(guard); }
    }
  });
  const deadline = performance.now() + 15_000;
  for (;;) {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('Solo gateway exited: ' + log);
    try {
      const response = await fetch(origin + '/api/health', { signal: AbortSignal.timeout(1000) });
      const health = await response.json();
      if (response.ok && health.workers?.length === 1 && health.workers[0].ready) break;
    } catch { /* The isolated gateway is still starting. */ }
    if (performance.now() >= deadline) throw new Error('Solo gateway did not become ready: ' + log);
    await sleep(40);
  }
  return {
    origin, key,
    async open(cookie: string) {
      const client = connect(origin, cookie);
      clients.add(client);
      await client.find('session:state');
      return client;
    },
  };
}

test('Private solo playtest is opt-in and supports bots, authoritative input and reconnect', { timeout: 40_000 }, async t => {
  assert.ok(process.env.DATABASE_URL && process.env.REDIS_URL, 'Provide isolated PostgreSQL and Redis endpoints');

  await t.test('normal invite rooms still require two connected humans, including with bot fill', async t => {
    const gateway = await startGateway(t, false);
    const account = await newAccount(gateway.origin, gateway.key, 'Normal host');
    const client = await gateway.open(account.cookie);
    client.send('room:create', { fillBots: true, minPlayers: 1 });
    const { room } = await client.find('session:state', state => state.room?.phase === 'waiting');
    assert.equal(room.minPlayers, 2, 'The client cannot lower the server player requirement');
    assert.equal(room.members.length, 1);
    client.clear();
    client.send('room:start', { version: room.version });
    await client.find('session:error', error => error.code === 'need_two_players');
    client.send('room:leave');
    await client.find('session:state', state => !state.room);
  });

  await t.test('explicit private test flag allows one human with optional bot fill', async t => {
    const gateway = await startGateway(t, true);
    const account = await newAccount(gateway.origin, gateway.key, 'Solo host');
    let client = await gateway.open(account.cookie);
    for (const fillBots of [false, true]) {
      client.clear();
      client.send('room:create', { mapId: fillBots ? 'cryo_relay' : 'reactor_foundry', mode: 'team_clash', fillBots });
      const { room } = await client.find('session:state', state => state.room?.phase === 'waiting');
      assert.equal(room.minPlayers, 1);
      assert.equal(room.members.length, 1);
      const readyRoom = await readyPrivateRoom([client], room);
      const snapshot = await startPrivateRoom(client, readyRoom);
      assert.equal(snapshot.phase, 'active');
      assert.equal(snapshot.players.length, fillBots ? 6 : 1);
      assert.equal(snapshot.players.filter((player: any) => player.isBot).length, fillBots ? 5 : 0);
      const own = snapshot.players.find((player: any) => player.id === account.playerId);
      assert.ok(own);
      client.send('player:input', { matchId: snapshot.matchId, seq: 1, moveX: 0, moveZ: 1, yaw: own.yaw, pitch: 0, ads: false, dash: false });
      const authoritative = await client.find('match:state', state => state.matchId === snapshot.matchId && state.players.some((player: any) => player.id === account.playerId && player.lastProcessedInputSeq === 1));
      const moved = authoritative.players.find((player: any) => player.id === account.playerId);
      assert.ok(Math.hypot(moved.x - own.x, moved.z - own.z) > 0, 'Solo movement must be processed by the authoritative simulation');

      const previous = client;
      previous.ws.close();
      await waitFor(() => previous.closed() !== undefined);
      client = await gateway.open(account.cookie);
      const resumed = await client.find('room:joined');
      assert.equal(resumed.playerId, account.playerId);
      assert.equal(resumed.snapshot.matchId, snapshot.matchId);
      assert.equal(resumed.snapshot.players.find((player: any) => player.id === account.playerId).lastProcessedInputSeq, 1);
      client.clear();
      client.send('room:leave');
      await client.find('session:state', state => !state.room);
    }

    client.clear();
    client.send('queue:join');
    await client.find('queue:state', state => state.status === 'queued' && state.position === 1);
    const queued = await client.find('session:state', state => typeof state.queuedAt === 'number');
    assert.equal(queued.room, null, 'Solo testing must not launch a one-player public match');
    assert.ok(!queued.offer, 'A single public queue member must not receive a ready offer');
    client.clear();
    client.send('queue:leave');
    await client.find('queue:state', state => state.status === 'idle');
  });
});

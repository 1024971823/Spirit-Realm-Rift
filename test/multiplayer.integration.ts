import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { api, beginPrivateCountdown, connect, newAccount, readyPrivateRoom, sleep, startPrivateRoom, waitFor } from './protocol.ts';

const matchMs = 5500;

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
  return port;
}

async function retry<T>(check: () => Promise<T | undefined>, message: string, timeout = 8000): Promise<T> {
  const deadline = performance.now() + timeout;
  do {
    const value = await check();
    if (value !== undefined) return value;
    await sleep(40);
  } while (performance.now() < deadline);
  throw new Error(message);
}

function childrenOf(parent: number): number[] {
  const rows = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,comm='], { encoding: 'utf8' }).trim().split('\n')
    .map(line => line.trim().split(/\s+/));
  const executable = rows.find(([pid]) => Number(pid) === parent)?.[2];
  return executable ? rows.flatMap(([pid, ppid, command]) => Number(ppid) === parent && command === executable ? [Number(pid)] : []) : [];
}

test('Gateway and workers: custom rooms, queue, reconnect, settlement and worker isolation', { timeout: 70_000 }, async t => {
  assert.ok(process.env.DATABASE_URL && process.env.REDIS_URL, 'Provide isolated PostgreSQL and Redis endpoints');
  const port = await freePort();
  const origin = 'http://127.0.0.1:' + port;
  const token = randomUUID();
  const key = 'multiplayer-integration:' + token;
  const staffEmail = 'staff-' + token + '@example.test';
  const child = spawn(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('../server.ts', import.meta.url))], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: {
      ...process.env, PORT: String(port), HOST: '127.0.0.1', ORIGIN: origin, NODE_ENV: 'test', PUBLIC_ACCESS: '0',
      TEST_MAILBOX: '1', PLAYTEST_KEY: key, GAME_WORKERS: '2', GAME_WORKER_KEY: undefined, PRISM_SIM_WORKER: undefined,
      TRUST_PROXY: 'loopback', TEST_MATCH_MS: String(matchMs), REDIS_NAMESPACE: 'multiplayer-integration:' + token, DRAIN_MATCHES: '0',
      MODERATOR_EMAILS: staffEmail, ALLOW_SOLO_PLAYTEST: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  const append = (chunk: Buffer) => { log = (log + chunk.toString()).slice(-10_000); };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  let spawnError: Error | undefined;
  child.once('error', err => { spawnError = err; });
  const clients = new Set<ReturnType<typeof connect>>();
  t.after(async () => {
    for (const client of clients) client.ws.terminate();
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      const exit = new Promise<void>(resolve => child.once('exit', () => resolve()));
      child.kill('SIGTERM');
      const guard = setTimeout(() => child.kill('SIGKILL'), 8000).unref();
      try { await exit; } finally { clearTimeout(guard); }
    }
  });
  async function health() {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('Gateway exited:\n' + log);
    try {
      const response = await fetch(origin + '/api/health', { signal: AbortSignal.timeout(1000) });
      return response.ok ? await response.json() : undefined;
    } catch { return undefined; }
  }
  try {
    await retry(async () => { const h = await health(); return h?.workers?.filter((w: { ready: boolean }) => w.ready).length === 2 ? h : undefined; }, 'Gateway did not start both game workers', 18_000);

    // Requests forwarded by the trusted local edge retain distinct client IP buckets.
    for (let i = 0; i < 61; i++) {
      const response = await fetch(origin + '/api/auth/resend', {
        method: 'POST',
        headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Forwarded-For': '198.51.100.10' },
        body: JSON.stringify({ email: `proxy-${token}-${i}@example.com` }),
      });
      assert.equal(response.status, i < 60 ? 200 : 429);
      await response.arrayBuffer();
    }
    const otherClient = await fetch(origin + '/api/auth/resend', {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json', 'X-Forwarded-For': '198.51.100.11' },
      body: JSON.stringify({ email: `proxy-other-${token}@example.com` }),
    });
    assert.equal(otherClient.status, 200, 'A second forwarded client must not share the exhausted IP limit');
    await otherClient.arrayBuffer();

    const accounts = await Promise.all(Array.from({ length: 7 }, (_, i) => newAccount(origin, key, 'Protocol ' + i)));
    const players = await Promise.all(accounts.map((_, i) => open(i)));
    async function open(i: number) {
      const conn = connect(origin, accounts[i].cookie);
      clients.add(conn);
      const state = await conn.find('session:state');
      assert.equal(state.playerId, accounts[i].playerId);
      return conn;
    }
    const state = (client: number, predicate: (p: any) => boolean) => players[client].find('session:state', predicate);
    const result = (idx: number, matchId: string) => api(origin, 'matches/' + matchId, { cookie: accounts[idx].cookie });
    const profile = (idx: number) => api(origin, 'profile', { cookie: accounts[idx].cookie });
    const create = async (host: number, guest: number, mode = 'team_clash') => {
      players[host].clear();
      players[guest].clear();
      players[host].send('room:create', { mapId: 'cryo_relay', mode, fillBots: false });
      const { room } = await state(host, s => s.room?.phase === 'waiting');
      assert.ok(room.isPrivate);
      players[guest].send('room:join', { roomId: room.roomId });
      return (await state(host, s => s.room?.roomId === room.roomId && s.room.members.length === 2)).room;
    };
    const sendInput = (idx: number, snapshot: any, seq: number) => {
      const own = snapshot.players.find((p: any) => p.id === accounts[idx].playerId);
      assert.ok(own);
      players[idx].send('player:input', { matchId: snapshot.matchId, seq, moveX: Math.sin(own.yaw), moveZ: Math.cos(own.yaw), yaw: own.yaw, pitch: 0, ads: false, dash: false });
      return own;
    };
    const acknowledge = (idx: number, id: string, seq: number) => players[idx].find('match:state', snap => snap.matchId === id && snap.players.some((p: any) => p.id === accounts[idx].playerId && p.lastProcessedInputSeq === seq));

    players[0].send('room:create', { mapId: 'cryo_relay', mode: 'team_clash', fillBots: false });
    const { room: waiting } = await state(0, s => s.room?.phase === 'waiting');
    assert.equal(waiting.isPrivate, true);
    players[0].send('room:start', { version: waiting.version });
    await players[0].find('session:error', e => e.code === 'need_two_players');
    players[1].send('room:preview', { roomId: waiting.roomId.toLowerCase() });
    const preview = await players[1].find('room:preview', p => p.roomId === waiting.roomId);
    assert.equal(preview.available, true);
    assert.equal(preview.mapId, 'cryo_relay');
    assert.equal(preview.playerCount, 1);

    const friendCode = (await api(origin, 'social', { cookie: accounts[1].cookie })).data.friendCode;
    assert.equal((await api(origin, 'social/request', { cookie: accounts[0].cookie, data: { friendCode } })).status, 200);
    assert.equal((await api(origin, 'social/respond', { cookie: accounts[1].cookie, data: { playerId: accounts[0].playerId, accept: true } })).status, 200);
    players[0].send('social:invite', { kind: 'room', playerId: accounts[1].playerId });
    const { invites: pendingRoomInvites } = await state(1, s => s.invites?.some((i: any) => i.kind === 'room'));
    const roomInvite = pendingRoomInvites[0];
    assert.equal(roomInvite.senderId, accounts[0].playerId);
    assert.ok(roomInvite.expiresAt > Date.now());
    assert.equal((await api(origin, 'social/settings', { cookie: accounts[1].cookie, data: { allowInvites: false } })).status, 200);
    players[1].send('social:respond', { inviteId: roomInvite.id, accept: true });
    await players[1].find('session:error', e => e.action === 'social:respond' && e.code === 'invite_unavailable');
    assert.equal((await api(origin, 'social/settings', { cookie: accounts[1].cookie, data: { allowInvites: true } })).status, 200);
    players[0].send('social:invite', { kind: 'room', playerId: accounts[1].playerId });
    const { invites: freshRoomInvites } = await state(1, s => s.invites?.some((i: any) => i.kind === 'room' && i.id !== roomInvite.id));
    players[1].send('social:respond', { inviteId: freshRoomInvites[0].id, accept: true });
    const { room: joinedRoom } = await state(0, s => s.room?.members.length === 2);
    players[1].send('room:start', { version: joinedRoom.version });
    await players[1].find('session:error', e => e.code === 'not_host');
    players[0].send('room:start', { version: joinedRoom.version });
    await players[0].find('session:error', e => e.code === 'all_must_be_ready');
    const text = '你好，准备出发';
    players[0].send('chat:send', { text });
    const chat = await players[1].find('chat:msg', msg => msg.text === text.normalize('NFKC'));
    assert.equal(chat.playerId, accounts[0].playerId);

    const both = players.slice(0, 2);
    const armed = await readyPrivateRoom(both, joinedRoom);
    const team = armed.members.find(m => m.id === accounts[0].playerId)!.team;
    players[1].send('room:team', { version: armed.version, team });
    const { room: sameTeam } = await state(0, s => s.room?.version > armed.version &&
      s.room.members.every((m: any) => m.team === team && !m.ready));
    const sameTeamReady = await readyPrivateRoom(both, sameTeam);
    assert.equal(sameTeamReady.canStart, false);
    players[0].send('room:start', { version: sameTeamReady.version });
    await players[0].find('session:error', e => e.code === 'need_both_teams');
    players[1].send('room:team', { version: sameTeam.version, team: team === 'cobalt' ? 'amber' : 'cobalt' });
    const { room: split } = await state(0, s => s.room?.version > sameTeam.version);
    const armedAgain = await readyPrivateRoom(both, split);
    const countdown = await beginPrivateCountdown(players[0], armedAgain);
    assert.ok(countdown.countdownEndsAt! > Date.now());
    players[2].send('room:preview', { roomId: waiting.roomId });
    await players[2].find('room:preview', p => p.roomId === waiting.roomId && !p.available && p.error === 'match_locked');
    players[1].send('room:ready', { version: countdown.version, ready: false });
    const { room: cancelledStart } = await state(0, s => s.room?.version > countdown.version &&
      s.room.phase === 'waiting' && !s.room.countdownEndsAt && s.room.members.every((m: any) => !m.ready));
    players[0].send('room:ready', { version: countdown.version, ready: true });
    await players[0].find('session:error', e => e.action === 'room:ready' && e.code === 'stale_room');
    await sleep(Math.max(0, countdown.countdownEndsAt! - Date.now() + 100));
    assert.equal(players[0].packets('room:joined').length, 0, 'A cancelled countdown must not launch when its original timer expires');
    const first = await startPrivateRoom(players[0], await readyPrivateRoom(both, cancelledStart));
    assert.equal(first.players.length, 2);
    assert.equal(first.mapId, 'cryo_relay');
    players[2].send('room:join', { roomId: waiting.roomId });
    await players[2].find('session:error', e => e.code === 'match_locked');
    const before = sendInput(0, first, 1);
    const after = (await acknowledge(0, first.matchId, 1)).players.find((p: any) => p.id === before.id);
    assert.ok(Math.hypot(after.x - before.x, after.z - before.z) > 0, 'The server must apply input to the fighter');
    const { status: classStatus } = await api(origin, 'profile', { cookie: accounts[0].cookie, data: { loadout: { robotClass: 'ep_miner' } } });
    assert.equal(classStatus, 200);
    const mining = await players[0].find('match:state', s => s.matchId === first.matchId && s.players.some((p: any) => p.id === before.id && p.robotClass === 'ep_miner'));
    assert.equal(mining.players.find((p: any) => p.id === before.id).ammo, 0);
    const { status: strikerStatus } = await api(origin, 'profile', { cookie: accounts[0].cookie, data: { loadout: { robotClass: 's1_striker' } } });
    assert.equal(strikerStatus, 200);
    const striker = await players[0].find('match:state', s => s.matchId === first.matchId && s.serverTick > mining.serverTick && s.players.some((p: any) => p.id === before.id && p.robotClass === 's1_striker'));
    assert.equal(striker.players.find((p: any) => p.id === before.id).ammo, after.ammo);

    const old = players[0];
    players[0] = await open(0);
    await waitFor(() => old.closed() === 4409);
    const resumed = (await players[0].find('room:joined')).snapshot;
    assert.equal(resumed.matchId, first.matchId);
    assert.equal(resumed.players.find((p: any) => p.id === before.id).lastProcessedInputSeq, 1);
    players[0].ws.close();
    await state(1, s => s.room?.phase === 'active' && s.room.members.some((m: any) => m.id === before.id && !m.online));
    players[0] = await open(0);
    const resumedAfterDisconnect = (await players[0].find('room:joined')).snapshot;
    sendInput(0, resumedAfterDisconnect, 2);
    await acknowledge(0, first.matchId, 2);

    const custom = await players[0].find('match:summary', s => s.matchId === first.matchId);
    assert.equal(custom.xpEarned, 0);
    assert.deepEqual((await result(0, first.matchId)).data.summary, custom);
    assert.equal((await profile(0)).data.stats.matchesPlayed, 0);
    assert.equal((await result(2, first.matchId)).status, 404);
    const { room: afterFirst } = await state(0, s => s.room?.phase === 'waiting' && s.room.roomId === waiting.roomId);
    assert.ok(afterFirst.members.every((m: any) => !m.ready), 'A rematch must require fresh readiness');
    players[0].send('room:settings', { version: afterFirst.version, mode: 'ffa', fillBots: true });
    const { room: ffaRoom } = await state(0, s => s.room?.phase === 'waiting' && s.room.mode === 'ffa' && s.room.fillBots);
    const second = await startPrivateRoom(players[0], await readyPrivateRoom(players.slice(0, 2), ffaRoom));
    assert.notEqual(second.matchId, first.matchId);
    assert.equal(second.mode, 'ffa');
    assert.equal(second.players.filter((p: any) => p.isBot).length, 4);
    players[0].send('player:ping', { matchId: second.matchId, actionSeq: 1, kind: 'support', yaw: 0, pitch: 0 });
    await players[0].find('match:state', s => s.matchId === second.matchId && s.serverTick > second.serverTick + 2);
    assert.equal(players[0].packets('match:ping').length, 0, 'FFA must not deliver tactical pings');
    players[0].send('room:leave');
    await state(1, s => s.room?.phase === 'active' && s.room.matchId === second.matchId && s.room.hostId === accounts[1].playerId);
    players[1].send('room:leave');
    await retry(async () => (await result(0, second.matchId)).data.status === 'cancelled' ? true : undefined, 'Abandoned custom match did not cancel');

    for (let i = 0; i < 6; i++) {
      players[i].clear();
      players[i].send('queue:join');
      const queued = await players[i].find('queue:state', q => q.status === 'queued');
      assert.equal(queued.position, i + 1);
    }
    const offer = await players[0].find('queue:state', q => q.status === 'ready');
    for (let i = 0; i < 5; i++) {
      players[i].send('queue:confirm', { readyId: offer.readyId, accept: true });
      await players[i].find('queue:state', q => q.readyId === offer.readyId && q.accepted);
    }
    for (let i = 0; i < 5; i++) players[i].clear();
    players[5].send('queue:confirm', { readyId: offer.readyId, accept: false });
    await players[5].find('queue:state', q => q.status === 'idle');
    await Promise.all([0, 1, 2, 3, 4].map(i => players[i].find('queue:state', q => q.status === 'queued' && q.position === i + 1)));
    players[6].send('queue:join');
    const offer2 = await players[0].find('queue:state', q => q.status === 'ready' && q.readyId !== offer.readyId);
    const accepted = [0, 1, 2, 3, 4, 6];
    for (const i of accepted) players[i].send('queue:confirm', { readyId: offer2.readyId, accept: true });
    const pub = (await players[0].find('room:joined', p => p.snapshot.matchId !== second.matchId)).snapshot;
    assert.equal(pub.mapId, 'reactor_foundry');
    assert.equal(pub.mode, 'team_clash');
    assert.equal(pub.players.filter((p: any) => p.team === 'cobalt').length, 3);
    assert.equal(pub.players.filter((p: any) => p.team === 'amber').length, 3);
    assert.ok(pub.players.every((p: any) => !p.isBot));
    assert.deepEqual(new Set(pub.players.map((p: any) => p.id)), new Set(accepted.map(i => accounts[i].playerId)));
    const sender = pub.players.find((p: any) => p.id === accounts[0].playerId);
    const teammates = accepted.filter(i => i !== 0 && pub.players.some((p: any) => p.id === accounts[i].playerId && p.team === sender.team));
    const opponents = accepted.filter(i => i !== 0 && !teammates.includes(i));
    const ping = (actionSeq: number, kind: string, matchId = pub.matchId, yaw = sender.yaw) =>
      players[0].send('player:ping', { matchId, actionSeq, kind, yaw, pitch: 0, position: { x: 99999, y: 0, z: 99999 } });
    ping(1, 'support', second.matchId);
    ping(2, 'support', pub.matchId, 'invalid');
    ping(3, 'support');
    const marker = await players[teammates[0]].find('match:ping', p => p.matchId === pub.matchId && p.kind === 'support');
    assert.equal(marker.playerId, sender.id);
    assert.equal(marker.team, sender.team);
    assert.ok(marker.expiresAt > Date.now());
    assert.ok(Math.hypot(marker.position.x - sender.x, marker.position.z - sender.z) < 0.1, 'Support uses the authoritative fighter position');
    await players[teammates[1]].find('match:ping', p => p.id === marker.id);
    ping(4, 'mine');
    assert.equal((await api(origin, 'chat/block', { cookie: accounts[teammates[0]].cookie,
      data: { playerId: accounts[0].playerId, blocked: true } })).status, 200);
    await sleep(2050);
    ping(4, 'rally');
    ping(5, 'danger');
    await players[teammates[1]].find('match:ping', p => p.matchId === pub.matchId && p.kind === 'danger');
    const kinds = (i: number) => players[i].packets('match:ping').filter(p => p.matchId === pub.matchId).map(p => p.kind);
    assert.deepEqual(kinds(teammates[0]), ['support'], 'A teammate who blocked the sender must not receive subsequent markers');
    assert.deepEqual(kinds(teammates[1]), ['support', 'danger'], 'Invalid, replayed and rate-limited markers must not be delivered');
    for (const i of opponents) assert.deepEqual(kinds(i), [], 'Opponents must not receive the other team’s markers');
    assert.equal((await api(origin, 'chat/block', { cookie: accounts[teammates[0]].cookie,
      data: { playerId: accounts[0].playerId, blocked: false } })).status, 200);
    const summary = await players[0].find('match:summary', s => s.matchId === pub.matchId, matchMs + 3000);
    const saved = await result(0, pub.matchId);
    assert.equal(saved.data.status, 'finished');
    assert.equal(summary.ranked, false);
    assert.ok(summary.xpEarned > 0);
    assert.deepEqual(saved.data.summary, summary);
    assert.equal((await profile(0)).data.stats.xp, summary.xpEarned);
    await Promise.all(accepted.map(i => state(i, s => !s.room && s.queue?.status === 'idle')));

    for (const i of accepted) players[i].clear();
    players[0].send('party:create');
    const { party } = await state(0, s => s.party?.leaderId === accounts[0].playerId);
    players[0].send('social:invite', { kind: 'party', playerId: accounts[1].playerId });
    const { invites: partyInvites } = await state(1, s => s.invites?.some((i: any) => i.kind === 'party'));
    players[1].send('social:respond', { inviteId: partyInvites[0].id, accept: true });
    await state(1, s => s.party?.id === party.id && s.party.members.length === 2);
    players[1].send('queue:join');
    await players[1].find('session:error', e => e.action === 'queue:join' && e.code === 'not_party_leader');
    const solos = accepted.slice(2);
    for (const i of [0, ...solos]) players[i].send('queue:join');
    const declinedPartyOffer = await players[0].find('queue:state', q => q.status === 'ready');
    for (const i of [0, ...solos]) players[i].send('queue:confirm', { readyId: declinedPartyOffer.readyId, accept: true });
    await players[0].find('queue:state', q => q.readyId === declinedPartyOffer.readyId && q.acceptedCount === 5);
    for (const i of accepted) players[i].clear();
    players[1].send('queue:confirm', { readyId: declinedPartyOffer.readyId, accept: false });
    await Promise.all([0, 1].map(i => players[i].find('queue:state', q => q.status === 'idle')));
    await Promise.all(solos.map(i => players[i].find('queue:state', q => q.status === 'queued')));
    players[0].send('queue:join');
    const rotationOffer = await players[0].find('queue:state', q => q.status === 'ready' && q.readyId !== declinedPartyOffer.readyId);
    for (const i of accepted) players[i].send('queue:confirm', { readyId: rotationOffer.readyId, accept: true });
    const rotation = (await players[0].find('room:joined')).snapshot;
    assert.equal(rotation.mapId, 'cryo_relay');
    const teamOf = (i: number) => rotation.players.find((p: any) => p.id === accounts[i].playerId)?.team;
    assert.ok(teamOf(0));
    assert.equal(teamOf(0), teamOf(1), 'A party must be assigned to the same team');
    for (const i of accepted) players[i].clear();
    const amber = accepted.filter(i => rotation.players.find((p: any) => p.id === accounts[i].playerId)?.team === 'amber');
    const cobalt = accepted.find(i => !amber.includes(i))!;
    assert.equal(amber.length, 3);
    const xpBeforeForfeit = (await profile(amber[0])).data.stats.xp;
    for (const i of amber) players[i].send('room:leave');
    const awarded = await players[cobalt].find('match:summary', s => s.matchId === rotation.matchId);
    assert.equal(awarded.result, 'win');
    const forfeited = await result(amber[0], rotation.matchId);
    assert.equal(forfeited.data.summary.result, 'forfeit');
    assert.equal((await profile(amber[0])).data.stats.xp, xpBeforeForfeit);
    await Promise.all(accepted.map(i => state(i, s => !s.room && s.queue?.status === 'idle')));
    players[1].send('party:leave');
    await state(0, s => s.party?.id === party.id && s.party.members.length === 1);
    players[0].send('party:leave');
    await state(0, s => !s.party && !s.room);

    if (process.platform !== 'win32') {
      const [aRoom, bRoom] = await Promise.all([create(0, 1), create(2, 3, 'control_core')]);
      const [aReady, bReady] = await Promise.all([
        readyPrivateRoom(players.slice(0, 2), aRoom),
        readyPrivateRoom(players.slice(2, 4), bRoom),
      ]);
      const [a, b] = await Promise.all([startPrivateRoom(players[0], aReady), startPrivateRoom(players[2], bReady)]);
      assert.equal(b.mode, 'control_core');
      await retry(async () => (await health())?.workers?.filter((w: { activeRooms: number }) => w.activeRooms === 1).length === 2 ? true : undefined, 'Rooms were not spread across two workers');
      const workers = childrenOf(child.pid!);
      assert.equal(workers.length, 2);
      const victim = workers[0];
      process.kill(victim, 'SIGKILL');
      const candidates = [{ idx: 0, snap: a }, { idx: 2, snap: b }];
      const stopped = await retry(async () => {
        for (const candidate of candidates) {
          if ((await result(candidate.idx, candidate.snap.matchId)).data.status === 'cancelled') return candidate;
        }
      }, 'Worker termination did not cancel its match');
      const survivor = candidates.find(candidate => candidate !== stopped)!;
      await players[stopped.idx].find('match:summary', s => s.matchId === stopped.snap.matchId && s.cancelled);
      sendInput(survivor.idx, survivor.snap, 1);
      await acknowledge(survivor.idx, survivor.snap.matchId, 1);
      await retry(async () => {
        const live = childrenOf(child.pid!);
        return live.length === 2 && !live.includes(victim) && (await health())?.workers?.every((w: { ready: boolean }) => w.ready) ? true : undefined;
      }, 'Killed game worker was not replaced');
      const completed = await players[survivor.idx].find('match:summary', s => s.matchId === survivor.snap.matchId);
      assert.equal(completed.cancelled, false);
      assert.deepEqual((await result(survivor.idx, survivor.snap.matchId)).data.summary, completed);
    }
    const revocationStart = performance.now();
    assert.equal((await api(origin, 'auth/forgot', { data: { email: accounts[6].email } })).status, 200);
    const resetMail = await api(origin, 'test/mail?kind=reset&email=' + encodeURIComponent(accounts[6].email), { key });
    const replacementPassword = 'prism-recovered:' + token;
    assert.equal((await api(origin, 'auth/reset', { data: { token: resetMail.data.token, password: replacementPassword } })).status, 200);
    await waitFor(() => players[6].closed() === 4401, 2000);
    assert.ok(performance.now() - revocationStart < 2500, 'Password reset must immediately revoke the active WebSocket');
    assert.equal((await api(origin, 'auth/session', { cookie: accounts[6].cookie })).status, 401);
    const recoveredLogin = await api(origin, 'auth/login', { data: { email: accounts[6].email, password: replacementPassword } });
    assert.equal(recoveredLogin.status, 200);
    accounts[6].cookie = recoveredLogin.cookie;
    players[6] = await open(6);
    assert.equal((await api(origin, 'auth/logout', { data: {}, cookie: accounts[6].cookie })).status, 200);
    await waitFor(() => players[6].closed() === 4401, 2000);

    const staffPassword = 'prism-staff:' + token;
    assert.equal((await api(origin, 'auth/register', { data: { email: staffEmail, password: staffPassword }, key })).status, 200);
    const staffMail = await api(origin, 'test/mail?kind=verify&email=' + encodeURIComponent(staffEmail), { key });
    assert.equal((await api(origin, 'auth/verify', { data: { token: staffMail.data.token } })).status, 200);
    const staff = await api(origin, 'auth/login', { data: { email: staffEmail, password: staffPassword } });
    assert.equal(staff.status, 200);
    for (const i of [0, 1]) players[i].send('room:leave');
    await sleep(100);
    const banRoom = await create(0, 1);
    const banText = 'offline moderation regression';
    players[0].send('chat:send', { text: banText });
    const banMessage = await players[1].find('chat:msg', m => m.text === banText);
    players[0].ws.close();
    await state(1, s => s.room?.members.some((m: any) => m.id === accounts[0].playerId && !m.online));
    assert.equal((await api(origin, 'chat/report', { cookie: accounts[1].cookie, data: { messageId: banMessage.id, reason: 'integration' } })).status, 200);
    assert.equal((await api(origin, 'moderation/actions', { cookie: staff.cookie, data: { messageId: banMessage.id, action: 'ban', reason: 'integration' } })).status, 200);
    await state(1, s => s.room?.roomId === banRoom.roomId && s.room.members.length === 1 && s.room.hostId === accounts[1].playerId);
    assert.equal((await api(origin, 'auth/session', { cookie: accounts[0].cookie })).status, 401);
  } catch (cause) {
    throw new Error('Multiplayer protocol test failed. Gateway output:\n' + log, { cause });
  }
});

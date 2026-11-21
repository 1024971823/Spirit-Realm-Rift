import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, firefox, type Page } from 'playwright';
import type { MatchSnapshot } from '../src/shared/types.ts';
import { MAPS } from '../src/shared/catalog.ts';
import { getArenaActiveColliders } from '../src/shared/physics.ts';
import { computePlayerCamera } from '../src/shared/playerInput.ts';
import type { MatchSummaryPayload, SessionView } from '../src/net/clientSocket.ts';
import { api, connect, newAccount } from './protocol.ts';

interface Packet { type: string; payload: unknown }
interface RoomJoin { playerId: string; roomId: string; snapshot: MatchSnapshot }
interface Credentials { email: string; password: string; callsign: string }

async function until<T>(read: () => T | false | undefined, label: string, timeoutMs = 12_000): Promise<T> {
  const stop = Date.now() + timeoutMs;
  do {
    const value = read();
    if (value) return value;
    await delay(50);
  } while (Date.now() < stop);
  throw new Error('Timed out waiting for ' + label);
}

function observePage(page: Page) {
  const events = new Map<string, unknown>();
  let joins = 0;
  page.on('websocket', socket => {
    if (new URL(socket.url()).pathname !== '/ws') return;
    socket.on('framereceived', ({ payload }) => {
      const packet = JSON.parse(String(payload)) as Packet;
      events.set(packet.type, packet.payload);
      if (packet.type === 'room:joined') joins++;
    });
  });
  return { events, get joins() { return joins; } };
}

async function freePort() {
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  return port;
}

const arena = (page: Page) => page.getByTestId('arena-canvas-mount').locator('canvas');
const lobby = (page: Page) => page.getByRole('dialog', { name: 'Multiplayer lobby' });
const button = (page: Page, name: string) => page.getByRole('button', { name, exact: true });

async function observeThreeScenes(page: Page) {
  // Three's existing devtools event observes live scenes without adding product hooks.
  // Install on every navigation, including email verification and refresh/resume.
  await page.addInitScript(() => {
    const scope = window as typeof window & { __THREE_DEVTOOLS__: EventTarget; __urdfTestScenes: any[] };
    scope.__urdfTestScenes = [];
    scope.__THREE_DEVTOOLS__ = new EventTarget();
    scope.__THREE_DEVTOOLS__.addEventListener('observe', event => {
      const object = (event as CustomEvent).detail;
      if (object?.isScene) scope.__urdfTestScenes.push(object);
    });
  });
}

async function assertMountedUrdf(page: Page, robotClass: 's1_striker' | 'ep_miner') {
  await page.waitForFunction(expectedClass => {
    const scenes = (window as typeof window & { __urdfTestScenes?: any[] }).__urdfTestScenes ?? [];
    return scenes.some(scene => {
      // Collada parsing creates detached scenes too; only inspect the fogged arena.
      if (!scene.fog) return false;
      let mounted = false;
      scene.traverse((object: any) => {
        if (!object.isURDFRobot) return;
        const expectedParts = expectedClass === 'ep_miner'
          ? object.links?.gripper_t_link && object.joints?.arm_1_joint
          : object.links?.blaster_link && object.joints?.gimbal_joint;
        if (!expectedParts) return;
        for (let parent = object; parent && parent !== scene; parent = parent.parent) {
          if (!parent.visible) return;
        }
        object.traverse((part: any) => {
          if (part.isMesh && part.geometry?.attributes?.position?.count > 0) mounted = true;
        });
      });
      return mounted;
    });
  }, robotClass, { timeout: 18_000 });
}

type ProtocolPlayer = ReturnType<typeof connect> & { playerId: string };

// Walk two opponents along the open perimeter so we can verify a hit on either map.
async function assertActualHit(players: ProtocolPlayer[], snap: MatchSnapshot) {
  const { matchId, mapId } = snap;
  const pose = (state: MatchSnapshot, player: ProtocolPlayer) => state.players.find(p => p.id === player.playerId)!;
  const sender = players.find(p => pose(snap, p).team === 'cobalt')!;
  const receiver = players.find(p => pose(snap, p).team === 'amber')!;
  assert.ok(sender && receiver);
  const latest = (player: ProtocolPlayer): MatchSnapshot | undefined => {
    const packet = player.last();
    const state = packet?.type === 'match:state' ? packet.payload as MatchSnapshot : undefined;
    return state?.matchId === matchId ? state : undefined;
  };
  const flank = 46;
  await Promise.all([sender, receiver].map(async player => {
    const initial = pose(snap, player);
    const direction = Math.sign(initial.x);
    let seq = 0;
    for (const target of [{ x: initial.x, z: flank }, { x: direction * 12, z: flank }]) {
      await until(() => {
        const current = latest(player);
        if (!current) return false;
        const p = pose(current, player);
        const dx = target.x - p.x, dz = target.z - p.z;
        const d = Math.hypot(dx, dz);
        const done = d < 0.65;
        player.send('player:input', { matchId, seq: ++seq, moveX: done ? 0 : dx / Math.max(1, d), moveZ: done ? 0 : dz / Math.max(1, d), yaw: p.yaw, pitch: 0, ads: false, dash: false });
        return done;
      }, 'opponent walking along the arena flank', 13_000);
    }
  }));
  await delay(300);
  for (let actionSeq = 1; actionSeq <= 4; actionSeq++) {
    const state = await until(() => latest(sender), 'opponents at clear firing positions');
    const from = pose(state, sender);
    const target = pose(state, receiver);
    const map = MAPS[mapId];
    const colliders = getArenaActiveColliders(map, state.barriers);
    const aim = { yaw: from.yaw, pitch: 0, ads: true };
    for (let n = 0; n < 4; n++) {
      const camera = computePlayerCamera(from, aim, colliders, map.halfSize).position;
      const dx = target.x - camera.x, dz = target.z - camera.z;
      aim.yaw = Math.atan2(-dx, -dz);
      aim.pitch = Math.atan2(target.y + 0.75 - camera.y, Math.hypot(dx, dz));
    }
    sender.send('player:fire', { matchId, actionSeq, ...aim });
    let hit: { damage: number };
    try {
      hit = await sender.find('hit:confirm', payload => payload.targetId === receiver.playerId, 350);
    } catch (err) {
      if (actionSeq === 4) throw err;
      continue;
    }
    assert.ok(hit.damage > 0);
    await until(() => {
      const current = latest(receiver);
      if (!current) return false;
      const p = pose(current, receiver);
      return p.hp + p.shield < target.hp + target.shield;
    }, 'damage in target authoritative snapshot');
    await delay(350); // Beyond the default carbine cooldown; cadence alone wouldn't block a replay.
    const ammo = pose(await until(() => latest(sender), 'post-shot ammunition'), sender).ammo;
    sender.send('player:fire', { matchId, actionSeq, ...aim });
    await delay(250);
    const next = await until(() => latest(sender), 'snapshot after replay');
    assert.equal(pose(next, sender).ammo, ammo, 'a replayed action sequence must not spend ammunition twice');
    return;
  }
}

// Run against dedicated test PostgreSQL and Redis instances. Install both Playwright browsers first.
test('Chromium and Firefox: verified accounts, invite room, resume, and two six-player public matches', { timeout: 220_000 }, async t => {
  assert.ok(process.env.DATABASE_URL && process.env.REDIS_URL, 'Provide isolated PostgreSQL and Redis endpoints');
  const id = randomUUID();
  const credentials = (n: number): Credentials => ({ email: 'browser-' + id + '-' + n + '@example.com', password: 'browser-testing-' + n + '-only', callsign: 'Browser-' + n });
  const playtestKey = 'browser-test:' + id;
  const port = await freePort();
  const origin = 'http://127.0.0.1:' + port;
  const child = spawn(process.execPath, ['--import', 'tsx', 'server.ts'], {
    env: { ...process.env, NODE_ENV: 'test', LOCAL_HTTP: '1', HOST: '127.0.0.1', PORT: String(port), ORIGIN: origin, PUBLIC_ACCESS: '0',
      TEST_MAILBOX: '1', PLAYTEST_KEY: playtestKey, REDIS_NAMESPACE: 'browser:' + id, TEST_MATCH_MS: '25000', DISABLE_HMR: 'true', DRAIN_MATCHES: '0',
      MODERATOR_EMAILS: credentials(1).email, CHAT_FILTER_TERMS: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { serverLog = (serverLog + String(chunk)).slice(-8000); });
  t.after(async () => {
    if (child.exitCode !== null || child.signalCode) return;
    const done = once(child, 'exit');
    child.kill('SIGTERM');
    const kill = setTimeout(() => child.kill('SIGKILL'), 8000).unref();
    await done;
    clearTimeout(kill);
  });
  try {
    await until(() => child.exitCode !== null || serverLog.includes('Prism Breach game server listening'), 'server startup', 20_000);
    assert.equal(child.exitCode, null, serverLog);
  } catch (err) { throw new Error(serverLog, { cause: err }); }

  async function verificationToken(email: string) {
    const response = await api(origin, 'test/mail?kind=verify&email=' + encodeURIComponent(email), { key: playtestKey });
    assert.equal(response.status, 200);
    return response.data.token as string;
  }

  const chromiumBrowser = await chromium.launch({
    channel: process.env.BROWSER_CHROMIUM_CHANNEL || undefined,
    executablePath: process.env.BROWSER_CHROMIUM_EXECUTABLE || undefined,
    args: ['--enable-unsafe-swiftshader', '--use-angle=swiftshader'],
  });
  t.after(() => chromiumBrowser.close());
  const firefoxBrowser = await firefox.launch({ firefoxUserPrefs: { 'webgl.force-enabled': true } });
  t.after(() => firefoxBrowser.close());
  const browserPlayers = await Promise.all([chromiumBrowser, firefoxBrowser].map(async (browser, i) => {
    const context = await browser.newContext({ viewport: { width: 960, height: 720 } });
    const page = await context.newPage();
    page.setDefaultTimeout(18_000);
    await observeThreeScenes(page);
    const observer = observePage(page);
    const account = credentials(i + 1);
    await page.goto(origin + '/?lang=en');
    await button(page, 'Register').click();
    await page.getByLabel('Email', { exact: true }).fill(account.email);
    await page.getByLabel('Password', { exact: true }).fill(account.password);
    await page.getByLabel('Callsign', { exact: true }).fill(account.callsign);
    await page.getByLabel('Closed test key (if provided)', { exact: true }).fill(playtestKey);
    await page.getByRole('button', { name: 'Register', exact: true }).click();
    await page.getByRole('status').filter({ hasText: 'verification link' }).waitFor();
    const token = await verificationToken(account.email);
    await page.goto(origin + '/?lang=en&verify=' + encodeURIComponent(token));
    await button(page, 'Verify email').click();
    await page.getByText('Email verified. You can now sign in.', { exact: true }).waitFor();
    await page.getByLabel('Email', { exact: true }).fill(account.email);
    await page.getByLabel('Password', { exact: true }).fill(account.password);
    await button(page, 'Sign in').click();
    await arena(page).waitFor({ state: 'attached' });
    const session = await until(() => observer.events.get('session:state') as (SessionView & { playerId: string }) | undefined, 'authenticated lobby');
    assert.equal(session.room, null, 'login must not automatically enter a room');
    await button(page, 'Multiplayer lobby').click();
    return { page, observer, account, playerId: session.playerId };
  }));
  const [host, guest] = browserPlayers;
  const profileFor = async (page: Page) => {
    const response = await page.request.get(origin + '/api/profile');
    assert.ok(response.ok());
    return await response.json() as { stats: { xp: number; matchesPlayed: number; recentMatches: { mapId: string }[] } };
  };

  await host.page.locator('input[name="name"]').fill('Cross browser scrimmage');
  await host.page.locator('select[name="map"]').selectOption('cryo_relay');
  await host.page.locator('select[name="mode"]').selectOption('control_core');
  await button(host.page, 'Create room').click();
  await host.page.getByRole('heading', { name: 'Cross browser scrimmage' }).waitFor();
  assert.equal(await button(host.page, 'Start match').isEnabled(), false);
  const code = (await lobby(host.page).locator('code').textContent())!;
  await guest.page.locator('input[name="code"]').fill(code);
  await button(guest.page, 'Join room').click();
  await guest.page.getByRole('heading', { name: 'Cross browser scrimmage' }).waitFor();
  const chat = 'Browser chat ' + id.slice(0, 8);
  await host.page.getByPlaceholder('Message players in this room').fill(chat);
  await button(host.page, 'Send').click();
  await guest.page.getByText(chat).waitFor();
  const reportedMessage = 'Reported test message ' + id.slice(0, 8);
  await guest.page.getByPlaceholder('Message players in this room').fill(reportedMessage);
  await button(guest.page, 'Send').click();
  const chatRow = host.page.getByRole('listitem').filter({ hasText: reportedMessage });
  await chatRow.getByRole('button', { name: 'Report', exact: true }).click();
  const reportReason = host.page.getByLabel('Reason for report (required)', { exact: true });
  await reportReason.fill('Moderation workflow test');
  await host.page.locator('form').filter({ has: reportReason }).getByRole('button', { name: 'Report', exact: true }).click();
  await host.page.getByText('Report submitted.', { exact: true }).waitFor();
  await chatRow.getByRole('button', { name: 'Block', exact: true }).click();
  await chatRow.waitFor({ state: 'hidden' });
  await lobby(host.page).getByRole('button', { name: 'Close', exact: true }).click();
  await button(host.page, 'Moderation').click();
  const reportRow = host.page.getByRole('listitem').filter({ hasText: reportedMessage });
  await reportRow.getByRole('button', { name: 'Mute for 24 hours', exact: true }).click();
  assert.match((await reportRow.locator('code').textContent()) ?? '', /^[0-9a-f-]{36}$/);
  await reportRow.getByLabel('Reason for action', { exact: false }).fill('Verified browser moderation test');
  await button(host.page, 'Apply action').click();
  await host.page.getByText('Action recorded.', { exact: true }).waitFor();
  await reportRow.waitFor({ state: 'hidden' });
  await button(host.page, 'Close').click();
  await button(host.page, 'Multiplayer lobby').click();
  await button(host.page, 'Start match').click();
  const custom = await until(() => host.observer.events.get('room:joined') as RoomJoin | undefined, 'custom match start');
  assert.equal(custom.snapshot.mode, 'control_core');
  assert.equal(custom.snapshot.mapId, 'cryo_relay');
  assert.equal(custom.snapshot.players.length, 2);
  await guest.page.getByTestId('active-unit-label').waitFor();
  await Promise.all(browserPlayers.map(({ page }) => assertMountedUrdf(page, 's1_striker')));
  const customJoins = guest.observer.joins;
  await guest.page.reload({ waitUntil: 'domcontentloaded' });
  const rejoined = await until(() => guest.observer.joins > customJoins && guest.observer.events.get('room:joined') as RoomJoin, 'guest refresh resume');
  assert.equal(rejoined.snapshot.matchId, custom.snapshot.matchId);
  assert.equal(rejoined.playerId, guest.playerId);

  for (const player of browserPlayers) {
    await button(player.page, 'Return to room').click({ timeout: 40_000 });
    await player.page.getByRole('heading', { name: 'Cross browser scrimmage' }).waitFor();
    assert.equal((await profileFor(player.page)).stats.xp, 0);
  }
  await button(host.page, 'Leave room').click();
  await button(guest.page, 'Leave room').click();

  const protocolPlayers: ProtocolPlayer[] = [];
  for (let n = 3; n <= 6; n++) {
    const account = await newAccount(origin, playtestKey, 'Protocol-' + n);
    const player = connect(origin, account.cookie);
    t.after(() => player.ws.terminate());
    await player.find('session:state');
    protocolPlayers.push(Object.assign(player, { playerId: account.playerId }));
  }

  for (const mapId of ['reactor_foundry', 'cryo_relay']) {
    const earlierMatch = (host.observer.events.get('room:joined') as RoomJoin).snapshot.matchId;
    await Promise.all(browserPlayers.map(({ page }) => button(page, 'Find a match').click()));
    for (const player of protocolPlayers) { player.clear(); player.send('queue:join'); }
    await Promise.all(browserPlayers.map(({ page }) => button(page, 'Accept match').click()));
    await Promise.all(protocolPlayers.map(async player => {
      const ready = await player.find('queue:state', state => state.status === 'ready');
      player.send('queue:confirm', { readyId: ready.readyId, accept: true });
    }));
    const joined = await until(() => {
      const event = host.observer.events.get('room:joined') as RoomJoin;
      return event.snapshot.matchId !== earlierMatch && event;
    }, 'public match start');
    assert.ok(joined.snapshot.matchId);
    assert.equal(joined.snapshot.mapId, mapId);
    assert.equal(joined.snapshot.mode, 'team_clash');
    assert.equal(new Set(joined.snapshot.players.map(player => player.id)).size, 6);
    await Promise.all([assertActualHit(protocolPlayers, joined.snapshot), verifyBrowserControls()]);

    async function verifyBrowserControls() {
      for (const { page, playerId, observer } of browserPlayers) {
        await page.getByTestId('active-unit-label').waitFor();
        const initial = await until(() => {
          const snapshot = observer.events.get('match:state') as MatchSnapshot | undefined;
          return snapshot !== undefined && snapshot.matchId === joined.snapshot.matchId && snapshot.players.find(player => player.id === playerId);
        }, 'first public snapshot');
        await page.keyboard.down('w');
        try {
          await until(() => {
            const state = observer.events.get('match:state') as MatchSnapshot;
            const current = state.players.find(p => p.id === playerId);
            return state.matchId === joined.snapshot.matchId && (state.serverTick ?? 0) > 0 && current &&
              (current.lastProcessedInputSeq ?? 0) > (initial.lastProcessedInputSeq ?? 0) && Math.hypot(current.x - initial.x, current.z - initial.z) > 0.75;
          }, 'authoritative movement from actual browser keyboard');
        } finally { await page.keyboard.up('w'); }
        const newClass = initial.robotClass === 's1_striker' ? 'ep_miner' : 's1_striker';
        await page.getByTestId('switch-unit-btn').click();
        await until(() => {
          const current = observer.events.get('match:state') as MatchSnapshot;
          return current.matchId === joined.snapshot.matchId && current.players.find(p => p.id === playerId)?.robotClass === newClass;
        }, 'authoritative chassis swap from browser button');
        await assertMountedUrdf(page, newClass);
      }
    }
    await Promise.all(browserPlayers.map(async ({ page, observer }) => {
      const summary = await until(() => {
        const result = observer.events.get('match:summary') as MatchSummaryPayload | undefined;
        return result?.matchId === joined.snapshot.matchId && result;
      }, 'committed public match result', 35_000);
      assert.ok(summary.xpEarned > 0);
      const result = await page.request.get(origin + '/api/matches/' + joined.snapshot.matchId);
      assert.ok(result.ok(), 'result must already be available in PostgreSQL');
      await button(page, 'Multiplayer lobby').click();
    }));
  }
  for (const { page } of browserPlayers) {
    const { stats } = await profileFor(page);
    assert.equal(stats.matchesPlayed, 2);
    assert.ok(stats.xp >= 200);
    assert.deepEqual(stats.recentMatches.slice(0, 2).map(match => match.mapId).sort(), ['cryo_relay', 'reactor_foundry']);
  }
});

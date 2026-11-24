import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, firefox, type Browser, type Page } from 'playwright';
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
test('Chromium and Firefox: invite link, room readiness, friends, party and two six-player public matches', { timeout: 220_000 }, async t => {
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
  const firefoxBrowser = await firefox.launch({
    headless: process.env.BROWSER_FIREFOX_HEADLESS !== '0',
    firefoxUserPrefs: { 'webgl.force-enabled': true },
  });
  t.after(() => firefoxBrowser.close());
  async function registerBrowser(browser: Browser, i: number, inviteCode?: string) {
    const context = await browser.newContext({ viewport: { width: 960, height: 720 } });
    const page = await context.newPage();
    const browserName = browser.browserType().name();
    const errors: string[] = [];
    const recordError = (message: string) => { errors.push(message); if (errors.length > 20) errors.shift(); };
    page.on('pageerror', error => recordError(error.message));
    page.on('console', message => { if (message.type() === 'error') recordError(message.text()); });
    page.setDefaultTimeout(18_000);
    await observeThreeScenes(page);
    const observer = observePage(page);
    const account = credentials(i + 1);
    await page.goto(origin + '/?lang=en' + (inviteCode ? '&invite=' + encodeURIComponent(inviteCode) : ''));
    if (inviteCode) {
      const preview = page.getByRole('region', { name: 'Room invitation' });
      assert.match(await preview.textContent() ?? '', new RegExp(inviteCode));
      await preview.getByText('Sign in to see the room and decide whether to join.').waitFor();
    }
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
    try {
      await arena(page).waitFor({ state: 'attached' });
    } catch (cause) {
      const alerts = await page.getByRole('alert').allTextContents();
      const webgl2 = await page.evaluate(() => {
        const gl = document.createElement('canvas').getContext('webgl2');
        if (!gl) return null;
        const version = String(gl.getParameter(gl.VERSION));
        gl.getExtension('WEBGL_lose_context')?.loseContext();
        return version;
      }).catch(() => 'unavailable');
      throw new Error(browserName + ' arena initialization failed: ' + JSON.stringify({ alerts, webgl2, errors }), { cause });
    }
    const session = await until(() => observer.events.get('session:state') as (SessionView & { playerId: string }) | undefined, 'authenticated lobby');
    assert.equal(session.room, null, 'login must not automatically enter a room');
    if (!inviteCode) await button(page, 'Multiplayer lobby').click();
    return { page, observer, account, playerId: session.playerId };
  }
  const host = await registerBrowser(chromiumBrowser, 0);
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
  const code = (await host.page.getByTestId('room-invite-code').textContent())!;
  const guest = await registerBrowser(firefoxBrowser, 1, code);
  const browserPlayers = [host, guest];
  const invitation = guest.page.getByRole('region', { name: 'Room invitation' });
  await invitation.getByText('Cross browser scrimmage', { exact: true }).waitFor();
  assert.equal(guest.observer.joins, 0);
  assert.equal((guest.observer.events.get('session:state') as SessionView).room, null, 'the invite link must not automatically join');
  await Promise.all(browserPlayers.map(({ page }) => button(page, 'Friends').click()));
  const guestFriendCode = (await guest.page.getByTestId('friend-code').textContent())!;
  await host.page.locator('input[name="friendCode"]').fill(guestFriendCode);
  await button(host.page, 'Send friend request').click();
  await host.page.getByText('Friend request sent.', { exact: true }).waitFor();
  await button(guest.page, 'Accept request').click();
  await host.page.getByRole('region', { name: 'Friends list' }).getByText(guest.account.callsign).waitFor();
  await button(host.page, 'Invite to room').click();
  await guest.page.getByRole('region', { name: 'Game invitations' }).getByText(host.account.callsign + ' invited you to a room').waitFor();
  await button(guest.page, 'Decline invitation').click();
  await guest.page.getByRole('region', { name: 'Game invitations' }).waitFor({ state: 'hidden' });
  await invitation.getByRole('button', { name: 'Join room', exact: true }).click();
  await guest.page.getByRole('heading', { name: 'Cross browser scrimmage' }).waitFor();
  await invitation.waitFor({ state: 'hidden' });
  await Promise.all(browserPlayers.map(({ page }) => button(page, 'Friends').click()));
  const guestCobalt = guest.page.getByRole('region', { name: 'Cobalt' });
  const readyBoth = () => Promise.all(browserPlayers.map(({ page }) => button(page, 'Ready up').click()));
  await button(host.page, 'Ready up').click();
  await button(host.page, 'Unready').waitFor();
  await button(guest.page, 'Join Cobalt').click();
  await guestCobalt.getByText(guest.account.callsign, { exact: true }).waitFor();
  await button(host.page, 'Ready up').waitFor();
  await button(guest.page, 'Join Amber').click();
  await guest.page.getByRole('region', { name: 'Amber' }).getByText(guest.account.callsign, { exact: true }).waitFor();
  await until(() => (host.observer.events.get('session:state') as SessionView).room?.members.find(member => member.id === guest.playerId)?.team === 'amber', 'host sees restored team');
  await readyBoth();
  await host.page.locator('summary').filter({ hasText: 'Edit room settings' }).click();
  await host.page.getByLabel('Friendly Fire', { exact: true }).check();
  await button(host.page, 'Save settings').click();
  await Promise.all(browserPlayers.map(({ page }) => button(page, 'Ready up').waitFor()));
  assert.equal(await button(host.page, 'Start match').isEnabled(), false, 'settings change invalidates readiness');
  await readyBoth();
  await button(host.page, 'Start match').click();
  await guest.page.getByRole('timer').waitFor();
  await button(guest.page, 'Unready').click();
  await host.page.getByRole('timer').waitFor({ state: 'hidden' });
  await button(host.page, 'Ready up').waitFor();
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
  await readyBoth();
  await button(host.page, 'Start match').click();
  await host.page.getByRole('timer').waitFor();
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
  const protocolCookies: string[] = [];
  for (let n = 3; n <= 6; n++) {
    const account = await newAccount(origin, playtestKey, 'Protocol-' + n);
    const player = connect(origin, account.cookie);
    t.after(() => player.ws.terminate());
    await player.find('session:state');
    protocolPlayers.push(Object.assign(player, { playerId: account.playerId }));
    protocolCookies.push(account.cookie);
  }

  const partyMate = protocolPlayers[0];
  const mateCode = (await api(origin, 'social', { cookie: protocolCookies[0] })).data.friendCode;
  assert.equal(typeof mateCode, 'string');
  await button(host.page, 'Create party').click();
  await button(host.page, 'Friends').click();
  await host.page.locator('input[name="friendCode"]').fill(mateCode);
  await button(host.page, 'Send friend request').click();
  await host.page.getByText('Friend request sent.', { exact: true }).waitFor();
  assert.equal((await api(origin, 'social/respond', { cookie: protocolCookies[0], data: { playerId: host.playerId, accept: true } })).status, 200);
  await button(host.page, 'Invite to party').click();
  const partyInvite = await partyMate.find('session:state', state => state.invites?.some((invite: { kind: string }) => invite.kind === 'party'));
  partyMate.send('social:respond', { inviteId: partyInvite.invites[0].id, accept: true });
  await host.page.getByRole('region', { name: 'Casual party' }).getByText('Protocol-3', { exact: true }).waitFor();
  await button(host.page, 'Friends').click();

  let previousPublicOffer: string | undefined;
  for (const mapId of ['reactor_foundry', 'cryo_relay']) {
    const earlierMatch = (host.observer.events.get('room:joined') as RoomJoin).snapshot.matchId;
    await Promise.all(browserPlayers.map(({ page }) => button(page, 'Find a match').click()));
    for (const player of protocolPlayers) {
      if (player === partyMate) continue;
      player.clear(); player.send('queue:join');
    }
    await Promise.all(browserPlayers.map(({ page }) => button(page, 'Accept match').click()));
    const offers = await Promise.all(protocolPlayers.map(async player => {
      const ready = await player.find('queue:state', state => state.status === 'ready' && state.readyId !== previousPublicOffer);
      player.send('queue:confirm', { readyId: ready.readyId, accept: true });
      return ready.readyId as string;
    }));
    previousPublicOffer = offers[0];
    const joined = await until(() => {
      const event = host.observer.events.get('room:joined') as RoomJoin;
      return event.snapshot.matchId !== earlierMatch && event;
    }, 'public match start');
    assert.ok(joined.snapshot.matchId);
    assert.equal(joined.snapshot.mapId, mapId);
    assert.equal(joined.snapshot.mode, 'team_clash');
    assert.equal(new Set(joined.snapshot.players.map(player => player.id)).size, 6);
    assert.equal(joined.snapshot.players.find(player => player.id === host.playerId)?.team,
      joined.snapshot.players.find(player => player.id === partyMate.playerId)?.team);
    await Promise.all([assertActualHit(protocolPlayers, joined.snapshot), verifyBrowserControls()]);

    async function verifyBrowserControls() {
      if (mapId === 'reactor_foundry') {
        const { page } = host;
        const menu = page.getByTestId('tactical-ping-menu');
        await page.getByTestId('active-unit-label').waitFor();
        await page.keyboard.down('g');
        await menu.waitFor();
        await page.keyboard.press('Escape');
        await menu.waitFor({ state: 'hidden' });
        await page.keyboard.up('g');
        await page.getByTestId('active-unit-label').waitFor();
        await page.keyboard.down('g');
        await page.keyboard.press('ArrowUp');
        await menu.locator('[data-kind="rally"][data-selected="true"]').waitFor();
        await page.keyboard.up('g');
        const ping = await partyMate.find('match:ping', payload => payload.matchId === joined.snapshot.matchId &&
          payload.kind === 'rally' && payload.playerId === host.playerId);
        assert.equal(ping.team, joined.snapshot.players.find(player => player.id === host.playerId)?.team);
        await page.getByTestId('minimap-tactical-ping').filter({ visible: true }).first().waitFor();
      }
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

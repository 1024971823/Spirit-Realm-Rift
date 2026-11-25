import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { test } from 'node:test';
import express from 'express';
import { makeMemoryServices } from './memoryServices.ts';
import { makeServices, type Result } from './services.ts';

test('standalone in-memory services handle guest login, block guest password impersonation, Cloud Run HTTPS origins, and match settlement', async t => {
  const prevOrigin = process.env.ORIGIN;
  const prevKey = process.env.PLAYTEST_KEY;
  delete process.env.ORIGIN;
  delete process.env.PLAYTEST_KEY;
  t.after(() => {
    if (prevOrigin !== undefined) process.env.ORIGIN = prevOrigin;
    if (prevKey !== undefined) process.env.PLAYTEST_KEY = prevKey;
  });

  const services = await makeMemoryServices();
  t.after(() => services.close());

  // Cloud Run HTTPS reverse-proxy origin matching
  assert.equal(
    services.allowOrigin({
      headers: { host: 'prism.us-west2.run.app', origin: 'https://prism.us-west2.run.app' },
    } as IncomingMessage),
    true,
  );
  assert.equal(
    services.allowOrigin({
      headers: { host: 'prism.us-west2.run.app', origin: 'https://evil.example' },
    } as IncomingMessage),
    false,
  );

  const app = express();
  app.use(express.json());
  services.install(app);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  t.after(() => server.close());
  const port = (server.address() as { port: number }).port;
  const origin = `http://127.0.0.1:${port}`;

  const modeRes = await fetch(`${origin}/api/auth/mode`);
  assert.equal(modeRes.status, 200);
  assert.deepEqual(await modeRes.json(), { standalone: true, ephemeral: true });

  // Guest quick-play issues valid session cookie and profile
  const guestRes = await fetch(`${origin}/api/auth/guest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ callsign: 'CloudPilot' }),
  });
  assert.equal(guestRes.status, 200);
  const guestCookie = guestRes.headers.get('set-cookie')?.split(';')[0] ?? '';
  const guestData = (await guestRes.json()) as { playerId: string };
  assert.ok(guestCookie.startsWith('prism_session='));

  // Guest accounts MUST NOT be loggable via password login (even with historical placeholder password)
  const guestEmail = `guest-${guestData.playerId}@local.prism`;
  const impersonateRes = await fetch(`${origin}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ email: guestEmail, password: 'placeholder-password-never-used' }),
  });
  assert.equal(impersonateRes.status, 401);

  // X-Forwarded-Proto: https adds Secure attribute to session cookie
  const httpsRes = await fetch(`${origin}/api/auth/guest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin, 'X-Forwarded-Proto': 'https' },
    body: JSON.stringify({}),
  });
  assert.ok(httpsRes.headers.get('set-cookie')?.includes('; Secure'));

  // Session & profile work with cookie
  const profileRes = await fetch(`${origin}/api/profile`, { headers: { Cookie: guestCookie } });
  assert.equal(profileRes.status, 200);
  const profile = (await profileRes.json()) as { id: string; callsign: string };
  assert.equal(profile.id, guestData.playerId);
  assert.equal(profile.callsign, 'CloudPilot');

  // Owner lease + idempotent match result commit
  const ownerId = randomUUID();
  const matchId = randomUUID();
  await services.renewOwner(ownerId);
  await services.openMatch(matchId, ownerId, [guestData.playerId]);
  const result: Result = {
    playerId: guestData.playerId,
    summary: { matchId },
    progress: {
      mapId: 'reactor_foundry',
      mode: 'team_clash',
      won: true,
      kills: 4,
      deaths: 1,
      assists: 2,
      shotsFired: 20,
      shotsHit: 10,
      damageDealt: 220,
      hazardKills: 0,
      barriersDestroyed: 1,
      weaponId: 'pulse_carbine',
      xpEarned: 150,
    },
  };
  await services.commitResults(matchId, [structuredClone(result)], ownerId);
  await services.commitResults(matchId, [structuredClone(result)], ownerId);
  assert.equal((await services.getProfile(guestData.playerId)).stats.xp, 150);
  const matchRes = await fetch(`${origin}/api/matches/${matchId}`, { headers: { Cookie: guestCookie } });
  assert.equal(matchRes.status, 200);
  assert.equal(((await matchRes.json()) as { status: string }).status, 'finished');
});

test('memory trial mode never grants moderator privileges to unverified self-registered accounts', async t => {
  const prevOrigin = process.env.ORIGIN;
  const prevKey = process.env.PLAYTEST_KEY;
  const prevMods = process.env.MODERATOR_EMAILS;
  delete process.env.ORIGIN;
  delete process.env.PLAYTEST_KEY;
  process.env.MODERATOR_EMAILS = 'admin@example.com';
  t.after(() => {
    if (prevOrigin !== undefined) process.env.ORIGIN = prevOrigin;
    else delete process.env.ORIGIN;
    if (prevKey !== undefined) process.env.PLAYTEST_KEY = prevKey;
    else delete process.env.PLAYTEST_KEY;
    if (prevMods !== undefined) process.env.MODERATOR_EMAILS = prevMods;
    else delete process.env.MODERATOR_EMAILS;
  });

  const services = await makeMemoryServices();
  t.after(() => services.close());

  const app = express();
  app.use(express.json());
  services.install(app);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  t.after(() => server.close());
  const port = (server.address() as { port: number }).port;
  const origin = `http://127.0.0.1:${port}`;

  const regRes = await fetch(`${origin}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ email: 'admin@example.com', password: 'StrongPassword123!', callsign: 'FakeAdmin' }),
  });
  assert.equal(regRes.status, 200);
  const regCookie = regRes.headers.get('set-cookie')?.split(';')[0] ?? '';
  const regBody = (await regRes.json()) as { moderator: boolean };
  assert.equal(regBody.moderator, false);

  const sessionRes = await fetch(`${origin}/api/auth/session`, { headers: { Cookie: regCookie } });
  assert.equal(sessionRes.status, 200);
  assert.equal(((await sessionRes.json()) as { moderator: boolean }).moderator, false);

  const modRes = await fetch(`${origin}/api/moderation/reports`, { headers: { Cookie: regCookie } });
  assert.equal(modRes.status, 403);
});

test('makeServices blocks silent memory fallback in production unless ALLOW_MEMORY_MODE=1 (and never when PUBLIC_ACCESS=1)', async t => {
  const saved = {
    NODE_ENV: process.env.NODE_ENV,
    DATABASE_URL: process.env.DATABASE_URL,
    REDIS_URL: process.env.REDIS_URL,
    PUBLIC_ACCESS: process.env.PUBLIC_ACCESS,
    ALLOW_MEMORY_MODE: process.env.ALLOW_MEMORY_MODE,
  };
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  delete process.env.DATABASE_URL;
  delete process.env.REDIS_URL;
  process.env.NODE_ENV = 'production';
  delete process.env.PUBLIC_ACCESS;
  delete process.env.ALLOW_MEMORY_MODE;

  // Missing DB/Redis in production without explicit opt-in MUST fail fast
  await assert.rejects(() => makeServices(), /ALLOW_MEMORY_MODE=1/);

  // PUBLIC_ACCESS=1 MUST reject memory mode even when ALLOW_MEMORY_MODE=1 is set
  process.env.PUBLIC_ACCESS = '1';
  process.env.ALLOW_MEMORY_MODE = '1';
  await assert.rejects(() => makeServices(), /DATABASE_URL and REDIS_URL are required/);

  // Explicit ALLOW_MEMORY_MODE=1 in non-public production starts in-memory demo mode
  process.env.PUBLIC_ACCESS = '0';
  process.env.ALLOW_MEMORY_MODE = '1';
  const svc = await makeServices();
  t.after(() => svc.close());
  assert.equal(svc.standalone, true);
});

test('daily missions progress via match settlement, handle concurrent claims safely, and resist profile spoofing', async t => {
  const prevOrigin = process.env.ORIGIN;
  delete process.env.ORIGIN;
  t.after(() => {
    if (prevOrigin !== undefined) process.env.ORIGIN = prevOrigin;
  });

  const services = await makeMemoryServices();
  t.after(() => services.close());

  const app = express();
  app.use(express.json());
  services.install(app);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  t.after(() => server.close());
  const port = (server.address() as { port: number }).port;
  const origin = `http://127.0.0.1:${port}`;

  const guestRes = await fetch(`${origin}/api/auth/guest`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin },
    body: JSON.stringify({ callsign: 'MissionTester' }),
  });
  assert.equal(guestRes.status, 200);
  const cookie = guestRes.headers.get('set-cookie')?.split(';')[0] ?? '';
  const { playerId } = (await guestRes.json()) as { playerId: string };

  const initialRes = await fetch(`${origin}/api/missions`, { headers: { Cookie: cookie } });
  assert.equal(initialRes.status, 200);
  const initialData = (await initialRes.json()) as {
    dailyMissions: { missions: Array<{ id: string; progress: number; target: number; rewardCredits: number }> };
    credits: number;
    nextResetMs: number;
    serverTimeMs: number;
    eligibilityPolicy: { publicOnly: boolean; minMatchSec: number };
  };
  assert.equal(initialData.dailyMissions.missions.length, 3);
  assert.equal(initialData.credits, 0);
  assert.ok(initialData.nextResetMs > 0);
  assert.ok(initialData.serverTimeMs > 0);
  assert.equal(typeof initialData.eligibilityPolicy.publicOnly, 'boolean');
  assert.ok(initialData.eligibilityPolicy.minMatchSec > 0);

  // Claiming an incomplete mission is rejected with 409
  const earlyClaim = await fetch(`${origin}/api/missions/claim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: cookie },
    body: JSON.stringify({ missionId: initialData.dailyMissions.missions[0].id }),
  });
  assert.equal(earlyClaim.status, 409);

  // Settle 3 matches with generous contributions so all 3 daily missions complete
  const ownerId = randomUUID();
  await services.renewOwner(ownerId);
  for (let i = 0; i < 3; i++) {
    const matchId = randomUUID();
    await services.openMatch(matchId, ownerId, [playerId]);
    const res: Result = {
      playerId,
      summary: { matchId },
      missionContribution: {
        won: true,
        matchesCompleted: 1,
        damageDealt: 700,
        barriersDestroyed: 4,
        allyRepair: 200,
        killsByRobot: { s1_striker: 9, ep_miner: 0 },
        oreMinedByRobot: { s1_striker: 0, ep_miner: 300 },
      },
    };
    await services.commitResults(matchId, [res], ownerId);
    if (i === 0) {
      assert.ok(Array.isArray(res.summary.missionUpdates));
      assert.ok((res.summary.missionUpdates as unknown[]).length >= 2);
    }
  }

  // Client saveProfile must not overwrite dailyMissions or credits
  const currentProfile = await services.getProfile(playerId);
  await services.saveProfile(playerId, {
    ...currentProfile,
    stats: { ...currentProfile.stats, credits: 999999 },
    dailyMissions: undefined,
  });
  const afterSave = await services.getProfile(playerId);
  assert.equal(afterSave.stats.credits, 0);
  assert.ok(afterSave.dailyMissions?.missions.every(m => m.progress >= m.target));

  // Concurrent claims on each mission must award credits exactly once
  let expectedCredits = 0;
  for (const m of initialData.dailyMissions.missions) {
    const [r1, r2] = await Promise.all([
      fetch(`${origin}/api/missions/claim`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: cookie },
        body: JSON.stringify({ missionId: m.id }),
      }),
      fetch(`${origin}/api/missions/claim`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: cookie },
        body: JSON.stringify({ missionId: m.id }),
      }),
    ]);
    const statuses = [r1.status, r2.status].sort((a, b) => a - b);
    assert.deepEqual(statuses, [200, 409]);
    expectedCredits += m.rewardCredits;
    const latestProfile = await services.getProfile(playerId);
    assert.equal(latestProfile.stats.credits, expectedCredits);
  }

  // Concurrent All-Clear bonus claims must award +200 credits exactly once
  const [b1, b2] = await Promise.all([
    fetch(`${origin}/api/missions/claim-bonus`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: cookie },
    }),
    fetch(`${origin}/api/missions/claim-bonus`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: cookie },
    }),
  ]);
  const bonusStatuses = [b1.status, b2.status].sort((a, b) => a - b);
  assert.deepEqual(bonusStatuses, [200, 409]);
  assert.equal((await services.getProfile(playerId)).stats.credits, expectedCredits + 200);
});

test('guest quick-play accepts X-Forwarded-Host behind trusted reverse proxy, sets iframe-safe HTTPS cookies, and rejects spoofed proxy headers when untrusted', async t => {
  const prevOrigin = process.env.ORIGIN;
  const prevKService = process.env.K_SERVICE;
  const prevTrustProxy = process.env.TRUST_PROXY;
  delete process.env.ORIGIN;
  delete process.env.K_SERVICE;
  delete process.env.TRUST_PROXY;
  t.after(() => {
    if (prevOrigin !== undefined) process.env.ORIGIN = prevOrigin;
    else delete process.env.ORIGIN;
    if (prevKService !== undefined) process.env.K_SERVICE = prevKService;
    else delete process.env.K_SERVICE;
    if (prevTrustProxy !== undefined) process.env.TRUST_PROXY = prevTrustProxy;
    else delete process.env.TRUST_PROXY;
  });

  // Untrusted direct server must reject spoofed X-Forwarded-Host
  const directServices = await makeMemoryServices();
  t.after(() => directServices.close());
  assert.equal(
    directServices.allowOrigin({
      headers: {
        host: 'localhost:3000',
        'x-forwarded-host': 'ais-dev-example.us-west2.run.app',
        origin: 'https://ais-dev-example.us-west2.run.app',
      },
    } as unknown as IncomingMessage),
    false,
  );

  // Trusted Cloud Run / AI Studio proxy accepts X-Forwarded-Host when nginx overrides Host to localhost:3000
  process.env.K_SERVICE = 'ais-dev-example';
  const proxyServices = await makeMemoryServices();
  t.after(() => proxyServices.close());

  const app = express();
  app.use(express.json());
  proxyServices.install(app);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  t.after(() => server.close());
  const port = (server.address() as { port: number }).port;
  const proxyHost = 'ais-dev-example.us-west2.run.app';
  const proxyOrigin = `https://${proxyHost}`;

  // Valid proxied guest sign-in succeeds even when nginx rewrites Host and X-Forwarded-Proto=http
  const okRes = await fetch(`http://127.0.0.1:${port}/api/auth/guest`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: proxyOrigin,
      'X-Forwarded-Host': proxyHost,
      'X-Forwarded-Proto': 'http',
    },
    body: JSON.stringify({}),
  });
  assert.equal(okRes.status, 200);
  const setCookie = okRes.headers.get('set-cookie') ?? '';
  assert.ok(setCookie.includes('SameSite=None'), `Expected SameSite=None cookie for HTTPS iframe, got: ${setCookie}`);
  assert.ok(setCookie.includes('Secure'), `Expected Secure cookie for HTTPS iframe, got: ${setCookie}`);
  assert.ok(setCookie.includes('Partitioned'), `Expected Partitioned cookie for HTTPS iframe, got: ${setCookie}`);

  // Cross-origin attacker is still blocked with 403
  const evilRes = await fetch(`http://127.0.0.1:${port}/api/auth/guest`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'https://evil.example',
      'X-Forwarded-Host': proxyHost,
    },
    body: JSON.stringify({}),
  });
  assert.equal(evilRes.status, 403);

  // Cookie-less cross-site iframe fallback: authenticate HTTP and WS subprotocol purely via sessionToken
  const guestPayload = (await okRes.json()) as {
    playerId: string;
    profile?: { id: string; callsign: string };
    sessionToken?: string;
  };
  assert.equal(guestPayload.profile?.id, guestPayload.playerId);
  assert.ok(guestPayload.sessionToken && guestPayload.sessionToken.length === 43);

  const bearerSessionRes = await fetch(`http://127.0.0.1:${port}/api/auth/session`, {
    headers: { Authorization: `Bearer ${guestPayload.sessionToken}` },
  });
  assert.equal(bearerSessionRes.status, 200);
  const bearerSession = (await bearerSessionRes.json()) as { playerId: string; profile?: { id: string } };
  assert.equal(bearerSession.playerId, guestPayload.playerId);
  assert.equal(bearerSession.profile?.id, guestPayload.playerId);

  const wsAuth = await proxyServices.authenticate({
    headers: {
      'sec-websocket-protocol': `prism.v2, prism.auth.${guestPayload.sessionToken}`,
    },
  } as unknown as IncomingMessage);
  assert.equal(wsAuth?.playerId, guestPayload.playerId);

  // Logout revokes the token even when sent without cookies
  const logoutRes = await fetch(`http://127.0.0.1:${port}/api/auth/logout`, {
    method: 'POST',
    headers: {
      Origin: proxyOrigin,
      'X-Forwarded-Host': proxyHost,
      Authorization: `Bearer ${guestPayload.sessionToken}`,
    },
  });
  assert.equal(logoutRes.status, 200);
  const afterLogout = await proxyServices.authenticate({
    headers: { Authorization: `Bearer ${guestPayload.sessionToken}` },
  } as unknown as IncomingMessage);
  assert.equal(afterLogout, null);
});



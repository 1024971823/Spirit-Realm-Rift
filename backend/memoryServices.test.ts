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


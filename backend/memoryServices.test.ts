import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { test } from 'node:test';
import express from 'express';
import { makeMemoryServices } from './memoryServices.ts';
import type { Result } from './services.ts';

test('standalone in-memory services handle guest login, Cloud Run HTTPS origins, social, and match settlement', async t => {
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
  assert.deepEqual(await modeRes.json(), { standalone: true });

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

test('daily missions progress via match settlement, claim rewards idempotently, and resist profile spoofing', async t => {
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
  };
  assert.equal(initialData.dailyMissions.missions.length, 3);
  assert.equal(initialData.credits, 0);
  assert.ok(initialData.nextResetMs > 0);

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

  // Claim all 3 individual missions + verify duplicate claim fails
  let expectedCredits = 0;
  for (const m of initialData.dailyMissions.missions) {
    const claimRes = await fetch(`${origin}/api/missions/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: cookie },
      body: JSON.stringify({ missionId: m.id }),
    });
    assert.equal(claimRes.status, 200);
    const body = (await claimRes.json()) as { creditsAwarded: number; profile: { stats: { credits: number } } };
    expectedCredits += m.rewardCredits;
    assert.equal(body.creditsAwarded, m.rewardCredits);
    assert.equal(body.profile.stats.credits, expectedCredits);

    const dupRes = await fetch(`${origin}/api/missions/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: cookie },
      body: JSON.stringify({ missionId: m.id }),
    });
    assert.equal(dupRes.status, 409);
  }

  // Claim All-Clear bonus (+200 credits) + duplicate rejection
  const bonusRes = await fetch(`${origin}/api/missions/claim-bonus`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: cookie },
  });
  assert.equal(bonusRes.status, 200);
  const bonusBody = (await bonusRes.json()) as { creditsAwarded: number; profile: { stats: { credits: number } } };
  assert.equal(bonusBody.creditsAwarded, 200);
  assert.equal(bonusBody.profile.stats.credits, expectedCredits + 200);

  const dupBonus = await fetch(`${origin}/api/missions/claim-bonus`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: origin, Cookie: cookie },
  });
  assert.equal(dupBonus.status, 409);
});


import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { Pool } from 'pg';
import { makeServices } from '../backend/services.ts';
import type { SocialView } from '../src/shared/social.ts';

test('friends persist across sessions and respect invitation, presence and moderation controls', { timeout: 30_000 }, async t => {
  assert.ok(process.env.DATABASE_URL && process.env.REDIS_URL, 'Provide isolated PostgreSQL and Redis endpoints');
  const run = randomUUID();
  const password = 'prism-testing:social';
  Object.assign(process.env, {
    NODE_ENV: 'test', TEST_MAILBOX: '1', PUBLIC_ACCESS: '0',
    PLAYTEST_KEY: run, REDIS_NAMESPACE: 'integration:social:' + run,
  });
  delete process.env.ORIGIN;
  const services = await makeServices();
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  t.after(async () => { await Promise.all([services.close(), db.end()]); });
  const app = express();
  app.use(express.json({ limit: '16kb' }));
  services.install(app);
  const http = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => http.once('listening', resolve));
  t.after(() => { http.close(); });
  const origin = 'http://127.0.0.1:' + (http.address() as { port: number }).port;

  async function call(path: string, status: number, data?: unknown, cookie = '', ref = origin) {
    const response = await fetch(origin + '/api/' + path, {
      method: data === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookie, Origin: ref, 'x-playtest-key': run },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    assert.equal(response.status, status, path);
    return { json: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] ?? '' };
  }
  async function account(callsign: string) {
    const email = run + '-' + callsign.toLowerCase() + '@example.com';
    await call('auth/register', 200, { email, password, callsign });
    const { token } = (await call('test/mail?kind=verify&email=' + email, 200)).json;
    await call('auth/verify', 200, { token });
    const session = await call('auth/login', 200, { email, password });
    return { id: session.json.playerId as string, cookie: session.cookie, email, callsign };
  }
  const social = async (cookie: string): Promise<SocialView> => (await call('social', 200, undefined, cookie)).json;

  await call('social', 401);
  const [a, b, c] = await Promise.all([account('Alpha'), account('Bravo'), account('Charlie')]);
  const [viewA, viewB] = await Promise.all([social(a.cookie), social(b.cookie)]);
  assert.match(viewA.friendCode, /^[A-F0-9]{16}$/);
  assert.match(viewB.friendCode, /^[A-F0-9]{16}$/);
  assert.notEqual(viewA.friendCode, viewB.friendCode);
  assert.equal(viewB.allowInvites, true);
  await call('social/request', 403, { friendCode: viewB.friendCode }, a.cookie, 'https://unrelated.example');
  const self = await call('social/request', 400, { friendCode: viewA.friendCode }, a.cookie);
  assert.equal(self.json.error, 'social_invalid');

  const friendCode = viewB.friendCode.toLowerCase().match(/.{4}/g)!.join('-');
  const requestB = () => call('social/request', 200, { friendCode }, a.cookie);
  await Promise.all([requestB(), requestB()]);
  assert.deepEqual((await social(a.cookie)).outgoing, [{ playerId: b.id, callsign: b.callsign }]);
  assert.deepEqual((await social(b.cookie)).incoming, [{ playerId: a.id, callsign: a.callsign }]);
  assert.equal(await services.social.canInvite(a.id, b.id), false);
  const reciprocal = await call('social/request', 409, { friendCode: viewA.friendCode }, b.cookie);
  assert.equal(reciprocal.json.error, 'social_request_received');
  const unrelated = await call('social/respond', 404, { playerId: a.id, accept: true }, c.cookie);
  assert.equal(unrelated.json.error, 'social_request_missing');
  await call('social/respond', 404, { playerId: b.id, accept: true }, a.cookie);
  await call('social/respond', 200, { playerId: a.id, accept: false }, b.cookie);
  assert.deepEqual((await social(a.cookie)).outgoing, []);
  assert.deepEqual((await social(b.cookie)).incoming, []);

  await requestB();
  await Promise.all([
    call('social/respond', 200, { playerId: a.id, accept: true }, b.cookie),
    call('social/respond', 200, { playerId: a.id, accept: true }, b.cookie),
  ]);
  services.social.setPresenceProvider(id => id === b.id ? 'in_match' : 'online');
  const anotherSession = (await call('auth/login', 200, { email: a.email, password })).cookie;
  await call('auth/logout', 200, {}, a.cookie);
  await call('social', 401, undefined, a.cookie);
  const persisted = await social(anotherSession);
  assert.equal(persisted.friendCode, viewA.friendCode);
  assert.deepEqual(persisted.friends, [{ id: b.id, callsign: b.callsign, status: 'in_match' }]);
  assert.deepEqual((await social(b.cookie)).friends, [{ id: a.id, callsign: a.callsign, status: 'online' }]);
  assert.deepEqual((await social(c.cookie)).friends, []);
  assert.equal(await services.social.canInvite(a.id, b.id), true);

  await call('social/settings', 200, { allowInvites: false }, b.cookie);
  assert.equal((await social(b.cookie)).allowInvites, false);
  assert.equal(await services.social.isFriend(a.id, b.id), true);
  assert.equal(await services.social.canInvite(a.id, b.id), false);
  assert.equal(await services.social.canInvite(b.id, a.id), true);
  await call('social/settings', 200, { allowInvites: true }, b.cookie);
  await db.query("UPDATE accounts SET muted_until = now() + interval '1 minute' WHERE id = $1", [a.id]);
  assert.equal(await services.social.canSignal(a.id), false);
  assert.equal(await services.social.canInvite(a.id, b.id), false);
  assert.equal(await services.social.canInvite(b.id, a.id), true);
  await db.query('UPDATE accounts SET muted_until = NULL WHERE id = $1', [a.id]);
  assert.equal(await services.social.canSignal(a.id), true);

  await call('chat/block', 200, { playerId: a.id, blocked: true }, b.cookie);
  assert.deepEqual((await social(anotherSession)).friends, []);
  assert.deepEqual((await social(b.cookie)).friends, []);
  assert.equal(await services.social.canInvite(a.id, b.id), false);
  assert.equal(await services.social.canInvite(b.id, a.id), false);
  const blocked = await call('social/request', 404, { friendCode }, anotherSession);
  assert.equal(blocked.json.error, 'social_unavailable');
  await call('chat/block', 200, { playerId: a.id, blocked: false }, b.cookie);
  assert.equal(await services.social.canInvite(a.id, b.id), true);

  await db.query('UPDATE accounts SET banned = true WHERE id = $1', [a.id]);
  await call('social', 401, undefined, anotherSession);
  assert.deepEqual((await social(b.cookie)).friends, []);
  assert.equal(await services.social.canInvite(b.id, a.id), false);
  assert.equal(await services.social.canSignal(a.id), false);
  await db.query('UPDATE accounts SET banned = false WHERE id = $1', [a.id]);
  await call('social/remove', 200, { playerId: a.id }, b.cookie);
  assert.deepEqual((await social(anotherSession)).friends, []);
  assert.deepEqual((await social(b.cookie)).friends, []);
  assert.equal(await services.social.canInvite(a.id, b.id), false);
});

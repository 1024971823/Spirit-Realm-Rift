import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { Pool } from 'pg';
import { makeServices, type Result } from '../backend/services.ts';
import { sleep } from './protocol.ts';

const password = 'prism-testing:initial';
const replacement = 'prism-testing:updated';
const playtestKey = 'integration-only:' + randomUUID();

test('PostgreSQL and Redis: verification, recovery, exactly-once XP, owner fencing and moderation', { timeout: 40_000 }, async t => {
  assert.ok(process.env.DATABASE_URL && process.env.REDIS_URL, 'Provide isolated PostgreSQL and Redis endpoints');
  const id = randomUUID();
  const email = id + '@example.com';
  const moderator = 'staff-' + id + '@example.com';
  Object.assign(process.env, { NODE_ENV: 'test', TEST_MAILBOX: '1', PUBLIC_ACCESS: '0', PLAYTEST_KEY: playtestKey, REDIS_NAMESPACE: 'integration:' + id, MODERATOR_EMAILS: moderator, CHAT_FILTER_TERMS: 'blocked_test_term' });
  delete process.env.ORIGIN;
  const revoked: { id: string; by: string }[] = [];
  const services = await makeServices((id, by) => { revoked.push({ id, by }); });
  const db = new Pool({ connectionString: process.env.DATABASE_URL });
  t.after(async () => { await Promise.all([services.close(),db.end()]); });
  const app = express();
  app.use(express.json({ limit: '16kb' }));
  services.install(app);
  const http = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => http.once('listening', resolve));
  t.after(() => { http.close(); });
  const port = (http.address() as { port: number }).port;
  const origin = 'http://127.0.0.1:' + port;
  const call = async (path: string, data?: unknown, cookie = '', testKey = false, ref = origin) => {
    const response = await fetch(origin + '/api/' + path, {
      method: data === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type':'application/json', Origin: ref, Cookie: cookie, ...(testKey ? { 'x-playtest-key': playtestKey } : {}) },
      body: data === undefined ? undefined : JSON.stringify(data),
    });
    return { status: response.status, json: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] ?? '' };
  };
  async function account(address: string) {
    assert.equal((await call('auth/register',{email:address,password,callsign:'Tester'},'',true)).status,200);
    assert.equal((await call('auth/login',{email:address,password})).status,403);
    assert.equal((await call('test/mail?kind=verify&email='+address)).status,404);
    const { token } = (await call('test/mail?kind=verify&email='+address,undefined,'',true)).json;
    assert.equal((await call('auth/verify',{token})).status,200);
    assert.equal((await call('auth/verify',{token})).status,400);
    const logged = await call('auth/login',{email:address,password});
    assert.equal(logged.status,200);
    return { playerId: logged.json.playerId as string, cookie: logged.cookie };
  }
  assert.equal((await call('auth/register',{email,password})).status,403);
  assert.equal((await call('auth/register',{email,password},'',true,'https://other.example')).status,403);
  const { playerId, cookie } = await account(email);
  const staff = await account(moderator);
  const start = await call('profile',undefined,cookie);
  assert.equal(start.json.stats.xp,0);
  assert.equal(start.json.stats.matchesPlayed,0);
  const inAnotherBrowser = (await call('auth/login',{email,password})).cookie;
  assert.equal((await call('profile',undefined,inAnotherBrowser)).json.id,playerId);
  assert.equal((await call('test/eligibility',{kind:'denied'},cookie,true)).status,200);
  assert.equal(await services.allowPlay(playerId),false);
  assert.equal((await call('test/eligibility',{kind:'adult'},cookie,true)).status,200);
  assert.equal(await services.allowPlay(playerId,180_000),true);

  const owner = randomUUID(), match = randomUUID();
  await services.renewOwner(owner);
  await services.openMatch(match,owner,[playerId]);
  const result: Result = {playerId,summary:{matchId:match},progress:{mapId:'reactor_foundry',mode:'team_clash',won:true,kills:2,deaths:1,assists:1,shotsFired:8,shotsHit:2,damageDealt:100,hazardKills:0,barriersDestroyed:1,weaponId:'pulse_carbine',xpEarned:181}};
  await assert.rejects(services.commitResults(match,[result],randomUUID()));
  // The roster and XP are both rolled back when an invalid participant appears at finalize.
  await assert.rejects(services.commitResults(match,[result,{...result,playerId:staff.playerId}],owner));
  assert.equal((await services.getProfile(playerId)).stats.xp,0);
  await Promise.all([services.commitResults(match,[structuredClone(result)],owner),services.commitResults(match,[structuredClone(result)],owner)]);
  assert.equal((await services.getProfile(playerId)).stats.xp,181);
  const persisted = await call('matches/'+match,undefined,cookie);
  assert.equal(persisted.json.summary.newXp,181);
  assert.equal((await call('matches/'+match,undefined,staff.cookie)).status,404);

  const orphan = randomUUID();
  await services.openMatch(orphan,owner,[playerId]);
  await db.query('UPDATE game_owners SET expires_at=now() WHERE id=$1',[owner]);
  await services.reap();
  assert.equal((await services.getResult(playerId,orphan))?.status,'cancelled');
  await assert.rejects(services.commitResults(orphan,[result],owner));

  assert.equal(await services.chat.send('TEST',playerId,'Tester','ＢＬＯＣＫＥＤ＿ＴＥＳＴ＿ＴＥＲＭ'),null);
  const message = await services.chat.send('TEST',playerId,'Tester','你好');
  assert.ok(message);
  assert.equal((await call('chat/report',{messageId:message.id,reason:'测试'},staff.cookie)).status,404);
  await services.chat.delivered(message.id,[staff.playerId]);
  assert.equal((await call('chat/report',{messageId:message.id,reason:'测试'},staff.cookie)).status,200);
  assert.equal((await call('moderation/reports',undefined,cookie)).status,403);
  const reported = (await call('moderation/reports',undefined,staff.cookie)).json.reports
    .find((report: {messageId: string}) => report.messageId === message.id);
  assert.ok(reported, 'Moderators should see the report created by this test run');
  await call('chat/block',{playerId,blocked:true},staff.cookie);
  assert.deepEqual(await services.chat.blockedBy([staff.playerId],playerId),new Set([staff.playerId]));
  assert.equal((await call('moderation/actions',{messageId:message.id,action:'mute',reason:'测试'},staff.cookie)).status,200);
  assert.equal(await services.chat.send('TEST',playerId,'Tester','muted'),null);

  assert.equal((await call('auth/forgot',{email})).status,200);
  const reset = (await call('test/mail?kind=reset&email='+email,undefined,'',true)).json.token;
  const loginLock = Math.floor(Math.random() * 1_000_000_000) + 1;
  const triggerName = 'prism_login_race_' + id.replaceAll('-', '');
  const lockClient = await db.connect();
  let overlappingLogin: Awaited<ReturnType<typeof call>>;
  try {
    await db.query(`CREATE FUNCTION ${triggerName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.account_id='${playerId}'::uuid THEN PERFORM pg_advisory_xact_lock(${loginLock}); END IF; RETURN NEW; END $$`);
    await db.query('CREATE TRIGGER ' + triggerName + ' BEFORE INSERT ON sessions FOR EACH ROW EXECUTE FUNCTION ' + triggerName + '()');
    await lockClient.query('SELECT pg_advisory_lock($1)', [loginLock]);
    const loginInFlight = call('auth/login', { email, password });
    // Wait for the login insert to reach the scoped trigger before starting reset.
    const untilBlocked = Date.now() + 5000;
    while (!(await db.query("SELECT 1 FROM pg_locks WHERE locktype='advisory' AND objid=$1 AND NOT granted", [loginLock])).rowCount) {
      assert.ok(Date.now() < untilBlocked, 'Login should reach the blocked session insert');
      await sleep(10);
    }
    const resetInFlight = call('auth/reset', { token:reset, password:replacement });
    await sleep(250);
    await lockClient.query('SELECT pg_advisory_unlock($1)', [loginLock]);
    const [login, changed] = await Promise.all([loginInFlight, resetInFlight]);
    assert.equal(login.status, 200);
    assert.equal(changed.status, 200);
    overlappingLogin = login;
  } finally {
    await lockClient.query('SELECT pg_advisory_unlock_all()');
    lockClient.release();
    await db.query('DROP TRIGGER IF EXISTS ' + triggerName + ' ON sessions');
    await db.query('DROP FUNCTION IF EXISTS ' + triggerName + '()');
  }
  assert.equal((await call('auth/session', undefined, overlappingLogin.cookie)).status, 401, 'Reset must revoke even a login that was already creating its session');
  assert.equal((await call('auth/reset',{token:reset,password:replacement})).status,400);
  assert.equal((await call('auth/session',undefined,cookie)).status,401);
  assert.equal((await call('auth/session',undefined,inAnotherBrowser)).status,401);
  const recovered = await call('auth/login',{email,password:replacement});
  assert.equal((await call('profile',undefined,recovered.cookie)).json.stats.xp,181);
  assert.ok(revoked.some(event => event.id === playerId && event.by === 'account'));
  await db.query("UPDATE accounts SET muted_until=now()-interval '1 second' WHERE id=$1", [playerId]);
  const banMessage = await services.chat.send('TEST',playerId,'Tester','moderation ban regression');
  assert.ok(banMessage);
  await services.chat.delivered(banMessage.id,[staff.playerId]);
  assert.equal((await call('chat/report',{messageId:banMessage.id,reason:'封禁测试'},staff.cookie)).status,200);
  assert.equal((await call('moderation/actions',{messageId:banMessage.id,action:'ban',reason:'封禁测试'},staff.cookie)).status,200);
  assert.ok(revoked.some(event => event.id === playerId && event.by === 'ban'));
  assert.equal((await call('auth/session',undefined,recovered.cookie)).status,401);
  assert.equal((await call('auth/login',{email,password:replacement})).status,401);
  assert.equal(await services.chat.send('TEST',playerId,'Tester','banned'),null);
  assert.equal(Number((await db.query('SELECT count(*) AS count FROM moderation_actions WHERE target_id=$1', [playerId])).rows[0].count),2);

});

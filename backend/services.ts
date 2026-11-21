import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import { promisify } from 'node:util';
import type { Express, Request, Response, RequestHandler } from 'express';
import { Pool, type PoolClient } from 'pg';
import { createClient } from 'redis';
import nodemailer from 'nodemailer';
import { normalizePlayerProfile } from '../src/shared/catalog.ts';
import type { GameModeId, MapId, PlayerProfile, WeaponId } from '../src/shared/types.ts';
import { minorWindowEnd, permitted, restrictEligibility, type Eligibility } from './eligibility.ts';

export type Auth = { playerId: string; sessionId: string; email: string };
export type Progress = {
  mapId: MapId; mode: GameModeId; won: boolean; draw?: boolean;
  kills: number; deaths: number; assists: number; shotsFired: number; shotsHit: number;
  damageDealt: number; hazardKills: number; barriersDestroyed: number; weaponId: WeaponId; xpEarned: number;
};
export type Result = { playerId: string; summary: Record<string, unknown>; progress?: Progress };
type MailKind = 'verify' | 'reset';
const sessionCookie = 'prism_session';
const sessionSeconds = 30 * 24 * 3_600;
const scryptAsync = promisify(scrypt);
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const token = () => randomBytes(32).toString('base64url');
const isToken = (value: unknown): value is string => typeof value === 'string' && /^[\w-]{43}$/.test(value);
const isId = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
const emailOf = (v: unknown) => typeof v === 'string' && v.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim()) ? v.trim().toLowerCase() : null;
const passwordOk = (v: unknown): v is string => typeof v === 'string' && v.length >= 12 && Buffer.byteLength(v) <= 256;
const cookieValue = (req: IncomingMessage) => req.headers.cookie?.split(/;\s*/).find(v => v.startsWith(sessionCookie + '='))?.slice(sessionCookie.length + 1);
const wrap = (handler: (req: Request, res: Response) => Promise<unknown>): RequestHandler => (req, res, next) => void handler(req, res).catch(next);

async function hashPassword(password: string, salt = randomBytes(16).toString('hex')) {
  const key = (await scryptAsync(password, salt, 64)) as Buffer;
  return salt + ':' + key.toString('hex');
}

export async function makeServices(onRevoked: (id: string, by: 'session' | 'account' | 'ban') => void = () => {}) {
  const { DATABASE_URL, REDIS_URL, SMTP_URL, SMTP_FROM, ORIGIN, PUBLIC_ACCESS, ELIGIBILITY_URL, ELIGIBILITY_TOKEN, PLAYTEST_KEY } = process.env;
  const prod = process.env.NODE_ENV === 'production';
  const publicAccess = PUBLIC_ACCESS === '1';
  const devMail = process.env.TEST_MAILBOX === '1';
  const localHttp = process.env.LOCAL_HTTP === '1' && !publicAccess;
  if (!DATABASE_URL || !REDIS_URL) throw new Error('DATABASE_URL and REDIS_URL are required');
  if (prod && !ORIGIN) throw new Error('Production requires an explicit ORIGIN');
  const canonicalOrigin = ORIGIN ? new URL(ORIGIN).origin : null;
  if ((publicAccess || (prod && !localHttp)) && !canonicalOrigin?.startsWith('https://')) throw new Error('HTTPS ORIGIN required');
  // A production build can run privately; the public mode additionally requires operator configuration.
  if (publicAccess && (!prod || !ELIGIBILITY_URL?.startsWith('https://') || !ELIGIBILITY_TOKEN || !SMTP_URL || !SMTP_FROM || devMail)) {
    throw new Error('Public access requires production, verified delivery and an operator eligibility endpoint');
  }
  if (prod && !publicAccess && !PLAYTEST_KEY) throw new Error('Private production requires PLAYTEST_KEY');
  if (devMail && !PLAYTEST_KEY) throw new Error('TEST_MAILBOX requires PLAYTEST_KEY');
  if (!devMail && (!SMTP_URL || !SMTP_FROM)) throw new Error('Configure SMTP delivery or a private test mailbox');
  const smtp = SMTP_URL ? new URL(SMTP_URL) : null;
  if (smtp?.protocol === 'smtp:' && prod && !localHttp) smtp.searchParams.set('requireTLS', 'true');
  const mailer = smtp ? nodemailer.createTransport(smtp.href) : null;
  const admins = new Set((process.env.MODERATOR_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
  const holidays = new Set((process.env.MINOR_HOLIDAYS || (!publicAccess ? process.env.PLAYTEST_HOLIDAYS : '') || '').split(',').filter(s => /^\d{4}-\d{2}-\d{2}$/.test(s)));
  const filtered = (process.env.CHAT_FILTER_TERMS || '').split(',').map(s => s.trim().normalize('NFKC').toLowerCase()).filter(Boolean);
  const pool = new Pool({ connectionString: DATABASE_URL, connectionTimeoutMillis: 5_000, statement_timeout: 5_000, max: 12 });
  pool.on('error', (err) => console.error('Database pool error:', err.message));
  const redis = createClient({ url: REDIS_URL, disableOfflineQueue: true, socket: { connectTimeout: 5_000 } });
  redis.on('error', (err) => console.error('Redis error:', err.message));
  await redis.connect();
  const namespace = process.env.REDIS_NAMESPACE || 'prism';
  const key = (value: string) => namespace + ':' + value;

  async function tx<T>(fn: (c: PoolClient) => Promise<T>) {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      const result = await fn(c);
      await c.query('COMMIT');
      return result;
    } catch (err) {
      await c.query('ROLLBACK');
      throw err;
    } finally { c.release(); }
  }
  try {
    const schema = await readFile(new URL('./schema.sql', import.meta.url), 'utf8');
    await tx(async c => {
      await c.query('SELECT pg_advisory_xact_lock(585038148)');
      await c.query(schema);
    });
  } catch (err) {
    await Promise.allSettled([pool.end(), redis.close()]);
    throw err;
  }

  function allowOrigin(req: IncomingMessage) {
    const origin = req.headers.origin;
    if (!origin) return false;
    const expected = canonicalOrigin ?? (req.headers.host ? 'http://' + req.headers.host : null);
    return origin === expected;
  }
  async function authenticate(req: IncomingMessage): Promise<Auth | null> {
    const raw = cookieValue(req);
    if (!isToken(raw)) return null;
    const sessionId = digest(raw);
    const { rows } = await pool.query(
      'SELECT a.id, a.email FROM sessions s JOIN accounts a ON a.id = s.account_id WHERE s.digest = $1 AND s.expires_at > now() AND a.verified AND NOT a.banned', [sessionId],
    );
    const account = rows[0];
    return account ? { playerId: account.id, email: account.email, sessionId } : null;
  }
  function setSession(res: Response, raw: string, duration = sessionSeconds) {
    const secure = canonicalOrigin?.startsWith('https://') || (prod && !localHttp);
    res.setHeader('Set-Cookie', sessionCookie + '=' + raw + '; Max-Age=' + duration + '; Path=/; HttpOnly; SameSite=Lax' + (secure ? '; Secure' : ''));
  }
  function keyMatches(req: Request) {
    const given = req.get('x-playtest-key');
    return Boolean(PLAYTEST_KEY && given && timingSafeEqual(Buffer.from(digest(given)), Buffer.from(digest(PLAYTEST_KEY))));
  }
  async function limit(bucket: string, max: number, ttl: number) {
    const count = await redis.eval("local n=redis.call('INCR',KEYS[1]); if n==1 then redis.call('EXPIRE',KEYS[1],ARGV[1]) end; return n", { keys: [key('limit:' + bucket)], arguments: [String(ttl)] });
    return Number(count) <= max;
  }
  async function deliver(req: Request, accountId: string, email: string, kind: MailKind) {
    const raw = token();
    await pool.query(
      "INSERT INTO account_tokens(account_id,kind,digest,expires_at) VALUES ($1,$2,$3,now()+($4 * interval '1 minute')) ON CONFLICT (account_id,kind) DO UPDATE SET digest=EXCLUDED.digest,expires_at=EXCLUDED.expires_at",
      [accountId, kind, digest(raw), kind === 'verify' ? 1_440 : 30],
    );
    const url = new URL('/?' + kind + '=' + raw, canonicalOrigin ?? 'http://' + req.get('host'));
    if (devMail) await redis.setEx(key('mail:' + kind + ':' + digest(email)), 1_800, raw);
    else await mailer!.sendMail({ from: SMTP_FROM, to: email, subject: kind === 'verify' ? '棱镜突破 · 验证邮箱' : '棱镜突破 · 重置密码', text: String(url) });
  }
  async function getProfile(playerId: string): Promise<PlayerProfile> {
    const { rows } = await pool.query('SELECT profile FROM accounts WHERE id=$1', [playerId]);
    if (!rows[0]) throw new Error('Account does not exist');
    return normalizePlayerProfile(rows[0].profile, playerId);
  }
  async function saveProfile(playerId: string, next: PlayerProfile): Promise<PlayerProfile> {
    return tx(async c => {
      const { rows } = await c.query('SELECT profile FROM accounts WHERE id=$1 FOR UPDATE', [playerId]);
      if (!rows[0]) throw new Error('Account does not exist');
      const current = normalizePlayerProfile(rows[0].profile, playerId);
      const callsign = next.callsign?.normalize('NFKC').replace(/[\p{Cc}\p{Cf}]/gu, '');
      const safeName = callsign && !filtered.some(term => callsign.toLowerCase().includes(term)) ? callsign : current.callsign;
      const profile = normalizePlayerProfile({ ...current, callsign: safeName, loadout: next.loadout, controller: next.controller }, playerId);
      await c.query('UPDATE accounts SET profile=$2 WHERE id=$1', [playerId, profile]);
      return profile;
    });
  }
  async function lookupEligibility(playerId: string): Promise<Eligibility> {
    const { rows } = await pool.query('SELECT email, verified, banned FROM accounts WHERE id=$1', [playerId]);
    if (!rows[0]?.verified || rows[0]?.banned) return { kind: 'denied' };
    if (!publicAccess) {
      const mock = await redis.get(key('eligibility:' + playerId));
      if (mock === 'denied') return { kind: 'denied' };
      if (mock !== 'minor') return { kind: 'adult' };
      const end = minorWindowEnd(Date.now(), holidays);
      return end === undefined ? { kind: 'denied' } : { kind: 'minor', permittedUntil: end };
    }
    try {
      const endpoint = await fetch(ELIGIBILITY_URL!, {
        method: 'POST', headers: { Authorization: 'Bearer ' + ELIGIBILITY_TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ playerId }), signal: AbortSignal.timeout(1500), redirect: 'error',
      });
      if (!endpoint.ok) return { kind: 'denied' };
      return restrictEligibility(await endpoint.json(), Date.now(), holidays);
    } catch { /* Provider unavailable: fail closed. */ }
    return { kind: 'denied' };
  }
  const allowPlay = async (id: string, minDurationMs = 0) => permitted(await lookupEligibility(id), Date.now(), minDurationMs);
  async function playUntil(id: string): Promise<number> {
    const rule = await lookupEligibility(id);
    return rule.kind === 'adult' ? Infinity : rule.kind === 'minor' ? rule.permittedUntil : 0;
  }

  const lobbyKey = key('lobby');
  const lobbyTtl = 15;
  const lobby = {
    async claim(id: string) {
      if (await redis.set(lobbyKey, id, { NX: true, EX: lobbyTtl }) !== 'OK') throw new Error('Another lobby owns this Redis namespace');
    },
    async renew(id: string) {
      const renewed = await redis.eval("if redis.call('GET',KEYS[1])~=ARGV[1] then return 0 end return redis.call('EXPIRE',KEYS[1],ARGV[2])", { keys: [lobbyKey], arguments: [id, String(lobbyTtl)] });
      if (!renewed) throw new Error('Lobby lease expired');
    },
    async release(id: string) {
      await redis.eval("if redis.call('GET',KEYS[1])==ARGV[1] then redis.call('DEL',KEYS[1]) end", { keys: [lobbyKey], arguments: [id] });
    },
    async updateQueue(id: string, added: readonly {id: string; order: number}[], removed: string[]) {
      const queueKey = key('queue:' + id);
      const update = redis.multi();
      if (removed.length) update.zRem(queueKey, removed);
      if (added.length) update.zAdd(queueKey, added.map(p => ({ score: p.order, value: p.id })));
      update.expire(queueKey, 30);
      await update.exec();
    },
    queueOrder(id: string) { return redis.zRange(key('queue:' + id), 0, -1); },
    async presence(id: string, accounts: string[]) {
      const presenceKey = key('presence:' + id);
      const write = redis.multi().del(presenceKey);
      if (accounts.length) write.sAdd(presenceKey, accounts).expire(presenceKey, 15);
      await write.exec();
    },
  };

  const ownerTtl = 20_000;
  async function renewOwner(ownerId: string) {
    await pool.query(
      "INSERT INTO game_owners(id,expires_at) VALUES ($1,now()+($2 * interval '1 millisecond')) ON CONFLICT(id) DO UPDATE SET expires_at=EXCLUDED.expires_at WHERE game_owners.expires_at>now() RETURNING id",
      [ownerId, ownerTtl],
    ).then(r => { if (!r.rowCount) throw new Error('Game lease expired'); });
    await redis.setEx(key('owner:' + ownerId), ownerTtl / 1_000, 'live');
  }
  async function requireOwner(c: PoolClient, ownerId: string) {
    const lease = await c.query('SELECT id FROM game_owners WHERE id=$1 AND expires_at>now() FOR SHARE', [ownerId]);
    if (!lease.rowCount || !await redis.exists(key('owner:' + ownerId))) throw new Error('Game lease unavailable');
  }
  async function openMatch(matchId: string, ownerId: string, playerIds: string[]) {
    await redis.setEx(key('route:' + matchId), 600, ownerId);
    await tx(async c => {
      await requireOwner(c, ownerId);
      await c.query("INSERT INTO matches(id,owner_id,status) VALUES ($1,$2,'active')", [matchId, ownerId]);
      await c.query('INSERT INTO match_players(match_id,player_id) SELECT $1,p FROM unnest($2::uuid[]) p', [matchId, playerIds]);
    }).catch(async err => { await redis.del(key('route:' + matchId)).catch(() => {}); throw err; });
  }
  async function cancelMatch(matchId: string, ownerId: string) {
    await pool.query("UPDATE matches SET status='cancelled',ended_at=now() WHERE id=$1 AND owner_id=$2 AND status='active'", [matchId, ownerId]);
    await redis.del(key('route:' + matchId));
  }
  async function revokeOwner(ownerId: string) {
    await redis.del(key('owner:' + ownerId)).catch(() => {});
    await pool.query('UPDATE game_owners SET expires_at=now() WHERE id=$1', [ownerId]);
    await pool.query("UPDATE matches SET status='cancelled',ended_at=now() WHERE owner_id=$1 AND status='active'", [ownerId]);
  }
  async function commitResults(matchId: string, results: readonly Result[], ownerId: string) {
    await tx(async c => {
      const { rows } = await c.query('SELECT owner_id,status FROM matches WHERE id=$1 FOR UPDATE', [matchId]);
      const match = rows[0];
      if (!match || match.owner_id !== ownerId || match.status === 'cancelled') throw new Error('Match is no longer owned by this process');
      if (match.status === 'finished') {
        for (const result of results) {
          const previous = await c.query('SELECT summary FROM match_players WHERE match_id=$1 AND player_id=$2', [matchId, result.playerId]);
          if (previous.rows[0]?.summary) Object.assign(result.summary, previous.rows[0].summary);
        }
        return;
      }
      await requireOwner(c, ownerId);
      for (const result of [...results].sort((a, b) => a.playerId.localeCompare(b.playerId))) {
        const row = await c.query('SELECT player_id FROM match_players WHERE match_id=$1 AND player_id=$2', [matchId, result.playerId]);
        if (!row.rowCount) throw new Error('Result player was not on the starting roster');
        const progress = result.progress;
        if (progress) {
          const { rows } = await c.query('SELECT profile FROM accounts WHERE id=$1 FOR UPDATE', [result.playerId]);
          const profile = normalizePlayerProfile(rows[0].profile, result.playerId);
          const stats = profile.stats;
          stats.matchesPlayed++;
          if (progress.won) stats.wins++;
          else if (!progress.draw) stats.losses++;
          for (const field of ['kills','deaths','assists','shotsFired','shotsHit','damageDealt','hazardKills','barriersDestroyed'] as const) stats[field] += Math.round(progress[field]);
          const weapon = stats.weaponStats[progress.weaponId];
          if (weapon) for (const field of ['kills','shotsFired','shotsHit','damageDealt'] as const) weapon[field] += Math.round(progress[field]);
          stats.xp += progress.xpEarned;
          stats.credits += Math.round(progress.xpEarned * 0.75);
          stats.recentMatches = [{ id: matchId, timestamp: Date.now(), mapId: progress.mapId, mode: progress.mode, won: progress.won,
            ...(progress.draw ? { draw: true } : {}), kills: progress.kills, deaths: progress.deaths, accuracy: progress.shotsFired > 0 ? Math.round(progress.shotsHit * 100 / progress.shotsFired) : 0,
            mmrDelta: 0, xpEarned: progress.xpEarned }, ...stats.recentMatches].slice(0, 10);
          result.summary.newXp = stats.xp;
          await c.query('UPDATE accounts SET profile=$2 WHERE id=$1', [result.playerId, profile]);
        }
        await c.query('UPDATE match_players SET summary=$3 WHERE match_id=$1 AND player_id=$2', [matchId, result.playerId, result.summary]);
      }
      await c.query("UPDATE matches SET status='finished',ended_at=now() WHERE id=$1", [matchId]);
    });
    await redis.del(key('route:' + matchId)).catch(err => console.error('Could not clear finished game route:', err));
  }
  async function getResult(playerId: string, matchId: string) {
    if (!isId(matchId)) return null;
    const { rows } = await pool.query('SELECT m.status, p.summary FROM matches m JOIN match_players p ON p.match_id=m.id WHERE m.id=$1 AND p.player_id=$2', [matchId, playerId]);
    return rows[0] ?? null;
  }
  async function reap() {
    await pool.query("UPDATE matches m SET status='cancelled',ended_at=now() WHERE status='active' AND NOT EXISTS (SELECT 1 FROM game_owners o WHERE o.id=m.owner_id AND o.expires_at>now())");
    await pool.query("DELETE FROM sessions WHERE expires_at<now(); DELETE FROM account_tokens WHERE expires_at<now(); DELETE FROM chat_messages m WHERE sent_at < now()-interval '30 days' AND NOT EXISTS (SELECT 1 FROM chat_reports r WHERE r.message_id=m.id)");
  }

  const chat = {
    async send(roomId: string, playerId: string, callsign: string, raw: unknown) {
      if (typeof raw !== 'string' || raw.length > 1_000) return null;
      const text = raw.normalize('NFKC').replace(/[\p{Cc}\p{Cf}]/gu, ' ').trim();
      if (!text || [...text].length > 200 || filtered.some(term => text.toLowerCase().includes(term)) || !await limit('chat:' + playerId, 5, 10)) return null;
      const id = randomUUID();
      const { rows } = await pool.query(
        'INSERT INTO chat_messages(id,room_id,player_id,callsign,body) SELECT $1,$2,id,$4,$5 FROM accounts WHERE id=$3 AND NOT banned AND (muted_until IS NULL OR muted_until <= now()) RETURNING sent_at',
        [id, roomId, playerId, callsign, text],
      );
      return rows[0] ? { id, playerId, callsign, text, timestamp: rows[0].sent_at.getTime() } : null;
    },
    async blockedBy(playerIds: string[], senderId: string) {
      if (!playerIds.length) return new Set<string>();
      const { rows } = await pool.query('SELECT player_id FROM chat_blocks WHERE player_id=ANY($1::uuid[]) AND blocked_id=$2', [playerIds, senderId]);
      return new Set<string>(rows.map(row => row.player_id));
    },
    async delivered(messageId: string, playerIds: string[]) {
      if (!playerIds.length) return;
      await redis.sAdd(key('chat-recipients:' + messageId), playerIds);
      await redis.expire(key('chat-recipients:' + messageId), 7 * 86_400);
    },
  };
  const fail = (res: Response, status: number, error: string) => res.status(status).json({ error });
  const ok = (res: Response) => res.json({ ok: true });
  const placeholderHash = await hashPassword('placeholder-password-never-used');
  const originGuard: RequestHandler = (req, res, next) => {
    if (['GET','HEAD','OPTIONS'].includes(req.method) || allowOrigin(req)) next();
    else fail(res, 403, '请求来源无效');
  };
  const authorized = (handler: (req: Request, res: Response, auth: Auth) => Promise<unknown>) => wrap(async (req,res) => {
    const auth = await authenticate(req);
    return auth ? handler(req, res, auth) : fail(res, 401, '请先登录');
  });
  const moderator = (handler: (req: Request,res: Response,auth: Auth) => Promise<unknown>) => authorized(async (req, res, auth) => {
    if (!admins.has(auth.email)) return fail(res, 403, '需要管理权限');
    return handler(req,res,auth);
  });
  async function authLimit(req: Request, action: string, email: string, count: number) {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const [accountOk, ipOk] = await Promise.all([limit('auth:' + action + ':account:' + digest(email), count, 900), limit('auth:' + action + ':ip:' + digest(ip), 60, 900)]);
    return accountOk && ipOk;
  }
  function install(app: Express) {
    app.use('/api', (_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); }, originGuard);
    app.get('/api/auth/session', authorized(async (_req, res, { playerId, email }) => res.json({ playerId, email, moderator: admins.has(email) })));
    app.post('/api/auth/register', wrap(async (req,res) => {
      if (!publicAccess && PLAYTEST_KEY && !keyMatches(req) && req.body?.playtestKey !== PLAYTEST_KEY) return fail(res, 403, '需要封闭测试访问码');
      const email = emailOf(req.body?.email), password = req.body?.password;
      if (!email || !passwordOk(password)) return fail(res, 400, '请输入有效邮箱及至少 12 个字符的密码');
      if (!await authLimit(req, 'register', email, 4)) return fail(res, 429, '请求过于频繁');
      const id = randomUUID();
      const name = typeof req.body?.callsign === 'string' ? req.body.callsign.normalize('NFKC').replace(/[\p{Cc}\p{Cf}]/gu, '') : '';
      const callsign = filtered.some(term => name.toLowerCase().includes(term)) ? '' : name;
      const profile = normalizePlayerProfile({ id, callsign }, id);
      const passwordHash = await hashPassword(password);
      const { rows } = await pool.query('INSERT INTO accounts(id,email,password_hash,profile) VALUES ($1,$2,$3,$4) ON CONFLICT(email) DO NOTHING RETURNING id', [id,email,passwordHash,profile]);
      if (rows[0]) await deliver(req,id,email,'verify');
      return ok(res);
    }));
    app.post('/api/auth/resend', wrap(async (req,res) => {
      const email = emailOf(req.body?.email);
      if (!email) return fail(res, 400, '请输入有效邮箱');
      if (!await authLimit(req,'resend',email,4)) return fail(res,429,'请求过于频繁');
      const { rows } = await pool.query('SELECT id FROM accounts WHERE email=$1 AND NOT verified AND NOT banned', [email]);
      if (rows[0]) await deliver(req,rows[0].id,email,'verify');
      return ok(res);
    }));
    app.post('/api/auth/verify', wrap(async (req,res) => {
      const raw = req.body?.token;
      if (!isToken(raw)) return fail(res,400,'验证链接无效或已过期');
      const changed = await tx(async c => {
        const { rows } = await c.query("DELETE FROM account_tokens WHERE kind='verify' AND digest=$1 AND expires_at>now() RETURNING account_id", [digest(raw)]);
        if (!rows[0]) return false;
        await c.query('UPDATE accounts SET verified=true WHERE id=$1', [rows[0].account_id]);
        return true;
      });
      return changed ? ok(res) : fail(res,400,'验证链接无效或已过期');
    }));
    app.post('/api/auth/login', wrap(async (req,res) => {
      const email = emailOf(req.body?.email), password = req.body?.password;
      if (!email || !passwordOk(password)) return fail(res,400,'请输入邮箱和密码');
      if (!await authLimit(req,'login',email,12)) return fail(res,429,'请求过于频繁');
      const { rows } = await pool.query('SELECT id,password_hash,verified,banned FROM accounts WHERE email=$1', [email]);
      const row = rows[0];
      const hash = row?.password_hash || placeholderHash;
      const candidate = await hashPassword(password, hash.split(':')[0]);
      if (!timingSafeEqual(Buffer.from(hash), Buffer.from(candidate)) || !row || row.banned) return fail(res,401,'登录失败：邮箱或密码不正确，或账号不可用');
      if (!row.verified) return fail(res,403,'请先验证邮箱');
      const raw = token();
      const inserted = await tx(async c => {
        // Reset/ban takes an exclusive account lock before deleting its sessions.
        // Keep this lock until the new session is committed so revocation cannot miss it.
        const current = await c.query('SELECT password_hash,verified,banned FROM accounts WHERE id=$1 FOR SHARE', [row.id]);
        const account = current.rows[0];
        if (!account?.verified || account.banned || account.password_hash !== hash) return false;
        await c.query("INSERT INTO sessions(digest,account_id,expires_at) VALUES ($1,$2,now()+($3 * interval '1 second'))", [digest(raw),row.id,sessionSeconds]);
        return true;
      });
      if (!inserted) return fail(res,401,'登录状态已变更，请重试');
      setSession(res,raw);
      return res.json({ ok: true, playerId: row.id, email, moderator: admins.has(email) });
    }));
    app.post('/api/auth/logout', wrap(async (req,res) => {
      const raw = cookieValue(req);
      if (isToken(raw)) {
        const id = digest(raw);
        await pool.query('DELETE FROM sessions WHERE digest=$1', [id]);
        onRevoked(id, 'session');
      }
      setSession(res,'',0);
      return ok(res);
    }));
    app.post('/api/auth/forgot', wrap(async (req,res) => {
      const email = emailOf(req.body?.email);
      if (!email) return fail(res,400,'请输入有效邮箱');
      if (!await authLimit(req,'forgot',email,4)) return fail(res,429,'请求过于频繁');
      const { rows } = await pool.query('SELECT id FROM accounts WHERE email=$1 AND verified AND NOT banned', [email]);
      if (rows[0]) await deliver(req,rows[0].id,email,'reset');
      return ok(res);
    }));
    app.post('/api/auth/reset', wrap(async (req,res) => {
      const raw = req.body?.token, password = req.body?.password;
      if (!isToken(raw) || !passwordOk(password)) return fail(res,400,'重置链接或新密码无效');
      if (!await authLimit(req,'reset',digest(raw),5)) return fail(res,429,'请求过于频繁');
      const hash = await hashPassword(password);
      const changed = await tx(async c => {
        const { rows } = await c.query("DELETE FROM account_tokens WHERE kind='reset' AND digest=$1 AND expires_at>now() RETURNING account_id", [digest(raw)]);
        const id = rows[0]?.account_id;
        if (!id) return null;
        await c.query('UPDATE accounts SET password_hash=$2 WHERE id=$1', [id,hash]);
        await c.query('DELETE FROM sessions WHERE account_id=$1', [id]);
        return id as string;
      });
      if (!changed) return fail(res,400,'重置链接无效或已过期');
      onRevoked(changed, 'account');
      setSession(res,'',0);
      return ok(res);
    }));
    if (devMail) app.get('/api/test/mail', wrap(async (req,res) => {
      if (!keyMatches(req)) return fail(res,404,'未找到');
      const email = emailOf(req.query.email), kind = req.query.kind;
      if (!email || (kind !== 'verify' && kind !== 'reset')) return fail(res,400,'请求无效');
      const raw = await redis.get(key('mail:' + kind + ':' + digest(email)));
      return raw ? res.json({ token: raw }) : fail(res,404,'未找到邮件');
    }));
    if (!publicAccess && PLAYTEST_KEY) app.post('/api/test/eligibility', authorized(async (req,res,{playerId}) => {
      if (!keyMatches(req)) return fail(res,404,'未找到');
      const mode = req.body?.kind;
      if (!['adult','minor','denied'].includes(mode)) return fail(res,400,'请求无效');
      await redis.setEx(key('eligibility:' + playerId), 24 * 3_600, mode);
      return ok(res);
    }));
    app.get('/api/profile', authorized(async (_req,res,{playerId}) => res.json(await getProfile(playerId))));
    app.get('/api/matches/:id', authorized(async (req,res,{playerId}) => {
      const result = await getResult(playerId,req.params.id);
      return result ? res.json(result) : fail(res,404,'找不到这场对局');
    }));
    app.get('/api/chat/blocks', authorized(async (_req,res,{playerId}) => {
      const { rows } = await pool.query('SELECT blocked_id FROM chat_blocks WHERE player_id=$1', [playerId]);
      return res.json({ playerIds: rows.map(row => row.blocked_id) });
    }));
    app.post('/api/chat/block', authorized(async (req,res,auth) => {
      const { playerId, blocked } = req.body || {};
      if (!isId(playerId) || playerId === auth.playerId || typeof blocked !== 'boolean') return fail(res,400,'请求无效');
      if (!await limit('block:' + auth.playerId,30,60)) return fail(res,429,'请求过于频繁');
      if (blocked) await pool.query('INSERT INTO chat_blocks(player_id,blocked_id) SELECT $1,id FROM accounts WHERE id=$2 ON CONFLICT DO NOTHING',[auth.playerId,playerId]);
      else await pool.query('DELETE FROM chat_blocks WHERE player_id=$1 AND blocked_id=$2',[auth.playerId,playerId]);
      return ok(res);
    }));
    app.post('/api/chat/report', authorized(async (req,res,{playerId}) => {
      const { messageId, reason } = req.body || {};
      if (!isId(messageId) || typeof reason !== 'string' || !reason.trim() || reason.length>300) return fail(res,400,'请选择消息并填写举报原因');
      if (!await limit('report:' + playerId,10,3600)) return fail(res,429,'请求过于频繁');
      if (!await redis.sIsMember(key('chat-recipients:' + messageId),playerId)) return fail(res,404,'找不到此消息');
      await pool.query('INSERT INTO chat_reports(message_id,reporter_id,reason) SELECT id,$2,$3 FROM chat_messages WHERE id=$1 AND player_id<>$2 ON CONFLICT DO NOTHING',[messageId,playerId,reason.trim()]);
      return ok(res);
    }));
    app.get('/api/moderation/reports', moderator(async (_req,res) => {
      const { rows } = await pool.query('SELECT m.id AS "messageId",m.player_id AS "playerId",m.callsign,m.body AS text,m.sent_at AS timestamp,count(r.reporter_id)::int AS reports,array_agg(r.reason) AS reasons FROM chat_reports r JOIN chat_messages m ON r.message_id=m.id WHERE r.resolved_at IS NULL GROUP BY m.id ORDER BY m.sent_at LIMIT 100');
      return res.json({ reports: rows });
    }));
    app.post('/api/moderation/actions', moderator(async (req,res,{playerId}) => {
      const {messageId,action,reason} = req.body ?? {};
      if (!isId(messageId) || !['dismiss','mute','ban'].includes(action) || typeof reason !== 'string' || !reason.trim() || reason.length > 300) return fail(res,400,'请求无效');
      const changed = await tx(async c => {
        const { rows } = await c.query('SELECT player_id FROM chat_messages WHERE id=$1 FOR UPDATE',[messageId]);
        const target = rows[0]?.player_id;
        if (!target || target === playerId) return null;
        const pending = await c.query('UPDATE chat_reports SET resolved_at=now() WHERE message_id=$1 AND resolved_at IS NULL RETURNING message_id',[messageId]);
        if (!pending.rowCount) return null;
        if (action === 'mute') await c.query("UPDATE accounts SET muted_until=GREATEST(muted_until,now()+interval '24 hours') WHERE id=$1",[target]);
        if (action === 'ban') {
          await c.query('UPDATE accounts SET banned=true WHERE id=$1',[target]);
          await c.query('DELETE FROM sessions WHERE account_id=$1',[target]);
        }
        await c.query('INSERT INTO moderation_actions(message_id,actor_id,target_id,action,reason) VALUES ($1,$2,$3,$4,$5)',[messageId,playerId,target,action,reason.trim()]);
        return target as string;
      });
      if (changed && action === 'ban') onRevoked(changed, 'ban');
      return changed ? ok(res) : fail(res,404,'举报已处理或不存在');
    }));
  }
  const health = async () => { await Promise.all([redis.ping(),pool.query('SELECT 1')]); };
  const close = async () => { await Promise.allSettled([redis.close(),pool.end()]); };
  const isDraining = async () => process.env.DRAIN_MATCHES === '1' || await redis.exists(key('drain')) > 0;
  return { install, authenticate, allowOrigin, getProfile, saveProfile, getResult, allowPlay, playUntil, lobby, limit, renewOwner, revokeOwner, openMatch, commitResults, cancelMatch, reap, chat, health, close, isDraining };
}

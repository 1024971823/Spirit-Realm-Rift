import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { promisify } from 'node:util';
import type { Express, Request, RequestHandler, Response } from 'express';
import { normalizePlayerProfile } from '../src/shared/catalog.ts';
import {
  applyMatchContributionToDailyMissions,
  claimAllClearBonus,
  claimDailyMission,
  msUntilNextUtcDay,
  normalizeDailyMissions,
} from '../src/shared/dailyMissions.ts';
import type { PlayerProfile } from '../src/shared/types.ts';
import type { FriendStatus, SocialView } from '../src/shared/social.ts';
import { readFriendCode, type SocialError } from './social.ts';
import type { Auth, Result } from './services.ts';

type MailKind = 'verify' | 'reset';

interface MemoryAccount {
  id: string;
  email: string;
  passwordHash: string;
  verified: boolean;
  banned: boolean;
  mutedUntil: number;
  friendCode: string;
  allowInvites: boolean;
  profile: PlayerProfile;
}

interface MemorySession {
  digest: string;
  accountId: string;
  expiresAt: number;
}

interface MemoryMatch {
  id: string;
  ownerId: string;
  status: 'active' | 'finished' | 'cancelled';
  players: Map<string, Record<string, unknown> | null>;
}

interface MemoryChatMessage {
  id: string;
  roomId: string;
  playerId: string;
  callsign: string;
  text: string;
  timestamp: number;
  recipients: Set<string>;
}

interface MemoryReport {
  messageId: string;
  reporterId: string;
  reason: string;
  resolvedAt?: number;
}

const sessionCookie = 'prism_session';
const sessionSeconds = 30 * 24 * 3_600;
const maximumFriends = 100;
const maximumRequests = 50;
const scryptAsync = promisify(scrypt);
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const token = () => randomBytes(32).toString('base64url');
const isToken = (value: unknown): value is string => typeof value === 'string' && /^[\w-]{43}$/.test(value);
const isId = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value);
const emailOf = (v: unknown) =>
  typeof v === 'string' && v.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim()) ? v.trim().toLowerCase() : null;
const passwordOk = (v: unknown): v is string => typeof v === 'string' && v.length >= 12 && Buffer.byteLength(v) <= 256;
const cookieValue = (req: IncomingMessage) =>
  req.headers.cookie?.split(/;\s*/).find(v => v.startsWith(sessionCookie + '='))?.slice(sessionCookie.length + 1);
const wrap = (handler: (req: Request, res: Response) => Promise<unknown>): RequestHandler => (req, res, next) => void handler(req, res).catch(next);

async function hashPassword(password: string, salt = randomBytes(16).toString('hex')) {
  const key = (await scryptAsync(password, salt, 64)) as Buffer;
  return salt + ':' + key.toString('hex');
}

function generateFriendCode(existing: Map<string, string>): string {
  for (;;) {
    const code = randomBytes(8).toString('hex').toUpperCase();
    if (!existing.has(code)) return code;
  }
}

function pairKey(a: string, b: string): [string, string, string] {
  const [low, high] = a < b ? [a, b] : [b, a];
  return [low, high, low + ':' + high];
}

export async function makeMemoryServices(onRevoked: (id: string, by: 'session' | 'account' | 'ban') => void = () => {}) {
  const { ORIGIN, PLAYTEST_KEY } = process.env;
  const canonicalOrigin = ORIGIN ? new URL(ORIGIN).origin : null;
  const admins = new Set((process.env.MODERATOR_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
  const filtered = (process.env.CHAT_FILTER_TERMS || '').split(',').map(s => s.trim().normalize('NFKC').toLowerCase()).filter(Boolean);

  const accounts = new Map<string, MemoryAccount>();
  const accountsByEmail = new Map<string, string>();
  const accountsByCode = new Map<string, string>();
  const sessions = new Map<string, MemorySession>();
  const tokens = new Map<string, { accountId: string; kind: MailKind; expiresAt: number }>();
  const rateLimits = new Map<string, { count: number; expiresAt: number }>();
  const owners = new Map<string, number>();
  const matches = new Map<string, MemoryMatch>();
  const chatMessages = new Map<string, MemoryChatMessage>();
  const chatBlocks = new Map<string, Set<string>>();
  const chatReports = new Map<string, MemoryReport[]>();
  const friendLinks = new Map<string, { low: string; high: string; requestedBy: string; acceptedAt: number | null }>();

  let lobbyOwner: { id: string; expiresAt: number } | null = null;
  const lobbyQueues = new Map<string, Map<string, number>>();
  let presenceProvider: (id: string) => FriendStatus = () => 'offline';

  const placeholderHash = await hashPassword('placeholder-password-never-used');

  function allowOrigin(req: IncomingMessage): boolean {
    const origin = req.headers.origin;
    if (!origin) return false;
    if (canonicalOrigin) return origin === canonicalOrigin;
    const host = req.headers.host;
    if (!host) return false;
    try {
      const parsed = new URL(origin);
      return parsed.host === host && (parsed.protocol === 'https:' || parsed.protocol === 'http:');
    } catch {
      return false;
    }
  }

  function isHttpsRequest(req?: IncomingMessage): boolean {
    if (canonicalOrigin?.startsWith('https://')) return true;
    const forwarded = req?.headers['x-forwarded-proto'];
    if (typeof forwarded === 'string' && forwarded.split(',')[0].trim() === 'https') return true;
    return false;
  }

  function setSession(req: IncomingMessage, res: Response, raw: string, duration = sessionSeconds) {
    const secure = isHttpsRequest(req);
    res.setHeader(
      'Set-Cookie',
      sessionCookie + '=' + raw + '; Max-Age=' + duration + '; Path=/; HttpOnly; SameSite=Lax' + (secure ? '; Secure' : ''),
    );
  }

  function keyMatches(req: Request) {
    const given = req.get('x-playtest-key');
    return Boolean(PLAYTEST_KEY && given && timingSafeEqual(Buffer.from(digest(given)), Buffer.from(digest(PLAYTEST_KEY))));
  }

  async function authenticate(req: IncomingMessage): Promise<Auth | null> {
    const raw = cookieValue(req);
    if (!isToken(raw)) return null;
    const sessionId = digest(raw);
    const session = sessions.get(sessionId);
    if (!session || session.expiresAt <= Date.now()) {
      sessions.delete(sessionId);
      return null;
    }
    const account = accounts.get(session.accountId);
    if (!account || !account.verified || account.banned) return null;
    return { playerId: account.id, email: account.email, sessionId };
  }

  async function limit(bucket: string, max: number, ttl: number): Promise<boolean> {
    const now = Date.now();
    const existing = rateLimits.get(bucket);
    if (!existing || existing.expiresAt <= now) {
      rateLimits.set(bucket, { count: 1, expiresAt: now + ttl * 1000 });
      return 1 <= max;
    }
    existing.count += 1;
    return existing.count <= max;
  }

  function createSessionFor(account: MemoryAccount): string {
    const raw = token();
    sessions.set(digest(raw), {
      digest: digest(raw),
      accountId: account.id,
      expiresAt: Date.now() + sessionSeconds * 1000,
    });
    return raw;
  }

  async function getProfile(playerId: string): Promise<PlayerProfile> {
    const account = accounts.get(playerId);
    if (!account) throw new Error('Account does not exist');
    return normalizePlayerProfile(structuredClone(account.profile), playerId);
  }

  async function saveProfile(playerId: string, next: PlayerProfile): Promise<PlayerProfile> {
    const account = accounts.get(playerId);
    if (!account) throw new Error('Account does not exist');
    const current = normalizePlayerProfile(account.profile, playerId);
    const callsign = next.callsign?.normalize('NFKC').replace(/[\p{Cc}\p{Cf}]/gu, '');
    const safeName = callsign && !filtered.some(term => callsign.toLowerCase().includes(term)) ? callsign : current.callsign;
    const profile = normalizePlayerProfile({ ...current, callsign: safeName, loadout: next.loadout, controller: next.controller }, playerId);
    account.profile = profile;
    return structuredClone(profile);
  }

  async function allowPlay(id: string, _minDurationMs = 0): Promise<boolean> {
    const account = accounts.get(id);
    return Boolean(account && account.verified && !account.banned);
  }

  async function playUntil(id: string): Promise<number> {
    return (await allowPlay(id)) ? Infinity : 0;
  }

  const lobbyTtlMs = 15_000;
  const lobby = {
    async claim(id: string) {
      const now = Date.now();
      if (lobbyOwner && lobbyOwner.id !== id && lobbyOwner.expiresAt > now) {
        throw new Error('Another lobby owns this standalone instance');
      }
      lobbyOwner = { id, expiresAt: now + lobbyTtlMs };
    },
    async renew(id: string) {
      if (!lobbyOwner || lobbyOwner.id !== id) throw new Error('Lobby lease expired');
      lobbyOwner.expiresAt = Date.now() + lobbyTtlMs;
    },
    async release(id: string) {
      if (lobbyOwner?.id === id) lobbyOwner = null;
    },
    async updateQueue(id: string, added: readonly { id: string; order: number }[], removed: string[]) {
      let q = lobbyQueues.get(id);
      if (!q) {
        q = new Map();
        lobbyQueues.set(id, q);
      }
      for (const r of removed) q.delete(r);
      for (const a of added) q.set(a.id, a.order);
    },
    async queueOrder(id: string): Promise<string[]> {
      const q = lobbyQueues.get(id);
      if (!q) return [];
      return [...q.entries()].sort((a, b) => a[1] - b[1]).map(([pid]) => pid);
    },
    async presence(_id: string, _accounts: string[]) {
      // Tracked in gateway connections map in standalone mode.
    },
  };

  const ownerTtlMs = 20_000;
  async function renewOwner(ownerId: string) {
    const existing = owners.get(ownerId);
    const now = Date.now();
    if (existing !== undefined && existing <= now) throw new Error('Game lease expired');
    owners.set(ownerId, now + ownerTtlMs);
  }

  function requireLiveOwner(ownerId: string) {
    const exp = owners.get(ownerId);
    if (!exp || exp <= Date.now()) throw new Error('Game lease unavailable');
  }

  async function openMatch(matchId: string, ownerId: string, playerIds: string[]) {
    requireLiveOwner(ownerId);
    const players = new Map<string, Record<string, unknown> | null>();
    for (const pid of playerIds) players.set(pid, null);
    matches.set(matchId, { id: matchId, ownerId, status: 'active', players });
  }

  async function cancelMatch(matchId: string, ownerId: string) {
    const match = matches.get(matchId);
    if (match && match.ownerId === ownerId && match.status === 'active') {
      match.status = 'cancelled';
    }
  }

  async function revokeOwner(ownerId: string) {
    owners.set(ownerId, Date.now() - 1);
    for (const match of matches.values()) {
      if (match.ownerId === ownerId && match.status === 'active') {
        match.status = 'cancelled';
      }
    }
  }

  async function commitResults(matchId: string, results: readonly Result[], ownerId: string) {
    const match = matches.get(matchId);
    if (!match || match.ownerId !== ownerId || match.status === 'cancelled') {
      throw new Error('Match is no longer owned by this process');
    }
    if (match.status === 'finished') {
      for (const result of results) {
        const previous = match.players.get(result.playerId);
        if (previous) Object.assign(result.summary, previous);
      }
      return;
    }
    requireLiveOwner(ownerId);
    for (const result of results) {
      if (!match.players.has(result.playerId)) throw new Error('Result player was not on the starting roster');
    }
    for (const result of results) {
      const progress = result.progress;
      const missionContribution = result.missionContribution;
      if (progress || missionContribution) {
        const account = accounts.get(result.playerId);
        if (account) {
          const profile = normalizePlayerProfile(account.profile, result.playerId);
          if (progress) {
            const stats = profile.stats;
            stats.matchesPlayed++;
            if (progress.won) stats.wins++;
            else if (!progress.draw) stats.losses++;
            for (const field of ['kills', 'deaths', 'assists', 'shotsFired', 'shotsHit', 'damageDealt', 'hazardKills', 'barriersDestroyed'] as const) {
              stats[field] += Math.round(progress[field]);
            }
            const weapon = stats.weaponStats[progress.weaponId];
            if (weapon) {
              for (const field of ['kills', 'shotsFired', 'shotsHit', 'damageDealt'] as const) {
                weapon[field] += Math.round(progress[field]);
              }
            }
            stats.xp += progress.xpEarned;
            stats.credits += Math.round(progress.xpEarned * 0.75);
            stats.recentMatches = [
              {
                id: matchId,
                timestamp: Date.now(),
                mapId: progress.mapId,
                mode: progress.mode,
                won: progress.won,
                ...(progress.draw ? { draw: true } : {}),
                kills: progress.kills,
                deaths: progress.deaths,
                accuracy: progress.shotsFired > 0 ? Math.round((progress.shotsHit * 100) / progress.shotsFired) : 0,
                mmrDelta: 0,
                xpEarned: progress.xpEarned,
              },
              ...stats.recentMatches,
            ].slice(0, 10);
            result.summary.newXp = stats.xp;
          }
          if (missionContribution) {
            const applied = applyMatchContributionToDailyMissions(profile.dailyMissions, result.playerId, missionContribution);
            profile.dailyMissions = applied.state;
            if (applied.updates.length > 0) result.summary.missionUpdates = applied.updates;
          }
          account.profile = profile;
        }
      }
      match.players.set(result.playerId, structuredClone(result.summary));
    }
    match.status = 'finished';
  }

  async function getResult(playerId: string, matchId: string) {
    if (!isId(matchId)) return null;
    const match = matches.get(matchId);
    if (!match || !match.players.has(playerId)) return null;
    return { status: match.status, summary: match.players.get(playerId) ?? undefined };
  }

  async function reap() {
    const now = Date.now();
    for (const match of matches.values()) {
      if (match.status === 'active') {
        const exp = owners.get(match.ownerId);
        if (!exp || exp <= now) match.status = 'cancelled';
      }
    }
    for (const [k, s] of sessions.entries()) {
      if (s.expiresAt <= now) sessions.delete(k);
    }
    for (const [k, t] of tokens.entries()) {
      if (t.expiresAt <= now) tokens.delete(k);
    }
    for (const [k, bucket] of rateLimits.entries()) {
      if (bucket.expiresAt <= now) rateLimits.delete(k);
    }
  }

  function isPairBlocked(a: string, b: string): boolean {
    return Boolean(chatBlocks.get(a)?.has(b) || chatBlocks.get(b)?.has(a));
  }

  const chat = {
    async send(roomId: string, playerId: string, callsign: string, raw: unknown) {
      if (typeof raw !== 'string' || raw.length > 1_000) return null;
      const text = raw.normalize('NFKC').replace(/[\p{Cc}\p{Cf}]/gu, ' ').trim();
      if (!text || [...text].length > 200 || filtered.some(term => text.toLowerCase().includes(term)) || !(await limit('chat:' + playerId, 5, 10))) {
        return null;
      }
      const account = accounts.get(playerId);
      if (!account || account.banned || account.mutedUntil > Date.now()) return null;
      const id = randomUUID();
      const timestamp = Date.now();
      chatMessages.set(id, { id, roomId, playerId, callsign, text, timestamp, recipients: new Set() });
      return { id, playerId, callsign, text, timestamp };
    },
    async blockedBy(playerIds: string[], senderId: string) {
      const blocked = new Set<string>();
      for (const pid of playerIds) {
        if (chatBlocks.get(pid)?.has(senderId)) blocked.add(pid);
      }
      return blocked;
    },
    async delivered(messageId: string, playerIds: string[]) {
      const msg = chatMessages.get(messageId);
      if (!msg) return;
      for (const pid of playerIds) msg.recipients.add(pid);
    },
  };

  function canRelate(actorId: string, targetId: string, invite: boolean): boolean {
    if (actorId === targetId) return false;
    const actor = accounts.get(actorId);
    const target = accounts.get(targetId);
    if (!actor?.verified || actor.banned || !target?.verified || target.banned) return false;
    if (isPairBlocked(actorId, targetId)) return false;
    const [, , key] = pairKey(actorId, targetId);
    const link = friendLinks.get(key);
    if (!link?.acceptedAt) return false;
    if (invite && (!target.allowInvites || actor.mutedUntil > Date.now())) return false;
    return true;
  }

  const social = {
    setPresenceProvider(provider: (id: string) => FriendStatus) {
      presenceProvider = provider;
    },
    async isFriend(actorId: string, targetId: string) {
      return canRelate(actorId, targetId, false);
    },
    async canInvite(actorId: string, targetId: string) {
      return canRelate(actorId, targetId, true);
    },
    async canSignal(actorId: string) {
      const actor = accounts.get(actorId);
      return Boolean(actor?.verified && !actor.banned && actor.mutedUntil <= Date.now());
    },
    async list(actorId: string): Promise<SocialView> {
      const actor = accounts.get(actorId);
      if (!actor) throw new Error('Account does not exist');
      const view: SocialView = {
        friendCode: actor.friendCode,
        allowInvites: actor.allowInvites,
        friends: [],
        incoming: [],
        outgoing: [],
      };
      for (const link of friendLinks.values()) {
        if (link.low !== actorId && link.high !== actorId) continue;
        const otherId = link.low === actorId ? link.high : link.low;
        const other = accounts.get(otherId);
        if (!other?.verified || other.banned || isPairBlocked(actorId, otherId)) continue;
        const callsign = other.profile.callsign?.trim().slice(0, 18) || `Prism-${other.id.slice(-4).toUpperCase()}`;
        if (link.acceptedAt) view.friends.push({ id: other.id, callsign, status: presenceProvider(other.id) });
        else if (link.requestedBy === actorId) view.outgoing.push({ playerId: other.id, callsign });
        else view.incoming.push({ playerId: other.id, callsign });
      }
      view.friends.sort((a, b) => a.callsign.toLowerCase().localeCompare(b.callsign.toLowerCase()) || a.id.localeCompare(b.id));
      return view;
    },
    async request(actorId: string, code: string): Promise<SocialError | undefined> {
      const targetId = accountsByCode.get(code);
      if (!targetId) return 'social_unavailable';
      if (actorId === targetId) return 'social_invalid';
      const actor = accounts.get(actorId);
      const target = accounts.get(targetId);
      if (!actor?.verified || actor.banned || actor.mutedUntil > Date.now() || !target?.verified || target.banned || isPairBlocked(actorId, targetId)) {
        return 'social_unavailable';
      }
      const [low, high, key] = pairKey(actorId, targetId);
      const existing = friendLinks.get(key);
      if (existing) {
        if (!existing.acceptedAt && existing.requestedBy !== actorId) return 'social_request_received';
        return;
      }
      let actorPending = 0;
      let targetPending = 0;
      for (const link of friendLinks.values()) {
        if (link.acceptedAt) continue;
        if (link.low === actorId || link.high === actorId) actorPending++;
        if (link.low === targetId || link.high === targetId) targetPending++;
      }
      if (actorPending >= maximumRequests || targetPending >= maximumRequests) return 'social_limit';
      friendLinks.set(key, { low, high, requestedBy: actorId, acceptedAt: null });
    },
    async respond(actorId: string, targetId: string, accept: boolean): Promise<SocialError | undefined> {
      const [, , key] = pairKey(actorId, targetId);
      const current = friendLinks.get(key);
      if (!current || current.requestedBy !== targetId) return 'social_request_missing';
      if (current.acceptedAt) return accept ? undefined : 'social_request_missing';
      if (!accept) {
        friendLinks.delete(key);
        return;
      }
      const actor = accounts.get(actorId);
      const target = accounts.get(targetId);
      if (!actor?.verified || actor.banned || !target?.verified || target.banned || isPairBlocked(actorId, targetId)) {
        return 'social_unavailable';
      }
      let actorFriends = 0;
      let targetFriends = 0;
      for (const link of friendLinks.values()) {
        if (!link.acceptedAt) continue;
        if (link.low === actorId || link.high === actorId) actorFriends++;
        if (link.low === targetId || link.high === targetId) targetFriends++;
      }
      if (actorFriends >= maximumFriends || targetFriends >= maximumFriends) return 'social_limit';
      current.acceptedAt = Date.now();
    },
    async remove(actorId: string, targetId: string) {
      const [, , key] = pairKey(actorId, targetId);
      friendLinks.delete(key);
    },
    async setAllowInvites(actorId: string, allow: boolean) {
      const actor = accounts.get(actorId);
      if (actor) actor.allowInvites = allow;
    },
    async setBlocked(actorId: string, targetId: string, blocked: boolean) {
      if (!accounts.has(targetId)) return;
      let set = chatBlocks.get(actorId);
      if (!set) {
        set = new Set();
        chatBlocks.set(actorId, set);
      }
      if (blocked) set.add(targetId);
      else set.delete(targetId);
    },
  };

  const fail = (res: Response, status: number, error: string) => res.status(status).json({ error });
  const ok = (res: Response) => res.json({ ok: true });
  const socialErrorStatus: Record<SocialError, number> = {
    social_invalid: 400,
    social_unavailable: 404,
    social_limit: 409,
    social_request_received: 409,
    social_request_missing: 404,
  };
  const socialResult = (res: Response, error?: SocialError) => (error ? fail(res, socialErrorStatus[error], error) : ok(res));

  const originGuard: RequestHandler = (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || allowOrigin(req)) next();
    else fail(res, 403, '请求来源无效');
  };
  const authorized = (handler: (req: Request, res: Response, auth: Auth) => Promise<unknown>) =>
    wrap(async (req, res) => {
      const auth = await authenticate(req);
      return auth ? handler(req, res, auth) : fail(res, 401, '请先登录');
    });
  const moderator = (handler: (req: Request, res: Response, auth: Auth) => Promise<unknown>) =>
    authorized(async (req, res, auth) => {
      if (!admins.has(auth.email)) return fail(res, 403, '需要管理权限');
      return handler(req, res, auth);
    });

  async function authLimit(req: Request, action: string, email: string, count: number) {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const [accountOk, ipOk] = await Promise.all([
      limit('auth:' + action + ':account:' + digest(email), count, 900),
      limit('auth:' + action + ':ip:' + digest(ip), 60, 900),
    ]);
    return accountOk && ipOk;
  }

  function install(app: Express) {
    app.use('/api', (_req, res, next) => {
      res.setHeader('Cache-Control', 'no-store');
      next();
    }, originGuard);

    app.get('/api/auth/mode', (_req, res) => res.json({ standalone: true }));
    app.get('/api/auth/session', authorized(async (_req, res, { playerId, email }) => res.json({ playerId, email, moderator: admins.has(email) })));

    app.post('/api/auth/guest', wrap(async (req, res) => {
      const ip = req.ip || req.socket.remoteAddress || 'unknown';
      if (!(await limit('auth:guest:ip:' + digest(ip), 30, 900))) return fail(res, 429, '请求过于频繁');
      const id = randomUUID();
      const rawName = typeof req.body?.callsign === 'string' ? req.body.callsign.normalize('NFKC').replace(/[\p{Cc}\p{Cf}]/gu, '').trim() : '';
      const callsign = rawName.length >= 2 && !filtered.some(term => rawName.toLowerCase().includes(term)) ? rawName.slice(0, 18) : `Prism-${id.slice(-4).toUpperCase()}`;
      const email = `guest-${id.slice(0, 8)}@prism.local`;
      const friendCode = generateFriendCode(accountsByCode);
      const account: MemoryAccount = {
        id,
        email,
        passwordHash: placeholderHash,
        verified: true,
        banned: false,
        mutedUntil: 0,
        friendCode,
        allowInvites: true,
        profile: normalizePlayerProfile({ id, callsign }, id),
      };
      accounts.set(id, account);
      accountsByEmail.set(email, id);
      accountsByCode.set(friendCode, id);
      const raw = createSessionFor(account);
      setSession(req, res, raw);
      return res.json({ ok: true, playerId: id, email, moderator: false });
    }));

    app.post('/api/auth/register', wrap(async (req, res) => {
      if (PLAYTEST_KEY && !keyMatches(req) && req.body?.playtestKey !== PLAYTEST_KEY) return fail(res, 403, '需要封闭测试访问码');
      const email = emailOf(req.body?.email);
      const password = req.body?.password;
      if (!email || !passwordOk(password)) return fail(res, 400, '请输入有效邮箱及至少 12 个字符的密码');
      if (!(await authLimit(req, 'register', email, 8))) return fail(res, 429, '请求过于频繁');
      if (accountsByEmail.has(email)) return fail(res, 409, '该邮箱已被注册，请直接登录');
      const id = randomUUID();
      const name = typeof req.body?.callsign === 'string' ? req.body.callsign.normalize('NFKC').replace(/[\p{Cc}\p{Cf}]/gu, '') : '';
      const callsign = filtered.some(term => name.toLowerCase().includes(term)) ? '' : name;
      const profile = normalizePlayerProfile({ id, callsign }, id);
      const passwordHash = await hashPassword(password);
      const friendCode = generateFriendCode(accountsByCode);
      const account: MemoryAccount = {
        id,
        email,
        passwordHash,
        verified: true,
        banned: false,
        mutedUntil: 0,
        friendCode,
        allowInvites: true,
        profile,
      };
      accounts.set(id, account);
      accountsByEmail.set(email, id);
      accountsByCode.set(friendCode, id);
      const raw = createSessionFor(account);
      setSession(req, res, raw);
      return res.json({ ok: true, playerId: id, email, moderator: admins.has(email) });
    }));

    app.post('/api/auth/resend', wrap(async (req, res) => {
      const email = emailOf(req.body?.email);
      if (!email) return fail(res, 400, '请输入有效邮箱');
      if (!(await authLimit(req, 'resend', email, 4))) return fail(res, 429, '请求过于频繁');
      return ok(res);
    }));

    app.post('/api/auth/verify', wrap(async (req, res) => {
      const raw = req.body?.token;
      if (!isToken(raw)) return fail(res, 400, '验证链接无效或已过期');
      const entry = tokens.get(digest(raw));
      if (!entry || entry.kind !== 'verify' || entry.expiresAt <= Date.now()) return fail(res, 400, '验证链接无效或已过期');
      tokens.delete(digest(raw));
      const account = accounts.get(entry.accountId);
      if (account) account.verified = true;
      return ok(res);
    }));

    app.post('/api/auth/login', wrap(async (req, res) => {
      const email = emailOf(req.body?.email);
      const password = req.body?.password;
      if (!email || !passwordOk(password)) return fail(res, 400, '请输入邮箱和密码');
      if (!(await authLimit(req, 'login', email, 12))) return fail(res, 429, '请求过于频繁');
      const accountId = accountsByEmail.get(email);
      const account = accountId ? accounts.get(accountId) : undefined;
      const hash = account?.passwordHash || placeholderHash;
      const candidate = await hashPassword(password, hash.split(':')[0]);
      if (!timingSafeEqual(Buffer.from(hash), Buffer.from(candidate)) || !account || account.banned) {
        return fail(res, 401, '登录失败：邮箱或密码不正确，或账号不可用');
      }
      if (!account.verified) return fail(res, 403, '请先验证邮箱');
      const raw = createSessionFor(account);
      setSession(req, res, raw);
      return res.json({ ok: true, playerId: account.id, email, moderator: admins.has(email) });
    }));

    app.post('/api/auth/logout', wrap(async (req, res) => {
      const raw = cookieValue(req);
      if (isToken(raw)) {
        const id = digest(raw);
        sessions.delete(id);
        onRevoked(id, 'session');
      }
      setSession(req, res, '', 0);
      return ok(res);
    }));

    app.post('/api/auth/forgot', wrap(async (req, res) => {
      const email = emailOf(req.body?.email);
      if (!email) return fail(res, 400, '请输入有效邮箱');
      if (!(await authLimit(req, 'forgot', email, 4))) return fail(res, 429, '请求过于频繁');
      return ok(res);
    }));

    app.post('/api/auth/reset', wrap(async (req, res) => {
      const raw = req.body?.token;
      const password = req.body?.password;
      if (!isToken(raw) || !passwordOk(password)) return fail(res, 400, '重置链接或新密码无效');
      const entry = tokens.get(digest(raw));
      if (!entry || entry.kind !== 'reset' || entry.expiresAt <= Date.now()) return fail(res, 400, '重置链接无效或已过期');
      tokens.delete(digest(raw));
      const account = accounts.get(entry.accountId);
      if (!account) return fail(res, 400, '重置链接无效或已过期');
      account.passwordHash = await hashPassword(password);
      for (const [k, s] of sessions.entries()) {
        if (s.accountId === account.id) sessions.delete(k);
      }
      onRevoked(account.id, 'account');
      setSession(req, res, '', 0);
      return ok(res);
    }));

    app.get('/api/profile', authorized(async (_req, res, { playerId }) => res.json(await getProfile(playerId))));
    app.get('/api/missions', authorized(async (_req, res, { playerId }) => {
      const profile = await getProfile(playerId);
      const dailyMissions = normalizeDailyMissions(profile.dailyMissions, playerId);
      return res.json({ dailyMissions, credits: profile.stats.credits, nextResetMs: msUntilNextUtcDay() });
    }));
    app.post('/api/missions/claim', authorized(async (req, res, { playerId }) => {
      const missionId = req.body?.missionId;
      if (typeof missionId !== 'string' || !missionId.trim() || missionId.length > 64) {
        return fail(res, 400, '无效的任务编号');
      }
      if (!(await limit('missions:claim:' + playerId, 30, 60))) return fail(res, 429, '请求过于频繁');
      const account = accounts.get(playerId);
      if (!account) return fail(res, 404, '账号不存在');
      const profile = normalizePlayerProfile(account.profile, playerId);
      const claimed = claimDailyMission(profile.dailyMissions, playerId, missionId.trim());
      if (!claimed.ok) {
        if (claimed.reason === 'not_found') return fail(res, 404, '未找到对应的每日任务');
        if (claimed.reason === 'not_completed') return fail(res, 409, '任务尚未完成');
        return fail(res, 409, '该任务奖励已领取');
      }
      profile.dailyMissions = claimed.state;
      profile.stats.credits += claimed.creditsAwarded;
      account.profile = profile;
      return res.json({ ok: true, profile: structuredClone(profile), creditsAwarded: claimed.creditsAwarded });
    }));
    app.post('/api/missions/claim-bonus', authorized(async (_req, res, { playerId }) => {
      if (!(await limit('missions:claim:' + playerId, 30, 60))) return fail(res, 429, '请求过于频繁');
      const account = accounts.get(playerId);
      if (!account) return fail(res, 404, '账号不存在');
      const profile = normalizePlayerProfile(account.profile, playerId);
      const claimed = claimAllClearBonus(profile.dailyMissions, playerId);
      if (!claimed.ok) {
        if (claimed.reason === 'not_completed') return fail(res, 409, '请先完成全部今日任务');
        return fail(res, 409, '全清奖励已领取');
      }
      profile.dailyMissions = claimed.state;
      profile.stats.credits += claimed.creditsAwarded;
      account.profile = profile;
      return res.json({ ok: true, profile: structuredClone(profile), creditsAwarded: claimed.creditsAwarded });
    }));
    app.get('/api/matches/:id', authorized(async (req, res, { playerId }) => {
      const result = await getResult(playerId, req.params.id);
      return result ? res.json(result) : fail(res, 404, '找不到这场对局');
    }));
    app.get('/api/social', authorized(async (_req, res, { playerId }) => {
      if (!(await limit('social:list:' + playerId, 30, 60))) return fail(res, 429, 'rate_limited');
      return res.json(await social.list(playerId));
    }));
    app.post('/api/social/request', authorized(async (req, res, { playerId }) => {
      if (!(await limit('social:request:' + playerId, 12, 60))) return fail(res, 429, 'rate_limited');
      const code = readFriendCode(req.body?.friendCode);
      return socialResult(res, code ? await social.request(playerId, code) : 'social_invalid');
    }));
    app.post('/api/social/respond', authorized(async (req, res, { playerId }) => {
      const target = req.body?.playerId;
      const accept = req.body?.accept;
      if (!isId(target) || target.toLowerCase() === playerId || typeof accept !== 'boolean') return socialResult(res, 'social_invalid');
      if (!(await limit('social:action:' + playerId, 30, 60))) return fail(res, 429, 'rate_limited');
      return socialResult(res, await social.respond(playerId, target.toLowerCase(), accept));
    }));
    app.post('/api/social/remove', authorized(async (req, res, { playerId }) => {
      const target = req.body?.playerId;
      if (!isId(target) || target.toLowerCase() === playerId) return socialResult(res, 'social_invalid');
      if (!(await limit('social:action:' + playerId, 30, 60))) return fail(res, 429, 'rate_limited');
      await social.remove(playerId, target.toLowerCase());
      return ok(res);
    }));
    app.post('/api/social/settings', authorized(async (req, res, { playerId }) => {
      if (typeof req.body?.allowInvites !== 'boolean') return socialResult(res, 'social_invalid');
      if (!(await limit('social:action:' + playerId, 30, 60))) return fail(res, 429, 'rate_limited');
      await social.setAllowInvites(playerId, req.body.allowInvites);
      return ok(res);
    }));
    app.get('/api/chat/blocks', authorized(async (_req, res, { playerId }) => {
      return res.json({ playerIds: [...(chatBlocks.get(playerId) ?? [])] });
    }));
    app.post('/api/chat/block', authorized(async (req, res, auth) => {
      const { playerId, blocked } = req.body || {};
      if (!isId(playerId) || playerId.toLowerCase() === auth.playerId || typeof blocked !== 'boolean') return fail(res, 400, '请求无效');
      if (!(await limit('block:' + auth.playerId, 30, 60))) return fail(res, 429, '请求过于频繁');
      await social.setBlocked(auth.playerId, playerId.toLowerCase(), blocked);
      return ok(res);
    }));
    app.post('/api/chat/report', authorized(async (req, res, { playerId }) => {
      const { messageId, reason } = req.body || {};
      if (!isId(messageId) || typeof reason !== 'string' || !reason.trim() || reason.length > 300) {
        return fail(res, 400, '请选择消息并填写举报原因');
      }
      if (!(await limit('report:' + playerId, 10, 3600))) return fail(res, 429, '请求过于频繁');
      const msg = chatMessages.get(messageId);
      if (!msg || !msg.recipients.has(playerId)) return fail(res, 404, '找不到此消息');
      if (msg.playerId !== playerId) {
        const list = chatReports.get(messageId) ?? [];
        if (!list.some(r => r.reporterId === playerId)) {
          list.push({ messageId, reporterId: playerId, reason: reason.trim() });
          chatReports.set(messageId, list);
        }
      }
      return ok(res);
    }));
    app.get('/api/moderation/reports', moderator(async (_req, res) => {
      const reports = [];
      for (const [messageId, entries] of chatReports.entries()) {
        const pending = entries.filter(e => !e.resolvedAt);
        if (!pending.length) continue;
        const msg = chatMessages.get(messageId);
        if (!msg) continue;
        reports.push({
          messageId: msg.id,
          playerId: msg.playerId,
          callsign: msg.callsign,
          text: msg.text,
          timestamp: new Date(msg.timestamp).toISOString(),
          reports: pending.length,
          reasons: pending.map(p => p.reason),
        });
      }
      return res.json({ reports });
    }));
    app.post('/api/moderation/actions', moderator(async (req, res, { playerId }) => {
      const { messageId, action, reason } = req.body ?? {};
      if (!isId(messageId) || !['dismiss', 'mute', 'ban'].includes(action) || typeof reason !== 'string' || !reason.trim() || reason.length > 300) {
        return fail(res, 400, '请求无效');
      }
      const msg = chatMessages.get(messageId);
      const entries = chatReports.get(messageId)?.filter(e => !e.resolvedAt) ?? [];
      if (!msg || msg.playerId === playerId || !entries.length) return fail(res, 404, '举报已处理或不存在');
      const now = Date.now();
      for (const entry of entries) entry.resolvedAt = now;
      const target = accounts.get(msg.playerId);
      if (target) {
        if (action === 'mute') target.mutedUntil = Math.max(target.mutedUntil, now + 24 * 3600_000);
        if (action === 'ban') {
          target.banned = true;
          for (const [k, s] of sessions.entries()) {
            if (s.accountId === target.id) sessions.delete(k);
          }
          onRevoked(target.id, 'ban');
        }
      }
      return ok(res);
    }));
  }

  const health = async () => {};
  const close = async () => {
    sessions.clear();
    rateLimits.clear();
  };
  const isDraining = async () => process.env.DRAIN_MATCHES === '1';

  return {
    install,
    authenticate,
    allowOrigin,
    getProfile,
    saveProfile,
    getResult,
    allowPlay,
    playUntil,
    lobby,
    limit,
    renewOwner,
    revokeOwner,
    openMatch,
    commitResults,
    cancelMatch,
    reap,
    chat,
    social,
    health,
    close,
    isDraining,
  };
}

import type { Pool, PoolClient } from 'pg';
import type { FriendStatus, SocialView } from '../src/shared/social.ts';

export type SocialError = 'social_invalid' | 'social_unavailable' | 'social_limit' | 'social_request_received' | 'social_request_missing';
type Transaction = <T>(run: (client: PoolClient) => Promise<T>) => Promise<T>;

const maximumFriends = 100;
const maximumRequests = 50;
const signalsAllowed = '(muted_until IS NULL OR muted_until <= now())';

export function readFriendCode(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 32) return;
  const code = value.replace(/[\s-]/g, '').toUpperCase();
  if (/^[A-F0-9]{16}$/.test(code)) return code;
}

export function createSocial(pool: Pool, tx: Transaction) {
  let presence: (id: string) => FriendStatus = () => 'offline';

  // Every write to a pair, including a chat block, serializes on both accounts.
  // Sorting the lock order prevents concurrent requests and creates a stable view for quotas.
  async function lockPair(client: PoolClient, actorId: string, targetId: string) {
    const [low, high] = [actorId, targetId].sort();
    const { rows } = await client.query<{ id: string; available: boolean; can_signal: boolean }>(`
      SELECT id, verified AND NOT banned AS available, ${signalsAllowed} AS can_signal
      FROM accounts WHERE id IN ($1, $2) ORDER BY id FOR NO KEY UPDATE`, [low, high]);
    return { low, high, actor: rows.find(row => row.id === actorId), target: rows.find(row => row.id === targetId) };
  }

  async function isBlocked(client: PoolClient, low: string, high: string): Promise<boolean> {
    const { rowCount } = await client.query(`
      SELECT 1 FROM chat_blocks
      WHERE (player_id = $1 AND blocked_id = $2) OR (player_id = $2 AND blocked_id = $1)
      LIMIT 1`, [low, high]);
    return Boolean(rowCount);
  }

  async function relationship(client: PoolClient, low: string, high: string) {
    const { rows } = await client.query<{ requested_by: string; accepted_at: Date | null }>(`
      SELECT requested_by, accepted_at FROM friend_connections WHERE account_low = $1 AND account_high = $2`, [low, high]);
    return rows[0];
  }

  async function canRelate(actorId: string, targetId: string, invite: boolean): Promise<boolean> {
    if (actorId === targetId) return false;
    const [low, high] = [actorId, targetId].sort();
    const { rowCount } = await pool.query(`
      SELECT 1 FROM friend_connections f
      JOIN accounts a ON a.id = $3 AND a.verified AND NOT a.banned
      JOIN accounts b ON b.id = $4 AND b.verified AND NOT b.banned
      WHERE f.account_low = $1 AND f.account_high = $2 AND f.accepted_at IS NOT NULL
        AND (NOT $5::boolean OR (b.allow_friend_invites AND (a.muted_until IS NULL OR a.muted_until <= now())))
        AND NOT EXISTS (SELECT 1 FROM chat_blocks
          WHERE (player_id = $1 AND blocked_id = $2) OR (player_id = $2 AND blocked_id = $1))`,
    [low, high, actorId, targetId, invite]);
    return Boolean(rowCount);
  }

  return {
    setPresenceProvider(provider: (id: string) => FriendStatus) { presence = provider; },
    isFriend: (actorId: string, targetId: string) => canRelate(actorId, targetId, false),
    canInvite: (actorId: string, targetId: string) => canRelate(actorId, targetId, true),
    async canSignal(actorId: string): Promise<boolean> {
      const { rowCount } = await pool.query(`
        SELECT 1 FROM accounts WHERE id = $1 AND verified AND NOT banned AND ${signalsAllowed}`, [actorId]);
      return Boolean(rowCount);
    },
    async list(actorId: string): Promise<SocialView> {
      const [account, links] = await Promise.all([
        pool.query<{ friend_code: string; allow_friend_invites: boolean }>(
          'SELECT friend_code, allow_friend_invites FROM accounts WHERE id = $1', [actorId]),
        pool.query<{ id: string; callsign: string | null; requested_by: string; accepted_at: Date | null }>(`
          SELECT a.id, a.profile->>'callsign' AS callsign, f.requested_by, f.accepted_at
          FROM friend_connections f
          JOIN accounts a ON a.id = CASE WHEN f.account_low = $1 THEN f.account_high ELSE f.account_low END
          WHERE (f.account_low = $1 OR f.account_high = $1) AND a.verified AND NOT a.banned
            AND NOT EXISTS (SELECT 1 FROM chat_blocks b
              WHERE (b.player_id = $1 AND b.blocked_id = a.id) OR (b.player_id = a.id AND b.blocked_id = $1))
          ORDER BY lower(a.profile->>'callsign'), a.id`, [actorId]),
      ]);
      const settings = account.rows[0];
      const view: SocialView = {
        friendCode: settings.friend_code, allowInvites: settings.allow_friend_invites,
        friends: [], incoming: [], outgoing: [],
      };
      for (const row of links.rows) {
        const callsign = row.callsign?.trim().slice(0, 18) || `Prism-${row.id.slice(-4).toUpperCase()}`;
        if (row.accepted_at) view.friends.push({ id: row.id, callsign, status: presence(row.id) });
        else if (row.requested_by === actorId) view.outgoing.push({ playerId: row.id, callsign });
        else view.incoming.push({ playerId: row.id, callsign });
      }
      return view;
    },
    request(actorId: string, code: string): Promise<SocialError | undefined> {
      return tx(async client => {
        const lookup = await client.query<{ id: string }>('SELECT id FROM accounts WHERE friend_code = $1 AND verified AND NOT banned', [code]);
        const targetId = lookup.rows[0]?.id;
        if (!targetId) return 'social_unavailable';
        if (actorId === targetId) return 'social_invalid';
        const { low, high, actor, target } = await lockPair(client, actorId, targetId);
        if (!actor?.available || !actor.can_signal || !target?.available || await isBlocked(client, low, high)) return 'social_unavailable';
        const existing = await relationship(client, low, high);
        if (existing) {
          if (!existing.accepted_at && existing.requested_by !== actorId) return 'social_request_received';
          return;
        }
        const { rows } = await client.query<{ id: string; pending: number }>(`
          SELECT a.id, count(f.account_low)::int AS pending
          FROM accounts a LEFT JOIN friend_connections f
            ON (f.account_low = a.id OR f.account_high = a.id) AND f.accepted_at IS NULL
          WHERE a.id IN ($1, $2) GROUP BY a.id`, [low, high]);
        if (rows.some(row => row.pending >= maximumRequests)) return 'social_limit';
        await client.query('INSERT INTO friend_connections(account_low, account_high, requested_by) VALUES ($1,$2,$3)', [low, high, actorId]);
      });
    },
    respond(actorId: string, targetId: string, accept: boolean): Promise<SocialError | undefined> {
      return tx(async client => {
        const { low, high, actor, target } = await lockPair(client, actorId, targetId);
        const current = await relationship(client, low, high);
        if (!current || current.requested_by !== targetId) return 'social_request_missing';
        if (current.accepted_at) return accept ? undefined : 'social_request_missing';
        if (!accept) {
          await client.query('DELETE FROM friend_connections WHERE account_low = $1 AND account_high = $2', [low, high]);
          return;
        }
        if (!actor?.available || !target?.available || await isBlocked(client, low, high)) return 'social_unavailable';
        const { rows } = await client.query<{ id: string; friends: number }>(`
          SELECT a.id, count(f.account_low)::int AS friends
          FROM accounts a LEFT JOIN friend_connections f
            ON (f.account_low = a.id OR f.account_high = a.id) AND f.accepted_at IS NOT NULL
          WHERE a.id IN ($1, $2) GROUP BY a.id`, [low, high]);
        if (rows.some(row => row.friends >= maximumFriends)) return 'social_limit';
        await client.query('UPDATE friend_connections SET accepted_at = now() WHERE account_low = $1 AND account_high = $2', [low, high]);
      });
    },
    async remove(actorId: string, targetId: string) {
      await tx(async client => {
        const { low, high } = await lockPair(client, actorId, targetId);
        await client.query('DELETE FROM friend_connections WHERE account_low = $1 AND account_high = $2', [low, high]);
      });
    },
    async setAllowInvites(actorId: string, allow: boolean) {
      await pool.query('UPDATE accounts SET allow_friend_invites = $2 WHERE id = $1', [actorId, allow]);
    },
    async setBlocked(actorId: string, targetId: string, blocked: boolean) {
      await tx(async client => {
        const { target } = await lockPair(client, actorId, targetId);
        if (!target) return;
        if (blocked) await client.query('INSERT INTO chat_blocks(player_id, blocked_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [actorId, targetId]);
        else await client.query('DELETE FROM chat_blocks WHERE player_id = $1 AND blocked_id = $2', [actorId, targetId]);
      });
    },
  };
}

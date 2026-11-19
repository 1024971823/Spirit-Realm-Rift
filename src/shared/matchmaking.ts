import type { GameModeId, PlatformType, TeamId } from './types.ts';

export interface QueueCandidate {
  playerId: string;
  callsign: string;
  mmr: number;
  platform: PlatformType;
  crossplayEnabled: boolean;
  queuedAtMs: number;
}

export interface BalancedTeamAssignment {
  cobalt: QueueCandidate[];
  amber: QueueCandidate[];
  mmrSpread: number;
  avgCobaltMmr: number;
  avgAmberMmr: number;
}

export function getSkillTier(mmr: number): { label: string; color: string; nextThreshold: number | null } {
  if (mmr < 1000) return { label: 'Bronze Vector', color: '#CD7F32', nextThreshold: 1000 };
  if (mmr < 1300) return { label: 'Silver Pulse', color: '#94A3B8', nextThreshold: 1300 };
  if (mmr < 1600) return { label: 'Cobalt Vanguard', color: '#06B6D4', nextThreshold: 1600 };
  if (mmr < 1950) return { label: 'Amber Prism', color: '#F59E0B', nextThreshold: 1950 };
  return { label: 'Apex Sovereign', color: '#EF4444', nextThreshold: null };
}

export function calculateMmrDelta(
  playerMmr: number,
  opponentAvgMmr: number,
  won: boolean,
  kdRatio: number,
): number {
  const expectedScore = 1 / (1 + Math.pow(10, (opponentAvgMmr - playerMmr) / 400));
  const actualScore = won ? 1 : 0;
  const kFactor = 32;
  const baseDelta = kFactor * (actualScore - expectedScore);
  // Subtle performance modifier capped to preserve zero-sum stability
  const perfBonus = Math.max(-6, Math.min(8, (kdRatio - 1.0) * 4));
  return Math.round(baseDelta + perfBonus);
}

export function canCandidatesMatch(a: QueueCandidate, b: QueueCandidate, nowMs: number): boolean {
  // Crossplay compatibility check
  if (!a.crossplayEnabled || !b.crossplayEnabled) {
    if (a.platform !== b.platform) return false;
  }
  // Dynamic MMR window widens with queue wait time
  const waitSec = Math.max((nowMs - a.queuedAtMs) / 1000, (nowMs - b.queuedAtMs) / 1000);
  const allowedSpread = 150 + Math.min(450, waitSec * 15);
  return Math.abs(a.mmr - b.mmr) <= allowedSpread;
}

export function formBalancedMatch(
  candidates: QueueCandidate[],
  nowMs: number,
  maxTeamSize = 4,
): BalancedTeamAssignment | null {
  if (candidates.length < 2) return null;

  // Pick anchor candidate who waited longest
  const sortedByWait = [...candidates].sort((a, b) => a.queuedAtMs - b.queuedAtMs);
  const anchor = sortedByWait[0];

  const compatible = sortedByWait
    .filter((c) => c.playerId === anchor.playerId || canCandidatesMatch(anchor, c, nowMs))
    .slice(0, maxTeamSize * 2);

  if (compatible.length < 2) return null;

  // Sort compatible players by MMR descending and snake-draft into balanced teams
  const byMmr = [...compatible].sort((a, b) => b.mmr - a.mmr);
  const cobalt: QueueCandidate[] = [];
  const amber: QueueCandidate[] = [];
  let cobaltSum = 0;
  let amberSum = 0;

  for (const player of byMmr) {
    if (cobalt.length <= amber.length && (cobaltSum <= amberSum || amber.length >= maxTeamSize)) {
      cobalt.push(player);
      cobaltSum += player.mmr;
    } else if (amber.length < maxTeamSize) {
      amber.push(player);
      amberSum += player.mmr;
    } else {
      cobalt.push(player);
      cobaltSum += player.mmr;
    }
  }

  const avgCobaltMmr = cobalt.length > 0 ? Math.round(cobaltSum / cobalt.length) : 0;
  const avgAmberMmr = amber.length > 0 ? Math.round(amberSum / amber.length) : 0;
  const mmrSpread = Math.abs(avgCobaltMmr - avgAmberMmr);

  return {
    cobalt,
    amber,
    mmrSpread,
    avgCobaltMmr,
    avgAmberMmr,
  };
}

export function pickBalancedTeamForJoiner(
  cobaltMmrs: number[],
  amberMmrs: number[],
): TeamId {
  if (cobaltMmrs.length < amberMmrs.length) return 'cobalt';
  if (amberMmrs.length < cobaltMmrs.length) return 'amber';
  const cAvg = cobaltMmrs.reduce((a, b) => a + b, 0) / Math.max(1, cobaltMmrs.length);
  const aAvg = amberMmrs.reduce((a, b) => a + b, 0) / Math.max(1, amberMmrs.length);
  return cAvg <= aAvg ? 'cobalt' : 'amber';
}

export interface MatchParticipantScore {
  id: string;
  callsign: string;
  team: TeamId;
  kills: number;
  deaths: number;
  damageDealt: number;
  mmr: number;
}

export interface MatchOutcome {
  winningTeam: TeamId;
  winnerId: string | null;
  winnerName: string;
  placements: Map<string, number>;
  avgCobaltMmr: number;
  avgAmberMmr: number;
  avgRoomMmr: number;
}

export function evaluateMatchOutcome(
  mode: GameModeId,
  scoreCobalt: number,
  scoreAmber: number,
  participants: MatchParticipantScore[],
): MatchOutcome {
  const cobaltMmrs = participants.filter((p) => p.team === 'cobalt').map((p) => p.mmr);
  const amberMmrs = participants.filter((p) => p.team === 'amber').map((p) => p.mmr);
  const avgCobaltMmr =
    cobaltMmrs.length > 0 ? Math.round(cobaltMmrs.reduce((a, b) => a + b, 0) / cobaltMmrs.length) : 1250;
  const avgAmberMmr =
    amberMmrs.length > 0 ? Math.round(amberMmrs.reduce((a, b) => a + b, 0) / amberMmrs.length) : 1250;
  const avgRoomMmr =
    participants.length > 0
      ? Math.round(participants.reduce((a, b) => a + b.mmr, 0) / participants.length)
      : 1250;

  const ranked = [...participants].sort((a, b) => {
    if (b.kills !== a.kills) return b.kills - a.kills;
    if (b.damageDealt !== a.damageDealt) return b.damageDealt - a.damageDealt;
    return a.deaths - b.deaths;
  });

  const placements = new Map<string, number>();
  ranked.forEach((p, idx) => placements.set(p.id, idx + 1));

  if (mode === 'ffa') {
    const leader = ranked[0] || null;
    return {
      winningTeam: leader?.team ?? 'cobalt',
      winnerId: leader?.id ?? null,
      winnerName: leader?.callsign ?? 'Draw',
      placements,
      avgCobaltMmr,
      avgAmberMmr,
      avgRoomMmr,
    };
  }

  const winningTeam: TeamId = scoreCobalt >= scoreAmber ? 'cobalt' : 'amber';
  return {
    winningTeam,
    winnerId: null,
    winnerName: winningTeam === 'cobalt' ? 'Cobalt Squad' : 'Amber Squad',
    placements,
    avgCobaltMmr,
    avgAmberMmr,
    avgRoomMmr,
  };
}

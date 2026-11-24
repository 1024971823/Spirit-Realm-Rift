import type { TeamId } from '../src/shared/types.ts';

interface QueuedPlayer {
  id: string;
  order: number;
  partyId?: string;
}

// A party is a single queue entry for purposes of selection and team assignment.
// For each possible 0..3 by 0..3 state, keep the earliest feasible set of units.
export function selectTeamClash<T extends QueuedPlayer>(entries: T[]) {
  const groups = new Map<string, T[]>();
  for (const entry of [...entries].sort((a, b) => a.order - b.order)) {
    const key = entry.partyId ? 'party:' + entry.partyId : 'player:' + entry.id;
    const group = groups.get(key);
    if (group) group.push(entry);
    else groups.set(key, [entry]);
  }
  const units = [...groups.values()];
  type Seat = { index: number; team: TeamId };
  const plans: (Seat[] | undefined)[] = Array(16);
  plans[0] = [];
  function earlier(a: Seat[], b: Seat[]) {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      if (a[i].index !== b[i].index) return a[i].index < b[i].index;
    }
    return a.length < b.length;
  }
  for (const [index, unit] of units.entries()) {
    for (let cobalt = 3; cobalt >= 0; cobalt--) {
      for (let amber = 3; amber >= 0; amber--) {
        const plan = plans[cobalt * 4 + amber];
        if (!plan) continue;
        const add = (c: number, a: number, team: TeamId) => {
          if (c > 3 || a > 3) return;
          const slot = c * 4 + a;
          const candidate = [...plan, { index, team }];
          const previous = plans[slot];
          if (!previous || earlier(candidate, previous)) plans[slot] = candidate;
        };
        add(cobalt + unit.length, amber, 'cobalt');
        add(cobalt, amber + unit.length, 'amber');
      }
    }
  }
  return plans[15]?.flatMap(({ index, team }) => units[index].map(entry => ({ entry, team })));
}

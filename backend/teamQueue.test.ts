import assert from 'node:assert/strict';
import { test } from 'node:test';
import { selectTeamClash } from './teamQueue.ts';

const group = (partyId: string, order: number, size: number) =>
  Array.from({ length: size }, (_, i) => ({ id: partyId + i, order, partyId }));
const solo = (id: string, order: number) => ({ id, order });

test('three pairs cannot fit two teams of three; later singles can make the oldest pairs fit', () => {
  const oldest = group('a', 1, 2);
  const next = group('b', 2, 2);
  const third = group('c', 3, 2);
  assert.equal(selectTeamClash([...oldest, ...next, ...third]), undefined);

  const firstSolo = solo('first', 4);
  const secondSolo = solo('second', 5);
  const result = selectTeamClash([secondSolo, ...third, ...next, firstSolo, ...oldest]);
  assert.ok(result);
  assert.deepEqual(new Set(result.map(seat => seat.entry.id)),
    new Set([...oldest, ...next, firstSolo, secondSolo].map(entry => entry.id)));
  for (const team of ['cobalt', 'amber'] as const) {
    const seats: typeof result = result.filter(seat => seat.team === team);
    assert.equal(seats.length, 3);
    const members = seats.flatMap(({ entry }) => 'partyId' in entry ? [entry.partyId] : []);
    assert.equal(members.length, 2);
    assert.equal(members[0], members[1]);
  }
});

test('the earliest solo remains ahead of a full party that cannot share that team', () => {
  const players = [solo('early', 1), ...group('p', 2, 3), ...group('q', 3, 3), solo('late1', 4), solo('late2', 5)];
  const result = selectTeamClash(players);
  assert.ok(result);
  const early = result.find(seat => seat.entry.id === 'early');
  assert.ok(early);
  assert.deepEqual(result.filter(seat => seat.team === early.team).map(seat => seat.entry.id), ['early', 'late1', 'late2']);
  assert.deepEqual(result.filter(seat => seat.team !== early.team).map(seat => seat.entry.id), ['p0', 'p1', 'p2']);
});

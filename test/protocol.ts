import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import type { RoomView } from '../src/net/clientSocket.ts';

export type Packet = {type: string; payload: any};
export const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

export async function waitFor<T>(check: () => T | undefined | false | null, timeout = 6000): Promise<T> {
  const deadline = performance.now() + timeout;
  do {
    const value = check();
    if (value) return value;
    await sleep(15);
  } while (performance.now() < deadline);
  throw new Error('Timed out waiting for a protocol event');
}

export function connect(origin: string, cookie: string) {
  const ws = new WebSocket(origin.replace(/^http/, 'ws') + '/ws', {headers: { Origin: origin, Cookie: cookie }});
  const received: Packet[] = [];
  let last: Packet | undefined;
  let error: Error | undefined;
  let code: number | undefined;
  ws.on('message', bytes => { last = JSON.parse(bytes.toString()); received.push(last!); if (received.length > 1000) received.shift(); });
  ws.on('close', value => { code = value; });
  ws.on('error', value => { error = value; });
  return {
    ws,
    last: () => last,
    closed: () => code,
    clear: () => { received.length = 0; },
    packets: (type: string) => received.filter(packet => packet.type === type).map(packet => packet.payload),
    send: (type: string, payload = {}) => ws.send(JSON.stringify({type, payload})),
    async find(type: string, predicate: (p: any) => boolean = () => true, timeout = 6000) {
      try {
        const message = await waitFor(() => {
          if (error) throw error;
          return received.find(p => p.type === type && predicate(p.payload));
        }, timeout);
        return message.payload;
      } catch (cause) {
        throw new Error('Missing ' + type + ' (last ' + (JSON.stringify(last) ?? 'none').slice(0, 500) + ', close ' + code + ')', {cause});
      }
    },
  };
}

type TestClient = ReturnType<typeof connect>;
type RoomVersion = Pick<RoomView, 'roomId' | 'version'>;

export async function readyPrivateRoom([host, ...guests]: TestClient[], room: RoomVersion): Promise<RoomView> {
  for (const seat of [host, ...guests]) seat.send('room:ready', { version: room.version, ready: true });
  return (await host.find('session:state', s => s.room?.roomId === room.roomId &&
    s.room.version === room.version && s.room.members.length === guests.length + 1 &&
    s.room.members.every((member: RoomView['members'][number]) => member.ready))).room;
}

export async function beginPrivateCountdown(host: TestClient, room: RoomVersion): Promise<RoomView> {
  host.clear();
  host.send('room:start', { version: room.version });
  return (await host.find('session:state', s => s.room?.roomId === room.roomId &&
    s.room.phase === 'waiting' && s.room.version > room.version &&
    typeof s.room.countdownEndsAt === 'number')).room;
}

export async function startPrivateRoom(host: TestClient, room: RoomVersion) {
  const countdown = await beginPrivateCountdown(host, room);
  const { snapshot } = await host.find('room:joined', p => p.roomId === room.roomId, 10_000);
  assert.ok(Date.now() >= countdown.countdownEndsAt!, 'The room must honor its advertised countdown');
  return snapshot;
}

export async function api(origin: string, path: string, options: {data?: unknown; cookie?: string; key?: string} = {}) {
  const resp = await fetch(origin + '/api/' + path, {
    headers: { Origin: origin, 'Content-Type': 'application/json', ...(options.cookie ? {Cookie: options.cookie} : {}), ...(options.key ? {'x-playtest-key': options.key} : {}) },
    body: options.data === undefined ? undefined : JSON.stringify(options.data),
    method: options.data === undefined ? 'GET' : 'POST',
  });
  return { status: resp.status, data: await resp.json(), cookie: resp.headers.get('set-cookie')?.split(';')[0] ?? '' };
}

export async function newAccount(origin: string, key: string, name: string) {
  const email = randomUUID() + '@example.test';
  const password = 'prism-test:' + randomUUID();
  function requireSuccess(value: Awaited<ReturnType<typeof api>>) {
    if (value.status !== 200) throw new Error('Account action failed: ' + JSON.stringify(value.data));
    return value;
  }
  requireSuccess(await api(origin, 'auth/register', { data: {email,password,callsign:name}, key }));
  const mail = requireSuccess(await api(origin, 'test/mail?kind=verify&email=' + encodeURIComponent(email), { key }));
  requireSuccess(await api(origin, 'auth/verify', { data: {token:mail.data.token} }));
  const login = requireSuccess(await api(origin, 'auth/login', { data: {email,password} }));
  return { email, password, playerId: login.data.playerId as string, cookie: login.cookie };
}

import { readFile } from 'node:fs/promises';
import { WebSocket, type RawData } from 'ws';
import { sleep, waitFor } from '../test/protocol.ts';

const { LOAD_ORIGIN: origin, LOAD_COOKIE_FILE } = process.env;
if (!origin || !LOAD_COOKIE_FILE || process.env.LOAD_ISOLATED !== '1') throw new Error('Use only a dedicated preproduction instance: set LOAD_ISOLATED=1, LOAD_ORIGIN and LOAD_COOKIE_FILE');
const cookies: string[] = JSON.parse(await readFile(LOAD_COOKIE_FILE, 'utf8'));
const clients = Number(process.env.LOAD_USERS ?? 1000);
const active = Number(process.env.LOAD_ACTIVE ?? 600);
const cookieOffset = Number(process.env.LOAD_COOKIE_OFFSET ?? 0);
const shard = process.env.LOAD_SHARD ?? String(cookieOffset);
const seconds = Number(process.env.LOAD_SECONDS ?? 3600);
const injectedOneWay = Number(process.env.LOAD_DELAY_MS ?? 0) / 2;
if (![clients,active,seconds,cookieOffset].every(Number.isSafeInteger) || cookieOffset < 0 || active < 12 || active % 6 || clients < active || cookieOffset + clients > cookies.length || seconds < 10 || !Number.isFinite(injectedOneWay) || injectedOneWay < 0 || !shard.trim() || shard.length > 80) throw new Error('Invalid load settings');

let stopped = false;
let opened = 0;
let bytesIn = 0;
let bytesOut = 0;
let errors = 0;
let inputs = 0;
let acks = 0;
let reconnects = 0;
let inputPackets = 0;
let endedDuringReconnect = 0;
const endedDuringReconnectStatuses = { finished: 0, cancelled: 0 };
const errorReasons: Record<string, number> = {};
type ErrorReason = 'ws_close' | 'ws_error' | 'cancelled_match' | 'session_error' | 'reconnect_timeout';
function recordError(reason: ErrorReason, detail: { code?: number | string; action?: string; errorKind?: string; matchStatus?: string } = {}): void {
  errors++;
  errorReasons[reason] = (errorReasons[reason] ?? 0) + 1;
  const safe = (value: string | undefined) => value?.replace(/[^a-zA-Z0-9_:.-]/g, '').slice(0, 64);
  console.log(JSON.stringify({ type:'capacity:error', time:new Date().toISOString(), shard, reason,
    code:typeof detail.code === 'number' ? detail.code : safe(detail.code), action:safe(detail.action),
    errorKind:safe(detail.errorKind), matchStatus:safe(detail.matchStatus),
  }));
}
const latency = new Uint32Array(2001);
const resume = new Uint32Array(5001);
const p = (hist: Uint32Array, fraction: number) => {
  const samples = hist.reduce((n, v) => n + v, 0);
  if (!samples) return null;
  let remaining = Math.ceil(samples * fraction);
  return hist.findIndex(n => (remaining -= n) <= 0);
};
const quantize = (hist: Uint32Array, delay: number) => { hist[Math.min(hist.length - 1, Math.max(0, Math.ceil(delay)))]++; };
class Player {
  ws?: WebSocket;
  id = '';
  match = '';
  room?: {roomId: string; phase: string; members: unknown[]; hostId: string};
  queued = false;
  seq = 0;
  yaw = 0;
  mine = false;
  pending = new Map<number, number>();
  restoring = 0;
  restoreMatch = '';
  intentional = false;
  readonly cookie: string;
  readonly index: number;
  readonly cancelledMatches = new Set<string>();
  constructor(cookie: string, index: number) { this.cookie = cookie; this.index = index; }
  async connect(): Promise<void> {
    const ws = this.ws = new WebSocket(origin!.replace(/^http/, 'ws')+'/ws', {headers:{Origin:origin!,Cookie:this.cookie}});
    ws.on('message', (data: RawData) => {
      bytesIn += Buffer.isBuffer(data) ? data.length : Buffer.byteLength(String(data));
      if (injectedOneWay) setTimeout(() => { if (this.ws === ws && !stopped) this.receive(String(data)); }, injectedOneWay);
      else if (this.ws === ws && !stopped) this.receive(String(data));
    });
    ws.on('close', code => {
      if (this.ws !== ws) return;
      opened -= wsReady ? 1 : 0;
      this.id = '';
      if (!this.intentional && !stopped) { recordError('ws_close', { code }); setTimeout(() => { if (!stopped) void this.connect().catch(() => {}); }, 1000); }
    });
    ws.on('error', err => { if (!stopped) recordError('ws_error', { errorKind:err.name }); });
    let wsReady = false;
    ws.once('open', () => { opened++; wsReady = true; });
    await waitFor(() => this.id, 20000);
  }
  send(type: string, payload: object = {}): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN || ws.bufferedAmount > 65536) return;
    const wire = JSON.stringify({type,payload});
    const write = () => { if (ws.readyState === WebSocket.OPEN) { ws.send(wire); bytesOut += Buffer.byteLength(wire); if (type === 'player:input') inputPackets++; } };
    if (injectedOneWay) setTimeout(write, injectedOneWay); else write();
  }
  receive(wire: string): void {
    const {type,payload:m} = JSON.parse(wire);
    if (type === 'session:state') {
      this.id = m.playerId;
      this.room = m.room;
      this.queued = m.queue.status !== 'idle';
      if (m.queue.status === 'ready' && !m.queue.accepted && m.queue.readyId !== this.ready) {
        this.ready = m.queue.readyId;
        this.send('queue:confirm', { readyId:m.queue.readyId, accept:true });
      }
    } else if (type === 'room:joined') {
      this.match = m.snapshot.matchId;
      const own = m.snapshot.players.find((p: {id: string}) => p.id === this.id);
      this.seq = own?.lastProcessedInputSeq ?? 0;
      this.yaw = own?.yaw ?? 0;
      this.mine = own?.robotClass === 'ep_miner';
      if (this.restoring && this.match === this.restoreMatch) { quantize(resume,performance.now()-this.restoring); reconnects++; this.restoring=0; }
    } else if (type === 'match:summary') {
      if (m.cancelled) this.recordCancellation(m.matchId ?? this.match);
      this.match = '';
      this.pending.clear();
    } else if (type === 'match:state') {
      const own = m.players.find((p: {id: string}) => p.id === this.id);
      const ack = own?.lastProcessedInputSeq ?? 0;
      const now = performance.now();
      for (const [queued, sentAt] of this.pending) {
        if (queued > ack) break;
        acks++;
        quantize(latency, now - sentAt);
        this.pending.delete(queued);
      }
    } else if (type === 'session:error' && m.code !== 'stale_ready') recordError('session_error', { code:m.code, action:m.action });
  }
  recordCancellation(matchId: string): void {
    if (this.cancelledMatches.has(matchId)) return;
    this.cancelledMatches.add(matchId);
    recordError('cancelled_match');
  }
  async restoreStatus(matchId: string): Promise<'finished' | 'cancelled' | 'active' | 'unknown'> {
    try {
      const response = await fetch(origin + '/api/matches/' + encodeURIComponent(matchId), {
        headers:{ Origin:origin!, Cookie:this.cookie }, redirect:'error', signal:AbortSignal.timeout(2000),
      });
      if (!response.ok) return 'unknown';
      const { status } = await response.json();
      return status === 'finished' || status === 'cancelled' || status === 'active' ? status : 'unknown';
    } catch { return 'unknown'; }
  }
  ready = '';
  operate(frame: number): void {
    if (!this.match || !this.id || this.ws?.readyState !== WebSocket.OPEN) return;
    const time = (frame + this.index * 13) * .07;
    const seq = ++this.seq;
    // Keep bounded samples and only count sequences acknowledged by an authoritative frame.
    if (seq % 5 === 0) {
      inputs++;
      this.pending.set(seq,performance.now());
      if (this.pending.size > 80) this.pending.delete(this.pending.keys().next().value!);
    }
    this.send('player:input', { matchId:this.match, seq, moveX:Math.cos(time),moveZ:Math.sin(time),yaw:this.yaw+Math.sin(time)*.5,pitch:0,ads:false,dash:seq%100===1 });
    if ((frame + this.index) % 12 === 0) this.send(this.mine ? 'player:mine' : 'player:fire', { matchId:this.match, actionSeq:seq });
  }
  async reconnect(): Promise<void> {
    if (!this.match || this.intentional || this.ws?.readyState !== WebSocket.OPEN) return;
    const ws = this.ws;
    this.intentional = true;
    const matchId = this.restoreMatch = this.match;
    this.id = '';
    this.match = '';
    this.pending.clear();
    ws.terminate();
    await new Promise<void>(resolve => ws.once('close', () => resolve()));
    this.restoring = performance.now();
    try { await this.connect(); await waitFor(() => !this.restoring, 7500); }
    catch {
      if (stopped) return;
      const status = await this.restoreStatus(matchId);
      if (stopped) return;
      if (status === 'finished' || status === 'cancelled') {
        endedDuringReconnect++;
        endedDuringReconnectStatuses[status]++;
        console.log(JSON.stringify({ type:'capacity:reconnect_ended', time:new Date().toISOString(), shard, status }));
        if (status === 'cancelled') this.recordCancellation(matchId);
      } else recordError('reconnect_timeout', { matchStatus:status });
    }
    finally { this.restoring = 0; this.intentional = false; }
  }
}
const players = cookies.slice(cookieOffset,cookieOffset+clients).map((cookie,i) => new Player(cookie,cookieOffset+i));
const publicCount = Math.max(6, Math.floor(active * .66 / 6) * 6);
const custom = Array.from({length:(active-publicCount)/6},(_,i) => players.slice(publicCount+i*6,publicCount+i*6+6));
const publicPlayers = players.slice(0,publicCount);
let latestHealth: unknown;
const report = async () => {
  const health = latestHealth = await fetch(origin+'/api/health').then(r=>r.json()).catch(() => ({ok:false}));
  console.log(JSON.stringify({ time:new Date().toISOString(), shard, cookieOffset, opened, active:players.filter(p=>p.match&&p.id).length, bytesIn,bytesOut,errors,errorReasons,endedDuringReconnect, inputPackets, sampledInputs:inputs,acks,reconnects, ackP95Ms:p(latency,.95),reconnectP95Ms:p(resume,.95),health }));
};
let actions: ReturnType<typeof setInterval> | undefined;
let churn: ReturnType<typeof setInterval> | undefined;
try {
  for(let i=0;i<clients;i+=40) await Promise.all(players.slice(i,i+40).map(p=>p.connect()));
  await Promise.all(custom.map(async ([host,...guests],i) => {
    host.send('room:create',{mode:['team_clash','control_core','ffa'][i%3],mapId:i%2?'cryo_relay':'reactor_foundry'});
    const code=await waitFor(() => host.room?.roomId);
    for (const guest of guests) guest.send('room:join',{roomId:code});
    await waitFor(() => host.room?.members.length===6);
    host.send('room:start');
  }));
  for(const player of publicPlayers) player.send('queue:join');
  await waitFor(() => players.slice(0,active).every(p=>p.match), 30000);
  const initialIn = bytesIn, initialOut = bytesOut;
  const startedAt = new Date().toISOString();
  const start = performance.now();
  let frame = 0;
  actions = setInterval(() => { frame++; for(const player of players.slice(0,active)) player.operate(frame); },50);
  let resumeIndex = 0;
  churn = setInterval(() => {
    for (const player of publicPlayers) if (player.id && !player.match && !player.room && !player.queued) player.send('queue:join');
    for (const [host] of custom) if (host.room?.phase==='waiting' && host.room.members.length===6 && !host.match) host.send('room:start');
    if (++resumeIndex % 5 === 0) void players[(resumeIndex*7)%active].reconnect();
  },2000);
  while(performance.now()-start < seconds*1000 && !stopped) { await sleep(Math.min(10000,seconds*1000-(performance.now()-start))); await report(); }
  const durationSec = (performance.now()-start)/1000;
  const measurementBytesIn = bytesIn-initialIn, measurementBytesOut = bytesOut-initialOut;
  console.log(JSON.stringify({
    type:'capacity:final', version:1, shard, cookieOffset, users:clients, targetActive:active, startedAt, endedAt:new Date().toISOString(),
    durationSec, frames:frame, opened, active:players.filter(p=>p.match&&p.id).length, bytesIn,bytesOut,measurementBytesIn,measurementBytesOut,
    errors,errorReasons,endedDuringReconnect,endedDuringReconnectStatuses,inputPackets,sampledInputs:inputs,acks,reconnects, inputHzPerActive:inputPackets/active/durationSec,
    meanInboundBytesPerSec:measurementBytesIn/durationSec, meanOutboundBytesPerSec:measurementBytesOut/durationSec,
    meanInboundMbit:measurementBytesIn*8/1e6/durationSec, meanOutboundMbit:measurementBytesOut*8/1e6/durationSec,
    injectedOneWayMs:injectedOneWay, simulatedRttMs:injectedOneWay*2,
    ackP95Ms:p(latency,.95), reconnectP95Ms:p(resume,.95), ackLatencyHistMs:Array.from(latency), reconnectLatencyHistMs:Array.from(resume),health:latestHealth,
  }));
} finally {
  stopped = true;
  clearInterval(actions);
  clearInterval(churn);
  for(const player of players) player.ws?.terminate();
}

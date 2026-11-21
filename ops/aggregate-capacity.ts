import { readFile } from 'node:fs/promises';

interface Summary {
  type: 'capacity:final';
  version: 1;
  shard: string;
  cookieOffset: number;
  users: number;
  targetActive: number;
  startedAt: string;
  endedAt: string;
  durationSec: number;
  frames: number;
  opened: number;
  active: number;
  bytesIn: number;
  bytesOut: number;
  measurementBytesIn: number;
  measurementBytesOut: number;
  errors: number;
  errorReasons?: Record<string, number>;
  endedDuringReconnect?: number;
  inputPackets: number;
  sampledInputs: number;
  acks: number;
  reconnects: number;
  simulatedRttMs: number;
  ackLatencyHistMs: number[];
  reconnectLatencyHistMs: number[];
  health: unknown;
}

const files = process.argv.slice(2);
if (!files.length) throw new Error('Usage: node ops/aggregate-capacity.ts SHARD_LOG.jsonl [SHARD_LOG.jsonl ...]');
const numeric = ['cookieOffset','users','targetActive','durationSec','frames','opened','active','bytesIn','bytesOut','measurementBytesIn','measurementBytesOut','errors','inputPackets','sampledInputs','acks','reconnects','simulatedRttMs'] as const;
const sumHist = (hist: number[]) => hist.reduce((sum, count) => sum + count, 0);
function percentile(hist: number[], fraction: number) {
  let remaining = Math.ceil(sumHist(hist) * fraction);
  return remaining ? hist.findIndex(count => (remaining -= count) <= 0) : null;
}
const summaries = await Promise.all(files.map(async file => {
  const line = (await readFile(file, 'utf8')).trim().split('\n').at(-1);
  let value: Summary;
  try { value = JSON.parse(line ?? '') as Summary; }
  catch { throw new Error('Missing final JSON summary: ' + file); }
  if (value?.type !== 'capacity:final' || value.version !== 1 || typeof value.shard !== 'string' || !value.shard || !numeric.every(key => Number.isFinite(value[key]) && value[key] >= 0) || value.durationSec <= 0 || !Number.isFinite(Date.parse(value.startedAt)) || !Number.isFinite(Date.parse(value.endedAt))) throw new Error('Invalid capacity summary: ' + file);
  if (value.users <= 0 || value.targetActive <= 0 || value.targetActive > value.users || !numeric.filter(key => key !== 'durationSec' && key !== 'simulatedRttMs').every(key => Number.isSafeInteger(value[key]))) throw new Error('Invalid capacity counts: ' + file);
  for (const [key, length] of [['ackLatencyHistMs',2001],['reconnectLatencyHistMs',5001]] as const) {
    if (!Array.isArray(value[key]) || value[key].length !== length || !value[key].every(count => Number.isSafeInteger(count) && count >= 0)) throw new Error('Invalid latency histogram in ' + file);
  }
  if (sumHist(value.ackLatencyHistMs) !== value.acks || sumHist(value.reconnectLatencyHistMs) !== value.reconnects) throw new Error('Histogram sample counts do not match summary in ' + file);
  if (value.errorReasons !== undefined && (!value.errorReasons || Array.isArray(value.errorReasons) || typeof value.errorReasons !== 'object' || !Object.entries(value.errorReasons).every(([reason,count]) => /^[a-z_]{1,64}$/.test(reason) && Number.isSafeInteger(count) && count >= 0))) throw new Error('Invalid error reasons in ' + file);
  const classified = Object.values(value.errorReasons ?? {}).reduce((total,count) => total + count, 0);
  if (classified > value.errors) throw new Error('Classified errors exceed the total in ' + file);
  value.errorReasons = { ...value.errorReasons, unclassified:(value.errorReasons?.unclassified ?? 0) + value.errors-classified };
  value.endedDuringReconnect ??= 0;
  if (!Number.isSafeInteger(value.endedDuringReconnect) || value.endedDuringReconnect < 0) throw new Error('Invalid ended reconnect count in ' + file);
  return value;
}));
for (let i = 0; i < summaries.length; i++) for (const previous of summaries.slice(0, i)) {
  const current = summaries[i];
  if (current.shard === previous.shard) throw new Error('Duplicate shard label: ' + current.shard);
  if (current.cookieOffset < previous.cookieOffset + previous.users && previous.cookieOffset < current.cookieOffset + current.users) throw new Error('Overlapping account ranges: ' + previous.shard + ' and ' + current.shard);
}
const sum = (field: typeof numeric[number]) => summaries.reduce((total, shard) => total + shard[field], 0);
const merge = (field: 'ackLatencyHistMs' | 'reconnectLatencyHistMs') => summaries.reduce((all, shard) => all.map((count, index) => count + shard[field][index]), Array(summaries[0][field].length).fill(0) as number[]);
const ackLatencyHistMs = merge('ackLatencyHistMs');
const reconnectLatencyHistMs = merge('reconnectLatencyHistMs');
const meanInboundBytesPerSec = summaries.reduce((total, shard) => total + shard.measurementBytesIn / shard.durationSec, 0);
const meanOutboundBytesPerSec = summaries.reduce((total, shard) => total + shard.measurementBytesOut / shard.durationSec, 0);
const starts = summaries.map(shard => Date.parse(shard.startedAt));
const ends = summaries.map(shard => Date.parse(shard.endedAt));
const rtt = [...new Set(summaries.map(shard => shard.simulatedRttMs))];
const errorReasons: Record<string, number> = Object.create(null);
for (const shard of summaries) for (const [reason,count] of Object.entries(shard.errorReasons!)) errorReasons[reason] = (errorReasons[reason] ?? 0) + count;
console.log(JSON.stringify({
  type:'capacity:aggregate', version:1, shardCount:summaries.length, users:sum('users'), targetActive:sum('targetActive'),
  durationSec:Math.max(...summaries.map(shard => shard.durationSec)), shardDurationMinSec:Math.min(...summaries.map(shard => shard.durationSec)),
  startedAt:new Date(Math.min(...starts)).toISOString(), endedAt:new Date(Math.max(...ends)).toISOString(),
  commonWindowSec:Math.max(0, Math.min(...ends)-Math.max(...starts))/1000,
  opened:sum('opened'), active:sum('active'), errors:sum('errors'), errorReasons, endedDuringReconnect:summaries.reduce((total,shard) => total+shard.endedDuringReconnect!,0), inputPackets:sum('inputPackets'), sampledInputs:sum('sampledInputs'), acks:sum('acks'), reconnects:sum('reconnects'),
  bytesIn:sum('bytesIn'), bytesOut:sum('bytesOut'), measurementBytesIn:sum('measurementBytesIn'), measurementBytesOut:sum('measurementBytesOut'),
  inputHzPerActive:sum('inputPackets')/summaries.reduce((total, shard) => total + shard.targetActive*shard.durationSec, 0),
  meanInboundBytesPerSec, meanOutboundBytesPerSec, meanInboundMbit:meanInboundBytesPerSec*8/1e6, meanOutboundMbit:meanOutboundBytesPerSec*8/1e6,
  simulatedRttMs:rtt.length === 1 ? rtt[0] : null, delayModel:'Application timers add half the simulated RTT in each direction; this is not measured network RTT.',
  ackP95Ms:percentile(ackLatencyHistMs,.95), reconnectP95Ms:percentile(reconnectLatencyHistMs,.95),
  histogramMaxMs:{ack:ackLatencyHistMs.length-1,reconnect:reconnectLatencyHistMs.length-1},
  histogramOverflowCounts:{ack:ackLatencyHistMs.at(-1),reconnect:reconnectLatencyHistMs.at(-1)},
  shards:summaries.map(shard => ({
    shard:shard.shard,cookieOffset:shard.cookieOffset,users:shard.users,targetActive:shard.targetActive,durationSec:shard.durationSec,
    opened:shard.opened,active:shard.active,errors:shard.errors,errorReasons:shard.errorReasons,endedDuringReconnect:shard.endedDuringReconnect,frames:shard.frames,inputPackets:shard.inputPackets,
    inputHzPerActive:shard.inputPackets/shard.targetActive/shard.durationSec,sampledInputs:shard.sampledInputs,acks:shard.acks,reconnects:shard.reconnects,
    ackP95Ms:percentile(shard.ackLatencyHistMs,.95),reconnectP95Ms:percentile(shard.reconnectLatencyHistMs,.95),simulatedRttMs:shard.simulatedRttMs,
    meanInboundMbit:shard.measurementBytesIn*8/1e6/shard.durationSec,meanOutboundMbit:shard.measurementBytesOut*8/1e6/shard.durationSec,health:shard.health,
  })),
  ackLatencyHistMs,reconnectLatencyHistMs,
}));

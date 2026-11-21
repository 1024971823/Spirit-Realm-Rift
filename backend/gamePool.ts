import { fork, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';

export interface TickStats {
  activeRooms: number;
  frames: number;
  tickP50Ms: number;
  tickP95Ms: number;
  tickP99Ms: number;
}

export interface GameWorker {
  id: string;
  slot: number;
  child: ChildProcess;
  ready: boolean;
  pending: number;
  rooms: Set<string>;
  lastReportAt: number;
  stats?: TickStats;
}

export function measureTicks() {
  const samples = new Float64Array(1200);
  let frames = 0;
  return {
    add(ms: number) { samples[frames++ % samples.length] = ms; },
    report(activeRooms: number): TickStats {
      const sorted = samples.slice(0, Math.min(frames, samples.length)).sort();
      const at = (q: number) => Number((sorted[Math.max(0, Math.ceil(sorted.length * q) - 1)] ?? 0).toFixed(3));
      return { activeRooms, frames, tickP50Ms: at(.5), tickP95Ms: at(.95), tickP99Ms: at(.99) };
    },
  };
}

export function createGamePool<Outbound extends object, Inbound extends {type: string}>(options: {
  entry: string;
  count: number;
  claim: (id: string) => Promise<void>;
  onEvent: (worker: GameWorker, message: Inbound) => void;
  onFailure: (worker: GameWorker) => void;
}) {
  const workers = new Map<number, GameWorker>();
  let closed = false;
  function spawn(slot: number) {
    const id = randomUUID();
    const child = fork(options.entry, [], {
      env: { ...process.env, PRISM_SIM_WORKER: id }, serialization: 'advanced',
      // Avoid inheriting the gateway's watch mode or debugger ports.
      execArgv: process.execArgv.includes('tsx') ? ['--import', 'tsx'] : [],
    });
    const worker: GameWorker = { id, slot, child, ready: false, pending: 0, rooms: new Set(), lastReportAt: Date.now() };
    workers.set(slot, worker);
    child.on('message', (value: Inbound) => {
      if (closed || workers.get(slot) !== worker) return;
      worker.lastReportAt = Date.now();
      if (value.type === 'ready') {
        void options.claim(id).then(() => {
          if (!closed && workers.get(slot) === worker) worker.ready = true;
        }).catch(err => { console.error('Cannot lease game worker:', err); child.kill('SIGKILL'); });
      } else if (value.type === 'metrics') {
        worker.stats = (value as {stats?: TickStats}).stats;
      } else if (worker.ready) options.onEvent(worker, value);
    });
    const fail = () => {
      if (workers.get(slot) !== worker) return;
      worker.ready = false;
      workers.delete(slot);
      if (closed) return;
      options.onFailure(worker);
      setTimeout(() => { if (!closed) spawn(slot); }, 500).unref();
    };
    child.on('disconnect', () => { if (!closed) child.kill('SIGKILL'); });
    child.once('exit', fail);
    child.on('error', error => { console.error('Game worker process failure:', error); child.kill('SIGKILL'); fail(); });
  }
  for (let slot = 0; slot < options.count; slot++) spawn(slot);
  return {
    reserve(matchId: string) {
      const worker = [...workers.values()].filter(w => w.ready && w.child.connected).sort((a, b) => a.rooms.size - b.rooms.size || a.slot - b.slot)[0];
      worker?.rooms.add(matchId);
      return worker;
    },
    send(worker: GameWorker, value: Outbound) {
      if (closed || !worker.ready || !worker.child.connected) return false;
      if (worker.pending >= 4096) { worker.child.kill('SIGKILL'); return false; }
      worker.pending++;
      try {
        worker.child.send(value, err => { worker.pending--; if (err && !closed) worker.child.kill('SIGKILL'); });
        return true;
      } catch {
        worker.pending--;
        worker.child.kill('SIGKILL');
        return false;
      }
    },
    live: () => [...workers.values()].filter(w => w.ready),
    inspect() {
      for (const w of workers.values()) if (Date.now() - w.lastReportAt > 8000) w.child.kill('SIGKILL');
      return [...workers.values()].map(w => ({ slot: w.slot, ready: w.ready, ...w.stats }));
    },
    close() {
      closed = true;
      for (const w of workers.values()) w.child.kill();
    },
  };
}

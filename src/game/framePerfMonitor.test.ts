import assert from 'node:assert/strict';
import test from 'node:test';
import { FramePerfMonitor, type FramePerfLogger } from './framePerfMonitor.ts';

function createMemoryLogger(): { logger: FramePerfLogger; infos: string[]; warns: string[] } {
  const infos: string[] = [];
  const warns: string[] = [];
  return {
    infos,
    warns,
    logger: {
      info: (...args) => infos.push(args.map(String).join(' ')),
      warn: (...args) => warns.push(args.map(String).join(' ')),
    },
  };
}

const normalPhases = {
  gameplayMs: 0.6,
  renderMs: 2.2,
  hudMs: 0.2,
  shaderCompileMs: 0,
  totalWorkMs: 3.1,
};

test('records steady 60fps frame deltas without false micro-stutter alerts', () => {
  const { logger, warns } = createMemoryLogger();
  const monitor = new FramePerfMonitor({ logger, logCooldownMs: 0 });

  for (let i = 0; i < 60; i++) {
    const ev = monitor.recordFrame(1000 + i * 16.67, 16.67, normalPhases);
    assert.equal(ev, null);
  }

  const report = monitor.getReport();
  assert.equal(report.totalFrames, 60);
  assert.equal(report.stutterCount, 0);
  assert.ok(Math.abs(report.avgDeltaMs - 16.67) < 0.05);
  assert.ok(Math.abs(report.effectiveFps - 60) < 0.5);
  assert.equal(warns.length, 0);
});

test('detects micro-stutter caused by blocking network snapshot processing and logs spike details', () => {
  const { logger, warns } = createMemoryLogger();
  const monitor = new FramePerfMonitor({ logger, logCooldownMs: 0, snapshotBlockingMs: 4 });

  // Warm up baseline at 60 fps
  for (let i = 0; i < 15; i++) {
    monitor.recordFrame(1000 + i * 16.67, 16.67, normalPhases);
  }

  // Simulate a heavy network snapshot decode + apply right before the next frame
  monitor.recordSnapshot({
    timestampMs: 1265,
    applyMs: 11.4,
    decodeMs: 3.1,
    bytes: 4200,
    serverTick: 128,
    playerCount: 6,
    rebuiltArena: false,
    rebuiltRigCount: 1,
  });

  const stutter = monitor.recordFrame(1285, 34.8, normalPhases);
  assert.ok(stutter, 'Expected a micro-stutter event to be detected');
  assert.equal(stutter.snapshotBlocking, true);
  assert.equal(stutter.likelyCause, 'network_snapshot');
  assert.equal(stutter.snapshotsInFrame, 1);
  assert.equal(stutter.snapshotRebuiltRigCount, 1);
  assert.ok(stutter.snapshotTotalMs >= 14.4);
  assert.ok(stutter.snapshotShareOfOverage > 0.7);

  const report = monitor.getReport();
  assert.equal(report.stutterCount, 1);
  assert.equal(report.snapshotCorrelatedStutterCount, 1);
  assert.equal(report.snapshotBlockingStutterCount, 1);
  assert.equal(report.blockingSnapshotCount, 1);
  assert.equal(report.stutterCauseBreakdown.network_snapshot, 1);
  assert.ok(warns.some((line) => line.includes('[LaserTagPerf][SnapshotSpike]')));
  assert.ok(warns.some((line) => line.includes('[LaserTagPerf][MicroStutter]') && line.includes('cause=network_snapshot')));
});

test('distinguishes non-blocking snapshot arrival from WebGL render or shader compile spikes', () => {
  const { logger } = createMemoryLogger();
  const monitor = new FramePerfMonitor({ logger, logCooldownMs: 0, snapshotBlockingMs: 4 });

  for (let i = 0; i < 15; i++) {
    monitor.recordFrame(2000 + i * 16.67, 16.67, normalPhases);
  }

  // Fast snapshot (0.3ms) arrives in same frame as a 28ms shader compile spike
  monitor.recordSnapshot({
    timestampMs: 2260,
    applyMs: 0.2,
    decodeMs: 0.1,
    bytes: 1200,
    serverTick: 201,
    playerCount: 6,
    rebuiltArena: false,
    rebuiltRigCount: 0,
  });
  const shaderStutter = monitor.recordFrame(2295, 45.2, {
    gameplayMs: 0.5,
    renderMs: 3.1,
    hudMs: 0.1,
    shaderCompileMs: 28.4,
    totalWorkMs: 32.1,
  });
  assert.ok(shaderStutter);
  assert.equal(shaderStutter.snapshotBlocking, false);
  assert.equal(shaderStutter.likelyCause, 'shader_compile');

  // External main-thread pause (e.g. GC / React re-render) with no snapshots and fast engine work
  const externalStutter = monitor.recordFrame(2340, 44.0, normalPhases);
  assert.ok(externalStutter);
  assert.equal(externalStutter.snapshotsInFrame, 0);
  assert.equal(externalStutter.likelyCause, 'external_main_thread');
});

test('ignores tab-background pauses, emits periodic summaries, and resets cleanly', () => {
  const { logger, infos } = createMemoryLogger();
  const monitor = new FramePerfMonitor({ logger, summaryIntervalMs: 500, logCooldownMs: 0 });

  for (let i = 0; i < 40; i++) {
    monitor.recordFrame(1000 + i * 16.67, 16.67, normalPhases);
  }
  assert.ok(infos.some((line) => line.includes('[LaserTagPerf][Summary]')), 'Expected periodic summary log');

  // Huge tab-switch gap (> 2000ms) should be ignored, not counted as a stutter
  const ignored = monitor.recordFrame(5000, 3200, normalPhases);
  assert.equal(ignored, null);
  assert.equal(monitor.getReport().stutterCount, 0);

  // Genuine 350ms main-thread freeze should be captured as a stutter
  const freeze = monitor.recordFrame(5350, 350, normalPhases);
  assert.ok(freeze);
  assert.equal(monitor.getReport().stutterCount, 1);

  monitor.reset();
  const cleared = monitor.getReport();
  assert.equal(cleared.totalFrames, 0);
  assert.equal(cleared.snapshotCount, 0);
  assert.equal(cleared.stutterCount, 0);
  assert.equal(cleared.mainThreadBlockCount, 0);
  assert.equal(cleared.lastSnapshotIntervalMs, null);
});

test('calculates consecutive inter-snapshot delta times and warns immediately when applySnapshot exceeds 16ms', () => {
  const { logger, warns } = createMemoryLogger();
  const monitor = new FramePerfMonitor({ logger, logCooldownMs: 5000 });

  // First snapshot establishes baseline (no inter-snapshot delta yet)
  monitor.recordSnapshot({
    timestampMs: 1000,
    applyMs: 0.4,
    decodeMs: 0.2,
    interSnapshotDeltaMs: null,
    bytes: 900,
    serverTick: 1,
    playerCount: 6,
    rebuiltArena: false,
    rebuiltRigCount: 0,
  });
  assert.equal(monitor.getReport().lastSnapshotIntervalMs, null);
  assert.equal(warns.length, 0);

  // Second snapshot 50.25ms later, under 16ms budget (15.9ms -> Spike warning, NOT MainThreadBlock)
  monitor.recordSnapshot({
    timestampMs: 1050.25,
    applyMs: 15.9,
    decodeMs: 0.2,
    interSnapshotDeltaMs: 50.25,
    bytes: 950,
    serverTick: 2,
    playerCount: 6,
    rebuiltArena: false,
    rebuiltRigCount: 0,
  });
  assert.equal(monitor.getReport().mainThreadBlockCount, 0);
  assert.equal(warns.filter((w) => w.includes('[MainThreadBlock]')).length, 0);

  // Third snapshot 64.5ms later, exceeding 16ms budget (18.4ms) — MUST warn immediately even within 5000ms cooldown
  monitor.recordSnapshot({
    timestampMs: 1114.75,
    applyMs: 18.4,
    decodeMs: 0.3,
    interSnapshotDeltaMs: 64.5,
    bytes: 1100,
    serverTick: 3,
    playerCount: 6,
    rebuiltArena: false,
    rebuiltRigCount: 1,
  });

  const report = monitor.getReport();
  assert.equal(report.snapshotCount, 3);
  assert.equal(report.mainThreadBlockCount, 1);
  assert.equal(report.lastSnapshotIntervalMs, 64.5);
  assert.equal(report.maxSnapshotIntervalMs, 64.5);
  assert.ok(Math.abs(report.avgSnapshotIntervalMs - 57.38) < 0.05);
  const blockWarns = warns.filter((w) => w.includes('[LaserTagPerf][MainThreadBlock]'));
  assert.equal(blockWarns.length, 1);
  assert.ok(blockWarns[0].includes('18.4ms'));
  assert.ok(blockWarns[0].includes('snapshotDelta=64.5ms'));
});

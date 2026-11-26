export type StutterCause =
  | 'network_snapshot'
  | 'shader_compile'
  | 'webgl_render'
  | 'gameplay_step'
  | 'hud_emit'
  | 'external_main_thread';

export interface FramePhaseTimings {
  gameplayMs: number;
  renderMs: number;
  hudMs: number;
  shaderCompileMs: number;
  totalWorkMs: number;
}

export interface SnapshotPerfSample {
  timestampMs: number;
  applyMs: number;
  decodeMs: number;
  interSnapshotDeltaMs?: number | null;
  bytes: number;
  serverTick: number;
  playerCount: number;
  rebuiltArena: boolean;
  rebuiltRigCount: number;
}

export interface MicroStutterEvent {
  timestampMs: number;
  frameIndex: number;
  deltaMs: number;
  baselineMs: number;
  overageMs: number;
  tickWorkMs: number;
  gameplayMs: number;
  renderMs: number;
  hudMs: number;
  shaderCompileMs: number;
  snapshotsInFrame: number;
  snapshotApplyTotalMs: number;
  snapshotDecodeTotalMs: number;
  snapshotTotalMs: number;
  snapshotBytesTotal: number;
  snapshotRebuiltArena: boolean;
  snapshotRebuiltRigCount: number;
  snapshotShareOfOverage: number;
  snapshotBlocking: boolean;
  likelyCause: StutterCause;
}

export interface FramePerfReport {
  sampleCount: number;
  totalFrames: number;
  avgDeltaMs: number;
  medianDeltaMs: number;
  p95DeltaMs: number;
  p99DeltaMs: number;
  maxDeltaMs: number;
  effectiveFps: number;
  stutterCount: number;
  snapshotCorrelatedStutterCount: number;
  snapshotBlockingStutterCount: number;
  stutterCauseBreakdown: Record<StutterCause, number>;
  snapshotCount: number;
  avgSnapshotApplyMs: number;
  p95SnapshotApplyMs: number;
  maxSnapshotApplyMs: number;
  avgSnapshotDecodeMs: number;
  maxSnapshotDecodeMs: number;
  avgSnapshotIntervalMs: number;
  p95SnapshotIntervalMs: number;
  maxSnapshotIntervalMs: number;
  lastSnapshotIntervalMs: number | null;
  blockingSnapshotCount: number;
  mainThreadBlockCount: number;
  maxTickWorkMs: number;
  maxRenderMs: number;
  maxGameplayMs: number;
  maxHudMs: number;
  maxShaderCompileMs: number;
  recentStutters: MicroStutterEvent[];
}

export interface FramePerfLogger {
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
}

export interface FramePerfMonitorOptions {
  windowSize?: number;
  snapshotWindowSize?: number;
  maxRecentStutters?: number;
  stutterThresholdMs?: number;
  stutterMultiplier?: number;
  snapshotBlockingMs?: number;
  snapshotMainThreadBlockMs?: number;
  maxTrackedDeltaMs?: number;
  logCooldownMs?: number;
  summaryIntervalMs?: number;
  isSoftwareGl?: boolean;
  loggingEnabled?: boolean;
  logger?: FramePerfLogger;
}

const DEFAULT_WINDOW_SIZE = 300;
const DEFAULT_SNAPSHOT_WINDOW_SIZE = 120;
const DEFAULT_MAX_RECENT_STUTTERS = 50;

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function createEmptyCauseBreakdown(): Record<StutterCause, number> {
  return {
    network_snapshot: 0,
    shader_compile: 0,
    webgl_render: 0,
    gameplay_step: 0,
    hud_emit: 0,
    external_main_thread: 0,
  };
}

/**
 * Low-overhead ring-buffer frame & micro-stutter telemetry monitor for LaserTagEngine.
 * Correlates frame-to-frame delta spikes against incoming network snapshot decode/apply work
 * and per-phase engine timings to isolate blocking main-thread spikes.
 */
export class FramePerfMonitor {
  private readonly windowSize: number;
  private readonly snapshotWindowSize: number;
  private readonly maxRecentStutters: number;
  private readonly stutterThresholdMs: number;
  private readonly stutterMultiplier: number;
  private readonly snapshotBlockingMs: number;
  private readonly snapshotMainThreadBlockMs: number;
  private readonly maxTrackedDeltaMs: number;
  private readonly logCooldownMs: number;
  private readonly summaryIntervalMs: number;
  private readonly logger: FramePerfLogger;
  private loggingEnabled: boolean;

  private deltaRing: Float64Array;
  private deltaCursor = 0;
  private deltaCount = 0;
  private totalFrames = 0;
  private maxDeltaMs = 0;

  private snapApplyRing: Float64Array;
  private snapDecodeRing: Float64Array;
  private snapIntervalRing: Float64Array;
  private snapCursor = 0;
  private snapSampleCount = 0;
  private snapIntervalCursor = 0;
  private snapIntervalCount = 0;
  private lastSnapshotTimestampMs: number | null = null;
  private lastSnapshotIntervalMs: number | null = null;
  private maxSnapshotIntervalMs = 0;
  private totalSnapshots = 0;
  private maxSnapshotApplyMs = 0;
  private maxSnapshotDecodeMs = 0;
  private blockingSnapshotCount = 0;
  private mainThreadBlockCount = 0;

  private maxTickWorkMs = 0;
  private maxRenderMs = 0;
  private maxGameplayMs = 0;
  private maxHudMs = 0;
  private maxShaderCompileMs = 0;

  private stutterCount = 0;
  private snapshotCorrelatedStutterCount = 0;
  private snapshotBlockingStutterCount = 0;
  private causeBreakdown: Record<StutterCause, number> = createEmptyCauseBreakdown();
  private recentStutters: MicroStutterEvent[] = [];

  // Inter-frame network snapshot accumulator (captured between previous tick end and current tick)
  private pendingSnapshotsInFrame = 0;
  private pendingSnapshotApplyMs = 0;
  private pendingSnapshotDecodeMs = 0;
  private pendingSnapshotBytes = 0;
  private pendingSnapshotRebuiltArena = false;
  private pendingSnapshotRebuiltRigCount = 0;

  private lastStutterLogMs = -Infinity;
  private lastSnapshotSpikeLogMs = -Infinity;
  private lastSummaryLogMs = -Infinity;

  constructor(options: FramePerfMonitorOptions = {}) {
    this.windowSize = Math.max(30, options.windowSize ?? DEFAULT_WINDOW_SIZE);
    this.snapshotWindowSize = Math.max(20, options.snapshotWindowSize ?? DEFAULT_SNAPSHOT_WINDOW_SIZE);
    this.maxRecentStutters = Math.max(5, options.maxRecentStutters ?? DEFAULT_MAX_RECENT_STUTTERS);
    this.stutterThresholdMs = options.stutterThresholdMs ?? (options.isSoftwareGl ? 110 : 25);
    this.stutterMultiplier = options.stutterMultiplier ?? 1.65;
    this.snapshotBlockingMs = options.snapshotBlockingMs ?? 4;
    this.snapshotMainThreadBlockMs = options.snapshotMainThreadBlockMs ?? 16;
    this.maxTrackedDeltaMs = options.maxTrackedDeltaMs ?? 2000;
    this.logCooldownMs = options.logCooldownMs ?? 500;
    this.summaryIntervalMs = options.summaryIntervalMs ?? 10_000;
    this.loggingEnabled = options.loggingEnabled ?? true;
    this.logger = options.logger ?? {
      info: (...args) => console.info(...args),
      warn: (...args) => console.warn(...args),
    };

    this.deltaRing = new Float64Array(this.windowSize);
    this.snapApplyRing = new Float64Array(this.snapshotWindowSize);
    this.snapDecodeRing = new Float64Array(this.snapshotWindowSize);
    this.snapIntervalRing = new Float64Array(this.snapshotWindowSize);
  }

  setLoggingEnabled(enabled: boolean): void {
    this.loggingEnabled = enabled;
  }

  isLoggingEnabled(): boolean {
    return this.loggingEnabled;
  }

  reset(): void {
    this.deltaRing.fill(0);
    this.deltaCursor = 0;
    this.deltaCount = 0;
    this.totalFrames = 0;
    this.maxDeltaMs = 0;

    this.snapApplyRing.fill(0);
    this.snapDecodeRing.fill(0);
    this.snapIntervalRing.fill(0);
    this.snapCursor = 0;
    this.snapSampleCount = 0;
    this.snapIntervalCursor = 0;
    this.snapIntervalCount = 0;
    this.lastSnapshotTimestampMs = null;
    this.lastSnapshotIntervalMs = null;
    this.maxSnapshotIntervalMs = 0;
    this.totalSnapshots = 0;
    this.maxSnapshotApplyMs = 0;
    this.maxSnapshotDecodeMs = 0;
    this.blockingSnapshotCount = 0;
    this.mainThreadBlockCount = 0;

    this.maxTickWorkMs = 0;
    this.maxRenderMs = 0;
    this.maxGameplayMs = 0;
    this.maxHudMs = 0;
    this.maxShaderCompileMs = 0;

    this.stutterCount = 0;
    this.snapshotCorrelatedStutterCount = 0;
    this.snapshotBlockingStutterCount = 0;
    this.causeBreakdown = createEmptyCauseBreakdown();
    this.recentStutters = [];
    this.clearPendingSnapshots();

    this.lastStutterLogMs = -Infinity;
    this.lastSnapshotSpikeLogMs = -Infinity;
    this.lastSummaryLogMs = -Infinity;
  }

  private clearPendingSnapshots(): void {
    this.pendingSnapshotsInFrame = 0;
    this.pendingSnapshotApplyMs = 0;
    this.pendingSnapshotDecodeMs = 0;
    this.pendingSnapshotBytes = 0;
    this.pendingSnapshotRebuiltArena = false;
    this.pendingSnapshotRebuiltRigCount = 0;
  }

  recordSnapshot(sample: SnapshotPerfSample): void {
    const applyMs = Number.isFinite(sample.applyMs) && sample.applyMs >= 0 ? sample.applyMs : 0;
    const decodeMs = Number.isFinite(sample.decodeMs) && sample.decodeMs >= 0 ? sample.decodeMs : 0;
    const bytes = Number.isFinite(sample.bytes) && sample.bytes >= 0 ? sample.bytes : 0;

    let interDeltaMs: number | null = null;
    if (sample.interSnapshotDeltaMs !== undefined) {
      if (
        sample.interSnapshotDeltaMs !== null &&
        Number.isFinite(sample.interSnapshotDeltaMs) &&
        sample.interSnapshotDeltaMs >= 0
      ) {
        interDeltaMs = sample.interSnapshotDeltaMs;
      }
    } else if (this.lastSnapshotTimestampMs !== null && Number.isFinite(sample.timestampMs)) {
      interDeltaMs = Math.max(0, sample.timestampMs - this.lastSnapshotTimestampMs);
    }
    if (Number.isFinite(sample.timestampMs)) {
      this.lastSnapshotTimestampMs = sample.timestampMs;
    }

    if (interDeltaMs !== null) {
      this.snapIntervalRing[this.snapIntervalCursor] = interDeltaMs;
      this.snapIntervalCursor = (this.snapIntervalCursor + 1) % this.snapshotWindowSize;
      if (this.snapIntervalCount < this.snapshotWindowSize) this.snapIntervalCount++;
      this.lastSnapshotIntervalMs = interDeltaMs;
      if (interDeltaMs > this.maxSnapshotIntervalMs) this.maxSnapshotIntervalMs = interDeltaMs;
    }

    this.snapApplyRing[this.snapCursor] = applyMs;
    this.snapDecodeRing[this.snapCursor] = decodeMs;
    this.snapCursor = (this.snapCursor + 1) % this.snapshotWindowSize;
    if (this.snapSampleCount < this.snapshotWindowSize) this.snapSampleCount++;
    this.totalSnapshots++;

    if (applyMs > this.maxSnapshotApplyMs) this.maxSnapshotApplyMs = applyMs;
    if (decodeMs > this.maxSnapshotDecodeMs) this.maxSnapshotDecodeMs = decodeMs;

    this.pendingSnapshotsInFrame++;
    this.pendingSnapshotApplyMs += applyMs;
    this.pendingSnapshotDecodeMs += decodeMs;
    this.pendingSnapshotBytes += bytes;
    if (sample.rebuiltArena) this.pendingSnapshotRebuiltArena = true;
    this.pendingSnapshotRebuiltRigCount += Math.max(0, sample.rebuiltRigCount);

    const deltaLabel = interDeltaMs !== null ? `${round2(interDeltaMs)}ms` : 'n/a';
    const totalMs = applyMs + decodeMs;

    // Exceeding a 16ms frame budget inside applySnapshot indicates a direct main-thread block.
    if (applyMs > this.snapshotMainThreadBlockMs) {
      this.mainThreadBlockCount++;
      this.blockingSnapshotCount++;
      if (this.loggingEnabled) {
        this.lastSnapshotSpikeLogMs = sample.timestampMs;
        this.logger.warn(
          `[LaserTagPerf][MainThreadBlock] applySnapshot took ${round2(applyMs)}ms (>${this.snapshotMainThreadBlockMs}ms budget) ` +
            `| snapshotDelta=${deltaLabel} | decode=${round2(decodeMs)}ms total=${round2(totalMs)}ms ` +
            `| tick=${sample.serverTick} players=${sample.playerCount} bytes=${bytes}` +
            (sample.rebuiltArena ? ' [rebuiltArena]' : '') +
            (sample.rebuiltRigCount > 0 ? ` [rebuiltRigs=${sample.rebuiltRigCount}]` : ''),
        );
      }
      return;
    }

    if (totalMs >= this.snapshotBlockingMs) {
      this.blockingSnapshotCount++;
      if (this.loggingEnabled && sample.timestampMs - this.lastSnapshotSpikeLogMs >= this.logCooldownMs) {
        this.lastSnapshotSpikeLogMs = sample.timestampMs;
        this.logger.warn(
          `[LaserTagPerf][SnapshotSpike] total=${round2(totalMs)}ms (apply=${round2(applyMs)}ms, decode=${round2(decodeMs)}ms) ` +
            `snapshotDelta=${deltaLabel} tick=${sample.serverTick} players=${sample.playerCount} bytes=${bytes}` +
            (sample.rebuiltArena ? ' [rebuiltArena]' : '') +
            (sample.rebuiltRigCount > 0 ? ` [rebuiltRigs=${sample.rebuiltRigCount}]` : ''),
        );
      }
    }
  }

  recordFrame(timestampMs: number, rawDeltaMs: number, phases: FramePhaseTimings): MicroStutterEvent | null {
    const snapshotsInFrame = this.pendingSnapshotsInFrame;
    const snapshotApplyTotalMs = this.pendingSnapshotApplyMs;
    const snapshotDecodeTotalMs = this.pendingSnapshotDecodeMs;
    const snapshotBytesTotal = this.pendingSnapshotBytes;
    const snapshotRebuiltArena = this.pendingSnapshotRebuiltArena;
    const snapshotRebuiltRigCount = this.pendingSnapshotRebuiltRigCount;
    this.clearPendingSnapshots();

    if (!Number.isFinite(rawDeltaMs) || rawDeltaMs <= 0) return null;

    // Ignore tab-backgrounding or debugger pauses so they do not poison frame statistics
    if (rawDeltaMs > this.maxTrackedDeltaMs) {
      return null;
    }

    const baselineMs = this.estimateRecentBaselineMs();

    this.deltaRing[this.deltaCursor] = rawDeltaMs;
    this.deltaCursor = (this.deltaCursor + 1) % this.windowSize;
    if (this.deltaCount < this.windowSize) this.deltaCount++;
    this.totalFrames++;

    if (rawDeltaMs > this.maxDeltaMs) this.maxDeltaMs = rawDeltaMs;
    if (phases.totalWorkMs > this.maxTickWorkMs) this.maxTickWorkMs = phases.totalWorkMs;
    if (phases.renderMs > this.maxRenderMs) this.maxRenderMs = phases.renderMs;
    if (phases.gameplayMs > this.maxGameplayMs) this.maxGameplayMs = phases.gameplayMs;
    if (phases.hudMs > this.maxHudMs) this.maxHudMs = phases.hudMs;
    if (phases.shaderCompileMs > this.maxShaderCompileMs) this.maxShaderCompileMs = phases.shaderCompileMs;

    let stutterEvent: MicroStutterEvent | null = null;
    const effectiveBaseline = baselineMs > 0 ? baselineMs : 16.67;
    const dynamicThreshold = Math.max(this.stutterThresholdMs, effectiveBaseline * this.stutterMultiplier);

    if (this.totalFrames > 3 && rawDeltaMs >= dynamicThreshold) {
      const overageMs = Math.max(0, rawDeltaMs - effectiveBaseline);
      const snapshotTotalMs = snapshotApplyTotalMs + snapshotDecodeTotalMs;
      const snapshotShareOfOverage = overageMs > 0 ? Math.min(1, snapshotTotalMs / overageMs) : 0;
      const snapshotBlocking =
        snapshotsInFrame > 0 &&
        (snapshotTotalMs >= this.snapshotBlockingMs || snapshotShareOfOverage >= 0.25);
      const likelyCause = this.classifyStutterCause(phases, snapshotTotalMs, snapshotBlocking);

      stutterEvent = {
        timestampMs,
        frameIndex: this.totalFrames,
        deltaMs: round2(rawDeltaMs),
        baselineMs: round2(effectiveBaseline),
        overageMs: round2(overageMs),
        tickWorkMs: round2(phases.totalWorkMs),
        gameplayMs: round2(phases.gameplayMs),
        renderMs: round2(phases.renderMs),
        hudMs: round2(phases.hudMs),
        shaderCompileMs: round2(phases.shaderCompileMs),
        snapshotsInFrame,
        snapshotApplyTotalMs: round2(snapshotApplyTotalMs),
        snapshotDecodeTotalMs: round2(snapshotDecodeTotalMs),
        snapshotTotalMs: round2(snapshotTotalMs),
        snapshotBytesTotal,
        snapshotRebuiltArena,
        snapshotRebuiltRigCount,
        snapshotShareOfOverage: round2(snapshotShareOfOverage),
        snapshotBlocking,
        likelyCause,
      };

      this.stutterCount++;
      if (snapshotsInFrame > 0) this.snapshotCorrelatedStutterCount++;
      if (snapshotBlocking) this.snapshotBlockingStutterCount++;
      this.causeBreakdown[likelyCause]++;

      this.recentStutters.push(stutterEvent);
      if (this.recentStutters.length > this.maxRecentStutters) {
        this.recentStutters.shift();
      }

      if (this.loggingEnabled && timestampMs - this.lastStutterLogMs >= this.logCooldownMs) {
        this.lastStutterLogMs = timestampMs;
        this.logger.warn(
          `[LaserTagPerf][MicroStutter] dt=${stutterEvent.deltaMs}ms (baseline=${stutterEvent.baselineMs}ms, +${stutterEvent.overageMs}ms) ` +
            `cause=${stutterEvent.likelyCause} | work=${stutterEvent.tickWorkMs}ms ` +
            `(gameplay=${stutterEvent.gameplayMs}ms render=${stutterEvent.renderMs}ms hud=${stutterEvent.hudMs}ms shader=${stutterEvent.shaderCompileMs}ms) ` +
            `| snapshots=${stutterEvent.snapshotsInFrame} snapTotal=${stutterEvent.snapshotTotalMs}ms ` +
            `(apply=${stutterEvent.snapshotApplyTotalMs}ms decode=${stutterEvent.snapshotDecodeTotalMs}ms blocking=${stutterEvent.snapshotBlocking})`,
        );
      }
    }

    if (this.loggingEnabled && this.lastSummaryLogMs === -Infinity) {
      this.lastSummaryLogMs = timestampMs;
    } else if (
      this.loggingEnabled &&
      this.deltaCount >= 30 &&
      timestampMs - this.lastSummaryLogMs >= this.summaryIntervalMs
    ) {
      this.lastSummaryLogMs = timestampMs;
      const report = this.getReport();
      this.logger.info(
        `[LaserTagPerf][Summary] fps=${report.effectiveFps} dt(avg=${report.avgDeltaMs}ms p95=${report.p95DeltaMs}ms p99=${report.p99DeltaMs}ms max=${report.maxDeltaMs}ms) ` +
          `| stutters=${report.stutterCount} (snapCorrelated=${report.snapshotCorrelatedStutterCount}, snapBlocking=${report.snapshotBlockingStutterCount}) ` +
          `| snap(count=${report.snapshotCount} avgInterval=${report.avgSnapshotIntervalMs}ms maxInterval=${report.maxSnapshotIntervalMs}ms avgApply=${report.avgSnapshotApplyMs}ms p95Apply=${report.p95SnapshotApplyMs}ms maxApply=${report.maxSnapshotApplyMs}ms maxDecode=${report.maxSnapshotDecodeMs}ms blocks>16ms=${report.mainThreadBlockCount})`,
      );
    }

    return stutterEvent;
  }

  private estimateRecentBaselineMs(): number {
    if (this.deltaCount === 0) return 16.67;
    const lookback = Math.min(this.deltaCount, 30);
    const recent: number[] = new Array(lookback);
    for (let i = 0; i < lookback; i++) {
      const idx = (this.deltaCursor - 1 - i + this.windowSize) % this.windowSize;
      recent[i] = this.deltaRing[idx];
    }
    recent.sort((a, b) => a - b);
    return recent[Math.floor(recent.length / 2)];
  }

  private classifyStutterCause(
    phases: FramePhaseTimings,
    snapshotTotalMs: number,
    snapshotBlocking: boolean,
  ): StutterCause {
    if (phases.shaderCompileMs >= 4 && phases.shaderCompileMs >= Math.max(snapshotTotalMs, phases.renderMs)) {
      return 'shader_compile';
    }
    if (
      snapshotBlocking &&
      snapshotTotalMs >= Math.max(phases.renderMs, phases.gameplayMs, phases.hudMs) * 0.65
    ) {
      return 'network_snapshot';
    }
    if (phases.renderMs >= 6 && phases.renderMs >= Math.max(phases.gameplayMs, phases.hudMs, snapshotTotalMs)) {
      return 'webgl_render';
    }
    if (phases.gameplayMs >= 4 && phases.gameplayMs >= phases.hudMs) {
      return 'gameplay_step';
    }
    if (phases.hudMs >= 4) {
      return 'hud_emit';
    }
    if (snapshotBlocking) {
      return 'network_snapshot';
    }
    return 'external_main_thread';
  }

  getRecentStutters(): MicroStutterEvent[] {
    return this.recentStutters.slice();
  }

  getReport(): FramePerfReport {
    const deltas: number[] = new Array(this.deltaCount);
    let deltaSum = 0;
    for (let i = 0; i < this.deltaCount; i++) {
      const v = this.deltaRing[i];
      deltas[i] = v;
      deltaSum += v;
    }
    deltas.sort((a, b) => a - b);

    const snapApplies: number[] = new Array(this.snapSampleCount);
    let snapApplySum = 0;
    let snapDecodeSum = 0;
    for (let i = 0; i < this.snapSampleCount; i++) {
      const a = this.snapApplyRing[i];
      const d = this.snapDecodeRing[i];
      snapApplies[i] = a;
      snapApplySum += a;
      snapDecodeSum += d;
    }
    snapApplies.sort((a, b) => a - b);

    const snapIntervals: number[] = new Array(this.snapIntervalCount);
    let snapIntervalSum = 0;
    for (let i = 0; i < this.snapIntervalCount; i++) {
      const iv = this.snapIntervalRing[i];
      snapIntervals[i] = iv;
      snapIntervalSum += iv;
    }
    snapIntervals.sort((a, b) => a - b);

    const avgDeltaMs = this.deltaCount > 0 ? deltaSum / this.deltaCount : 0;
    return {
      sampleCount: this.deltaCount,
      totalFrames: this.totalFrames,
      avgDeltaMs: round2(avgDeltaMs),
      medianDeltaMs: round2(percentile(deltas, 50)),
      p95DeltaMs: round2(percentile(deltas, 95)),
      p99DeltaMs: round2(percentile(deltas, 99)),
      maxDeltaMs: round2(this.maxDeltaMs),
      effectiveFps: avgDeltaMs > 0 ? round2(1000 / avgDeltaMs) : 0,
      stutterCount: this.stutterCount,
      snapshotCorrelatedStutterCount: this.snapshotCorrelatedStutterCount,
      snapshotBlockingStutterCount: this.snapshotBlockingStutterCount,
      stutterCauseBreakdown: { ...this.causeBreakdown },
      snapshotCount: this.totalSnapshots,
      avgSnapshotApplyMs: this.snapSampleCount > 0 ? round2(snapApplySum / this.snapSampleCount) : 0,
      p95SnapshotApplyMs: round2(percentile(snapApplies, 95)),
      maxSnapshotApplyMs: round2(this.maxSnapshotApplyMs),
      avgSnapshotDecodeMs: this.snapSampleCount > 0 ? round2(snapDecodeSum / this.snapSampleCount) : 0,
      maxSnapshotDecodeMs: round2(this.maxSnapshotDecodeMs),
      avgSnapshotIntervalMs: this.snapIntervalCount > 0 ? round2(snapIntervalSum / this.snapIntervalCount) : 0,
      p95SnapshotIntervalMs: round2(percentile(snapIntervals, 95)),
      maxSnapshotIntervalMs: round2(this.maxSnapshotIntervalMs),
      lastSnapshotIntervalMs: this.lastSnapshotIntervalMs !== null ? round2(this.lastSnapshotIntervalMs) : null,
      blockingSnapshotCount: this.blockingSnapshotCount,
      mainThreadBlockCount: this.mainThreadBlockCount,
      maxTickWorkMs: round2(this.maxTickWorkMs),
      maxRenderMs: round2(this.maxRenderMs),
      maxGameplayMs: round2(this.maxGameplayMs),
      maxHudMs: round2(this.maxHudMs),
      maxShaderCompileMs: round2(this.maxShaderCompileMs),
      recentStutters: this.getRecentStutters(),
    };
  }
}

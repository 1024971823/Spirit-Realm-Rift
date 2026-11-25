import React, { useCallback, useEffect, useState } from 'react';
import {
  CheckCircle2,
  Coins,
  Compass,
  Crosshair,
  Flame,
  GraduationCap,
  Pickaxe,
  Radio,
  RefreshCw,
  RotateCcw,
  X,
  Zap,
} from 'lucide-react';
import { soundEngine } from '../audio/soundEngine';
import { TACTICAL_KEYS, TACTICAL_PINGS } from '../game/tacticalPings';
import { useI18n } from '../i18n/LanguageContext';
import { ROBOT_CLASS_I18N } from '../i18n/translations';
import { AMMO_PACKS, INITIAL_TEAM_CREDITS } from '../shared/catalog';
import type { TacticalPingKind } from '../shared/social';
import {
  getNextIncompleteTrainingStep,
  isTrainingComplete,
  markTrainingStepComplete,
  TRAINING_STEP_ORDER,
  type TrainingProgress,
  type TrainingStepId,
} from '../shared/training';
import type { ControllerConfig, RobotClass } from '../shared/types';

interface TrainingModalProps {
  progress: TrainingProgress;
  activeRobotClass: RobotClass;
  controller: ControllerConfig;
  onSelectRobotClass: (robotClass: RobotClass) => void;
  onProgressChange: (next: TrainingProgress) => void;
  onGoToLobby: () => void;
  onClose: () => void;
}

const FULL_MAG_COST = AMMO_PACKS.full_mag.cost;
const PING_ORDER: TacticalPingKind[] = ['rally', 'danger', 'mine', 'support'];

function extractKeyboardLabel(bindingSpec: string | undefined, fallback: string): string {
  const first = (bindingSpec || '').split('/')[0]?.trim();
  return first || fallback;
}

function matchesBindingKey(e: KeyboardEvent, bindingSpec: string | undefined, fallbackCodes: string[]): boolean {
  const token = (bindingSpec || '').split('/')[0]?.trim().toLowerCase() ?? '';
  if (!token || token.startsWith('mouse')) {
    return fallbackCodes.includes(e.code);
  }
  const codeLower = e.code.toLowerCase();
  const keyLower = e.key.toLowerCase();
  if (token === 'space') return e.code === 'Space';
  if (token === 'shift') return e.code === 'ShiftLeft' || e.code === 'ShiftRight';
  if (token === 'ctrl' || token === 'control') return e.code === 'ControlLeft' || e.code === 'ControlRight';
  if (token === 'alt') return e.code === 'AltLeft' || e.code === 'AltRight';
  return codeLower === token || codeLower === `key${token}` || keyLower === token;
}

export const TrainingModal: React.FC<TrainingModalProps> = ({
  progress,
  activeRobotClass,
  controller,
  onSelectRobotClass,
  onProgressChange,
  onGoToLobby,
  onClose,
}) => {
  const { lang, t } = useI18n();
  const [selectedStep, setSelectedStep] = useState<TrainingStepId>(
    () => getNextIncompleteTrainingStep(progress) ?? 'drive_dash',
  );
  // Per-drill interactive micro-states aligned with live catalog economy
  const [movedKeys, setMovedKeys] = useState<string[]>([]);
  const [shotsFired, setShotsFired] = useState(0);
  const [heatPct, setHeatPct] = useState(0);
  const [oreExtracted, setOreExtracted] = useState(0);
  const [allyRepaired, setAllyRepaired] = useState(0);
  const [simCredits, setSimCredits] = useState(INITIAL_TEAM_CREDITS);
  const [simAmmo, setSimAmmo] = useState(6);
  const [pingWheelOpen, setPingWheelOpen] = useState(false);
  const [pingSpot, setPingSpot] = useState<{ x: number; y: number; kind: TacticalPingKind } | null>(null);

  const dashKeyLabel = extractKeyboardLabel(controller.bindings.dash, 'Shift');
  const reloadKeyLabel = extractKeyboardLabel(controller.bindings.reload, 'R');
  const classSkillKeyLabel = extractKeyboardLabel(controller.bindings.classSkill, 'E');
  const buyAmmoKeyLabel = extractKeyboardLabel(controller.bindings.buyAmmo, 'B');

  const keyHintForStep = (stepId: TrainingStepId): string => {
    switch (stepId) {
      case 'drive_dash':
        return `WASD + ${dashKeyLabel}`;
      case 'fire_vent':
        return `LMB + ${reloadKeyLabel}`;
      case 'switch_chassis':
        return 'U';
      case 'mine_repair':
        return classSkillKeyLabel;
      case 'team_resupply':
        return `${buyAmmoKeyLabel} / 2`;
      case 'tactical_ping':
        return t.trainingSteps.tactical_ping.keyHint;
    }
  };

  const completeStep = useCallback(
    (step: TrainingStepId) => {
      const next = markTrainingStepComplete(progress, step);
      onProgressChange(next);
      soundEngine.playHitmarker(true);
      const nextStep = getNextIncompleteTrainingStep(next);
      if (nextStep) {
        setSelectedStep(nextStep);
      }
    },
    [onProgressChange, progress],
  );

  const triggerPing = useCallback(
    (kind: TacticalPingKind, x = 120, y = 60) => {
      setPingWheelOpen(false);
      setPingSpot({ x, y, kind });
      completeStep('tactical_ping');
    },
    [completeStep],
  );

  // Support real keyboard interaction using the player's actual controller bindings
  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if ((ev.target as HTMLElement | null)?.closest?.('input,textarea,select')) return;
      const b = controller.bindings;
      if (selectedStep === 'drive_dash') {
        if (['KeyW', 'KeyA', 'KeyS', 'KeyD'].includes(ev.code)) {
          setMovedKeys(prev => (prev.includes(ev.code) ? prev : [...prev, ev.code]));
        } else if (matchesBindingKey(ev, b.dash, ['ShiftLeft', 'ShiftRight'])) {
          completeStep('drive_dash');
        }
      } else if (selectedStep === 'fire_vent' && matchesBindingKey(ev, b.reload, ['KeyR']) && shotsFired >= 3) {
        setHeatPct(0);
        completeStep('fire_vent');
      } else if (selectedStep === 'switch_chassis' && ev.code === 'KeyU') {
        const nextClass: RobotClass = activeRobotClass === 's1_striker' ? 'ep_miner' : 's1_striker';
        onSelectRobotClass(nextClass);
        completeStep('switch_chassis');
      } else if (selectedStep === 'mine_repair' && matchesBindingKey(ev, b.classSkill, ['KeyE'])) {
        setOreExtracted(prev => prev + 90);
        setAllyRepaired(prev => prev + 45);
        completeStep('mine_repair');
      } else if (
        selectedStep === 'team_resupply' &&
        (matchesBindingKey(ev, b.buyAmmo, ['KeyB']) || ev.code === 'Digit2')
      ) {
        setSimCredits(c => Math.max(0, c - FULL_MAG_COST));
        setSimAmmo(30);
        completeStep('team_resupply');
      } else if (selectedStep === 'tactical_ping') {
        if (ev.code === 'KeyG' && !ev.repeat) {
          ev.preventDefault();
          setPingWheelOpen(true);
        } else if (pingWheelOpen && TACTICAL_KEYS[ev.code]) {
          ev.preventDefault();
          const kind = TACTICAL_KEYS[ev.code]!;
          const coords: Record<TacticalPingKind, { x: number; y: number }> = {
            rally: { x: 120, y: 36 },
            danger: { x: 184, y: 60 },
            mine: { x: 194, y: 88 },
            support: { x: 56, y: 60 },
          };
          triggerPing(kind, coords[kind].x, coords[kind].y);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [activeRobotClass, completeStep, controller.bindings, onSelectRobotClass, pingWheelOpen, selectedStep, shotsFired, triggerPing]);

  const doneCount = progress.completedSteps.length;
  const totalCount = TRAINING_STEP_ORDER.length;
  const allCleared = isTrainingComplete(progress);
  const stepCopy = t.trainingSteps[selectedStep];

  const handleFireTest = () => {
    const nextShots = shotsFired + 1;
    setShotsFired(nextShots);
    setHeatPct(Math.min(92, nextShots * 28));
    soundEngine.playHitmarker(false);
  };

  const handleVentHeat = () => {
    setHeatPct(0);
    completeStep('fire_vent');
  };

  const handleSwapChassis = () => {
    const nextClass: RobotClass = activeRobotClass === 's1_striker' ? 'ep_miner' : 's1_striker';
    onSelectRobotClass(nextClass);
    completeStep('switch_chassis');
  };

  const handleMineAndRepair = () => {
    setOreExtracted(prev => prev + 90);
    setAllyRepaired(prev => prev + 45);
    completeStep('mine_repair');
  };

  const handleResupply = () => {
    setSimCredits(prev => Math.max(0, prev - FULL_MAG_COST));
    setSimAmmo(30);
    completeStep('team_resupply');
  };

  const handleRadarClick = (ev: React.MouseEvent<SVGSVGElement>) => {
    const rect = ev.currentTarget.getBoundingClientRect();
    const x = Math.round(((ev.clientX - rect.left) / rect.width) * 240);
    const y = Math.round(((ev.clientY - rect.top) / rect.height) * 120);
    triggerPing(pingSpot?.kind ?? 'rally', x, y);
  };

  const handleReset = () => {
    onProgressChange({ completedSteps: [] });
    setSelectedStep('drive_dash');
    setMovedKeys([]);
    setShotsFired(0);
    setHeatPct(0);
    setOreExtracted(0);
    setAllyRepaired(0);
    setSimCredits(INITIAL_TEAM_CREDITS);
    setSimAmmo(6);
    setPingWheelOpen(false);
    setPingSpot(null);
  };

  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/80 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="training-modal-title"
        className="chamfer-panel w-full max-w-4xl max-h-[90vh] overflow-y-auto bg-[#0C121C] border border-cyan-500/30 p-6 shadow-2xl"
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-4 pb-4 border-b border-white/10 mb-5">
          <div className="flex items-start gap-3">
            <GraduationCap className="w-6 h-6 text-cyan-400 mt-0.5 shrink-0" />
            <div>
              <h2
                id="training-modal-title"
                className="font-display font-bold text-2xl text-white uppercase tracking-wide"
              >
                {t.trainingTitle}
              </h2>
              <p className="text-xs text-slate-400 mt-0.5 leading-relaxed">{t.trainingSubtitle}</p>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-2 text-xs font-mono-tabular">
                <span className="text-cyan-300 font-semibold">
                  {t.trainingProgressLabel(doneCount, totalCount)}
                </span>
                <span aria-hidden="true" className="text-slate-600">·</span>
                <span className="text-slate-400">
                  {ROBOT_CLASS_I18N[lang][activeRobotClass].shortName}
                </span>
              </div>
            </div>
          </div>

          <button
            type="button"
            aria-label={t.trainingClose}
            onClick={onClose}
            className="chamfer-sm p-2 bg-[#162030] hover:bg-[#1F2E44] text-slate-300 cursor-pointer shrink-0"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Completion Banner */}
        {allCleared && (
          <div
            role="status"
            data-testid="training-complete-banner"
            className="chamfer-sm mb-5 flex flex-wrap items-center justify-between gap-3 border border-emerald-400/40 bg-emerald-950/35 px-4 py-3 text-sm text-emerald-200"
          >
            <span className="inline-flex items-center gap-2 font-medium">
              <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
              {t.trainingCompletedBanner}
            </span>
            <button
              type="button"
              onClick={onGoToLobby}
              className="chamfer-btn bg-amber-500 hover:bg-amber-400 px-3.5 py-2 text-xs font-display font-bold uppercase tracking-wider text-slate-950 cursor-pointer"
            >
              {t.trainingGoLobby}
            </button>
          </div>
        )}

        {/* Two-Column Drill Layout */}
        <div className="grid gap-5 md:grid-cols-[260px_1fr]">
          {/* Left Step Index */}
          <nav aria-label={t.trainingTitle} className="flex flex-col gap-2">
            {TRAINING_STEP_ORDER.map(stepId => {
              const stepDone = progress.completedSteps.includes(stepId);
              const active = selectedStep === stepId;
              const copy = t.trainingSteps[stepId];
              return (
                <button
                  key={stepId}
                  type="button"
                  data-training-step={stepId}
                  onClick={() => setSelectedStep(stepId)}
                  className={`chamfer-sm text-left px-3.5 py-2.5 border transition-colors cursor-pointer ${
                    active
                      ? 'bg-[#122232] border-cyan-400 text-white'
                      : stepDone
                        ? 'bg-[#0E1A1C] border-emerald-500/30 text-slate-200 hover:border-emerald-400/50'
                        : 'bg-[#101723] border-white/10 text-slate-300 hover:border-white/25'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2 text-[11px] font-mono-tabular">
                    <span className={active ? 'text-cyan-300' : 'text-slate-400'}>{keyHintForStep(stepId)}</span>
                    {stepDone && (
                      <span className="inline-flex items-center gap-1 text-emerald-400">
                        <CheckCircle2 className="w-3.5 h-3.5" />
                        {t.trainingStepDone}
                      </span>
                    )}
                  </div>
                  <div className="font-display font-bold text-sm mt-0.5 leading-snug">{copy.title}</div>
                </button>
              );
            })}
          </nav>

          {/* Right Active Interactive Drill Console */}
          <section className="chamfer-sm border border-white/10 bg-[#101723] p-5 flex flex-col justify-between gap-4">
            <div>
              <div className="flex items-center justify-between gap-2 text-xs font-mono-tabular uppercase tracking-wider text-cyan-300 mb-2">
                <span>{keyHintForStep(selectedStep)}</span>
                <span>
                  {progress.completedSteps.includes(selectedStep)
                    ? t.trainingStepDone
                    : t.trainingStepCurrent}
                </span>
              </div>
              <h3 className="font-display font-bold text-xl text-white">{stepCopy.title}</h3>
              <p className="text-sm text-slate-300 mt-2 leading-relaxed">{stepCopy.desc}</p>
              <p className="text-xs font-mono-tabular text-amber-300 mt-3">{stepCopy.action}</p>

              {/* Step-Specific Interactive Control */}
              <div className="mt-5 chamfer-sm border border-white/10 bg-[#0A101A] p-4">
                {selectedStep === 'drive_dash' && (
                  <div className="space-y-3">
                    <div className="flex items-center gap-2 text-xs font-mono-tabular text-slate-300">
                      <Compass className="w-4 h-4 text-cyan-400" />
                      <span>
                        WASD: {movedKeys.length > 0 ? movedKeys.map(k => k.replace('Key', '')).join(' · ') : '—'}
                      </span>
                    </div>
                    <button
                      type="button"
                      data-testid="training-action-drive_dash"
                      onClick={() => completeStep('drive_dash')}
                      className="chamfer-btn inline-flex items-center gap-2 bg-cyan-500 hover:bg-cyan-400 px-4 py-2.5 text-xs font-display font-bold uppercase tracking-wider text-slate-950 cursor-pointer"
                    >
                      <Zap className="w-4 h-4" />
                      {t.trainingSteps.drive_dash.btn.replace('[Shift]', `[${dashKeyLabel}]`)}
                    </button>
                  </div>
                )}

                {selectedStep === 'fire_vent' && (
                  <div className="space-y-3">
                    <div className="flex items-center justify-between text-xs font-mono-tabular">
                      <span className="inline-flex items-center gap-1.5 text-slate-300">
                        <Flame className="w-4 h-4 text-amber-400" />
                        {t.heatLabel}: {heatPct}%
                      </span>
                      <span className="text-cyan-300">{shotsFired} / 3</span>
                    </div>
                    <div className="h-2 w-full bg-slate-800 overflow-hidden">
                      <div
                        className={`h-full origin-left transition-transform duration-200 ${
                          heatPct >= 75 ? 'bg-amber-400' : 'bg-cyan-400'
                        }`}
                        style={{ transform: `scaleX(${Math.min(1, heatPct / 100)})` }}
                      />
                    </div>
                    <div className="flex flex-wrap gap-2.5">
                      <button
                        type="button"
                        data-testid="training-action-fire"
                        onClick={handleFireTest}
                        className="chamfer-sm inline-flex items-center gap-1.5 border border-cyan-400/40 bg-cyan-500/15 hover:bg-cyan-500/25 px-3.5 py-2 text-xs font-mono-tabular font-semibold text-cyan-200 cursor-pointer"
                      >
                        <Crosshair className="w-3.5 h-3.5" />
                        {t.trainingSteps.fire_vent.fireBtn}
                      </button>
                      <button
                        type="button"
                        data-testid="training-action-vent"
                        disabled={shotsFired < 3}
                        onClick={handleVentHeat}
                        className="chamfer-btn inline-flex items-center gap-1.5 bg-amber-500 hover:bg-amber-400 disabled:opacity-45 px-3.5 py-2 text-xs font-display font-bold uppercase tracking-wider text-slate-950 cursor-pointer"
                      >
                        {t.trainingSteps.fire_vent.ventBtn.replace('[R]', `[${reloadKeyLabel}]`)}
                      </button>
                    </div>
                  </div>
                )}

                {selectedStep === 'switch_chassis' && (
                  <div className="space-y-3">
                    <div className="text-xs font-mono-tabular text-slate-300">
                      {t.deployChassisUnit}:{' '}
                      <strong className="text-cyan-300">{ROBOT_CLASS_I18N[lang][activeRobotClass].name}</strong>
                    </div>
                    <button
                      type="button"
                      data-testid="training-action-switch_chassis"
                      onClick={handleSwapChassis}
                      className="chamfer-btn inline-flex items-center gap-2 bg-cyan-500 hover:bg-cyan-400 px-4 py-2.5 text-xs font-display font-bold uppercase tracking-wider text-slate-950 cursor-pointer"
                    >
                      <RefreshCw className="w-4 h-4" />
                      {t.trainingSteps.switch_chassis.btn}
                    </button>
                  </div>
                )}

                {selectedStep === 'mine_repair' && (
                  <div className="space-y-3">
                    <div className="flex flex-wrap items-center gap-4 text-xs font-mono-tabular">
                      <span className="text-emerald-300">
                        {t.contribOreMined}: +{oreExtracted}
                      </span>
                      <span className="text-cyan-300">
                        {t.contribAllyRepair}: +{allyRepaired}
                      </span>
                    </div>
                    <button
                      type="button"
                      data-testid="training-action-mine_repair"
                      onClick={handleMineAndRepair}
                      className="chamfer-btn inline-flex items-center gap-2 bg-emerald-500 hover:bg-emerald-400 px-4 py-2.5 text-xs font-display font-bold uppercase tracking-wider text-slate-950 cursor-pointer"
                    >
                      <Pickaxe className="w-4 h-4" />
                      {t.trainingSteps.mine_repair.btn.replace('[E]', `[${classSkillKeyLabel}]`)}
                    </button>
                  </div>
                )}

                {selectedStep === 'team_resupply' && (
                  <div className="space-y-3">
                    <div className="flex flex-wrap items-center gap-4 text-xs font-mono-tabular">
                      <span className="inline-flex items-center gap-1 text-amber-300">
                        <Coins className="w-3.5 h-3.5" />
                        {simCredits} {t.creditsSuffix}
                      </span>
                      <span className="text-cyan-300">S1 Ammo: {simAmmo} / 30</span>
                    </div>
                    <button
                      type="button"
                      data-testid="training-action-team_resupply"
                      onClick={handleResupply}
                      className="chamfer-btn inline-flex items-center gap-2 bg-amber-500 hover:bg-amber-400 px-4 py-2.5 text-xs font-display font-bold uppercase tracking-wider text-slate-950 cursor-pointer"
                    >
                      {t.trainingSteps.team_resupply.btn(FULL_MAG_COST, `${buyAmmoKeyLabel} / 2`)}
                    </button>
                  </div>
                )}

                {selectedStep === 'tactical_ping' && (
                  <div className="space-y-3">
                    <div className="flex items-center justify-between gap-2 text-xs font-mono-tabular text-slate-300">
                      <span className="inline-flex items-center gap-2">
                        <Radio className="w-4 h-4 text-cyan-400" />
                        <span>{t.trainingSteps.tactical_ping.radarHint}</span>
                      </span>
                      {pingWheelOpen && (
                        <span className="text-amber-300 font-semibold">[G] ↑→↓←</span>
                      )}
                    </div>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                      {PING_ORDER.map(kind => {
                        const meta = TACTICAL_PINGS[kind];
                        const active = pingSpot?.kind === kind;
                        return (
                          <button
                            key={kind}
                            type="button"
                            data-testid={`training-ping-${kind}`}
                            onClick={() => triggerPing(kind)}
                            className={`chamfer-sm flex items-center justify-between px-2.5 py-2 border text-xs font-mono-tabular cursor-pointer transition-colors ${
                              active
                                ? 'bg-[#122636] border-cyan-400 text-white'
                                : 'bg-[#0D1623] border-white/10 text-slate-300 hover:border-white/30'
                            }`}
                          >
                            <span className="inline-flex items-center gap-1.5">
                              <span style={{ color: meta.color }}>{meta.symbol}</span>
                              <span>{meta[lang]}</span>
                            </span>
                            <span className="text-slate-400">{meta.arrow}</span>
                          </button>
                        );
                      })}
                    </div>
                    <svg
                      viewBox="0 0 240 120"
                      role="button"
                      tabIndex={0}
                      data-testid="training-action-tactical_ping"
                      aria-label={t.trainingSteps.tactical_ping.radarHint}
                      onClick={handleRadarClick}
                      onKeyDown={ev => {
                        if (ev.key === 'Enter' || ev.key === ' ') {
                          ev.preventDefault();
                          triggerPing('rally', 120, 60);
                        }
                      }}
                      className="w-full max-w-sm h-28 rounded border border-cyan-400/35 bg-[#071019] cursor-crosshair"
                    >
                      <line x1="120" y1="0" x2="120" y2="120" stroke="#1E293B" strokeDasharray="3 3" />
                      <line x1="0" y1="60" x2="240" y2="60" stroke="#1E293B" strokeDasharray="3 3" />
                      <circle cx="120" cy="60" r="18" fill="none" stroke="#F59E0B" strokeOpacity="0.55" />
                      <rect x="34" y="24" width="12" height="12" fill="#10B981" fillOpacity="0.6" />
                      <rect x="194" y="84" width="12" height="12" fill="#10B981" fillOpacity="0.6" />
                      {pingSpot && (
                        <g>
                          <circle
                            cx={pingSpot.x}
                            cy={pingSpot.y}
                            r="10"
                            fill="none"
                            stroke={TACTICAL_PINGS[pingSpot.kind].color}
                            strokeWidth="2"
                          />
                          <circle
                            cx={pingSpot.x}
                            cy={pingSpot.y}
                            r="3.5"
                            fill={TACTICAL_PINGS[pingSpot.kind].color}
                          />
                        </g>
                      )}
                    </svg>
                  </div>
                )}
              </div>
            </div>

            {/* Footer Controls */}
            <div className="flex flex-wrap items-center justify-between gap-2 pt-3 border-t border-white/10">
              <button
                type="button"
                onClick={handleReset}
                className="inline-flex items-center gap-1.5 text-xs font-mono-tabular text-slate-400 hover:text-slate-200 cursor-pointer"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                {t.trainingReset}
              </button>
              <button
                type="button"
                onClick={onGoToLobby}
                className="chamfer-sm border border-amber-400/40 bg-[#1B1F14] hover:bg-[#262B1A] px-3.5 py-2 text-xs font-display font-bold uppercase tracking-wider text-amber-300 cursor-pointer"
              >
                {t.trainingGoLobby}
              </button>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
};

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Award, CheckCircle2, Clock, Coins, Crosshair, Flame, HeartHandshake, Pickaxe, Shield, Target, Trophy, X } from 'lucide-react';
import { soundEngine } from '../audio/soundEngine';
import { useI18n } from '../i18n/LanguageContext';
import { formatDailyMissionCopy } from '../i18n/translations';
import { postJson, requestJson } from '../net/account';
import {
  computeServerResetDeadline,
  DAILY_MISSION_ALL_CLEAR_BONUS,
  msUntilNextUtcDay,
  normalizeDailyMissions,
  shouldRefreshDailyMissions,
} from '../shared/dailyMissions';
import type {
  DailyMissionEligibilityPolicy,
  DailyMissionObjectiveKind,
  DailyMissionsState,
  PlayerProfile,
} from '../shared/types';

interface DailyMissionsModalProps {
  profile: PlayerProfile;
  onProfileUpdated: (next: PlayerProfile) => void;
  onClose: () => void;
}

interface MissionsApiResponse {
  dailyMissions: DailyMissionsState;
  credits: number;
  nextResetMs: number;
  serverTimeMs?: number;
  eligibilityPolicy?: DailyMissionEligibilityPolicy;
}

interface ClaimApiResponse {
  ok: true;
  profile: PlayerProfile;
  creditsAwarded: number;
}

function formatCountdown(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function MissionIcon({ kind, className }: { kind: DailyMissionObjectiveKind; className?: string }) {
  switch (kind) {
    case 'kills_with_robot':
      return <Crosshair className={className} />;
    case 'mine_ore_with_robot':
      return <Pickaxe className={className} />;
    case 'win_matches':
      return <Trophy className={className} />;
    case 'play_matches':
      return <Target className={className} />;
    case 'deal_damage':
      return <Flame className={className} />;
    case 'destroy_barriers':
      return <Shield className={className} />;
    case 'ally_repair':
      return <HeartHandshake className={className} />;
  }
}

export const DailyMissionsModal: React.FC<DailyMissionsModalProps> = ({
  profile,
  onProfileUpdated,
  onClose,
}) => {
  const { lang, t } = useI18n();
  const [missionsState, setMissionsState] = useState<DailyMissionsState>(() =>
    normalizeDailyMissions(profile.dailyMissions, profile.id),
  );
  const [credits, setCredits] = useState<number>(profile.stats.credits);
  const [policy, setPolicy] = useState<DailyMissionEligibilityPolicy | null>(null);
  const [refreshingRollover, setRefreshingRollover] = useState(false);
  const resetDeadlineRef = useRef<number>(computeServerResetDeadline(msUntilNextUtcDay(), Date.now()));
  const fetchingRef = useRef(false);
  const profileRef = useRef(profile);
  const [remainingMs, setRemainingMs] = useState<number>(() => msUntilNextUtcDay());
  const [claimingId, setClaimingId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);

  useEffect(() => {
    profileRef.current = profile;
    setMissionsState(normalizeDailyMissions(profile.dailyMissions, profile.id));
    setCredits(profile.stats.credits);
  }, [profile]);

  const fetchServerMissions = useCallback(async (isRollover = false) => {
    if (fetchingRef.current) return;
    fetchingRef.current = true;
    if (isRollover) setRefreshingRollover(true);
    try {
      const data = await requestJson<MissionsApiResponse>('/api/missions');
      const now = Date.now();
      const deadline = computeServerResetDeadline(data.nextResetMs, now);
      resetDeadlineRef.current = deadline;
      setMissionsState(data.dailyMissions);
      setCredits(data.credits);
      setRemainingMs(Math.max(0, deadline - now));
      if (data.eligibilityPolicy) setPolicy(data.eligibilityPolicy);
      if (
        profileRef.current.dailyMissions?.dayKey !== data.dailyMissions.dayKey ||
        profileRef.current.stats.credits !== data.credits
      ) {
        onProfileUpdated({
          ...profileRef.current,
          dailyMissions: data.dailyMissions,
          stats: { ...profileRef.current.stats, credits: data.credits },
        });
      }
    } catch {
      // Keep normalized local profile state if momentarily offline.
    } finally {
      fetchingRef.current = false;
      if (isRollover) setRefreshingRollover(false);
    }
  }, [onProfileUpdated]);

  useEffect(() => {
    void fetchServerMissions(false);
  }, [fetchServerMissions]);

  useEffect(() => {
    const tick = () => {
      const now = Date.now();
      const left = Math.max(0, resetDeadlineRef.current - now);
      setRemainingMs(left);
      if (shouldRefreshDailyMissions(resetDeadlineRef.current, now)) {
        // Delay next auto-retry slightly in case the request fails transiently.
        resetDeadlineRef.current = now + 5_000;
        void fetchServerMissions(true);
      }
    };
    const timer = window.setInterval(tick, 1000);
    const onFocusOrVisible = () => {
      if (document.visibilityState === 'hidden') return;
      if (shouldRefreshDailyMissions(resetDeadlineRef.current, Date.now())) {
        void fetchServerMissions(true);
      }
    };
    window.addEventListener('focus', onFocusOrVisible);
    document.addEventListener('visibilitychange', onFocusOrVisible);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocusOrVisible);
      document.removeEventListener('visibilitychange', onFocusOrVisible);
    };
  }, [fetchServerMissions]);

  const completedCount = missionsState.missions.filter(m => m.progress >= m.target).length;
  const totalCount = missionsState.missions.length;
  const allCompleted = totalCount > 0 && completedCount === totalCount;
  const bonusClaimed = missionsState.allClearClaimedAt !== undefined;

  const handleClaimMission = async (missionId: string) => {
    if (claimingId) return;
    setClaimingId(missionId);
    setFeedback(null);
    try {
      const res = await postJson<ClaimApiResponse>('/api/missions/claim', { missionId });
      setMissionsState(normalizeDailyMissions(res.profile.dailyMissions, res.profile.id));
      setCredits(res.profile.stats.credits);
      onProfileUpdated(res.profile);
      soundEngine.playHitmarker(true);
      setFeedback({ kind: 'success', text: t.missionsRewardReceived(res.creditsAwarded) });
    } catch (err) {
      setFeedback({
        kind: 'error',
        text: err instanceof Error && err.message ? err.message : t.missionsInProgress,
      });
    } finally {
      setClaimingId(null);
    }
  };

  const handleClaimBonus = async () => {
    if (claimingId) return;
    setClaimingId('__all_clear__');
    setFeedback(null);
    try {
      const res = await postJson<ClaimApiResponse>('/api/missions/claim-bonus', {});
      setMissionsState(normalizeDailyMissions(res.profile.dailyMissions, res.profile.id));
      setCredits(res.profile.stats.credits);
      onProfileUpdated(res.profile);
      soundEngine.playMatchEnd(true);
      setFeedback({ kind: 'success', text: t.missionsRewardReceived(res.creditsAwarded) });
    } catch (err) {
      setFeedback({
        kind: 'error',
        text: err instanceof Error && err.message ? err.message : t.missionsInProgress,
      });
    } finally {
      setClaimingId(null);
    }
  };

  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/80 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="daily-missions-title"
        className="chamfer-panel w-full max-w-3xl max-h-[88vh] overflow-y-auto bg-[#0C121C] border border-cyan-500/25 p-6 shadow-2xl"
      >
        {/* Header */}
        <div className="flex items-start justify-between gap-4 pb-4 border-b border-white/10 mb-5">
          <div className="flex items-start gap-3">
            <Target className="w-6 h-6 text-amber-400 mt-0.5 shrink-0" />
            <div>
              <h2
                id="daily-missions-title"
                className="font-display font-bold text-2xl text-white uppercase tracking-wide"
              >
                {t.missionsTitle}
              </h2>
              <p className="text-xs text-slate-400 mt-0.5">{t.missionsSubtitle}</p>
              <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1 mt-2 text-xs font-mono-tabular text-slate-300">
                <span className="inline-flex items-center gap-1 text-cyan-300">
                  <Clock className="w-3.5 h-3.5" />
                  {refreshingRollover ? t.missionsRefreshing : t.missionsResetIn(formatCountdown(remainingMs))}
                </span>
                <span aria-hidden="true" className="text-slate-600">·</span>
                <span className="text-slate-400">{missionsState.dayKey}</span>
                <span aria-hidden="true" className="text-slate-600">·</span>
                <span className="inline-flex items-center gap-1 text-amber-400 font-semibold">
                  <Coins className="w-3.5 h-3.5" />
                  {t.missionsBalanceLabel}: {credits} {t.creditsSuffix}
                </span>
              </div>
              {policy && (
                <p data-testid="mission-eligibility-policy" className="mt-1.5 text-[11px] font-mono-tabular text-slate-400">
                  {policy.publicOnly
                    ? t.missionsPolicyPublicOnly(policy.minMatchSec)
                    : t.missionsPolicyDemo(policy.minMatchSec)}
                </p>
              )}
            </div>
          </div>

          <button
            type="button"
            aria-label={t.missionsClose}
            onClick={onClose}
            className="chamfer-sm p-2 bg-[#162030] hover:bg-[#1F2E44] text-slate-300 cursor-pointer shrink-0"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Status Feedback */}
        {feedback && (
          <div
            role="status"
            className={`chamfer-sm mb-4 px-3.5 py-2.5 text-sm font-mono-tabular border ${
              feedback.kind === 'success'
                ? 'bg-emerald-950/50 border-emerald-500/40 text-emerald-300'
                : 'bg-red-950/50 border-red-500/40 text-red-200'
            }`}
          >
            {feedback.text}
          </div>
        )}

        {/* Daily Missions List */}
        <div className="flex flex-col gap-3 mb-5">
          {missionsState.missions.map(mission => {
            const copy = formatDailyMissionCopy(mission.kind, mission.target, mission.robotClass, lang);
            const completed = mission.progress >= mission.target;
            const claimed = mission.claimedAt !== undefined;
            const pct = Math.min(100, Math.round((mission.progress / Math.max(1, mission.target)) * 100));
            const isClaiming = claimingId === mission.id;

            return (
              <div
                key={mission.id}
                data-mission-id={mission.templateId}
                className={`chamfer-sm p-4 border transition-colors ${
                  claimed
                    ? 'bg-[#0F1B1D] border-emerald-500/30'
                    : completed
                      ? 'bg-[#171A12] border-amber-400/50'
                      : 'bg-[#121A28] border-white/10'
                }`}
              >
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
                  <div className="flex items-start gap-3.5 min-w-0 flex-1">
                    <div
                      className={`chamfer-sm p-2.5 border shrink-0 ${
                        claimed
                          ? 'bg-emerald-950/60 border-emerald-500/30 text-emerald-400'
                          : completed
                            ? 'bg-amber-950/60 border-amber-400/40 text-amber-400'
                            : 'bg-[#0C121C] border-white/10 text-cyan-400'
                      }`}
                    >
                      <MissionIcon kind={mission.kind} className="w-5 h-5" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-x-2 text-[11px] font-mono-tabular uppercase tracking-wider text-slate-400">
                        <span className="text-cyan-300">{copy.category}</span>
                        <span aria-hidden="true" className="text-slate-600">·</span>
                        <span className="text-amber-400 font-semibold">
                          +{mission.rewardCredits} {t.creditsSuffix}
                        </span>
                      </div>
                      <h3 className="font-display font-bold text-base text-white mt-0.5 leading-snug">
                        {copy.title}
                      </h3>
                      <p className="text-xs text-slate-400 mt-0.5 leading-relaxed">{copy.subtitle}</p>

                      {/* Progress Bar */}
                      <div className="mt-3">
                        <div className="flex items-center justify-between text-xs font-mono-tabular mb-1">
                          <span className={completed ? 'text-emerald-400 font-semibold' : 'text-slate-300'}>
                            {mission.progress} / {mission.target}
                          </span>
                          <span className="text-slate-400">{pct}%</span>
                        </div>
                        <div className="h-2 w-full bg-slate-800/90 overflow-hidden">
                          <div
                            className={`h-full origin-left transition-transform duration-300 ${
                              claimed
                                ? 'bg-emerald-500'
                                : completed
                                  ? 'bg-amber-400'
                                  : 'bg-cyan-400'
                            }`}
                            style={{ transform: `scaleX(${Math.min(1, mission.progress / Math.max(1, mission.target))})` }}
                          />
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Right Action Column */}
                  <div className="sm:w-40 shrink-0 flex sm:justify-end">
                    {claimed ? (
                      <div className="inline-flex items-center gap-1.5 text-xs font-mono-tabular uppercase tracking-wider text-emerald-400 font-semibold py-2 px-3">
                        <CheckCircle2 className="w-4 h-4" />
                        <span>{t.missionsClaimed}</span>
                      </div>
                    ) : completed ? (
                      <button
                        type="button"
                        disabled={Boolean(claimingId)}
                        onClick={() => void handleClaimMission(mission.id)}
                        className="chamfer-btn w-full sm:w-auto px-4 py-2.5 bg-amber-500 hover:bg-amber-400 disabled:opacity-60 text-slate-950 font-display font-bold text-xs uppercase tracking-wider transition-colors cursor-pointer whitespace-nowrap"
                      >
                        {isClaiming ? t.missionsClaiming : t.missionsClaimBtn(mission.rewardCredits)}
                      </button>
                    ) : (
                      <span className="text-xs font-mono-tabular uppercase tracking-wider text-slate-400 py-2 px-2">
                        {t.missionsInProgress}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* All-Clear Bonus Footer Card */}
        <div
          className={`chamfer-sm p-4 border flex flex-col sm:flex-row sm:items-center justify-between gap-4 ${
            bonusClaimed
              ? 'bg-[#0F1B1D] border-emerald-500/30'
              : allCompleted
                ? 'bg-[#171A12] border-amber-400/50'
                : 'bg-[#101724] border-white/10'
          }`}
        >
          <div className="flex items-start gap-3">
            <Award
              className={`w-6 h-6 mt-0.5 shrink-0 ${
                bonusClaimed ? 'text-emerald-400' : allCompleted ? 'text-amber-400' : 'text-slate-400'
              }`}
            />
            <div>
              <div className="flex items-center gap-2">
                <h3 className="font-display font-bold text-base text-white uppercase tracking-wide">
                  {t.missionsAllClearTitle}
                </h3>
                <span className="text-xs font-mono-tabular text-amber-400 font-semibold">
                  +{DAILY_MISSION_ALL_CLEAR_BONUS} {t.creditsSuffix}
                </span>
              </div>
              <p className="text-xs text-slate-400 mt-0.5">
                {t.missionsAllClearDesc(completedCount, totalCount)}
              </p>
            </div>
          </div>

          <div className="shrink-0">
            {bonusClaimed ? (
              <div className="inline-flex items-center gap-1.5 text-xs font-mono-tabular uppercase tracking-wider text-emerald-400 font-semibold py-2 px-3">
                <CheckCircle2 className="w-4 h-4" />
                <span>{t.missionsClaimed}</span>
              </div>
            ) : allCompleted ? (
              <button
                type="button"
                disabled={Boolean(claimingId)}
                onClick={() => void handleClaimBonus()}
                className="chamfer-btn w-full sm:w-auto px-4 py-2.5 bg-amber-500 hover:bg-amber-400 disabled:opacity-60 text-slate-950 font-display font-bold text-xs uppercase tracking-wider transition-colors cursor-pointer whitespace-nowrap"
              >
                {claimingId === '__all_clear__'
                  ? t.missionsClaiming
                  : t.missionsClaimBonusBtn(DAILY_MISSION_ALL_CLEAR_BONUS)}
              </button>
            ) : (
              <span className="text-xs font-mono-tabular text-slate-400">
                {completedCount} / {totalCount}
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

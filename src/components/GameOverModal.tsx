import { HeartHandshake, Pickaxe, RotateCcw, Shield, Target, Trophy } from 'lucide-react';
import { useI18n } from '../i18n/LanguageContext';
import { MULTIPLAYER_TEXT } from '../i18n/multiplayer';
import { formatDailyMissionCopy, translateDynamicLabel, translateTeamName, translateXpRank } from '../i18n/translations';
import type { MatchSummaryPayload } from '../net/clientSocket';
import { getXpRank } from '../shared/catalog';

interface GameOverModalProps {
  summary: MatchSummaryPayload;
  isPrivate: boolean;
  onPlayAgain?: () => void;
  onOpenMissions?: () => void;
  onReturnToTitle: () => void;
}

export function GameOverModal({ summary, isPrivate, onPlayAgain, onOpenMissions, onReturnToTitle }: GameOverModalProps) {
  const { lang, t } = useI18n();
  const copy = MULTIPLAYER_TEXT[lang];
  const cancelled = summary.cancelled || summary.result === 'cancelled';
  const rank = getXpRank(summary.newXp ?? 0);
  const title = cancelled ? copy.cancelled : summary.result === 'draw' ? copy.draw : summary.won ? t.victorySecured : t.matchComplete;
  const missionUpdates = summary.missionUpdates ?? [];
  const oreMined = Math.round(summary.oreMined ?? 0);
  const allyRepair = Math.round(summary.allyRepair ?? 0);
  const coreControlSec = Math.round(summary.coreControlSec ?? 0);
  const barriersDestroyed = Math.round(summary.barriersDestroyed ?? 0);
  const showContribution = !cancelled && (
    oreMined > 0 || allyRepair > 0 || coreControlSec > 0 || barriersDestroyed > 0 || summary.robotClass === 'ep_miner'
  );
  const engineerHighlight = oreMined > 0 || allyRepair > 0;
  const ineligibleMessage = (() => {
    if (cancelled || summary.missionEligible !== false) return null;
    switch (summary.missionIneligibleReason) {
      case 'private_room_ineligible':
        return t.missionsIneligiblePrivate;
      case 'match_too_short':
        return t.missionsIneligibleShort;
      case 'inactive_participant':
        return t.missionsIneligibleInactive;
      case 'forfeited':
        return t.missionsIneligibleForfeit;
      default:
        return null;
    }
  })();

  return <div className="fixed inset-0 z-30 grid place-items-center bg-black/80 p-4">
    <section role="dialog" aria-modal="true" aria-labelledby="result-title" className="chamfer-panel w-full max-w-md max-h-[90vh] overflow-y-auto border border-cyan-500/25 bg-[#0C121C] p-6 shadow-2xl">
      <div className="mb-4 flex items-center gap-3">
        <Trophy className={summary.won ? 'h-6 w-6 text-amber-400' : 'h-6 w-6 text-cyan-400'} />
        <div>
          <h2 id="result-title" className="font-display text-2xl font-bold text-white">{title}</h2>
          {!cancelled && <p className="text-xs text-slate-400">
            {summary.mode === 'ffa' ? t.rankPlacement(summary.placement ?? 1, translateDynamicLabel(summary.winnerName || 'Top Operative', lang))
              : translateTeamName('cobalt', lang) + ' ' + summary.scoreCobalt + ' · ' + translateTeamName('amber', lang) + ' ' + summary.scoreAmber}
          </p>}
        </div>
      </div>
      {!cancelled && <div className="mb-4 grid grid-cols-2 gap-2.5">
        <div className="chamfer-sm border border-white/10 bg-[#121A28] p-3"><p className="text-xs text-slate-400">{t.kdHeader}</p><p className="font-display text-xl font-bold font-mono-tabular text-white">{summary.kills} / {summary.deaths}</p></div>
        <div className="chamfer-sm border border-white/10 bg-[#121A28] p-3"><p className="text-xs text-slate-400">{t.accuracyHeader}</p><p className="font-display text-xl font-bold font-mono-tabular text-cyan-400">{summary.accuracy}%</p></div>
      </div>}
      {showContribution && (
        <div className="chamfer-sm mb-4 border border-emerald-400/25 bg-[#0E191B] p-3.5">
          <div className="mb-2 flex items-center gap-1.5 text-xs font-mono-tabular uppercase tracking-wider text-emerald-300">
            <Pickaxe className="h-3.5 w-3.5" />
            <span>{t.teamContributionTitle}</span>
          </div>
          <div className="grid grid-cols-2 gap-2 text-xs font-mono-tabular">
            <div className="flex items-center justify-between border border-white/10 bg-[#0B1218] px-2.5 py-1.5">
              <span className="text-slate-400">{t.contribOreMined}</span>
              <span className="font-bold text-emerald-300">{oreMined}</span>
            </div>
            <div className="flex items-center justify-between border border-white/10 bg-[#0B1218] px-2.5 py-1.5">
              <span className="text-slate-400 inline-flex items-center gap-1"><HeartHandshake className="h-3 w-3 text-cyan-300" />{t.contribAllyRepair}</span>
              <span className="font-bold text-cyan-300">{allyRepair}</span>
            </div>
            <div className="flex items-center justify-between border border-white/10 bg-[#0B1218] px-2.5 py-1.5">
              <span className="text-slate-400">{t.contribCoreControl}</span>
              <span className="font-bold text-amber-300">{coreControlSec}s</span>
            </div>
            <div className="flex items-center justify-between border border-white/10 bg-[#0B1218] px-2.5 py-1.5">
              <span className="text-slate-400 inline-flex items-center gap-1"><Shield className="h-3 w-3 text-slate-400" />{t.contribBarriers}</span>
              <span className="font-bold text-white">{barriersDestroyed}</span>
            </div>
          </div>
          {engineerHighlight && (
            <p className="mt-2 text-[11px] text-emerald-200/90 leading-snug">{t.contribEngineerSpotlight}</p>
          )}
        </div>
      )}
      {cancelled ? <p className="mb-4 text-sm text-slate-300">{copy.cancelledResult}</p> : isPrivate ? <p className="mb-4 text-sm text-slate-300">{copy.customResult}</p> : <div className="chamfer-sm mb-4 border border-white/10 bg-[#121A28] p-3.5">
        <div className="mb-1.5 flex justify-between gap-2 text-xs">
          <span className="text-slate-300">{t.rankLabel}: <strong style={{ color: rank.current.color }}>{translateXpRank(rank.current.name, lang)}</strong></span>
          <span className="text-amber-400">+{summary.xpEarned} XP</span>
        </div>
        <div className="h-2 w-full overflow-hidden bg-slate-800"><div className="h-full origin-left bg-amber-400" style={{ transform: 'scaleX(' + rank.progress + ')' }} /></div>
      </div>}
      {ineligibleMessage && (
        <p role="note" className="mb-4 rounded border border-white/10 bg-[#111926] px-3 py-2 text-xs text-slate-300 leading-relaxed">
          {ineligibleMessage}
        </p>
      )}
      {!cancelled && missionUpdates.length > 0 && (
        <div className="chamfer-sm mb-5 border border-amber-400/25 bg-[#121822] p-3.5">
          <div className="mb-2 flex items-center justify-between gap-2 text-xs font-mono-tabular uppercase tracking-wider text-amber-300">
            <span className="inline-flex items-center gap-1.5">
              <Target className="h-3.5 w-3.5" />
              {t.missionsProgressSummaryTitle}
            </span>
          </div>
          <div className="flex flex-col gap-2">
            {missionUpdates.map(u => {
              const info = formatDailyMissionCopy(u.kind, u.target, u.robotClass, lang);
              return (
                <div key={u.id} className="text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-slate-200 truncate">{info.title}</span>
                    <span className={`font-mono-tabular shrink-0 ${u.newlyCompleted ? 'text-emerald-400 font-semibold' : 'text-cyan-300'}`}>
                      {u.after}/{u.target} {u.newlyCompleted ? `· ${t.missionsCompletedTag}` : ''}
                    </span>
                  </div>
                  <div className="mt-1 h-1.5 w-full overflow-hidden bg-slate-800">
                    <div
                      className={`h-full origin-left ${u.newlyCompleted ? 'bg-emerald-400' : 'bg-cyan-400'}`}
                      style={{ transform: `scaleX(${Math.min(1, u.after / Math.max(1, u.target))})` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
      <div className="flex flex-wrap gap-2.5">
        {onPlayAgain && <button type="button" onClick={onPlayAgain} className="chamfer-btn flex flex-1 items-center justify-center gap-2 bg-amber-500 px-4 py-3 text-sm font-bold text-slate-950 hover:bg-amber-400 cursor-pointer"><RotateCcw className="h-4 w-4" />{copy.findMatch}</button>}
        {onOpenMissions && !cancelled && (
          <button type="button" onClick={onOpenMissions} className="chamfer-sm flex items-center justify-center gap-1.5 border border-amber-400/40 bg-[#181B12] px-3.5 py-3 text-sm text-amber-300 hover:bg-[#232719] cursor-pointer">
            <Target className="h-4 w-4" />
            {t.missionsOpenBtn}
          </button>
        )}
        <button type="button" onClick={onReturnToTitle} className="chamfer-sm border border-white/10 bg-[#151F2E] px-4 py-3 text-sm text-slate-200 hover:bg-[#1D2B40] cursor-pointer">{isPrivate && !cancelled ? copy.returnRoom : copy.lobby}</button>
      </div>
    </section>
  </div>;
}

import React from 'react';
import { RotateCcw, Trophy } from 'lucide-react';
import { useI18n } from '../i18n/LanguageContext';
import { translateDynamicLabel, translateTeamName, translateXpRank } from '../i18n/translations';
import type { MatchSummaryPayload } from '../net/clientSocket';
import { getXpRank } from '../shared/catalog';

interface GameOverModalProps {
  summary: MatchSummaryPayload;
  onPlayAgain: () => void;
  onReturnToTitle: () => void;
}

export const GameOverModal: React.FC<GameOverModalProps> = ({
  summary,
  onPlayAgain,
  onReturnToTitle,
}) => {
  const { lang, t } = useI18n();
  const rank = getXpRank(summary.newXp);

  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/82 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t.matchComplete}
        className="chamfer-panel w-full max-w-md bg-[#0C121C] border border-cyan-500/25 p-6 shadow-2xl"
      >
        <div className="flex items-center gap-3 mb-4">
          <div className={`chamfer-sm p-2.5 ${summary.won ? 'bg-amber-500/20 text-amber-400' : 'bg-cyan-500/20 text-cyan-400'}`}>
            <Trophy className="w-6 h-6" />
          </div>
          <div>
            <h2 className="font-display font-bold text-2xl text-white uppercase tracking-wide">
              {summary.won ? t.victorySecured : t.matchComplete}
            </h2>
            <p className="text-xs text-slate-400 font-mono-tabular">
              {summary.mode === 'ffa'
                ? t.rankPlacement(
                    summary.placement ?? 1,
                    translateDynamicLabel(summary.winnerName || 'Top Operative', lang),
                  )
                : `${translateTeamName('cobalt', lang)} ${summary.scoreCobalt} · ${translateTeamName('amber', lang)} ${summary.scoreAmber}`}
            </p>
          </div>
        </div>

        <div className="grid grid-cols-3 gap-2.5 mb-5">
          <div className="chamfer-sm p-3 bg-[#121A28] border border-white/10">
            <div className="text-[11px] uppercase text-slate-400">{t.kdHeader}</div>
            <div className="font-display font-bold text-xl text-white tabular-nums mt-0.5">
              {summary.kills} / {summary.deaths}
            </div>
          </div>
          <div className="chamfer-sm p-3 bg-[#121A28] border border-white/10">
            <div className="text-[11px] uppercase text-slate-400">{t.accuracyHeader}</div>
            <div className="font-display font-bold text-xl text-cyan-400 tabular-nums mt-0.5">
              {summary.accuracy}%
            </div>
          </div>
          <div className="chamfer-sm p-3 bg-[#121A28] border border-white/10">
            <div className="text-[11px] uppercase text-slate-400">{t.mmrDeltaHeader}</div>
            <div className={`font-display font-bold text-xl tabular-nums mt-0.5 ${summary.mmrDelta >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
              {summary.mmrDelta >= 0 ? `+${summary.mmrDelta}` : summary.mmrDelta}
            </div>
          </div>
        </div>

        <div className="chamfer-sm p-3.5 bg-[#121A28] border border-white/10 mb-5">
          <div className="flex items-center justify-between text-xs mb-1.5">
            <span className="text-slate-300 font-medium">
              {t.rankLabel}: <strong style={{ color: rank.current.color }}>{translateXpRank(rank.current.name, lang)}</strong>
            </span>
            <span className="font-mono-tabular text-amber-400">+{summary.xpEarned} XP</span>
          </div>
          <div className="h-2 w-full bg-slate-800 overflow-hidden">
            <div
              className="h-full bg-amber-400 transition-transform duration-300 origin-left"
              style={{ transform: `scaleX(${rank.progress})` }}
            />
          </div>
        </div>

        <div className="flex gap-3">
          <button
            type="button"
            data-start="true"
            onClick={onPlayAgain}
            className="chamfer-btn flex-1 flex items-center justify-center gap-2 px-4 py-3 bg-amber-500 hover:bg-amber-400 text-slate-950 font-display font-bold text-sm uppercase tracking-wider cursor-pointer"
          >
            <RotateCcw className="w-4 h-4" />
            <span>{t.playAgain}</span>
          </button>
          <button
            type="button"
            onClick={onReturnToTitle}
            className="chamfer-sm px-4 py-3 bg-[#151F2E] hover:bg-[#1D2B40] border border-white/10 text-slate-200 text-sm font-medium cursor-pointer"
          >
            {t.backTitle}
          </button>
        </div>
      </div>
    </div>
  );
};

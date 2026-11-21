import { RotateCcw, Trophy } from 'lucide-react';
import { useI18n } from '../i18n/LanguageContext';
import { MULTIPLAYER_TEXT } from '../i18n/multiplayer';
import { translateDynamicLabel, translateTeamName, translateXpRank } from '../i18n/translations';
import type { MatchSummaryPayload } from '../net/clientSocket';
import { getXpRank } from '../shared/catalog';

interface GameOverModalProps {
  summary: MatchSummaryPayload;
  isPrivate: boolean;
  onPlayAgain?: () => void;
  onReturnToTitle: () => void;
}

export function GameOverModal({ summary, isPrivate, onPlayAgain, onReturnToTitle }: GameOverModalProps) {
  const { lang, t } = useI18n();
  const copy = MULTIPLAYER_TEXT[lang];
  const cancelled = summary.cancelled || summary.result === 'cancelled';
  const rank = getXpRank(summary.newXp ?? 0);
  const title = cancelled ? copy.cancelled : summary.result === 'draw' ? copy.draw : summary.won ? t.victorySecured : t.matchComplete;

  return <div className="fixed inset-0 z-30 grid place-items-center bg-black/80 p-4">
    <section role="dialog" aria-modal="true" aria-labelledby="result-title" className="chamfer-panel w-full max-w-md border border-cyan-500/25 bg-[#0C121C] p-6 shadow-2xl">
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
        <div className="chamfer-sm border border-white/10 bg-[#121A28] p-3"><p className="text-xs text-slate-400">{t.kdHeader}</p><p className="font-display text-xl font-bold text-white">{summary.kills} / {summary.deaths}</p></div>
        <div className="chamfer-sm border border-white/10 bg-[#121A28] p-3"><p className="text-xs text-slate-400">{t.accuracyHeader}</p><p className="font-display text-xl font-bold text-cyan-400">{summary.accuracy}%</p></div>
      </div>}
      {cancelled ? <p className="mb-4 text-sm text-slate-300">{copy.cancelledResult}</p> : isPrivate ? <p className="mb-4 text-sm text-slate-300">{copy.customResult}</p> : <div className="chamfer-sm mb-5 border border-white/10 bg-[#121A28] p-3.5">
        <div className="mb-1.5 flex justify-between gap-2 text-xs">
          <span className="text-slate-300">{t.rankLabel}: <strong style={{ color: rank.current.color }}>{translateXpRank(rank.current.name, lang)}</strong></span>
          <span className="text-amber-400">+{summary.xpEarned} XP</span>
        </div>
        <div className="h-2 w-full overflow-hidden bg-slate-800"><div className="h-full origin-left bg-amber-400" style={{ transform: 'scaleX(' + rank.progress + ')' }} /></div>
      </div>}
      <div className="flex flex-wrap gap-3">
        {onPlayAgain && <button type="button" onClick={onPlayAgain} className="chamfer-btn flex flex-1 items-center justify-center gap-2 bg-amber-500 px-4 py-3 text-sm font-bold text-slate-950 hover:bg-amber-400"><RotateCcw className="h-4 w-4" />{copy.findMatch}</button>}
        <button type="button" onClick={onReturnToTitle} className="chamfer-sm border border-white/10 bg-[#151F2E] px-4 py-3 text-sm text-slate-200 hover:bg-[#1D2B40]">{isPrivate && !cancelled ? copy.returnRoom : copy.lobby}</button>
      </div>
    </section>
  </div>;
}

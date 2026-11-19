import React from 'react';
import { ShieldCheck, Trophy, X } from 'lucide-react';
import { useI18n } from '../i18n/LanguageContext';
import { MAP_I18N, MODE_I18N, translateSkillTier, WEAPON_I18N } from '../i18n/translations';
import { WEAPONS } from '../shared/catalog';
import { getSkillTier } from '../shared/matchmaking';
import type { AntiCheatAudit, PlayerProfile, WeaponId } from '../shared/types';

interface StatsModalProps {
  profile: PlayerProfile;
  antiCheat?: AntiCheatAudit;
  pingMs: number;
  onClose: () => void;
}

export const StatsModal: React.FC<StatsModalProps> = ({
  profile,
  antiCheat,
  pingMs,
  onClose,
}) => {
  const { lang, t } = useI18n();
  const { stats } = profile;
  const tier = getSkillTier(stats.mmr);
  const winRate = stats.matchesPlayed > 0 ? Math.round((stats.wins / stats.matchesPlayed) * 100) : 0;
  const kd = (stats.kills / Math.max(1, stats.deaths)).toFixed(2);
  const accuracy = stats.shotsFired > 0 ? Math.round((stats.shotsHit / stats.shotsFired) * 100) : 0;

  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/80 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t.statsTitle}
        className="chamfer-panel w-full max-w-4xl max-h-[88vh] overflow-y-auto bg-[#0C121C] border border-cyan-500/25 p-6 shadow-2xl"
      >
        <div className="flex items-center justify-between pb-4 border-b border-white/10 mb-5">
          <div className="flex items-center gap-3">
            <Trophy className="w-6 h-6 text-amber-400" />
            <div>
              <h2 className="font-display font-bold text-2xl text-white uppercase tracking-wide">{t.statsTitle}</h2>
              <p className="text-xs text-slate-400 font-mono-tabular">
                {profile.callsign} · <span style={{ color: tier.color }}>{translateSkillTier(tier.label, lang)}</span> ({stats.mmr} MMR)
              </p>
            </div>
          </div>
          <button
            type="button"
            aria-label={t.closeArmory}
            onClick={onClose}
            className="chamfer-sm p-2 bg-[#162030] hover:bg-[#1F2E44] text-slate-300 cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Top KPI Grid */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
          <div className="p-3.5 rounded-lg bg-[#141C2A] border border-white/10">
            <div className="text-[11px] uppercase text-slate-400">{t.winRate}</div>
            <div className="font-display font-bold text-2xl text-white tabular-nums mt-0.5">{winRate}%</div>
            <div className="text-[11px] font-mono-tabular text-slate-400">{t.winsLosses(stats.wins, stats.losses)}</div>
          </div>
          <div className="p-3.5 rounded-lg bg-[#141C2A] border border-white/10">
            <div className="text-[11px] uppercase text-slate-400">{t.kdRatio}</div>
            <div className="font-display font-bold text-2xl text-cyan-400 tabular-nums mt-0.5">{kd}</div>
            <div className="text-[11px] font-mono-tabular text-slate-400">{t.eliminations(stats.kills)}</div>
          </div>
          <div className="p-3.5 rounded-lg bg-[#141C2A] border border-white/10">
            <div className="text-[11px] uppercase text-slate-400">{t.laserAccuracy}</div>
            <div className="font-display font-bold text-2xl text-amber-400 tabular-nums mt-0.5">{accuracy}%</div>
            <div className="text-[11px] font-mono-tabular text-slate-400">{t.hitsRatio(stats.shotsHit, stats.shotsFired)}</div>
          </div>
          <div className="p-3.5 rounded-lg bg-[#141C2A] border border-white/10">
            <div className="text-[11px] uppercase text-slate-400">{t.destructionHazards}</div>
            <div className="font-display font-bold text-2xl text-emerald-400 tabular-nums mt-0.5">{stats.barriersDestroyed}</div>
            <div className="text-[11px] font-mono-tabular text-slate-400">{t.hazardAssists(stats.hazardKills)}</div>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-5 mb-5">
          {/* Weapon Mastery */}
          <div className="p-4 rounded-lg bg-[#141C2A] border border-white/10">
            <h3 className="text-sm font-semibold text-slate-200 mb-3">{t.emitterMastery}</h3>
            <div className="space-y-2.5">
              {(Object.keys(WEAPONS) as WeaponId[]).map((wid) => {
                const ws = stats.weaponStats?.[wid] ?? { kills: 0, shotsFired: 0, shotsHit: 0, damageDealt: 0 };
                const acc = ws.shotsFired > 0 ? Math.round((ws.shotsHit / ws.shotsFired) * 100) : 0;
                return (
                  <div key={wid} className="p-2.5 rounded bg-[#0C111A] border border-white/10 flex items-center justify-between text-xs">
                    <div>
                      <div className="font-semibold text-white">{WEAPON_I18N[lang][wid].name}</div>
                      <div className="text-[11px] font-mono-tabular text-slate-400">{t.totalDmg(ws.damageDealt)}</div>
                    </div>
                    <div className="text-right font-mono-tabular">
                      <div className="text-cyan-400 font-bold">{t.killsCount(ws.kills)}</div>
                      <div className="text-[11px] text-slate-400">{t.accShort(acc)}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Anti-Cheat & Server Integrity */}
          <div className="p-4 rounded-lg bg-[#141C2A] border border-white/10">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-slate-200 flex items-center gap-2">
                <ShieldCheck className="w-4 h-4 text-emerald-400" />
                <span>{t.serverAuthorityTitle}</span>
              </h3>
              <span className="text-xs font-mono-tabular text-emerald-400">
                {antiCheat?.integrityStatus === 'verified' ? t.antiCheatVerified : t.antiCheatActive}
              </span>
            </div>
            <div className="grid grid-cols-2 gap-2.5 text-xs font-mono-tabular">
              <div className="p-2.5 rounded bg-[#0C111A] border border-white/10">
                <div className="text-slate-400">{t.serverRtt}</div>
                <div className="text-white font-bold mt-0.5">{pingMs} ms (20Hz Tick)</div>
              </div>
              <div className="p-2.5 rounded bg-[#0C111A] border border-white/10">
                <div className="text-slate-400">{t.packetsAudited}</div>
                <div className="text-white font-bold mt-0.5">{antiCheat?.packetsValidated ?? 0}</div>
              </div>
              <div className="p-2.5 rounded bg-[#0C111A] border border-white/10">
                <div className="text-slate-400">{t.speedClamps}</div>
                <div className="text-cyan-400 font-bold mt-0.5">{antiCheat?.movementCorrections ?? 0}</div>
              </div>
              <div className="p-2.5 rounded bg-[#0C111A] border border-white/10">
                <div className="text-slate-400">{t.rateLosBlocks}</div>
                <div className="text-amber-400 font-bold mt-0.5">
                  {(antiCheat?.rateLimitBlocks ?? 0) + (antiCheat?.losRejections ?? 0)}
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Recent Match History */}
        <div className="p-4 rounded-lg bg-[#141C2A] border border-white/10">
          <h3 className="text-sm font-semibold text-slate-200 mb-3">{t.recentHistory}</h3>
          <div className="space-y-2">
            {stats.recentMatches.length === 0 ? (
              <div className="text-xs text-slate-400 py-3 text-center">{t.noMatchesYet}</div>
            ) : (
              stats.recentMatches.map((m) => (
                <div
                  key={m.id}
                  className="px-3 py-2 rounded bg-[#0C111A] border border-white/10 flex items-center justify-between text-xs font-mono-tabular"
                >
                  <div className="flex items-center gap-3">
                    <span className={m.won ? 'text-emerald-400 font-bold' : 'text-red-400 font-bold'}>
                      {m.won ? t.winBadge : t.lossBadge}
                    </span>
                    <span className="text-white">{MAP_I18N[lang][m.mapId]?.name ?? m.mapId}</span>
                    <span className="text-slate-400">
                      {MODE_I18N[lang][m.mode]?.short ?? m.mode}
                    </span>
                  </div>
                  <div className="flex items-center gap-4">
                    <span className="text-slate-200">{m.kills}K / {m.deaths}D</span>
                    <span className="text-cyan-400">{t.accShort(m.accuracy)}</span>
                    <span className={m.mmrDelta >= 0 ? 'text-emerald-400' : 'text-red-400'}>
                      {m.mmrDelta >= 0 ? `+${m.mmrDelta}` : m.mmrDelta} MMR
                    </span>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

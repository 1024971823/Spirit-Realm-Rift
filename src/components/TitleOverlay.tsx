import React from 'react';
import { Cpu, Crosshair, Pickaxe, Shield, Sliders, Trophy, Users } from 'lucide-react';
import { useI18n } from '../i18n/LanguageContext';
import { ROBOT_CLASS_I18N, translateSkillTier } from '../i18n/translations';
import { ROBOT_CLASSES } from '../shared/catalog';
import { getSkillTier } from '../shared/matchmaking';
import type { PlayerProfile, RobotClass } from '../shared/types';
import { LanguageSwitch } from './LanguageSwitch';

interface TitleOverlayProps {
  profile: PlayerProfile;
  connected: boolean;
  pingMs: number;
  onSelectRobotClass: (robotClass: RobotClass) => void;
  onStartMatch: () => void;
  onOpenLoadout: () => void;
  onOpenSocial: () => void;
  onOpenStats: () => void;
  onOpenSettings: () => void;
}

export const TitleOverlay: React.FC<TitleOverlayProps> = ({
  profile,
  connected,
  pingMs,
  onSelectRobotClass,
  onStartMatch,
  onOpenLoadout,
  onOpenSocial,
  onOpenStats,
  onOpenSettings,
}) => {
  const { lang, t } = useI18n();
  const tier = getSkillTier(profile.stats.mmr);
  const selectedClass: RobotClass =
    profile.loadout?.robotClass === 'ep_miner' ? 'ep_miner' : 's1_striker';

  return (
    <div className="fixed inset-0 z-20 flex flex-col justify-between p-6 md:p-10 pointer-events-none">
      {/* Directional gradient scrim preserving the right 65% for live 3D RoboMaster arena */}
      <div
        className="fixed inset-y-0 left-0 w-full md:w-[560px] pointer-events-none"
        style={{
          background:
            'linear-gradient(90deg, rgba(7,10,15,0.95) 0%, rgba(7,10,15,0.78) 62%, rgba(7,10,15,0) 100%)',
        }}
      />

      {/* Top row: Minimal Operative Telemetry & Language Switch */}
      <div className="relative z-10 flex items-center justify-between gap-4">
        <div className="flex items-center gap-3 text-xs text-slate-300 font-mono-tabular hud-text-stroke">
          <span className="font-bold text-white tracking-wide">{profile.callsign}</span>
          <span aria-hidden="true" className="text-slate-600">|</span>
          <span style={{ color: tier.color }}>
            {translateSkillTier(tier.label, lang)} · {profile.stats.mmr} MMR
          </span>
          <span aria-hidden="true" className="text-slate-600">|</span>
          <span className={connected ? 'text-emerald-400' : 'text-amber-400'}>
            {connected ? `${pingMs} ms` : t.linking}
          </span>
        </div>

        <LanguageSwitch />
      </div>

      {/* Main Left-Third Robotics League Lockup */}
      <div className="relative z-10 max-w-md my-auto pointer-events-auto">
        {/* Bespoke Robotics Crest & SVG Lockup */}
        <div className="mb-4">
          <svg
            viewBox="0 0 380 78"
            className="w-80 md:w-[360px] h-auto"
            aria-label={t.pageTitle}
            role="img"
          >
            <polygon
              points="24,6 44,24 44,54 24,72 4,54 4,24"
              fill="#0D1420"
              stroke="#06B6D4"
              strokeWidth="2.5"
            />
            <polygon points="24,18 35,39 24,60 13,39" fill="#F59E0B" />
            <line x1="44" y1="39" x2="62" y2="39" stroke="#06B6D4" strokeWidth="2.5" />
            <text
              x="72"
              y="37"
              fill="#F8FAFC"
              fontFamily="Chakra Petch, sans-serif"
              fontWeight="700"
              fontSize="30"
              letterSpacing="2.8"
            >
              PRISM BREACH
            </text>
            <text
              x="73"
              y="59"
              fill="#38BDF8"
              fontFamily="JetBrains Mono, monospace"
              fontWeight="600"
              fontSize="11.5"
              letterSpacing="1.6"
            >
              {t.titleSubtitle}
            </text>
          </svg>
        </div>

        <p className="text-sm text-slate-300 leading-relaxed mb-5 max-w-sm">
          {t.titleDesc}
        </p>

        {/* Active Chassis Unit Selector */}
        <div className="mb-4 max-w-md">
          <div className="text-[11px] font-mono-tabular uppercase tracking-wider text-slate-400 mb-2">
            {t.deployChassisUnit}
          </div>
          <div className="grid grid-cols-2 gap-2.5">
            {(['s1_striker', 'ep_miner'] as RobotClass[]).map((rc) => {
              const spec = ROBOT_CLASSES[rc];
              const rcText = ROBOT_CLASS_I18N[lang][rc];
              const active = selectedClass === rc;
              const isEp = rc === 'ep_miner';
              return (
                <button
                  key={rc}
                  type="button"
                  data-unit={rc}
                  onClick={() => onSelectRobotClass(rc)}
                  className={`chamfer-sm text-left p-3 border transition-colors cursor-pointer ${
                    active
                      ? isEp
                        ? 'bg-[#102422] border-emerald-400 text-white'
                        : 'bg-[#10202E] border-cyan-400 text-white'
                      : 'bg-[#0F1520] border-white/10 hover:border-white/25 text-slate-300'
                  }`}
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className="font-mono-tabular text-[11px] font-bold tracking-wider uppercase text-amber-400">
                      {spec.code}
                    </span>
                    {isEp ? (
                      <Pickaxe className={`w-4 h-4 ${active ? 'text-emerald-400' : 'text-slate-400'}`} />
                    ) : (
                      <Cpu className={`w-4 h-4 ${active ? 'text-cyan-400' : 'text-slate-400'}`} />
                    )}
                  </div>
                  <div className="font-display font-bold text-sm leading-tight">
                    {rcText.shortName}
                  </div>
                  <div className="text-[11px] text-slate-400 mt-1 font-mono-tabular">
                    {rcText.titleSub}
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Primary CTA + Tactical Sub-Menu */}
        <div className="flex flex-col gap-2.5 max-w-md">
          <button
            type="button"
            data-start="true"
            onClick={onStartMatch}
            className="chamfer-btn flex items-center justify-between px-5 py-3.5 bg-amber-500 hover:bg-amber-400 active:scale-[0.99] text-slate-950 font-display font-bold text-base tracking-wider uppercase transition-colors cursor-pointer whitespace-nowrap"
          >
            <span>{t.enterArena} · {ROBOT_CLASSES[selectedClass].code}</span>
            <Crosshair className="w-5 h-5" />
          </button>

          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={onOpenLoadout}
              className="chamfer-sm flex items-center gap-2.5 px-4 py-2.5 bg-[#121926] hover:bg-[#1A2436] border border-white/10 text-slate-100 text-sm font-medium transition-colors cursor-pointer whitespace-nowrap"
            >
              <Shield className="w-4 h-4 text-cyan-400 shrink-0" />
              <span>{t.armory}</span>
            </button>

            <button
              type="button"
              onClick={onOpenSocial}
              className="chamfer-sm flex items-center gap-2.5 px-4 py-2.5 bg-[#121926] hover:bg-[#1A2436] border border-white/10 text-slate-100 text-sm font-medium transition-colors cursor-pointer whitespace-nowrap"
            >
              <Users className="w-4 h-4 text-amber-400 shrink-0" />
              <span>{t.matchmakingVoice}</span>
            </button>

            <button
              type="button"
              onClick={onOpenStats}
              className="chamfer-sm flex items-center gap-2.5 px-4 py-2.5 bg-[#121926] hover:bg-[#1A2436] border border-white/10 text-slate-100 text-sm font-medium transition-colors cursor-pointer whitespace-nowrap"
            >
              <Trophy className="w-4 h-4 text-emerald-400 shrink-0" />
              <span>{t.careerTelemetry}</span>
            </button>

            <button
              type="button"
              onClick={onOpenSettings}
              className="chamfer-sm flex items-center gap-2.5 px-4 py-2.5 bg-[#121926] hover:bg-[#1A2436] border border-white/10 text-slate-100 text-sm font-medium transition-colors cursor-pointer whitespace-nowrap"
            >
              <Sliders className="w-4 h-4 text-slate-300 shrink-0" />
              <span>{t.controlsPad}</span>
            </button>
          </div>
        </div>
      </div>

      {/* Bottom flat control hint line */}
      <div className="relative z-10 flex items-center justify-between text-[11px] text-slate-400 font-mono-tabular hud-text-stroke">
        <span>{t.titleHints}</span>
      </div>
    </div>
  );
};

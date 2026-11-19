import React from 'react';
import { Check, Cpu, Lock, Pickaxe, Shield, X, Zap } from 'lucide-react';
import { useI18n } from '../i18n/LanguageContext';
import {
  GADGET_I18N,
  ROBOT_CLASS_I18N,
  translateCosmeticName,
  translateXpRank,
  WEAPON_I18N,
} from '../i18n/translations';
import { COSMETICS, GADGETS, getXpRank, ROBOT_CLASSES, WEAPONS } from '../shared/catalog';
import type { GadgetId, LoadoutConfig, PlayerProfile, RobotClass, WeaponId } from '../shared/types';

interface LoadoutModalProps {
  profile: PlayerProfile;
  onUpdateLoadout: (loadout: LoadoutConfig) => void;
  onClose: () => void;
}

export const LoadoutModal: React.FC<LoadoutModalProps> = ({
  profile,
  onUpdateLoadout,
  onClose,
}) => {
  const { lang, t } = useI18n();
  const xp = profile.stats.xp;
  const rank = getXpRank(xp);
  const { loadout } = profile;

  const beams = COSMETICS.filter((c) => c.category === 'beam');
  const skins = COSMETICS.filter((c) => c.category === 'skin');
  const emblems = COSMETICS.filter((c) => c.category === 'emblem');

  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/82 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t.armoryTitle}
        className="chamfer-panel w-full max-w-4xl max-h-[88vh] overflow-y-auto bg-[#0C121C] border border-cyan-500/25 p-6 shadow-2xl"
      >
        <div className="flex items-center justify-between pb-4 border-b border-white/10 mb-5">
          <div>
            <h2 className="font-display font-bold text-2xl text-white uppercase tracking-wide">
              {t.armoryTitle}
            </h2>
            <p className="text-xs text-slate-400 mt-0.5 font-mono-tabular">
              {t.rankLabel}: <span style={{ color: rank.current.color }}>{translateXpRank(rank.current.name, lang)}</span> · {xp} XP · {profile.stats.credits} {t.careerCreditsSuffix}
            </p>
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

        {/* Progression Track */}
        <div className="chamfer-sm p-4 bg-[#121A28] border border-white/10 mb-6">
          <div className="flex items-center justify-between text-xs mb-2">
            <span className="text-slate-200 font-medium">
              {t.currentTier}: <strong style={{ color: rank.current.color }}>{translateXpRank(rank.current.name, lang)}</strong>
            </span>
            <span className="font-mono-tabular text-slate-400">
              {rank.next ? t.nextTier(translateXpRank(rank.next.name, lang), rank.next.minXp) : t.maxTierReached}
            </span>
          </div>
          <div className="h-2 w-full bg-slate-800 overflow-hidden">
            <div
              className="h-full bg-amber-400 transition-transform duration-300 origin-left"
              style={{ transform: `scaleX(${rank.progress})` }}
            />
          </div>
        </div>

        {/* Robot Unit Selection (RM-S1 Striker vs RM-EP Engineer) */}
        <div className="mb-6">
          <h3 className="text-sm font-semibold text-slate-200 mb-3 flex items-center gap-2 uppercase tracking-wider font-display">
            <Cpu className="w-4 h-4 text-emerald-400" />
            <span>{t.chassisPlatformTitle}</span>
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {(['s1_striker', 'ep_miner'] as RobotClass[]).map((rc) => {
              const spec = ROBOT_CLASSES[rc];
              const rcText = ROBOT_CLASS_I18N[lang][rc];
              const selected = loadout.robotClass === rc;
              const isEp = rc === 'ep_miner';
              return (
                <button
                  key={rc}
                  type="button"
                  onClick={() => onUpdateLoadout({ ...loadout, robotClass: rc })}
                  className={`chamfer-sm text-left p-4 border transition-colors cursor-pointer ${
                    selected
                      ? isEp
                        ? 'bg-[#102622] border-emerald-400'
                        : 'bg-[#122234] border-cyan-400'
                      : 'bg-[#121A28] border-white/10 hover:border-white/25'
                  }`}
                >
                  <div className="flex items-center justify-between mb-1">
                    <div className="flex items-center gap-2">
                      {isEp ? (
                        <Pickaxe className="w-4 h-4 text-emerald-400" />
                      ) : (
                        <Cpu className="w-4 h-4 text-cyan-400" />
                      )}
                      <span className="font-display font-bold text-base text-white">
                        {spec.code} · {rcText.name}
                      </span>
                    </div>
                    {selected && <Check className="w-4 h-4 text-amber-400" />}
                  </div>
                  <div className="text-xs text-amber-300 mb-1.5 font-mono-tabular">{rcText.role}</div>
                  <p className="text-xs text-slate-300 mb-2 leading-relaxed">{rcText.summary}</p>
                  <div className="text-[11px] font-mono-tabular text-slate-400">
                    {t.hullLabel} {spec.maxHp} · {t.shieldStatLabel} {spec.maxShield} · {isEp ? `${t.unarmedTag} · ` : ''}{t.mineRateLabel} {spec.miningRatePerSec}/s · [E] {rcText.classSkillName}
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Primary Weapons */}
        <div className="mb-6">
          <h3 className="text-sm font-semibold text-slate-200 mb-3 flex items-center gap-2 uppercase tracking-wider font-display">
            <Zap className="w-4 h-4 text-amber-400" />
            <span>{t.primaryEmitterTitle}</span>
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {(Object.keys(WEAPONS) as WeaponId[]).map((wid) => {
              const w = WEAPONS[wid];
              const wText = WEAPON_I18N[lang][wid];
              const unlocked = xp >= w.unlockXp;
              const selected = loadout.weaponId === wid;
              return (
                <button
                  key={wid}
                  type="button"
                  disabled={!unlocked}
                  onClick={() => onUpdateLoadout({ ...loadout, weaponId: wid })}
                  className={`chamfer-sm text-left p-4 border transition-colors cursor-pointer disabled:opacity-55 disabled:cursor-not-allowed ${
                    selected
                      ? 'bg-[#192436] border-amber-400'
                      : 'bg-[#121A28] border-white/10 hover:border-white/25'
                  }`}
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className="font-display font-bold text-base text-white">{wText.name}</span>
                    {selected ? (
                      <Check className="w-4 h-4 text-amber-400" />
                    ) : !unlocked ? (
                      <Lock className="w-4 h-4 text-slate-500" />
                    ) : null}
                  </div>
                  <div className="text-xs text-cyan-400 mb-2">{wText.role}</div>
                  <div className="text-[11px] font-mono-tabular text-slate-400 whitespace-nowrap">
                    {t.damageShort} {w.damage * w.pellets} · {w.range}m · {unlocked ? t.unlocked : `${w.unlockXp} XP`}
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Tactical Gadgets */}
        <div className="mb-6">
          <h3 className="text-sm font-semibold text-slate-200 mb-3 flex items-center gap-2 uppercase tracking-wider font-display">
            <Shield className="w-4 h-4 text-cyan-400" />
            <span>{t.tacticalModuleTitle}</span>
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {(Object.keys(GADGETS) as GadgetId[]).map((gid) => {
              const g = GADGETS[gid];
              const gText = GADGET_I18N[lang][gid];
              const unlocked = xp >= g.unlockXp;
              const selected = loadout.gadgetId === gid;
              return (
                <button
                  key={gid}
                  type="button"
                  disabled={!unlocked}
                  onClick={() => onUpdateLoadout({ ...loadout, gadgetId: gid })}
                  className={`chamfer-sm text-left p-3.5 border transition-colors cursor-pointer disabled:opacity-55 disabled:cursor-not-allowed ${
                    selected
                      ? 'bg-[#192436] border-cyan-400'
                      : 'bg-[#121A28] border-white/10 hover:border-white/25'
                  }`}
                >
                  <div className="flex items-center justify-between mb-1">
                    <span className="font-display font-bold text-sm text-white">{gText.name}</span>
                    {selected && <Check className="w-4 h-4 text-cyan-400" />}
                  </div>
                  <div className="text-xs text-slate-300 mb-1">{gText.role}</div>
                  <div className="text-[11px] font-mono-tabular text-slate-400">
                    {t.cooldownLabel} {g.cooldownSec}s · {unlocked ? t.unlocked : `${g.unlockXp} XP`}
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Unlockable Cosmetics */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div className="chamfer-sm p-4 bg-[#121A28] border border-white/10">
            <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-3">{t.beamSpectrum}</h4>
            <div className="flex flex-col gap-2">
              {beams.map((b) => {
                const unlocked = xp >= b.unlockXp;
                const active = loadout.beamColorId === b.id;
                return (
                  <button
                    key={b.id}
                    type="button"
                    disabled={!unlocked}
                    onClick={() => onUpdateLoadout({ ...loadout, beamColorId: b.id })}
                    className={`flex items-center justify-between px-3 py-2 border text-xs cursor-pointer disabled:opacity-50 ${
                      active ? 'border-amber-400 bg-white/5 text-white' : 'border-white/10 text-slate-300'
                    }`}
                  >
                    <span className="flex items-center gap-2">
                      <span className="w-3 h-3 inline-block" style={{ backgroundColor: b.hex }} />
                      <span>{translateCosmeticName(b.id, b.name, lang)}</span>
                    </span>
                    <span className="font-mono-tabular text-[11px] text-slate-400">
                      {unlocked ? (active ? t.equipped : t.equip) : `${b.unlockXp} XP`}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="chamfer-sm p-4 bg-[#121A28] border border-white/10">
            <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-3">{t.armorFinish}</h4>
            <div className="flex flex-col gap-2">
              {skins.map((s) => {
                const unlocked = xp >= s.unlockXp;
                const active = loadout.skinId === s.id;
                return (
                  <button
                    key={s.id}
                    type="button"
                    disabled={!unlocked}
                    onClick={() => onUpdateLoadout({ ...loadout, skinId: s.id })}
                    className={`flex items-center justify-between px-3 py-2 border text-xs cursor-pointer disabled:opacity-50 ${
                      active ? 'border-cyan-400 bg-white/5 text-white' : 'border-white/10 text-slate-300'
                    }`}
                  >
                    <span className="flex items-center gap-2">
                      <span className="w-3 h-3 inline-block border border-white/20" style={{ backgroundColor: s.hex }} />
                      <span>{translateCosmeticName(s.id, s.name, lang)}</span>
                    </span>
                    <span className="font-mono-tabular text-[11px] text-slate-400">
                      {unlocked ? (active ? t.equipped : t.equip) : `${s.unlockXp} XP`}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="chamfer-sm p-4 bg-[#121A28] border border-white/10">
            <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-3">{t.operativeEmblem}</h4>
            <div className="flex flex-col gap-2">
              {emblems.map((em) => {
                const unlocked = xp >= em.unlockXp;
                const active = loadout.emblemId === em.id;
                return (
                  <button
                    key={em.id}
                    type="button"
                    disabled={!unlocked}
                    onClick={() => onUpdateLoadout({ ...loadout, emblemId: em.id })}
                    className={`flex items-center justify-between px-3 py-2 border text-xs cursor-pointer disabled:opacity-50 ${
                      active ? 'border-emerald-400 bg-white/5 text-white' : 'border-white/10 text-slate-300'
                    }`}
                  >
                    <span>{translateCosmeticName(em.id, em.name, lang)}</span>
                    <span className="font-mono-tabular text-[11px] text-slate-400">
                      {unlocked ? (active ? t.equipped : t.equip) : `${em.unlockXp} XP`}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

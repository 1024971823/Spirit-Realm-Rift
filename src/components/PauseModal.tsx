import React from 'react';
import { LogOut, Play, Repeat, Shield, Sliders } from 'lucide-react';
import { useI18n } from '../i18n/LanguageContext';
import { ROBOT_CLASS_I18N } from '../i18n/translations';
import type { RobotClass } from '../shared/types';
import { LanguageSwitch } from './LanguageSwitch';

interface PauseModalProps {
  robotClass: RobotClass;
  onQuickSwitchClass: (nextClass: RobotClass) => void;
  onResume: () => void;
  onOpenLoadout: () => void;
  onOpenSettings: () => void;
  onReturnToTitle: () => void;
}

export const PauseModal: React.FC<PauseModalProps> = ({
  robotClass,
  onQuickSwitchClass,
  onResume,
  onOpenLoadout,
  onOpenSettings,
  onReturnToTitle,
}) => {
  const { lang, t } = useI18n();
  const nextClass: RobotClass = robotClass === 'ep_miner' ? 's1_striker' : 'ep_miner';

  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/78 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t.matchPaused}
        className="chamfer-panel w-full max-w-sm bg-[#0C121C] border border-cyan-500/25 p-6 shadow-2xl"
      >
        <div className="flex items-start justify-between gap-2 mb-1">
          <h2 className="font-display font-bold text-2xl text-white uppercase tracking-wide">
            {t.matchPaused}
          </h2>
          <LanguageSwitch compact />
        </div>
        <p className="text-xs text-slate-400 mb-5">
          {t.pauseDesc}
        </p>

        <div className="flex flex-col gap-2.5">
          <button
            type="button"
            onClick={onResume}
            className="chamfer-btn flex items-center justify-between px-4 py-3 bg-amber-500 hover:bg-amber-400 text-slate-950 font-display font-bold text-sm uppercase tracking-wider cursor-pointer"
          >
            <span>{t.resumeMatch}</span>
            <Play className="w-4 h-4" />
          </button>

          <button
            type="button"
            onClick={() => onQuickSwitchClass(nextClass)}
            className="chamfer-sm flex items-center justify-between px-4 py-2.5 bg-[#142234] hover:bg-[#1C2F47] border border-emerald-400/35 text-slate-100 text-sm font-medium cursor-pointer"
          >
            <span>{t.deployUnitPrefix} · {ROBOT_CLASS_I18N[lang][nextClass].shortName}</span>
            <Repeat className="w-4 h-4 text-emerald-400" />
          </button>

          <button
            type="button"
            onClick={onOpenLoadout}
            className="chamfer-sm flex items-center justify-between px-4 py-2.5 bg-[#151F2E] hover:bg-[#1D2B40] border border-white/10 text-slate-100 text-sm font-medium cursor-pointer"
          >
            <span>{t.armoryCosmetics}</span>
            <Shield className="w-4 h-4 text-cyan-400" />
          </button>

          <button
            type="button"
            onClick={onOpenSettings}
            className="chamfer-sm flex items-center justify-between px-4 py-2.5 bg-[#151F2E] hover:bg-[#1D2B40] border border-white/10 text-slate-100 text-sm font-medium cursor-pointer"
          >
            <span>{t.controlsSensitivity}</span>
            <Sliders className="w-4 h-4 text-slate-300" />
          </button>

          <button
            type="button"
            onClick={onReturnToTitle}
            className="chamfer-sm flex items-center justify-between px-4 py-2.5 bg-red-950/60 hover:bg-red-900/70 border border-red-500/35 text-red-200 text-sm font-medium cursor-pointer mt-1"
          >
            <span>{t.leaveToTitle}</span>
            <LogOut className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
};

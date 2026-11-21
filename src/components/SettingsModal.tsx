import React, { useEffect, useState } from 'react';
import { Gamepad2, Globe, Monitor, RotateCcw, Sliders, X } from 'lucide-react';
import { useI18n } from '../i18n/LanguageContext';
import { ACTION_BINDING_LABELS } from '../i18n/translations';
import { DEFAULT_CONTROLLER } from '../shared/catalog';
import type { ControllerConfig, PlayerProfile } from '../shared/types';
import { LanguageSwitch } from './LanguageSwitch';

interface SettingsModalProps {
  profile: PlayerProfile;
  onUpdateProfileMeta: (callsign: string) => void;
  onUpdateController: (controller: ControllerConfig) => void;
  onClose: () => void;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
  profile,
  onUpdateProfileMeta,
  onUpdateController,
  onClose,
}) => {
  const { lang, t } = useI18n();
  const [callsign, setCallsign] = useState(profile.callsign);
  const [ctrl, setCtrl] = useState<ControllerConfig>(profile.controller);
  const [detectedPad, setDetectedPad] = useState<string | null>(null);

  useEffect(() => {
    const checkPads = () => {
      const pads = navigator.getGamepads?.() || [];
      const active = pads.find((p) => p && p.connected);
      setDetectedPad(active ? active.id : null);
    };
    checkPads();
    const timer = window.setInterval(checkPads, 1000);
    return () => window.clearInterval(timer);
  }, []);

  const applyController = (next: ControllerConfig) => {
    setCtrl(next);
    onUpdateController(next);
  };

  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/80 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t.settingsTitle}
        className="chamfer-panel w-full max-w-4xl max-h-[88vh] overflow-y-auto bg-[#0C121C] border border-cyan-500/25 p-6 shadow-2xl"
      >
        <div className="flex items-center justify-between pb-4 border-b border-white/10 mb-5">
          <div className="flex items-center gap-3">
            <Sliders className="w-5 h-5 text-cyan-400" />
            <div>
              <h2 className="font-display font-bold text-2xl text-white uppercase tracking-wide">{t.settingsTitle}</h2>
              <p className="text-xs text-slate-400">{t.settingsDesc}</p>
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

        {/* Dedicated Language Switch Banner inside Settings */}
        <div className="mb-5 p-3.5 rounded-lg bg-[#141C2A] border border-cyan-500/25 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2.5">
            <Globe className="w-4 h-4 text-cyan-400 shrink-0" />
            <div>
              <div className="text-sm font-semibold text-white">{t.languageSection}</div>
              <div className="text-xs text-slate-400">{t.languageDesc}</div>
            </div>
          </div>
          <LanguageSwitch />
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
          {/* Player profile */}
          <div className="p-4 rounded-lg bg-[#141C2A] border border-white/10 space-y-3">
            <h3 className="text-sm font-semibold text-white flex items-center gap-2">
              <Monitor className="w-4 h-4 text-amber-400" />
              <span>{t.operativeProfileTitle}</span>
            </h3>

            <div>
              <label htmlFor="cfg-callsign" className="block text-xs text-slate-400 mb-1">{t.callsignLabel}</label>
              <div className="flex gap-2">
                <input
                  id="cfg-callsign"
                  type="text"
                  maxLength={18}
                  value={callsign}
                  onChange={(e) => setCallsign(e.target.value)}
                  className="flex-1 px-3 py-2 rounded bg-[#0C111A] border border-white/15 text-sm text-white"
                />
                <button
                  type="button"
                  onClick={() => onUpdateProfileMeta(callsign)}
                  className="px-3 py-2 rounded bg-amber-500 hover:bg-amber-400 text-slate-950 text-xs font-bold cursor-pointer whitespace-nowrap"
                >
                  {t.saveBtn}
                </button>
              </div>
            </div>

            {/* Mouse & Camera */}
            <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-400 pt-2">{t.mouseReticleTitle}</h4>
            <div>
              <div className="flex justify-between text-xs mb-1">
                <span className="text-slate-300">{t.mouseSensitivity}</span>
                <span className="font-mono-tabular text-cyan-400">{ctrl.mouseSensitivity.toFixed(2)}</span>
              </div>
              <input
                type="range"
                min="0.2"
                max="3.0"
                step="0.05"
                value={ctrl.mouseSensitivity}
                onChange={(e) => applyController({ ...ctrl, mouseSensitivity: Number(e.target.value) })}
                className="w-full accent-amber-400"
              />
            </div>

            <div>
              <div className="flex justify-between text-xs mb-1">
                <span className="text-slate-300">{t.fovLabel}</span>
                <span className="font-mono-tabular text-cyan-400">{ctrl.fov}°</span>
              </div>
              <input
                type="range"
                min="65"
                max="105"
                step="1"
                value={ctrl.fov}
                onChange={(e) => applyController({ ...ctrl, fov: Number(e.target.value) })}
                className="w-full accent-amber-400"
              />
            </div>

            <div className="grid grid-cols-2 gap-2.5">
              <div>
                <label htmlFor="cfg-crosshair" className="block text-xs text-slate-400 mb-1">{t.crosshairStyle}</label>
                <select
                  id="cfg-crosshair"
                  value={ctrl.crosshairStyle}
                  onChange={(e) => applyController({ ...ctrl, crosshairStyle: e.target.value as ControllerConfig['crosshairStyle'] })}
                  className="w-full px-2.5 py-1.5 rounded bg-[#0C111A] border border-white/15 text-xs text-white"
                >
                  <option value="precision">{t.crosshairPrecision}</option>
                  <option value="chevron">{t.crosshairChevron}</option>
                  <option value="ring">{t.crosshairRing}</option>
                </select>
              </div>
              <label className="flex items-center gap-2 px-3 py-1.5 rounded bg-[#0C111A] border border-white/15 text-xs text-slate-200 cursor-pointer self-end">
                <input
                  type="checkbox"
                  checked={ctrl.invertY}
                  onChange={(e) => applyController({ ...ctrl, invertY: e.target.checked })}
                  className="accent-cyan-400"
                />
                <span>{t.invertLookY}</span>
              </label>
            </div>
          </div>

          {/* Gamepad / Controller Customization */}
          <div className="p-4 rounded-lg bg-[#141C2A] border border-white/10 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-white flex items-center gap-2">
                <Gamepad2 className="w-4 h-4 text-cyan-400" />
                <span>{t.controllerTuningTitle}</span>
              </h3>
              <span className="text-[11px] font-mono-tabular text-slate-400">
                {detectedPad ? t.padConnected : t.noPadDetected}
              </span>
            </div>

            <div className="grid grid-cols-2 gap-2.5">
              <label className="flex items-center justify-between p-2.5 rounded bg-[#0C111A] border border-white/10 text-xs text-slate-200 cursor-pointer">
                <span>{t.gamepadPolling}</span>
                <input
                  type="checkbox"
                  checked={ctrl.gamepadEnabled}
                  onChange={(e) => applyController({ ...ctrl, gamepadEnabled: e.target.checked })}
                  className="accent-cyan-400"
                />
              </label>
              <label className="flex items-center justify-between p-2.5 rounded bg-[#0C111A] border border-white/10 text-xs text-slate-200 cursor-pointer">
                <span>{t.hapticVibration}</span>
                <input
                  type="checkbox"
                  checked={ctrl.vibrationEnabled}
                  onChange={(e) => applyController({ ...ctrl, vibrationEnabled: e.target.checked })}
                  className="accent-cyan-400"
                />
              </label>
            </div>

            <div>
              <div className="flex justify-between text-xs mb-1">
                <span className="text-slate-300">{t.stickSensitivity}</span>
                <span className="font-mono-tabular text-cyan-400">{ctrl.gamepadSensitivity.toFixed(1)}</span>
              </div>
              <input
                type="range"
                min="1.0"
                max="5.0"
                step="0.1"
                value={ctrl.gamepadSensitivity}
                onChange={(e) => applyController({ ...ctrl, gamepadSensitivity: Number(e.target.value) })}
                className="w-full accent-cyan-400"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <div className="flex justify-between text-xs mb-1">
                  <span className="text-slate-300">{t.leftDeadzone}</span>
                  <span className="font-mono-tabular text-slate-400">{ctrl.leftStickDeadzone.toFixed(2)}</span>
                </div>
                <input
                  type="range"
                  min="0.05"
                  max="0.4"
                  step="0.01"
                  value={ctrl.leftStickDeadzone}
                  onChange={(e) => applyController({ ...ctrl, leftStickDeadzone: Number(e.target.value) })}
                  className="w-full accent-cyan-400"
                />
              </div>
              <div>
                <div className="flex justify-between text-xs mb-1">
                  <span className="text-slate-300">{t.rightDeadzone}</span>
                  <span className="font-mono-tabular text-slate-400">{ctrl.rightStickDeadzone.toFixed(2)}</span>
                </div>
                <input
                  type="range"
                  min="0.05"
                  max="0.4"
                  step="0.01"
                  value={ctrl.rightStickDeadzone}
                  onChange={(e) => applyController({ ...ctrl, rightStickDeadzone: Number(e.target.value) })}
                  className="w-full accent-cyan-400"
                />
              </div>
            </div>

            <div className="flex items-center justify-between pt-1">
              <h4 className="text-xs font-semibold uppercase tracking-wider text-slate-400">{t.actionBindings}</h4>
              <button
                type="button"
                onClick={() => applyController(structuredClone(DEFAULT_CONTROLLER))}
                className="flex items-center gap-1 text-[11px] text-slate-400 hover:text-white cursor-pointer"
              >
                <RotateCcw className="w-3 h-3" />
                <span>{t.resetDefaults}</span>
              </button>
            </div>
            <div className="grid grid-cols-2 gap-2 text-xs">
              {(Object.keys(DEFAULT_CONTROLLER.bindings) as Array<keyof ControllerConfig['bindings']>).filter(action => action !== 'voicePtt').map((action) => (
                <div key={action} className="flex items-center justify-between px-2.5 py-1.5 rounded bg-[#0C111A] border border-white/10">
                  <span className="text-slate-300 truncate">{ACTION_BINDING_LABELS[lang][action]}</span>
                  <input
                    type="text"
                    aria-label={ACTION_BINDING_LABELS[lang][action]}
                    value={ctrl.bindings?.[action] ?? DEFAULT_CONTROLLER.bindings[action]}
                    onChange={(e) =>
                      applyController({
                        ...ctrl,
                        bindings: {
                          ...DEFAULT_CONTROLLER.bindings,
                          ...ctrl.bindings,
                          [action]: e.target.value,
                        },
                      })
                    }
                    className="w-24 text-right bg-transparent font-mono-tabular text-amber-400 focus:outline-none"
                  />
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

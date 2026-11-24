import React, { useEffect, useMemo, useState } from 'react';
import {
  Coins,
  Cpu,
  Pause,
  Pickaxe,
  Repeat,
  ShoppingCart,
  Volume2,
  VolumeX,
  Zap,
} from 'lucide-react';
import type { HudLiveState } from '../game/LaserTagEngine';
import { TACTICAL_PINGS } from '../game/tacticalPings';
import type { TacticalPingKind } from '../shared/social';
import { useI18n } from '../i18n/LanguageContext';
import {
  AMMO_PACK_I18N,
  GADGET_I18N,
  MAP_I18N,
  ROBOT_CLASS_I18N,
  translateControlOwner,
  translateOreLabel,
  translateTeamName,
  WEAPON_I18N,
} from '../i18n/translations';
import { KillFeed } from './KillFeed';
import { TacticalMinimap } from './TacticalMinimap';
import { RoomChat, type ChatViewProps } from './RoomChat';
import { MULTIPLAYER_TEXT } from '../i18n/multiplayer';
import { AMMO_PACKS, canRobotClassFire, GADGETS, MAPS, ROBOT_CLASSES, WEAPONS } from '../shared/catalog';
import type {
  AmmoPackId,
  ControllerConfig,
  LoadoutConfig,
  MatchSnapshot,
  RobotClass,
} from '../shared/types';

interface GameHudProps {
  hud: HudLiveState;
  snapshot: MatchSnapshot | null;
  localPlayerId: string;
  loadout: LoadoutConfig;
  controller: ControllerConfig;
  pingMs: number;
  muted: boolean;
  chat: ChatViewProps;
  onToggleMute: () => void;
  onPause: () => void;
  onRequestPointerLock: () => void;
  onBuyAmmo: (packId: AmmoPackId) => void;
  onTriggerClassSkill: () => void;
  onQuickSwitchClass: (nextClass: RobotClass) => void;
}

export const GameHud: React.FC<GameHudProps> = ({
  hud,
  snapshot,
  localPlayerId,
  loadout,
  controller,
  pingMs,
  muted,
  chat,
  onToggleMute,
  onPause,
  onRequestPointerLock,
  onBuyAmmo,
  onTriggerClassSkill,
  onQuickSwitchClass,
}) => {
  const { lang, t } = useI18n();
  const [trailingHp, setTrailingHp] = useState(hud.hp);
  const [chatOpen, setChatOpen] = useState(false);
  const chatText = MULTIPLAYER_TEXT[lang];
  const [copiedCode, setCopiedCode] = useState(false);

  useEffect(() => {
    if (hud.hp < trailingHp) {
      const tmr = window.setTimeout(() => setTrailingHp(hud.hp), 320);
      return () => window.clearTimeout(tmr);
    }
    setTrailingHp(hud.hp);
  }, [hud.hp, trailingHp]);

  const weapon = WEAPONS[loadout.weaponId] || WEAPONS.pulse_carbine;
  const gadget = GADGETS[loadout.gadgetId] || GADGETS.phase_dash;
  const activeClass = hud.robotClass || loadout.robotClass || 's1_striker';
  const classSpec = ROBOT_CLASSES[activeClass] || ROBOT_CLASSES.s1_striker;
  const map = snapshot && MAPS[snapshot.mapId] ? MAPS[snapshot.mapId] : MAPS.reactor_foundry;

  const localizedMapName = MAP_I18N[lang][map.id]?.name ?? map.name;
  const localizedWeaponName = WEAPON_I18N[lang][weapon.id]?.name ?? weapon.name;
  const localizedGadgetName = GADGET_I18N[lang][gadget.id]?.name ?? gadget.name;
  const localizedClassText = ROBOT_CLASS_I18N[lang][activeClass] || ROBOT_CLASS_I18N[lang].s1_striker;

  const localPose = useMemo(
    () => ({ pos: hud.playerPos, yaw: hud.playerYaw }),
    [hud.playerPos, hud.playerYaw],
  );

  const timeRemaining = snapshot ? Math.max(0, Math.ceil(snapshot.durationSec - snapshot.elapsedSec)) : 180;
  const mins = Math.floor(timeRemaining / 60);
  const secs = String(timeRemaining % 60).padStart(2, '0');

  const me = snapshot?.players.find((p) => p.id === localPlayerId);
  const myTeam = me?.team ?? 'cobalt';
  const tacticalPings = (hud.tacticalPings ?? []).filter((ping) =>
    ping.matchId === snapshot?.matchId && ping.team === myTeam && !chat.blockedIds.includes(ping.playerId));
  const tacticalLabels = lang === 'zh'
    ? { title: '战术标记', choose: '移动鼠标或按方向键，松开 G 发出', padChoose: '右摇杆选择，松开方向键 ↓ 发出',
      hint: '按住 G 标记', padHint: '按住手柄方向键 ↓ 标记' }
    : { title: 'Tactical pings', choose: 'Move mouse or use arrow keys, then release G', padChoose: 'Select with the right stick, then release D-pad ↓',
      hint: 'Hold G to ping', padHint: 'Hold D-pad ↓ to ping' };
  const ffaLeader = snapshot?.mode === 'ffa'
    ? [...(snapshot.players || [])].sort((a, b) => b.kills - a.kills || b.damageDealt - a.damageDealt)[0]
    : null;

  const isArmed = canRobotClassFire(activeClass);
  const lowAmmo = isArmed && hud.ammo <= Math.max(4, Math.floor(hud.maxAmmo * 0.2));
  const emptyAmmo = isArmed && hud.ammo <= 0;

  const handleCopyInvite = () => {
    if (!snapshot?.roomId) return;
    navigator.clipboard?.writeText(snapshot.roomId).catch(() => {});
    setCopiedCode(true);
    window.setTimeout(() => setCopiedCode(false), 1800);
  };

  return (
    <div className="fixed inset-0 z-10 pointer-events-none">
      {/* Peripheral Damage Flash Vignette */}
      {hud.damageFlash > 0.02 && (
        <div
          className="fixed inset-0 pointer-events-none"
          style={{
            boxShadow: `inset 0 0 110px rgba(239, 68, 68, ${Math.min(0.65, hud.damageFlash * 0.7)})`,
          }}
        />
      )}

      {/* Cryo Slow Peripheral Vignette */}
      {hud.slowed && (
        <div
          className="fixed inset-0 pointer-events-none"
          style={{ boxShadow: 'inset 0 0 90px rgba(56, 189, 248, 0.35)' }}
        />
      )}

      {/* TOP-LEFT: Dedicated Tactical Minimap (Real-Time Players & Active Hazards) */}
      <TacticalMinimap
        map={map}
        localizedMapName={localizedMapName}
        snapshot={snapshot}
        localPlayerId={localPlayerId}
        localTeam={myTeam}
        localPose={localPose}
        tacticalPings={tacticalPings}
        copiedCode={copiedCode}
        onCopyInvite={handleCopyInvite}
      />

      {/* TOP-CENTER: Pro League Scoreboard & Team Economy Credits */}
      <div className="fixed top-4 left-1/2 -translate-x-1/2 flex flex-col items-center gap-1.5">
        {snapshot?.mode === 'ffa' ? (
          <div className="chamfer-panel flex items-center gap-5 px-5 py-2 bg-[#0B1019]/92 border border-white/15">
            <div className="flex items-center gap-2">
              <span className="text-[11px] uppercase tracking-wider text-cyan-400 font-semibold whitespace-nowrap">{t.you}</span>
              <span className="font-display font-bold text-2xl text-white tabular-nums">
                {me?.kills ?? 0}
              </span>
            </div>
            <div className="px-3 py-0.5 bg-white/5 text-slate-100 font-mono-tabular font-bold text-base">
              {mins}:{secs}
            </div>
            <div className="flex items-center gap-2">
              <span className="font-display font-bold text-2xl text-amber-400 tabular-nums">
                {ffaLeader?.kills ?? 0}
              </span>
              <span className="text-[11px] uppercase tracking-wider text-amber-400 font-semibold whitespace-nowrap">
                {ffaLeader ? `${t.leadPrefix} (${ffaLeader.callsign.slice(0, 10)})` : t.leader}
              </span>
            </div>
          </div>
        ) : (
          <div className="chamfer-panel flex items-center gap-4 px-5 py-2 bg-[#0B1019]/92 border border-white/15">
            <div className="flex items-center gap-2.5">
              <span className="text-[11px] uppercase tracking-wider text-cyan-400 font-bold whitespace-nowrap">{translateTeamName('cobalt', lang)}</span>
              <span className="font-display font-bold text-2xl text-white tabular-nums">
                {snapshot?.scoreCobalt ?? 0}
              </span>
            </div>
            <div className="px-3.5 py-0.5 bg-[#141D2D] border border-white/10 text-slate-100 font-mono-tabular font-bold text-base">
              {mins}:{secs}
            </div>
            <div className="flex items-center gap-2.5">
              <span className="font-display font-bold text-2xl text-white tabular-nums">
                {snapshot?.scoreAmber ?? 0}
              </span>
              <span className="text-[11px] uppercase tracking-wider text-amber-400 font-bold whitespace-nowrap">{translateTeamName('amber', lang)}</span>
            </div>
          </div>
        )}

        {/* Team Economy Reserve Strip */}
        <div className="flex items-center gap-3">
          <div className={`chamfer-sm flex items-center gap-2 px-3 py-1 bg-[#0B1019]/92 border ${
            myTeam === 'amber' ? 'border-amber-400/55' : 'border-cyan-400/55'
          }`}>
            <Coins className="w-3.5 h-3.5 text-amber-400" />
            <span className="text-[10px] font-mono-tabular uppercase tracking-wider text-slate-300 whitespace-nowrap">
              {t.teamCreditsLabel(myTeam)}
            </span>
            <span data-testid="team-credits" className="font-mono-tabular font-bold text-sm text-amber-400 tabular-nums whitespace-nowrap">
              {hud.teamCredits} {t.creditsSuffix}
            </span>
          </div>

          {snapshot?.mode === 'control_core' && (
            <div className="chamfer-sm text-xs font-mono-tabular px-2.5 py-1 bg-[#0B1019]/92 border border-cyan-500/30 text-slate-200 whitespace-nowrap">
              {t.corePrefix}: {translateControlOwner(snapshot.controlOwner, lang)}
            </div>
          )}
        </div>

        {hud.hazardWarning && (
          <div className="px-3 py-1 bg-red-950/95 border border-red-500/70 text-red-200 text-xs font-mono-tabular font-semibold whitespace-nowrap">
            {t.hazardAlertPrefix}: {hud.hazardWarning}
          </div>
        )}

        {hud.economyAlert && (
          <div className="px-3 py-1 bg-[#10202E]/95 border border-amber-400/70 text-amber-200 text-xs font-mono-tabular font-semibold whitespace-nowrap">
            {hud.economyAlert}
          </div>
        )}
      </div>

      {/* TOP-RIGHT: Utility Controls & Kill Feed */}
      <div className="fixed top-4 right-4 flex flex-col items-end gap-2">
        <div className="flex items-center gap-1.5 pointer-events-auto">
          {!hud.pointerLocked && (
            <button
              type="button"
              onClick={(e) => {
                e.currentTarget.blur();
                onRequestPointerLock();
              }}
              className="chamfer-sm px-3 py-1.5 bg-amber-500 hover:bg-amber-400 text-slate-950 text-xs font-display font-bold uppercase tracking-wider cursor-pointer whitespace-nowrap"
            >
              {t.lockAim}
            </button>
          )}
          <button
            type="button"
            tabIndex={-1}
            aria-label={muted ? t.unmuteAudio : t.muteAudio}
            onClick={(e) => {
              e.currentTarget.blur();
              onToggleMute();
            }}
            className="p-2 bg-[#0B1019]/92 hover:bg-[#162030] border border-white/15 text-slate-200 cursor-pointer"
          >
            {muted ? <VolumeX className="w-4 h-4 text-slate-400" /> : <Volume2 className="w-4 h-4 text-slate-200" />}
          </button>
          <button
            type="button"
            tabIndex={-1}
            aria-label={t.pauseGame}
            onClick={(e) => {
              e.currentTarget.blur();
              onPause();
            }}
            className="p-2 bg-[#0B1019]/92 hover:bg-[#162030] border border-white/15 text-slate-200 cursor-pointer"
          >
            <Pause className="w-4 h-4" />
          </button>
        </div>

        <KillFeed
          key={snapshot?.roomId ?? 'arena'}
          events={snapshot?.killFeed ?? []}
          localPlayerId={localPlayerId}
          localCallsign={me?.callsign}
        />
      </div>

      {snapshot?.mode !== 'ffa' && snapshot?.phase === 'active' && (
        <div className="fixed left-1/2 top-[55%] -translate-x-1/2 max-w-[90vw] text-center pointer-events-none">
          <div data-testid="tactical-ping-feed" className="flex flex-col items-center gap-1" aria-live="polite">
            {tacticalPings.slice(-3).map((ping) => {
              const info = TACTICAL_PINGS[ping.kind];
              return <div key={ping.id} className="rounded border border-white/15 bg-[#0B1019]/90 px-2 py-1 text-xs"
                style={{ color: info.color }}><span aria-hidden="true">{info.symbol} </span>{ping.callsign} · {info[lang]}</div>;
            })}
          </div>
          {!hud.tacticalMenu && hud.alive && (
            <span className="text-[10px] text-slate-300 hud-text-stroke">
              {tacticalLabels.hint}{hud.gamepadName ? ' · ' + tacticalLabels.padHint : ''}
            </span>
          )}
        </div>
      )}

      {hud.tacticalMenu && (
        <div data-testid="tactical-ping-menu" className="fixed left-1/2 top-1/2 z-10 -translate-x-1/2 -translate-y-1/2 text-center"
          aria-label={tacticalLabels.title}>
          <div className="grid w-[min(21rem,96vw)] grid-cols-3 items-center gap-1">
            {(['rally', 'support', 'danger', 'mine'] as const).map((kind) => {
              const info = TACTICAL_PINGS[kind];
              const slot: Record<TacticalPingKind, string> = {
                rally: 'col-start-2 row-start-1', support: 'col-start-1 row-start-2',
                danger: 'col-start-3 row-start-2', mine: 'col-start-2 row-start-3',
              };
              const selected = hud.tacticalMenu === kind;
              return <div key={kind} data-kind={kind} data-selected={selected}
                className={`${slot[kind]} rounded border bg-[#0B1019]/95 px-1 py-2 text-xs font-semibold ${selected ? 'ring-1 ring-white' : 'border-white/20'}`}
                style={{ color: info.color, borderColor: selected ? info.color : undefined }}>
                <span aria-hidden="true">{info.arrow} {info.symbol} </span>{info[lang]}
              </div>;
            })}
            <div className="col-start-2 row-start-2 rounded bg-[#0B1019]/95 px-1 py-2 text-xs font-bold text-slate-100">
              {tacticalLabels.title}
            </div>
          </div>
          <div className="mt-2 rounded bg-[#0B1019]/95 px-1 py-1 text-[11px] text-slate-300">
            <div>{tacticalLabels.choose}</div>
            {hud.gamepadName && <div>{tacticalLabels.padChoose}</div>}
          </div>
        </div>
      )}

      {/* CENTER: Precision SVG Crosshair & Hitmarker */}
      <div className={`fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 pointer-events-none ${hud.tacticalMenu ? 'invisible' : ''}`}>
        <svg viewBox="-24 -24 48 48" className="w-10 h-10">
          {controller.crosshairStyle === 'precision' && (
            <g stroke={!isArmed ? '#34D399' : emptyAmmo ? '#EF4444' : '#F8FAFC'} strokeWidth="1.8" opacity="0.92">
              <line x1="-10" y1="0" x2="-4" y2="0" />
              <line x1="4" y1="0" x2="10" y2="0" />
              <line x1="0" y1="-10" x2="0" y2="-4" />
              <line x1="0" y1="4" x2="0" y2="10" />
              <circle cx="0" cy="0" r="1.4" fill={hud.isMining || !isArmed ? '#34D399' : '#06B6D4'} stroke="none" />
            </g>
          )}
          {controller.crosshairStyle === 'chevron' && (
            <g fill="none" stroke={!isArmed ? '#34D399' : emptyAmmo ? '#EF4444' : '#F59E0B'} strokeWidth="2">
              <polyline points="-7,5 0,-3 7,5" />
              <circle cx="0" cy="0" r="1.2" fill="#FFFFFF" stroke="none" />
            </g>
          )}
          {controller.crosshairStyle === 'ring' && (
            <g fill="none" stroke={!isArmed ? '#34D399' : emptyAmmo ? '#EF4444' : '#06B6D4'} strokeWidth="1.6">
              <circle cx="0" cy="0" r="8" />
              <circle cx="0" cy="0" r="1.5" fill="#FFFFFF" stroke="none" />
            </g>
          )}
          {hud.hitmarkerActive && (
            <g stroke={hud.hitmarkerKilled ? '#EF4444' : '#F59E0B'} strokeWidth="2.4">
              <line x1="-12" y1="-12" x2="-5" y2="-5" />
              <line x1="12" y1="-12" x2="5" y2="-5" />
              <line x1="-12" y1="12" x2="-5" y2="5" />
              <line x1="12" y1="12" x2="5" y2="5" />
            </g>
          )}
        </svg>
      </div>

      {/* Respawn Banner */}
      {!hud.alive && (
        <div className="fixed inset-x-0 top-1/3 flex justify-center">
          <div className="chamfer-panel px-6 py-3 bg-[#0B1019]/95 border border-red-500/55 text-center">
            <div className="text-xs uppercase tracking-wider text-red-400 font-semibold">{t.chassisDisabled}</div>
            <div className="font-display font-bold text-2xl text-white tabular-nums mt-0.5">
              {t.redeployingIn(hud.respawnSec)}
            </div>
          </div>
        </div>
      )}

      {/* BOTTOM-LEFT: Active Robot Unit Plate, Vitality & Squad Comms */}
      <div className="fixed bottom-4 left-4 flex flex-col gap-2 w-80">
        <div className="pointer-events-auto" onKeyDown={event => {
          if (!chatOpen) return;
          event.stopPropagation();
          if (event.key === 'Escape') setChatOpen(false);
        }}>
          {chatOpen && <RoomChat {...chat} />}
          <button type="button" aria-expanded={chatOpen} className="mt-1 rounded bg-[#0B1019]/95 px-3 py-1.5 text-xs text-cyan-300"
            onClick={() => { if (!chatOpen && document.pointerLockElement) document.exitPointerLock(); setChatOpen(open => !open); }}>
            {chatOpen ? chatText.close : chatText.roomChat}{!chatOpen && chat.messages.length > 0 ? ' (' + chat.messages.filter(m => !chat.blockedIds.includes(m.playerId)).length + ')' : ''}
          </button>
        </div>

        {/* Robot Chassis + Vitality Cluster */}
        <div className="chamfer-panel p-3 bg-[#0B1019]/92 border border-white/15">
          <div className="flex items-center justify-between pb-2 mb-2 border-b border-white/10 gap-1">
            <div className="flex items-center gap-1.5 min-w-0">
              {activeClass === 'ep_miner' ? (
                <Pickaxe className="w-4 h-4 text-emerald-400 shrink-0" />
              ) : (
                <Cpu className="w-4 h-4 text-cyan-400 shrink-0" />
              )}
              <span data-testid="active-unit-label" className="font-display font-bold text-xs tracking-wider uppercase text-white whitespace-nowrap truncate">
                {classSpec.code} · {localizedClassText.hudName}
              </span>
              <span className={`px-1.5 py-0.5 text-[9px] font-mono-tabular font-bold uppercase border shrink-0 whitespace-nowrap ${
                myTeam === 'amber'
                  ? 'border-amber-400/50 text-amber-300 bg-amber-500/10'
                  : 'border-cyan-400/50 text-cyan-300 bg-cyan-500/10'
              }`}>
                {translateTeamName(myTeam, lang)}
              </span>
            </div>
            <button
              type="button"
              tabIndex={-1}
              data-testid="switch-unit-btn"
              onClick={(e) => {
                e.currentTarget.blur();
                onQuickSwitchClass(activeClass === 'ep_miner' ? 's1_striker' : 'ep_miner');
              }}
              className="pointer-events-auto flex items-center gap-1 px-2 py-0.5 bg-[#152032] hover:bg-[#1E2E47] border border-white/15 text-[10px] font-mono-tabular text-amber-300 cursor-pointer shrink-0 whitespace-nowrap"
            >
              <Repeat className="w-3 h-3" />
              <span>[U] {activeClass === 'ep_miner' ? 'S1' : 'EP'}</span>
            </button>
          </div>

          <div className="flex items-baseline justify-between mb-1.5">
            <div className="flex items-baseline gap-2">
              <span className="font-display font-bold text-3xl text-white tabular-nums">{Math.round(hud.hp)}</span>
              <span className="text-[11px] uppercase tracking-wider text-slate-400 font-semibold">{t.hull}</span>
            </div>
            <div className="flex items-baseline gap-1.5">
              <span className="font-mono-tabular font-bold text-base text-cyan-400 tabular-nums">{Math.round(hud.shield)}</span>
              <span className="text-[11px] uppercase tracking-wider text-cyan-400/80">{t.shield}</span>
            </div>
          </div>

          {/* Shield Bar */}
          <div className="h-1.5 w-full bg-slate-800 overflow-hidden mb-1">
            <div
              className="h-full bg-cyan-400 transition-transform duration-100 origin-left"
              style={{ transform: `scaleX(${Math.max(0, Math.min(1, hud.shield / Math.max(1, hud.maxShield)))})` }}
            />
          </div>
          {/* Hull Bar with Delayed Trailing Damage Ghost */}
          <div className="relative h-2.5 w-full bg-slate-800 overflow-hidden">
            <div
              className="absolute inset-0 bg-red-400/70 transition-transform duration-300 origin-left"
              style={{ transform: `scaleX(${Math.max(0, Math.min(1, trailingHp / Math.max(1, hud.maxHp)))})` }}
            />
            <div
              className="relative h-full bg-emerald-400 transition-transform duration-75 origin-left"
              style={{ transform: `scaleX(${Math.max(0, Math.min(1, hud.hp / Math.max(1, hud.maxHp)))})` }}
            />
          </div>
          <div className="flex items-center justify-between mt-1.5 text-[11px] font-mono-tabular text-slate-400">
            <span>{t.kdShort}: {me?.kills ?? 0}/{me?.deaths ?? 0}</span>
            <span className={hud.overclockActive ? 'text-amber-300 font-semibold' : ''}>
              {hud.overclockActive
                ? t.overclockStatus(hud.overclockRemainingSec)
                : hud.shielded
                  ? t.aegisActive
                  : hud.slowed
                    ? t.cryoSlowed
                    : t.nominal}
            </span>
          </div>
        </div>
      </div>

      {/* BOTTOM-CENTER: Context Ore Mining Prompt + Active Skill & Ammo Action Bar */}
      <div className="fixed bottom-4 left-1/2 -translate-x-1/2 flex flex-col items-center gap-2">
        {hud.nearbyOreNode && (
          <div className={`chamfer-sm px-4 py-1.5 border font-mono-tabular text-xs flex items-center gap-2.5 whitespace-nowrap ${
            hud.isMining
              ? 'bg-emerald-950/95 border-emerald-400 text-emerald-200'
              : 'bg-[#0B1019]/92 border-amber-400/60 text-amber-200'
          }`}>
            <Pickaxe className="w-3.5 h-3.5 text-emerald-400" />
            <span>
              {hud.isMining ? t.extractingOre : t.holdToExtract} · {translateOreLabel(hud.nearbyOreNode.label, lang)} ({hud.nearbyOreNode.amount} {t.creditsSuffix})
            </span>
          </div>
        )}

        <div className="flex items-center gap-2 pointer-events-auto">
          {/* Slot 1: Phase Dash */}
          <div className="chamfer-sm w-28 px-2.5 py-2 bg-[#0B1019]/92 border border-white/15">
            <div className="flex items-center justify-between text-[10px] font-mono-tabular text-slate-400 mb-0.5">
              <span>[SHIFT]</span>
              <span className={hud.dashCooldown > 0 ? 'text-amber-400' : 'text-emerald-400'}>
                {hud.dashCooldown > 0 ? `${hud.dashCooldown}s` : t.ready}
              </span>
            </div>
            <div className="text-xs font-display font-bold text-white truncate">{t.thrusterDash}</div>
          </div>

          {/* Slot 2: Tactical Rig Gadget */}
          <div className="chamfer-sm w-36 px-2.5 py-2 bg-[#0B1019]/92 border border-white/15">
            <div className="flex items-center justify-between text-[10px] font-mono-tabular text-slate-400 mb-0.5">
              <span>[Q]</span>
              <span className={hud.gadgetCooldown > 0 ? 'text-amber-400' : 'text-cyan-400'}>
                {hud.gadgetCooldown > 0 ? `${hud.gadgetCooldown}s` : t.ready}
              </span>
            </div>
            <div className="text-xs font-display font-bold text-white truncate">{localizedGadgetName}</div>
          </div>

          {/* Slot 3: Robot Class Skill / Mine */}
          <button
            type="button"
            tabIndex={-1}
            onClick={(e) => {
              e.currentTarget.blur();
              onTriggerClassSkill();
            }}
            className={`chamfer-sm w-36 px-2.5 py-2 text-left border cursor-pointer transition-colors ${
              hud.overclockActive
                ? 'bg-emerald-950/90 border-emerald-400'
                : 'bg-[#0B1019]/92 hover:bg-[#141F30] border-white/15'
            }`}
          >
            <div className="flex items-center justify-between text-[10px] font-mono-tabular text-slate-400 mb-0.5">
              <span className="flex items-center gap-1">
                <Zap className="w-3 h-3 text-amber-400" />
                <span>[E]</span>
              </span>
              <span className={hud.classSkillCooldown > 0 ? 'text-amber-400' : 'text-emerald-400'}>
                {hud.classSkillCooldown > 0 ? `${hud.classSkillCooldown}s` : t.ready}
              </span>
            </div>
            <div className="text-xs font-display font-bold text-white truncate">{localizedClassText.classSkillName}</div>
          </button>

          {/* Slot 4: Quick Buy Ammo (S1) or Harvester Rig Status (EP) */}
          {isArmed ? (
            <button
              type="button"
              tabIndex={-1}
              data-testid="quick-buy-ammo"
              onClick={(e) => {
                e.currentTarget.blur();
                onBuyAmmo('full_mag');
              }}
              className={`chamfer-sm w-32 px-2.5 py-2 text-left border cursor-pointer transition-colors ${
                emptyAmmo
                  ? 'bg-red-950/95 border-red-400'
                  : lowAmmo
                    ? 'bg-amber-950/90 border-amber-400'
                    : 'bg-[#0B1019]/92 hover:bg-[#141F30] border-amber-500/35'
              }`}
            >
              <div className="flex items-center justify-between text-[10px] font-mono-tabular text-amber-300 mb-0.5">
                <span className="flex items-center gap-1">
                  <ShoppingCart className="w-3 h-3" />
                  <span>[B]</span>
                </span>
                <span>{AMMO_PACKS.full_mag.cost} {t.creditsSuffix}</span>
              </div>
              <div className="text-xs font-display font-bold text-white truncate">{t.buyFullMag}</div>
            </button>
          ) : (
            <div
              data-testid="ep-unarmed-badge"
              className="chamfer-sm w-36 px-2.5 py-2 text-left bg-[#0B1019]/92 border border-emerald-500/40"
            >
              <div className="flex items-center justify-between text-[10px] font-mono-tabular text-emerald-300 mb-0.5">
                <span className="flex items-center gap-1">
                  <Pickaxe className="w-3 h-3" />
                  <span>{t.minerTag}</span>
                </span>
                <span>{t.miningRate}</span>
              </div>
              <div className="text-xs font-display font-bold text-white truncate">{t.unarmedSupport}</div>
            </div>
          )}
        </div>
      </div>

      {/* BOTTOM-RIGHT: Weapon Ammo (S1) or Unarmed EP Mining & Repair Rig */}
      <div className="fixed bottom-4 right-4 flex flex-col items-end gap-2 w-80">
        {isArmed ? (
          <div className="chamfer-panel w-full p-3 bg-[#0B1019]/92 border border-white/15">
            <div className="flex items-baseline justify-between mb-1">
              <div>
                <span className="font-display font-bold text-base text-white">{localizedWeaponName}</span>
                <span className={`ml-2 font-mono-tabular text-[11px] font-semibold ${hud.overheated ? 'text-red-400' : 'text-amber-400'}`}>
                  {hud.overheated ? t.overheatReload : `${t.heatLabel} ${hud.heat}%`}
                </span>
              </div>
              <div className="flex items-baseline gap-1 font-mono-tabular">
                <span
                  data-testid="ammo-count"
                  className={`font-display font-bold text-2xl tabular-nums ${
                    emptyAmmo ? 'text-red-400' : lowAmmo ? 'text-amber-400' : 'text-cyan-300'
                  }`}
                >
                  {hud.ammo}
                </span>
                <span className="text-xs text-slate-400">/ {hud.maxAmmo}</span>
              </div>
            </div>

            <div className="h-1.5 w-full bg-slate-800 overflow-hidden mb-2.5">
              <div
                className={`h-full transition-transform duration-75 origin-left ${hud.overheated ? 'bg-red-500' : 'bg-amber-400'}`}
                style={{ transform: `scaleX(${Math.max(0, Math.min(1, hud.heat / 100))})` }}
              />
            </div>

            <div className="grid grid-cols-3 gap-1.5 text-[11px] font-mono-tabular pointer-events-auto">
              {(['light_mag', 'full_mag', 'combat_resupply'] as AmmoPackId[]).map((pid, idx) => {
                const pack = AMMO_PACKS[pid];
                const canAfford = hud.teamCredits >= pack.cost;
                return (
                  <button
                    key={pid}
                    type="button"
                    tabIndex={-1}
                    disabled={!canAfford}
                    onClick={(e) => {
                      e.currentTarget.blur();
                      onBuyAmmo(pid);
                    }}
                    className="px-2 py-1.5 bg-[#121B29] hover:bg-[#1B283D] disabled:opacity-45 border border-white/10 text-left cursor-pointer disabled:cursor-not-allowed"
                  >
                    <div className="text-amber-300 font-bold whitespace-nowrap">[{idx + 1}] {pack.cost} {t.creditsSuffix}</div>
                    <div className="text-slate-300 truncate">{AMMO_PACK_I18N[lang][pid].shortLabel}</div>
                  </button>
                );
              })}
            </div>
          </div>
        ) : (
          <div className="chamfer-panel w-full p-3 bg-[#0B1019]/92 border border-emerald-500/35">
            <div className="flex items-baseline justify-between gap-2 mb-1">
              <div className="flex items-baseline gap-2 min-w-0">
                <span className="font-display font-bold text-base text-white whitespace-nowrap">{t.epRigTitle}</span>
                <span className="font-mono-tabular text-[11px] font-semibold text-emerald-400 whitespace-nowrap">
                  {t.unarmedBadge}
                </span>
              </div>
              <div className="flex items-baseline gap-1 font-mono-tabular shrink-0 whitespace-nowrap">
                <span data-testid="ammo-count" className="font-display font-bold text-xl text-slate-400 tabular-nums">
                  0
                </span>
                <span className="text-xs text-slate-500">/ 0</span>
              </div>
            </div>
            <p className="text-[11px] text-slate-300 leading-snug mb-2">
              {t.epRigDesc}
            </p>
            <div className="flex items-center justify-between gap-2 text-[11px] font-mono-tabular pointer-events-auto">
              <button
                type="button"
                tabIndex={-1}
                disabled={hud.teamCredits < AMMO_PACKS.combat_resupply.cost || (hud.hp >= hud.maxHp && hud.shield >= hud.maxShield)}
                onClick={(e) => {
                  e.currentTarget.blur();
                  onBuyAmmo('combat_resupply');
                }}
                className="flex-1 px-2.5 py-1.5 bg-[#121B29] hover:bg-[#1B283D] disabled:opacity-45 border border-white/10 text-left cursor-pointer disabled:cursor-not-allowed"
              >
                <span className="text-amber-300 font-bold">[3] {AMMO_PACKS.combat_resupply.cost} {t.creditsSuffix}</span>
                <span className="text-slate-300 ml-1.5">{t.hullShieldRepair}</span>
              </button>
            </div>
          </div>
        )}

        <div className="text-[11px] font-mono-tabular text-slate-300 hud-text-stroke flex items-center gap-2">
          <span>{t.pingLabel} {pingMs} ms</span>
          <span aria-hidden="true">·</span>
          <span>{t.antiCheatLabel} {snapshot?.antiCheat.integrityStatus === 'verified' ? t.antiCheatVerified : t.antiCheatActive}</span>
          {hud.gamepadName && (
            <>
              <span aria-hidden="true">·</span>
              <span>{t.padActive}</span>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

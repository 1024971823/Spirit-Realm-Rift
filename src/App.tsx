import { useCallback, useEffect, useRef, useState } from 'react';
import { soundEngine } from './audio/soundEngine';
import { GameHud } from './components/GameHud';
import { GameOverModal } from './components/GameOverModal';
import { LoadoutModal } from './components/LoadoutModal';
import { PauseModal } from './components/PauseModal';
import { SettingsModal } from './components/SettingsModal';
import { SocialLobbyModal } from './components/SocialLobbyModal';
import { StatsModal } from './components/StatsModal';
import { TitleOverlay } from './components/TitleOverlay';
import { LaserTagEngine, type HudLiveState } from './game/LaserTagEngine';
import { useI18n } from './i18n/LanguageContext';
import { GameNetworkClient, type ChatMessage, type MatchSummaryPayload } from './net/clientSocket';
import { DEFAULT_CONTROLLER, DEFAULT_LOADOUT, INITIAL_TEAM_CREDITS, normalizePlayerProfile } from './shared/catalog';
import type {
  AmmoPackId,
  ControllerConfig,
  GameModeId,
  GamePhase,
  LoadoutConfig,
  MapId,
  MatchSnapshot,
  PlatformType,
  PlayerProfile,
  RobotClass,
  VoiceChannel,
  VoiceInputMode,
} from './shared/types';

function getOrCreateLocalPlayerId(): string {
  try {
    const existing = window.localStorage.getItem('prism_player_id');
    if (existing) return existing;
    const fresh = `op_${Math.random().toString(36).slice(2, 9)}`;
    window.localStorage.setItem('prism_player_id', fresh);
    return fresh;
  } catch {
    return `op_${Math.random().toString(36).slice(2, 9)}`;
  }
}

const FALLBACK_PROFILE = (id: string): PlayerProfile => ({
  id,
  callsign: `Prism-${id.slice(-4).toUpperCase()}`,
  platform: 'pc',
  crossplayEnabled: true,
  loadout: { ...DEFAULT_LOADOUT },
  controller: structuredClone(DEFAULT_CONTROLLER),
  stats: {
    matchesPlayed: 0,
    wins: 0,
    losses: 0,
    kills: 0,
    deaths: 0,
    assists: 0,
    shotsFired: 0,
    shotsHit: 0,
    damageDealt: 0,
    hazardKills: 0,
    barriersDestroyed: 0,
    mmr: 1250,
    xp: 0,
    credits: 0,
    weaponStats: {
      pulse_carbine: { kills: 0, shotsFired: 0, shotsHit: 0, damageDealt: 0 },
      prism_railgun: { kills: 0, shotsFired: 0, shotsHit: 0, damageDealt: 0 },
      scatter_projector: { kills: 0, shotsFired: 0, shotsHit: 0, damageDealt: 0 },
    },
    recentMatches: [],
  },
});

const INITIAL_HUD: HudLiveState = {
  hp: 100,
  maxHp: 100,
  shield: 50,
  maxShield: 50,
  ammo: 30,
  maxAmmo: 30,
  robotClass: 's1_striker',
  teamCredits: INITIAL_TEAM_CREDITS,
  heat: 0,
  overheated: false,
  gadgetCooldown: 0,
  gadgetMaxCooldown: 4.5,
  dashCooldown: 0,
  classSkillCooldown: 0,
  classSkillMaxCooldown: 11,
  overclockActive: false,
  overclockRemainingSec: 0,
  isMining: false,
  nearbyOreNode: null,
  economyAlert: null,
  alive: true,
  respawnSec: 0,
  slowed: false,
  shielded: false,
  hitmarkerActive: false,
  hitmarkerKilled: false,
  damageFlash: 0,
  hazardWarning: null,
  pointerLocked: false,
  gamepadName: null,
  playerPos: { x: -42, y: 0, z: 0 },
  playerYaw: -Math.PI / 2,
};

type ActiveModal = 'none' | 'loadout' | 'social' | 'stats' | 'settings';

export default function App() {
  const { lang } = useI18n();
  const langRef = useRef(lang);
  const playerIdRef = useRef<string>(getOrCreateLocalPlayerId());
  const canvasMountRef = useRef<HTMLDivElement | null>(null);
  const engineRef = useRef<LaserTagEngine | null>(null);
  const networkRef = useRef<GameNetworkClient | null>(null);

  const [phase, setPhase] = useState<GamePhase>(() => {
    const params = new URLSearchParams(window.location.search);
    return params.get('autostart') === '1' ? 'playing' : 'title';
  });
  const phaseRef = useRef<GamePhase>(phase);
  const [activeModal, setActiveModal] = useState<ActiveModal>('none');
  const activeModalRef = useRef<ActiveModal>('none');

  const [profile, setProfile] = useState<PlayerProfile>(() => FALLBACK_PROFILE(playerIdRef.current));
  const [snapshot, setSnapshot] = useState<MatchSnapshot | null>(null);
  const [hud, setHud] = useState<HudLiveState>(INITIAL_HUD);
  const [connected, setConnected] = useState(false);
  const [pingMs, setPingMs] = useState(14);
  const [currentRoomId, setCurrentRoomId] = useState('PUBLIC-ALPHA');
  const [queuing, setQueuing] = useState(false);
  const [muted, setMuted] = useState(false);
  const [voiceChannel, setVoiceChannel] = useState<VoiceChannel>('team');
  const [voiceInputMode, setVoiceInputMode] = useState<VoiceInputMode>('ptt');
  const [voiceSpeaking, setVoiceSpeaking] = useState(false);
  const [micReady, setMicReady] = useState(false);
  const [micError, setMicError] = useState<string | null>(null);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [matchSummary, setMatchSummary] = useState<MatchSummaryPayload | null>(null);

  useEffect(() => {
    langRef.current = lang;
    engineRef.current?.setLanguage(lang);
  }, [lang]);

  useEffect(() => {
    phaseRef.current = phase;
    document.body.dataset.state = phase;
    engineRef.current?.setPhase(phase);
  }, [phase]);

  useEffect(() => {
    activeModalRef.current = activeModal;
  }, [activeModal]);

  const profileSaveSeqRef = useRef(0);

  const persistProfile = useCallback(async (patch: Partial<PlayerProfile>) => {
    const seq = ++profileSaveSeqRef.current;
    try {
      const res = await fetch('/api/profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: playerIdRef.current, ...patch }),
      });
      if (res.ok && seq === profileSaveSeqRef.current) {
        const updated = normalizePlayerProfile((await res.json()) as Partial<PlayerProfile>, playerIdRef.current);
        setProfile(updated);
      }
    } catch {
      // Ignore offline save failure
    }
  }, []);

  const userModifiedClassRef = useRef(false);
  const profileRef = useRef<PlayerProfile>(profile);
  useEffect(() => {
    profileRef.current = profile;
  }, [profile]);
  const quickSwitchRef = useRef<(nextClass: RobotClass) => void>(() => {});

  const handleQuickSwitchClass = useCallback(
    (nextClass: RobotClass) => {
      userModifiedClassRef.current = true;
      const nextLoadout: LoadoutConfig = { ...profileRef.current.loadout, robotClass: nextClass };
      setProfile((prev) => ({ ...prev, loadout: { ...prev.loadout, robotClass: nextClass } }));
      void persistProfile({ loadout: nextLoadout });
    },
    [persistProfile],
  );

  useEffect(() => {
    quickSwitchRef.current = handleQuickSwitchClass;
  }, [handleQuickSwitchClass]);

  // Initialize Network & Three.js Engine once
  useEffect(() => {
    const pid = playerIdRef.current;
    const net = new GameNetworkClient(pid, `Prism-${pid.slice(-4).toUpperCase()}`);
    networkRef.current = net;

    const mount = canvasMountRef.current;
    if (!mount) return;

    const engine = new LaserTagEngine(
      mount,
      net,
      pid,
      DEFAULT_LOADOUT,
      DEFAULT_CONTROLLER,
      {
        onHudUpdate: (nextHud) => setHud(nextHud),
        onVoicePttChange: (active) => {
          net.setSpeaking(active);
          setVoiceSpeaking(net.isSpeaking);
        },
        onQuickSwitchClass: (nextClass) => quickSwitchRef.current(nextClass),
      },
    );
    engineRef.current = engine;
    engine.setLanguage(langRef.current);
    engine.setPhase(phaseRef.current);

    net.setListeners({
      onConnectionChange: (isConn) => setConnected(isConn),
      onPingUpdate: (rtt) => setPingMs(rtt),
      onRoomJoined: (data) => {
        setCurrentRoomId(data.roomId);
        setSnapshot(data.snapshot);
        engine.syncToRoomJoin(data.snapshot);
      },
      onRoomReset: (data) => {
        setSnapshot(data.snapshot);
        engine.syncToRoomJoin(data.snapshot);
      },
      onSnapshot: (snap) => {
        setSnapshot(snap);
        engine.applySnapshot(snap);
      },
      onBeam: (beam) => engine.spawnBeamVisual(beam),
      onHitConfirm: (info) => engine.onHitConfirmed(info.killed),
      onBarrierShatter: (id) => engine.onBarrierShattered(id),
      onAntiCheatCorrect: (pos) => engine.applyServerCorrection(pos),
      onEconomyNotice: (notice) => engine.handleEconomyNotice(notice),
      onMatched: () => {
        setQueuing(false);
        setActiveModal('none');
        setPhase('playing');
      },
      onMatchSummary: (summary) => {
        setMatchSummary(summary);
        soundEngine.playMatchEnd(summary.won);
        setPhase('gameover');
        // Refresh profile stats after match end
        fetch(`/api/profile/${encodeURIComponent(pid)}`)
          .then((r) => (r.ok ? r.json() : null))
          .then((p) => {
            if (p) setProfile(normalizePlayerProfile(p, pid));
          })
          .catch(() => {});
      },
      onChat: (msg) => {
        setChatMessages((prev) => [...prev.slice(-14), msg]);
      },
    });

    net.connect();

    // Load saved profile from server
    fetch(`/api/profile/${encodeURIComponent(pid)}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((loaded: Partial<PlayerProfile> | null) => {
        if (loaded) {
          const normalized = normalizePlayerProfile(loaded, pid);
          const effectiveLoadout = userModifiedClassRef.current
            ? { ...normalized.loadout, robotClass: profileRef.current.loadout.robotClass }
            : normalized.loadout;
          setProfile((prev) => {
            if (userModifiedClassRef.current) {
              return { ...normalized, loadout: { ...normalized.loadout, robotClass: prev.loadout.robotClass } };
            }
            return normalized;
          });
          net.setIdentity(normalized.id, normalized.callsign);
          engine.updateConfig(effectiveLoadout, normalized.controller);
        }
      })
      .catch(() => {});

    return () => {
      engine.dispose();
      net.dispose();
    };
  }, []);

  // Sync config changes to engine
  useEffect(() => {
    engineRef.current?.updateConfig(profile.loadout, profile.controller);
  }, [profile.loadout, profile.controller]);

  const startArenaPlay = useCallback(() => {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
    setMatchSummary(null);
    setActiveModal('none');
    document.body.dataset.state = 'playing';
    setPhase('playing');
    engineRef.current?.requestPointerLock();
  }, []);

  const handlePlayAgain = useCallback(() => {
    networkRef.current?.requestRematch();
    startArenaPlay();
  }, [startArenaPlay]);

  // Global keyboard shortcuts (Title Enter/Space, Pause Esc/P, Mute M)
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

      if (phaseRef.current === 'title' && activeModalRef.current === 'none') {
        if (e.code === 'Enter' || e.code === 'Space') {
          e.preventDefault();
          startArenaPlay();
        }
        return;
      }

      if (e.code === 'Escape' || e.code === 'KeyP') {
        if (activeModalRef.current !== 'none') {
          setActiveModal('none');
        } else if (phaseRef.current === 'playing') {
          setPhase('paused');
        } else if (phaseRef.current === 'paused') {
          setPhase('playing');
        }
      } else if (e.code === 'KeyM') {
        setMuted((prev) => {
          const next = !prev;
          soundEngine.setMuted(next);
          return next;
        });
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [startArenaPlay]);

  const handleToggleMute = () => {
    setMuted((prev) => {
      const next = !prev;
      soundEngine.setMuted(next);
      return next;
    });
  };

  const handleToggleVoiceChannel = () => {
    const order: VoiceChannel[] = ['team', 'squad', 'proximity', 'muted'];
    const next = order[(order.indexOf(voiceChannel) + 1) % order.length];
    setVoiceChannel(next);
    networkRef.current?.setVoiceChannel(next);
  };

  const handleUpdateLoadout = (loadout: LoadoutConfig) => {
    setProfile((prev) => ({ ...prev, loadout }));
    persistProfile({ loadout });
  };

  const handleUpdateController = (controller: ControllerConfig) => {
    setProfile((prev) => ({ ...prev, controller }));
    persistProfile({ controller });
  };

  const handleUpdateProfileMeta = (callsign: string, platform: PlatformType, crossplayEnabled: boolean) => {
    const clean = callsign.trim() || profile.callsign;
    setProfile((prev) => ({ ...prev, callsign: clean, platform, crossplayEnabled }));
    networkRef.current?.setIdentity(profile.id, clean);
    persistProfile({ callsign: clean, platform, crossplayEnabled });
  };

  return (
    <div className="relative w-full h-full overflow-hidden bg-[#0A0D12]">
      {/* Isolated WebGL Viewport */}
      <div
        ref={canvasMountRef}
        data-testid="arena-canvas-mount"
        className="fixed inset-0 w-full h-full"
      />

      {/* Title Screen */}
      {phase === 'title' && activeModal === 'none' && (
        <TitleOverlay
          profile={profile}
          connected={connected}
          pingMs={pingMs}
          onSelectRobotClass={handleQuickSwitchClass}
          onStartMatch={startArenaPlay}
          onOpenLoadout={() => setActiveModal('loadout')}
          onOpenSocial={() => setActiveModal('social')}
          onOpenStats={() => setActiveModal('stats')}
          onOpenSettings={() => setActiveModal('settings')}
        />
      )}

      {/* Playing HUD */}
      {phase === 'playing' && activeModal === 'none' && (
        <GameHud
          hud={hud}
          snapshot={snapshot}
          localPlayerId={profile.id}
          loadout={profile.loadout}
          controller={profile.controller}
          pingMs={pingMs}
          muted={muted}
          voiceChannel={voiceChannel}
          voiceSpeaking={voiceSpeaking}
          chatMessages={chatMessages}
          onToggleMute={handleToggleMute}
          onToggleVoiceChannel={handleToggleVoiceChannel}
          onPause={() => setPhase('paused')}
          onRequestPointerLock={() => engineRef.current?.requestPointerLock()}
          onSendChat={(text) => networkRef.current?.send('chat:send', { text })}
          onBuyAmmo={(packId: AmmoPackId) => engineRef.current?.buyAmmoPack(packId)}
          onTriggerClassSkill={() => engineRef.current?.triggerClassSkillPublic()}
          onQuickSwitchClass={handleQuickSwitchClass}
        />
      )}

      {/* Pause Modal */}
      {phase === 'paused' && activeModal === 'none' && (
        <PauseModal
          robotClass={profile.loadout.robotClass}
          onQuickSwitchClass={handleQuickSwitchClass}
          onResume={() => {
            setPhase('playing');
            engineRef.current?.requestPointerLock();
          }}
          onOpenLoadout={() => setActiveModal('loadout')}
          onOpenSettings={() => setActiveModal('settings')}
          onReturnToTitle={() => setPhase('title')}
        />
      )}

      {/* Match Complete / Victory / Defeat Modal */}
      {phase === 'gameover' && matchSummary && activeModal === 'none' && (
        <GameOverModal
          summary={matchSummary}
          onPlayAgain={handlePlayAgain}
          onReturnToTitle={() => {
            setMatchSummary(null);
            setPhase('title');
          }}
        />
      )}

      {/* Feature Modals */}
      {activeModal === 'loadout' && (
        <LoadoutModal
          profile={profile}
          onUpdateLoadout={handleUpdateLoadout}
          onClose={() => setActiveModal('none')}
        />
      )}

      {activeModal === 'social' && (
        <SocialLobbyModal
          profile={profile}
          currentRoomId={currentRoomId}
          voiceChannel={voiceChannel}
          voiceInputMode={voiceInputMode}
          micReady={micReady}
          micError={micError}
          queuing={queuing}
          onJoinRoom={(roomId) => {
            networkRef.current?.joinRoom(roomId);
            setActiveModal('none');
            setPhase('playing');
          }}
          onStartMatchmaking={(mode: GameModeId, mapId: MapId) => {
            setQueuing(true);
            networkRef.current?.joinMatchmaking(mode, mapId);
          }}
          onCancelMatchmaking={() => {
            setQueuing(false);
            networkRef.current?.leaveMatchmaking();
          }}
          onToggleCrossplay={(enabled) => handleUpdateProfileMeta(profile.callsign, profile.platform, enabled)}
          onChangeVoice={(ch, mode) => {
            setVoiceChannel(ch);
            setVoiceInputMode(mode);
            if (networkRef.current) {
              networkRef.current.voiceInputMode = mode;
              networkRef.current.setVoiceChannel(ch);
            }
          }}
          onInitMic={async () => {
            if (!networkRef.current) return;
            const ok = await networkRef.current.initMicrophone();
            setMicReady(ok);
            setMicError(networkRef.current.micError);
          }}
          onClose={() => setActiveModal('none')}
        />
      )}

      {activeModal === 'stats' && (
        <StatsModal
          profile={profile}
          antiCheat={snapshot?.antiCheat}
          pingMs={pingMs}
          onClose={() => setActiveModal('none')}
        />
      )}

      {activeModal === 'settings' && (
        <SettingsModal
          profile={profile}
          onUpdateProfileMeta={handleUpdateProfileMeta}
          onUpdateController={handleUpdateController}
          onClose={() => setActiveModal('none')}
        />
      )}
    </div>
  );
}

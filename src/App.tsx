import { useCallback, useEffect, useRef, useState } from 'react';
import { soundEngine } from './audio/soundEngine';
import { AccountPanel, accountActionFromUrl } from './components/AccountPanel';
import { GameHud } from './components/GameHud';
import { GameOverModal } from './components/GameOverModal';
import { LoadoutModal } from './components/LoadoutModal';
import { ModerationPanel } from './components/ModerationPanel';
import { MatchReady, MultiplayerLobby } from './components/MultiplayerLobby';
import { PauseModal } from './components/PauseModal';
import type { ChatViewProps } from './components/RoomChat';
import { SettingsModal } from './components/SettingsModal';
import { StatsModal } from './components/StatsModal';
import { TitleOverlay } from './components/TitleOverlay';
import { LaserTagEngine, type HudLiveState } from './game/LaserTagEngine';
import { useI18n } from './i18n/LanguageContext';
import { multiplayerError, MULTIPLAYER_TEXT } from './i18n/multiplayer';
import { ApiError, postJson, requestJson, type AccountSession } from './net/account';
import { GameNetworkClient, type ChatMessage, type MatchSummaryPayload, type SessionView } from './net/clientSocket';
import { INITIAL_TEAM_CREDITS, normalizePlayerProfile } from './shared/catalog';
import type { ControllerConfig, GamePhase, LoadoutConfig, MatchSnapshot, PlayerProfile, RobotClass } from './shared/types';

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


type ActiveModal = 'none' | 'loadout' | 'lobby' | 'stats' | 'settings' | 'moderation';
const matchKey = (id: string) => 'prism-latest-match:' + id;
function rememberedMatch(id: string): string | null {
  try { return sessionStorage.getItem(matchKey(id)); } catch { return null; }
}
function rememberMatch(playerId: string, matchId?: string) {
  try { if (matchId) sessionStorage.setItem(matchKey(playerId), matchId); else sessionStorage.removeItem(matchKey(playerId)); } catch { /* Storage is optional. */ }
}

export default function App() {
  const { lang } = useI18n();
  const t = MULTIPLAYER_TEXT[lang];
  const [emailAction] = useState(accountActionFromUrl);
  const [account, setAccount] = useState<AccountSession | null | undefined>(emailAction ? null : undefined);
  const [loadFailed, setLoadFailed] = useState(false);
  const checkSession = useCallback(async () => {
    setLoadFailed(false);
    try { setAccount(await requestJson<AccountSession>('/api/auth/session')); }
    catch (err) {
      if (err instanceof ApiError && err.status === 401) setAccount(null);
      else setLoadFailed(true);
    }
  }, []);
  useEffect(() => { if (!emailAction) void checkSession(); }, [checkSession, emailAction]);

  if (account === undefined) return <main className="grid h-full place-items-center text-slate-300">
    {loadFailed ? <div className="text-center"><p role="alert">{t.error}</p><button type="button" onClick={() => void checkSession()} className="mt-2 text-cyan-300">{t.retry}</button></div> : <p role="status">{t.loading}</p>}
  </main>;
  if (account === null) return <AccountPanel onSignIn={setAccount} />;
  return <Arena key={account.playerId} playerId={account.playerId} moderator={account.moderator} onSignedOut={() => setAccount(null)} />;
}

function Arena({ playerId, moderator, onSignedOut }: { playerId: string; moderator?: boolean; onSignedOut: () => void }) {
  const { lang } = useI18n();
  const t = MULTIPLAYER_TEXT[lang];
  const langRef = useRef(lang);
  const canvasMountRef = useRef<HTMLDivElement | null>(null);
  const engineRef = useRef<LaserTagEngine | null>(null);
  const networkRef = useRef<GameNetworkClient | null>(null);
  const [phase, setPhaseState] = useState<GamePhase>('title');
  const phaseRef = useRef<GamePhase>('title');
  const [activeModal, setActiveModal] = useState<ActiveModal>('none');
  const activeModalRef = useRef<ActiveModal>('none');
  const [profile, setProfile] = useState<PlayerProfile>(() => normalizePlayerProfile(null, playerId));
  const profileRef = useRef(profile);
  const [snapshot, setSnapshot] = useState<MatchSnapshot | null>(null);
  const [hud, setHud] = useState<HudLiveState>(INITIAL_HUD);
  const [connected, setConnected] = useState(false);
  const [synced, setSynced] = useState(false);
  const [connectionIssue, setConnectionIssue] = useState<'superseded' | 'ineligible'>();
  const [rendererError, setRendererError] = useState(false);
  const [pingMs, setPingMs] = useState(0);
  const [view, setView] = useState<SessionView>({});
  const viewRef = useRef<SessionView>({});
  const [muted, setMuted] = useState(false);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [blockedIds, setBlockedIds] = useState<string[]>([]);
  const [matchSummary, setMatchSummary] = useState<MatchSummaryPayload | null>(null);
  const [notice, setNotice] = useState('');
  const currentMatchRef = useRef<string | undefined>(undefined);
  const [resultMatchId, setResultMatchId] = useState<string>();
  const summaryRef = useRef<MatchSummaryPayload | null>(null);
  const dismissedResult = useRef<string | undefined>(undefined);
  const leavingMatch = useRef<string | undefined>(undefined);
  const recoverId = useRef(rememberedMatch(playerId));
  const saves = useRef(Promise.resolve());
  const saveVersion = useRef(0);

  const setPhase = useCallback((next: GamePhase) => {
    if (next === phaseRef.current) return;
    phaseRef.current = next;
    document.body.dataset.state = next;
    engineRef.current?.setPhase(next);
    setPhaseState(next);
  }, []);
  useEffect(() => { activeModalRef.current = activeModal; }, [activeModal]);
  useEffect(() => { langRef.current = lang; engineRef.current?.setLanguage(lang); }, [lang]);
  const updateProfile = useCallback((next: PlayerProfile) => {
    profileRef.current = next;
    setProfile(next);
    engineRef.current?.updateConfig(next.loadout, next.controller);
  }, []);
  const loadProfile = useCallback(async () => {
    const version = saveVersion.current;
    try {
      const next = await requestJson<PlayerProfile>('/api/profile');
      if (saveVersion.current === version) updateProfile(normalizePlayerProfile(next, playerId));
    } catch { /* Most often a transient disconnect; keep the current configuration. */ }
  }, [playerId, updateProfile]);
  const persistProfile = useCallback((patch: Partial<PlayerProfile>) => {
    const version = ++saveVersion.current;
    updateProfile({ ...profileRef.current, ...patch });
    saves.current = saves.current.then(async () => {
      try {
        const next = await postJson<PlayerProfile>('/api/profile', patch);
        if (version === saveVersion.current) updateProfile(normalizePlayerProfile(next, playerId));
      } catch (err) {
        if (version === saveVersion.current) {
          setNotice(err instanceof Error && err.message ? err.message : MULTIPLAYER_TEXT[langRef.current].error);
          void loadProfile();
        }
      }
    });
  }, [loadProfile, playerId, updateProfile]);
  const quickSwitch = useCallback((robotClass: RobotClass) => {
    persistProfile({ loadout: { ...profileRef.current.loadout, robotClass } });
  }, [persistProfile]);

  const showResult = useCallback((summary: MatchSummaryPayload) => {
    if (summary.matchId === dismissedResult.current || summary.matchId === leavingMatch.current) return;
    if (summary.matchId && summaryRef.current?.matchId === summary.matchId) return;
    if (currentMatchRef.current && summary.matchId && currentMatchRef.current !== summary.matchId) return;
    summaryRef.current = summary;
    setMatchSummary(summary);
    setActiveModal('none');
    setPhase('gameover');
    if (summary.cancelled) setNotice('');
    else soundEngine.playMatchEnd(summary.won);
    void loadProfile();
  }, [loadProfile, setPhase]);

  useEffect(() => {
    const net = new GameNetworkClient();
    networkRef.current = net;
    const mount = canvasMountRef.current;
    let engine: LaserTagEngine | null = null;
    if (mount) {
      try {
        engine = new LaserTagEngine(mount, net, playerId, profileRef.current.loadout, profileRef.current.controller, {
          onHudUpdate: setHud,
          onVoicePttChange: () => {},
          onQuickSwitchClass: quickSwitch,
        });
        engineRef.current = engine;
        engine.setLanguage(langRef.current);
      } catch { setRendererError(true); }
    }
    let snapshotRoundId: string | undefined;
    let resumePhase: GamePhase = 'playing';
    let active = true;
    net.setListeners({
      onConnectionChange: (open, code) => {
        if (!active) return;
        setConnected(open);
        if (open) return;
        setSynced(false);
        if (phaseRef.current === 'playing' || phaseRef.current === 'paused') {
          resumePhase = phaseRef.current;
          engine?.setPhase('paused');
          snapshotRoundId = undefined;
        }
        if (code === 4009 || code === 4409) setConnectionIssue('superseded');
        else if (code === 4403) setConnectionIssue('ineligible');
        else if (code === 4001 || code === 4401) void requestJson('/api/auth/session')
          .then(() => { if (active) setConnectionIssue('ineligible'); })
          .catch(() => { if (active) onSignedOut(); });
        else void requestJson('/api/auth/session').catch(err => { if (active && err instanceof ApiError && err.status === 401) onSignedOut(); });
      },
      onSession: (next) => {
        const previous = viewRef.current;
        if (next.room?.phase !== 'active') setSynced(true);
        viewRef.current = next;
        setView(next);
        if (previous.room?.roomId !== next.room?.roomId) setChatMessages([]);
        if (next.message) setNotice(next.message);
        if (next.summary) showResult(next.summary);
        if (next.room?.phase === 'active') {
          if (currentMatchRef.current !== next.room.matchId) resumePhase = 'playing';
          setActiveModal('none');
          return;
        }
        if (next.room?.phase === 'ended' && !summaryRef.current && next.room.matchId !== dismissedResult.current) {
          setActiveModal('none');
          setResultMatchId(next.room.matchId || currentMatchRef.current);
          setPhase('gameover');
          return;
        }
        const interruptedMatch = currentMatchRef.current;
        if (interruptedMatch && !summaryRef.current && next.room?.phase !== 'ended' && interruptedMatch !== dismissedResult.current && interruptedMatch !== leavingMatch.current) {
          setResultMatchId(interruptedMatch);
          if (phaseRef.current !== 'gameover') { setActiveModal('lobby'); setPhase('title'); }
          if (!next.room) setNotice(MULTIPLAYER_TEXT[langRef.current].seatUnavailable);
          snapshotRoundId = undefined;
          return;
        }
        if (next.room || next.queuedAt || next.offer) {
          if (!summaryRef.current) { setPhase('title'); setActiveModal('lobby'); }
        } else if (!summaryRef.current && phaseRef.current !== 'gameover') {
          setPhase('title');
          if (previous.room) setActiveModal('lobby');
          setSnapshot(null);
          currentMatchRef.current = undefined;
          snapshotRoundId = undefined;
        }
      },
      onError: error => setNotice(multiplayerError(langRef.current, error.code)),
      onPingUpdate: setPingMs,
      onSnapshot: (snap) => {
        const room = viewRef.current.room;
        if (!room || room.roomId !== snap.roomId || !snap.players.some(p => p.id === playerId)) return;
        if (room.matchId && snap.matchId && room.matchId !== snap.matchId) return;
        if (room.phase === 'waiting') return;
        const round = snap.matchId ?? room.matchId ?? snap.roomId;
        if (round === dismissedResult.current) return;
        setSynced(true);
        if (snap.phase === 'active' && summaryRef.current?.matchId === round) return;
        setSnapshot(snap);
        if (snapshotRoundId !== round) {
          if (currentMatchRef.current !== round) {
            leavingMatch.current = undefined;
            summaryRef.current = null;
            setMatchSummary(null);
            setResultMatchId(undefined);
          }
          snapshotRoundId = round;
          currentMatchRef.current = round;
          rememberMatch(playerId, round);
          recoverId.current = null;
          engine?.syncToRoomJoin(snap);
          if (snap.phase === 'active') {
            setActiveModal('none');
            setPhase(resumePhase);
            engine?.setPhase(resumePhase);
            resumePhase = 'playing';
          }
        } else engine?.applySnapshot(snap);
        if (snap.phase === 'ended' && !summaryRef.current) { setResultMatchId(round); setPhase('gameover'); }
      },
      onBeam: (beam) => engine?.spawnBeamVisual(beam),
      onHitConfirm: (info) => engine?.onHitConfirmed(info.killed),
      onBarrierShatter: (id) => engine?.onBarrierShattered(id),
      onEconomyNotice: (info) => engine?.handleEconomyNotice(info),
      onMatchSummary: showResult,
      onChat: (msg) => setChatMessages(previous => [...previous.slice(-49), msg]),
    });
    net.connect();
    void loadProfile();
    void requestJson<{ playerIds: string[] }>('/api/chat/blocks').then(body => { if (active && Array.isArray(body.playerIds)) setBlockedIds(body.playerIds); }).catch(() => {});
    return () => {
      active = false;
      net.dispose();
      engine?.dispose();
      networkRef.current = null;
      engineRef.current = null;
      document.body.dataset.state = 'title';
    };
  // Network and rendering lifetime is keyed by the authenticated player ID.
  // The sign-out callback is intentionally read from the instance that started the session.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadProfile, playerId, quickSwitch, setPhase, showResult]);

  // A page refresh can occur after server settlement or while delivery is still pending.
  useEffect(() => {
    const matchId = resultMatchId ?? recoverId.current;
    if (!synced || !matchId || matchId === dismissedResult.current || matchId === leavingMatch.current || matchSummary || view.room?.phase === 'active') return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    let attempts = 0;
    const lookup = async () => {
      try {
        const reply = await requestJson<{ summary?: MatchSummaryPayload; status?: string } & Partial<MatchSummaryPayload>>('/api/matches/' + encodeURIComponent(matchId));
        if (stopped || matchId === dismissedResult.current || matchId === leavingMatch.current) return;
        const summary = reply.summary ?? (reply.matchId && typeof reply.kills === 'number' ? reply as MatchSummaryPayload : undefined);
        if (summary) { showResult({ ...summary, matchId }); return; }
        if (reply.status === 'cancelled') { showResult({ matchId, won: false, cancelled: true, kills: 0, deaths: 0, accuracy: 0, xpEarned: 0, scoreCobalt: 0, scoreAmber: 0 }); return; }
      } catch { /* The room may still be committing the result. */ }
      if (!stopped && ++attempts < 35) timer = setTimeout(lookup, 1000);
      else if (!stopped && phaseRef.current === 'gameover') setNotice(MULTIPLAYER_TEXT[langRef.current].resultPending);
    };
    void lookup();
    return () => { stopped = true; clearTimeout(timer); };
  }, [synced, resultMatchId, matchSummary, showResult, view.room?.phase]);

  const send = useCallback((type: string, payload: object = {}) => {
    const sent = networkRef.current?.send(type, payload) ?? false;
    setNotice(sent ? '' : MULTIPLAYER_TEXT[langRef.current].missingConnection);
    return sent;
  }, []);
  const toggleMute = useCallback(() => setMuted(value => { soundEngine.setMuted(!value); return !value; }), []);
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if ((event.target as HTMLElement | null)?.closest?.('input,textarea,select,button,[contenteditable]')) return;
      if (event.code === 'Escape' || event.code === 'KeyP') {
        if (activeModalRef.current !== 'none') setActiveModal('none');
        else if (phaseRef.current === 'playing') setPhase('paused');
        else if (phaseRef.current === 'paused' && synced) setPhase('playing');
      } else if (event.code === 'KeyM') toggleMute();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [setPhase, synced, toggleMute]);

  const dismissResult = () => {
    dismissedResult.current = summaryRef.current?.matchId ?? resultMatchId ?? recoverId.current ?? undefined;
    currentMatchRef.current = undefined;
    summaryRef.current = null;
    setMatchSummary(null);
    setResultMatchId(undefined);
    recoverId.current = null;
    rememberMatch(playerId);
    setPhase('title');
    setActiveModal('lobby');
  };
  const leave = () => {
    if (phaseRef.current === 'playing' || phaseRef.current === 'paused') {
      if (!window.confirm(t.leaveBattle)) return;
    }
    if (send('room:leave')) { leavingMatch.current = currentMatchRef.current; recoverId.current = null; rememberMatch(playerId); }
  };
  const logout = async () => {
    try { await postJson('/api/auth/logout'); onSignedOut(); }
    catch (err) { setNotice(err instanceof Error && err.message ? err.message : t.error); }
  };
  const chat: ChatViewProps = {
    messages: chatMessages, playerId, blockedIds,
    onSend: text => send('chat:send', { text }),
    onBlockChanged: (id, block) => setBlockedIds(ids => block ? Array.from(new Set([...ids, id])) : ids.filter(value => value !== id)),
  };

  return <div className="relative h-full w-full overflow-hidden bg-[#0A0D12]">
    <div ref={canvasMountRef} data-testid="arena-canvas-mount" className="fixed inset-0 h-full w-full" />
    {phase === 'title' && activeModal === 'none' && <TitleOverlay profile={profile} connected={connected && synced} pingMs={pingMs}
      onSelectRobotClass={quickSwitch} onStartMatch={() => setActiveModal('lobby')} onOpenLoadout={() => setActiveModal('loadout')}
      onOpenModeration={moderator ? () => setActiveModal('moderation') : undefined} onOpenStats={() => setActiveModal('stats')} onOpenSettings={() => setActiveModal('settings')} onSignOut={logout} />}
    {phase === 'playing' && activeModal === 'none' && connected && synced && <GameHud hud={hud} snapshot={snapshot} localPlayerId={playerId}
      loadout={profile.loadout} controller={profile.controller} pingMs={pingMs} muted={muted} chat={chat} onToggleMute={toggleMute}
      onPause={() => setPhase('paused')} onRequestPointerLock={() => engineRef.current?.requestPointerLock()}
      onBuyAmmo={packId => engineRef.current?.buyAmmoPack(packId)} onTriggerClassSkill={() => engineRef.current?.triggerClassSkillPublic()} onQuickSwitchClass={quickSwitch} />}
    {phase === 'paused' && activeModal === 'none' && connected && synced && <PauseModal robotClass={profile.loadout.robotClass} onQuickSwitchClass={quickSwitch}
      onResume={() => { setPhase('playing'); engineRef.current?.requestPointerLock(); }} onOpenLoadout={() => setActiveModal('loadout')}
      onOpenSettings={() => setActiveModal('settings')} onReturnToTitle={leave} />}
    {phase === 'gameover' && matchSummary && <GameOverModal summary={matchSummary} isPrivate={matchSummary.isPrivate ?? view.room?.isPrivate ?? snapshot?.isPrivate ?? false}
      onPlayAgain={!matchSummary.isPrivate && !view.room && !snapshot?.isPrivate && connected && synced ? () => { dismissResult(); send('queue:join'); } : undefined}
      onReturnToTitle={dismissResult} />}
    {phase === 'gameover' && !matchSummary && <div className="fixed inset-0 z-30 grid place-items-center bg-black/75 p-4">
      <section className="rounded bg-[#101926] p-6 text-center"><p role="status">{t.resultPending}</p><button type="button" className="mt-4 text-cyan-300" onClick={dismissResult}>{t.lobby}</button></section>
    </div>}
    {activeModal === 'loadout' && <LoadoutModal profile={profile} onUpdateLoadout={(loadout: LoadoutConfig) => persistProfile({ loadout })} onClose={() => setActiveModal('none')} />}
    {activeModal === 'lobby' && <MultiplayerLobby view={view} playerId={playerId} connected={connected && synced} chat={chat} onClose={() => setActiveModal('none')}
      onQueue={join => { send(join ? 'queue:join' : 'queue:leave'); }} onJoinRoom={code => { send('room:join', { roomId: code }); }}
      onCreateRoom={({ botFill, ...settings }) => { send('room:create', { ...settings, fillBots: botFill }); }} onStart={() => send('room:start')} onLeave={leave} />}
    {activeModal === 'stats' && <StatsModal profile={profile} pingMs={pingMs} antiCheat={snapshot?.antiCheat} onClose={() => setActiveModal('none')} />}
    {activeModal === 'settings' && <SettingsModal profile={profile} onUpdateProfileMeta={callsign => persistProfile({ callsign })}
      onUpdateController={(controller: ControllerConfig) => persistProfile({ controller })} onClose={() => setActiveModal('none')} />}
    {activeModal === 'moderation' && moderator && <ModerationPanel onClose={() => setActiveModal('none')} />}
    {view.offer && synced && view.room?.phase !== 'active' && <MatchReady key={view.offer.offerId} offer={view.offer} connected={connected} onRespond={accept => { send('queue:confirm', { readyId: view.offer?.offerId, accept }); }} />}
    {(!connected || !synced || rendererError || notice) && <div className="pointer-events-none fixed inset-x-0 top-2 z-[60] flex flex-col items-center gap-2 px-4 text-sm">
      {(!connected || !synced) && <div role="status" className="pointer-events-auto rounded border border-amber-700 bg-[#191303] px-3 py-2 text-amber-200">
        {connectionIssue === 'superseded' ? t.superseded : connectionIssue === 'ineligible' ? multiplayerError(lang, 'ineligible') : t.reconnecting}
        {connectionIssue && <button type="button" className="ml-2 text-cyan-300" onClick={() => { setConnectionIssue(undefined); networkRef.current?.connect(); }}>{t.retry}</button>}
      </div>}
      {rendererError && <p role="alert" className="rounded border border-red-800 bg-[#24131A] px-3 py-2 text-red-200">{t.engineError}</p>}
      {notice && <div role="alert" className="pointer-events-auto flex gap-3 rounded border border-cyan-800 bg-[#0B1927] px-3 py-2 text-slate-200">
        {notice}<button type="button" aria-label={t.close} className="text-cyan-300" onClick={() => setNotice('')}>×</button>
      </div>}
    </div>}
  </div>;
}

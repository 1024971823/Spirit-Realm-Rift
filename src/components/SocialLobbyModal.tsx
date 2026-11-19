import React, { useEffect, useState } from 'react';
import { Globe, Lock, Mic, Plus, Radio, UserPlus, Users, X } from 'lucide-react';
import { useI18n } from '../i18n/LanguageContext';
import {
  MAP_I18N,
  MODE_I18N,
  translateDynamicLabel,
  translateSkillTier,
  VOICE_CHANNEL_LABELS,
} from '../i18n/translations';
import { MAPS } from '../shared/catalog';
import { getSkillTier } from '../shared/matchmaking';
import type {
  FriendEntry,
  GameModeId,
  LobbyConfig,
  MapId,
  PlayerProfile,
  VoiceChannel,
  VoiceInputMode,
} from '../shared/types';

interface SocialLobbyModalProps {
  profile: PlayerProfile;
  currentRoomId: string;
  voiceChannel: VoiceChannel;
  voiceInputMode: VoiceInputMode;
  micReady: boolean;
  micError: string | null;
  onJoinRoom: (roomId: string) => void;
  onStartMatchmaking: (mode: GameModeId, mapId: MapId) => void;
  onCancelMatchmaking: () => void;
  queuing: boolean;
  onToggleCrossplay: (enabled: boolean) => void;
  onChangeVoice: (channel: VoiceChannel, mode: VoiceInputMode) => void;
  onInitMic: () => void;
  onClose: () => void;
}

export const SocialLobbyModal: React.FC<SocialLobbyModalProps> = ({
  profile,
  currentRoomId,
  voiceChannel,
  voiceInputMode,
  micReady,
  micError,
  onJoinRoom,
  onStartMatchmaking,
  onCancelMatchmaking,
  queuing,
  onToggleCrossplay,
  onChangeVoice,
  onInitMic,
  onClose,
}) => {
  const { lang, t } = useI18n();
  const [tab, setTab] = useState<'matchmake' | 'private' | 'friends'>('matchmake');
  const [lobbies, setLobbies] = useState<LobbyConfig[]>([]);
  const [friends, setFriends] = useState<FriendEntry[]>([]);
  const [friendInput, setFriendInput] = useState('');
  const [friendMsgKey, setFriendMsgKey] = useState<
    null | 'cannotAddSelf' | 'friendAdded' | 'friendExists' | 'friendAddFail' | 'friendNetErr'
  >(null);

  // Matchmaking options
  const [mmMode, setMmMode] = useState<GameModeId>('team_clash');
  const [mmMap, setMmMap] = useState<MapId>('reactor_foundry');

  // Private lobby creation
  const [privName, setPrivName] = useState(() => t.defaultPrivateName(profile.callsign));
  const [privMap, setPrivMap] = useState<MapId>('reactor_foundry');
  const [privMode, setPrivMode] = useState<GameModeId>('team_clash');
  const [privHazards, setPrivHazards] = useState<'standard' | 'overdrive'>('standard');
  const [privFriendlyFire, setPrivFriendlyFire] = useState(false);
  const [joinCode, setJoinCode] = useState('');
  const [lobbyErrorKey, setLobbyErrorKey] = useState<
    null | 'createLobbyErr' | 'enterRoomCodeErr' | 'lobbyNotFoundErr' | 'networkCheckErr'
  >(null);
  const [createdCode, setCreatedCode] = useState<string | null>(null);

  const tier = getSkillTier(profile.stats.mmr);

  const loadLobbiesAndFriends = async () => {
    try {
      const [lRes, fRes] = await Promise.all([
        fetch('/api/lobbies'),
        fetch(`/api/friends/${encodeURIComponent(profile.id)}`),
      ]);
      if (lRes.ok) {
        const data = (await lRes.json()) as { lobbies: LobbyConfig[] };
        setLobbies(data.lobbies || []);
      }
      if (fRes.ok) {
        const fData = (await fRes.json()) as { friends: FriendEntry[] };
        setFriends(fData.friends || []);
      }
    } catch {
      // Ignore network hiccup
    }
  };

  useEffect(() => {
    loadLobbiesAndFriends();
  }, [profile.id]);

  const handleCreatePrivate = async (e: React.FormEvent) => {
    e.preventDefault();
    setLobbyErrorKey(null);
    try {
      const res = await fetch('/api/lobbies/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: privName.trim() || t.defaultPrivateName(profile.callsign),
          hostId: profile.id,
          hostCallsign: profile.callsign,
          isPrivate: true,
          mapId: privMap,
          mode: privMode,
          hazardIntensity: privHazards,
          friendlyFire: privFriendlyFire,
          crossplayPool: profile.crossplayEnabled,
        }),
      });
      if (res.ok) {
        const data = (await res.json()) as { lobby: LobbyConfig };
        setCreatedCode(data.lobby.roomId);
        onJoinRoom(data.lobby.roomId);
      }
    } catch {
      setLobbyErrorKey('createLobbyErr');
    }
  };

  const handleJoinByCode = async (e: React.FormEvent) => {
    e.preventDefault();
    setLobbyErrorKey(null);
    const code = joinCode.trim().toUpperCase();
    if (!code) {
      setLobbyErrorKey('enterRoomCodeErr');
      return;
    }
    try {
      const res = await fetch('/api/lobbies/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomId: code }),
      });
      if (!res.ok) {
        setLobbyErrorKey('lobbyNotFoundErr');
        return;
      }
      onJoinRoom(code);
    } catch {
      setLobbyErrorKey('networkCheckErr');
    }
  };

  const handleAddFriend = async (e: React.FormEvent) => {
    e.preventDefault();
    setFriendMsgKey(null);
    const trimmed = friendInput.trim();
    if (!trimmed) return;
    if (trimmed.toLowerCase() === profile.callsign.toLowerCase()) {
      setFriendMsgKey('cannotAddSelf');
      return;
    }
    try {
      const res = await fetch('/api/friends/add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ playerId: profile.id, callsign: trimmed }),
      });
      if (res.ok) {
        const data = (await res.json()) as { friends: FriendEntry[]; added: boolean };
        setFriends(data.friends);
        setFriendMsgKey(data.added ? 'friendAdded' : 'friendExists');
        setFriendInput('');
      } else {
        setFriendMsgKey('friendAddFail');
      }
    } catch {
      setFriendMsgKey('friendNetErr');
    }
  };

  const formatFriendStatus = (status: FriendEntry['status']) => {
    switch (status) {
      case 'online':
        return t.friendStatusOnline;
      case 'in_match':
        return t.friendStatusInMatch;
      case 'in_lobby':
        return t.friendStatusInLobby;
      default:
        return t.friendStatusOffline;
    }
  };

  return (
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-black/80 p-4">
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t.socialTitle}
        className="chamfer-panel w-full max-w-4xl max-h-[88vh] overflow-y-auto bg-[#0C121C] border border-cyan-500/25 p-6 shadow-2xl"
      >
        <div className="flex items-center justify-between pb-4 border-b border-white/10 mb-5">
          <div>
            <h2 className="font-display font-bold text-2xl text-white uppercase tracking-wide">{t.socialTitle}</h2>
            <p className="text-xs text-slate-400 font-mono-tabular mt-0.5">
              {t.activeRoom}: {currentRoomId} · {t.skillBracket}: {translateSkillTier(tier.label, lang)} ({profile.stats.mmr} MMR)
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

        {/* Navigation Tabs */}
        <div className="flex gap-2 mb-5">
          <button
            type="button"
            onClick={() => setTab('matchmake')}
            className={`chamfer-sm px-4 py-2 text-xs font-semibold cursor-pointer ${
              tab === 'matchmake' ? 'bg-amber-500 text-slate-950' : 'bg-[#121A28] text-slate-300 hover:text-white'
            }`}
          >
            {t.tabMatchmake}
          </button>
          <button
            type="button"
            onClick={() => setTab('private')}
            className={`chamfer-sm px-4 py-2 text-xs font-semibold cursor-pointer ${
              tab === 'private' ? 'bg-amber-500 text-slate-950' : 'bg-[#121A28] text-slate-300 hover:text-white'
            }`}
          >
            {t.tabPrivate}
          </button>
          <button
            type="button"
            onClick={() => setTab('friends')}
            className={`chamfer-sm px-4 py-2 text-xs font-semibold cursor-pointer ${
              tab === 'friends' ? 'bg-amber-500 text-slate-950' : 'bg-[#121A28] text-slate-300 hover:text-white'
            }`}
          >
            {t.tabFriends}
          </button>
        </div>

        {tab === 'matchmake' && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            {/* SBMM Matchmaker Card */}
            <div className="p-4 rounded-lg bg-[#141C2A] border border-white/10">
              <div className="flex items-center justify-between mb-3">
                <h3 className="font-display font-bold text-lg text-white">{t.sbmmTitle}</h3>
                <Globe className="w-4 h-4 text-cyan-400" />
              </div>

              <div className="space-y-3 mb-4">
                <div>
                  <label htmlFor="mm-mode" className="block text-xs text-slate-400 mb-1">{t.gameMode}</label>
                  <select
                    id="mm-mode"
                    value={mmMode}
                    onChange={(e) => setMmMode(e.target.value as GameModeId)}
                    className="w-full px-3 py-2 rounded bg-[#0C111A] border border-white/15 text-sm text-white"
                  >
                    <option value="team_clash">{MODE_I18N[lang].team_clash.full}</option>
                    <option value="control_core">{MODE_I18N[lang].control_core.full}</option>
                    <option value="ffa">{MODE_I18N[lang].ffa.full}</option>
                  </select>
                </div>

                <div>
                  <label htmlFor="mm-map" className="block text-xs text-slate-400 mb-1">{t.preferredArena}</label>
                  <select
                    id="mm-map"
                    value={mmMap}
                    onChange={(e) => setMmMap(e.target.value as MapId)}
                    className="w-full px-3 py-2 rounded bg-[#0C111A] border border-white/15 text-sm text-white"
                  >
                    {Object.values(MAPS).map((m) => (
                      <option key={m.id} value={m.id}>{MAP_I18N[lang][m.id]?.name ?? m.name}</option>
                    ))}
                  </select>
                </div>

                <label className="flex items-center justify-between p-2.5 rounded bg-[#0C111A] border border-white/10 cursor-pointer">
                  <span className="text-xs text-slate-200">{t.crossplayPool}</span>
                  <input
                    type="checkbox"
                    checked={profile.crossplayEnabled}
                    onChange={(e) => onToggleCrossplay(e.target.checked)}
                    className="accent-cyan-400"
                  />
                </label>
              </div>

              {!queuing ? (
                <button
                  type="button"
                  onClick={() => onStartMatchmaking(mmMode, mmMap)}
                  className="w-full py-2.5 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 font-display font-bold text-sm cursor-pointer"
                >
                  {t.findRankedMatch(profile.stats.mmr)}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={onCancelMatchmaking}
                  className="w-full py-2.5 rounded-lg bg-red-600 hover:bg-red-500 text-white font-display font-bold text-sm cursor-pointer"
                >
                  {t.searchingLobby}
                </button>
              )}
            </div>

            {/* Live Public Servers */}
            <div className="p-4 rounded-lg bg-[#141C2A] border border-white/10">
              <h3 className="font-display font-bold text-lg text-white mb-3">{t.liveServers}</h3>
              <div className="space-y-2.5">
                {lobbies.map((lob) => (
                  <div
                    key={lob.roomId}
                    className="p-3 rounded-lg bg-[#0C111A] border border-white/10 flex items-center justify-between gap-3"
                  >
                    <div>
                      <div className="text-sm font-semibold text-white">{translateDynamicLabel(lob.name, lang)}</div>
                      <div className="text-[11px] font-mono-tabular text-slate-400">
                        {MAP_I18N[lang][lob.mapId]?.name ?? MAPS[lob.mapId].name} · {MODE_I18N[lang][lob.mode]?.short ?? lob.mode} · {lob.playerCount}/{lob.maxPlayers} {t.operativesUnit}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => onJoinRoom(lob.roomId)}
                      className="px-3 py-1.5 rounded bg-cyan-500 hover:bg-cyan-400 text-slate-950 text-xs font-bold cursor-pointer whitespace-nowrap"
                    >
                      {currentRoomId === lob.roomId ? t.activeRoomBtn : t.deployRoomBtn}
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {tab === 'private' && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            <form onSubmit={handleCreatePrivate} className="p-4 rounded-lg bg-[#141C2A] border border-white/10 space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="font-display font-bold text-lg text-white">{t.createPrivateTitle}</h3>
                <Lock className="w-4 h-4 text-amber-400" />
              </div>

              <div>
                <label htmlFor="priv-name" className="block text-xs text-slate-400 mb-1">{t.lobbyName}</label>
                <input
                  id="priv-name"
                  type="text"
                  value={privName}
                  onChange={(e) => setPrivName(e.target.value)}
                  className="w-full px-3 py-2 rounded bg-[#0C111A] border border-white/15 text-sm text-white"
                />
              </div>

              <div className="grid grid-cols-2 gap-2.5">
                <div>
                  <label htmlFor="priv-map" className="block text-xs text-slate-400 mb-1">{t.arenaMap}</label>
                  <select
                    id="priv-map"
                    value={privMap}
                    onChange={(e) => setPrivMap(e.target.value as MapId)}
                    className="w-full px-2.5 py-2 rounded bg-[#0C111A] border border-white/15 text-xs text-white"
                  >
                    <option value="reactor_foundry">{MAP_I18N[lang].reactor_foundry.name}</option>
                    <option value="cryo_relay">{MAP_I18N[lang].cryo_relay.name}</option>
                  </select>
                </div>
                <div>
                  <label htmlFor="priv-mode" className="block text-xs text-slate-400 mb-1">{t.modeLabel}</label>
                  <select
                    id="priv-mode"
                    value={privMode}
                    onChange={(e) => setPrivMode(e.target.value as GameModeId)}
                    className="w-full px-2.5 py-2 rounded bg-[#0C111A] border border-white/15 text-xs text-white"
                  >
                    <option value="team_clash">{MODE_I18N[lang].team_clash.short}</option>
                    <option value="control_core">{MODE_I18N[lang].control_core.short}</option>
                    <option value="ffa">{MODE_I18N[lang].ffa.short}</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2.5">
                <div>
                  <label htmlFor="priv-haz" className="block text-xs text-slate-400 mb-1">{t.hazardIntensity}</label>
                  <select
                    id="priv-haz"
                    value={privHazards}
                    onChange={(e) => setPrivHazards(e.target.value as 'standard' | 'overdrive')}
                    className="w-full px-2.5 py-2 rounded bg-[#0C111A] border border-white/15 text-xs text-white"
                  >
                    <option value="standard">{t.hazardStandard}</option>
                    <option value="overdrive">{t.hazardOverdrive}</option>
                  </select>
                </div>
                <label className="flex items-center gap-2 px-3 py-2 rounded bg-[#0C111A] border border-white/15 text-xs text-slate-200 cursor-pointer self-end">
                  <input
                    type="checkbox"
                    checked={privFriendlyFire}
                    onChange={(e) => setPrivFriendlyFire(e.target.checked)}
                    className="accent-amber-400"
                  />
                  <span>{t.friendlyFire}</span>
                </label>
              </div>

              <button
                type="submit"
                className="w-full py-2.5 rounded-lg bg-amber-500 hover:bg-amber-400 text-slate-950 font-display font-bold text-sm cursor-pointer flex items-center justify-center gap-2"
              >
                <Plus className="w-4 h-4" />
                <span>{t.createAndDeploy}</span>
              </button>

              {createdCode && (
                <div className="p-2.5 rounded bg-emerald-950/60 border border-emerald-500/40 text-xs font-mono-tabular text-emerald-200">
                  {t.privateRoomCreated} <strong>{createdCode}</strong> ({t.shareCodeHint})
                </div>
              )}
            </form>

            <form onSubmit={handleJoinByCode} className="p-4 rounded-lg bg-[#141C2A] border border-white/10 space-y-3 h-fit">
              <h3 className="font-display font-bold text-lg text-white">{t.joinByCodeTitle}</h3>
              <p className="text-xs text-slate-400">
                {t.joinByCodeDesc}
              </p>
              <div>
                <label htmlFor="join-code" className="block text-xs text-slate-400 mb-1">{t.roomCodeLabel}</label>
                <input
                  id="join-code"
                  type="text"
                  placeholder="PRISM-4829"
                  value={joinCode}
                  onChange={(e) => setJoinCode(e.target.value)}
                  className="w-full px-3 py-2 rounded bg-[#0C111A] border border-white/15 text-sm font-mono-tabular text-white uppercase"
                />
              </div>
              {lobbyErrorKey && <p className="text-xs text-red-400">{t[lobbyErrorKey]}</p>}
              <button
                type="submit"
                className="w-full py-2.5 rounded-lg bg-cyan-500 hover:bg-cyan-400 text-slate-950 font-display font-bold text-sm cursor-pointer"
              >
                {t.joinPrivateLobby}
              </button>
            </form>
          </div>
        )}

        {tab === 'friends' && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
            {/* Friends Roster */}
            <div className="p-4 rounded-lg bg-[#141C2A] border border-white/10">
              <div className="flex items-center justify-between mb-3">
                <h3 className="font-display font-bold text-lg text-white flex items-center gap-2">
                  <Users className="w-4 h-4 text-cyan-400" />
                  <span>{t.friendsRoster}</span>
                </h3>
                <span className="text-xs font-mono-tabular text-slate-400">{t.operativesCount(friends.length)}</span>
              </div>

              <form onSubmit={handleAddFriend} className="flex gap-2 mb-3">
                <input
                  type="text"
                  aria-label={t.addCallsignPlaceholder}
                  placeholder={t.addCallsignPlaceholder}
                  value={friendInput}
                  onChange={(e) => setFriendInput(e.target.value)}
                  className="flex-1 px-3 py-1.5 rounded bg-[#0C111A] border border-white/15 text-xs text-white"
                />
                <button
                  type="submit"
                  className="px-3 py-1.5 rounded bg-cyan-500 hover:bg-cyan-400 text-slate-950 text-xs font-bold cursor-pointer flex items-center gap-1 whitespace-nowrap"
                >
                  <UserPlus className="w-3.5 h-3.5" />
                  <span>{t.addFriendBtn}</span>
                </button>
              </form>
              {friendMsgKey && <p className="text-[11px] text-emerald-400 mb-2">{t[friendMsgKey]}</p>}

              <div className="space-y-2 max-h-60 overflow-y-auto">
                {friends.map((f) => (
                  <div
                    key={f.id}
                    className="p-2.5 rounded bg-[#0C111A] border border-white/10 flex items-center justify-between"
                  >
                    <div>
                      <div className="text-xs font-semibold text-white">{f.callsign}</div>
                      <div className="text-[11px] font-mono-tabular text-slate-400">
                        {f.platform.toUpperCase()} · {f.mmr} MMR · {formatFriendStatus(f.status)}
                      </div>
                    </div>
                    {f.roomId ? (
                      <button
                        type="button"
                        onClick={() => onJoinRoom(f.roomId!)}
                        className="px-2.5 py-1 rounded bg-amber-500/90 hover:bg-amber-400 text-slate-950 text-[11px] font-bold cursor-pointer whitespace-nowrap"
                      >
                        {t.joinFriendMatch}
                      </button>
                    ) : (
                      <span className="text-[11px] text-slate-500 font-mono-tabular">
                        {f.status === 'online' ? t.friendReady : t.friendOffline}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>

            {/* In-Game Voice Chat Configuration */}
            <div className="p-4 rounded-lg bg-[#141C2A] border border-white/10 space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="font-display font-bold text-lg text-white flex items-center gap-2">
                  <Radio className="w-4 h-4 text-emerald-400" />
                  <span>{t.webrtcVoiceTitle}</span>
                </h3>
                <span className="text-xs font-mono-tabular text-slate-400">
                  {micReady ? t.micActive : t.micStandby}
                </span>
              </div>

              <div>
                <label className="block text-xs text-slate-400 mb-1.5">{t.voiceChannelLabel}</label>
                <div className="grid grid-cols-2 gap-2">
                  {(['team', 'squad', 'proximity', 'muted'] as VoiceChannel[]).map((ch) => (
                    <button
                      key={ch}
                      type="button"
                      onClick={() => onChangeVoice(ch, voiceInputMode)}
                      className={`py-2 px-3 rounded border text-xs font-medium cursor-pointer ${
                        voiceChannel === ch
                          ? 'border-cyan-400 bg-cyan-500/15 text-white'
                          : 'border-white/10 bg-[#0C111A] text-slate-300'
                      }`}
                    >
                      {VOICE_CHANNEL_LABELS[lang][ch]}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-xs text-slate-400 mb-1.5">{t.transmissionMode}</label>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => onChangeVoice(voiceChannel, 'ptt')}
                    className={`py-2 px-3 rounded border text-xs font-medium cursor-pointer ${
                      voiceInputMode === 'ptt'
                        ? 'border-amber-400 bg-amber-500/15 text-white'
                        : 'border-white/10 bg-[#0C111A] text-slate-300'
                    }`}
                  >
                    {t.pttMode}
                  </button>
                  <button
                    type="button"
                    onClick={() => onChangeVoice(voiceChannel, 'open')}
                    className={`py-2 px-3 rounded border text-xs font-medium cursor-pointer ${
                      voiceInputMode === 'open'
                        ? 'border-amber-400 bg-amber-500/15 text-white'
                        : 'border-white/10 bg-[#0C111A] text-slate-300'
                    }`}
                  >
                    {t.openMicMode}
                  </button>
                </div>
              </div>

              <button
                type="button"
                onClick={onInitMic}
                className="w-full py-2.5 rounded-lg bg-[#1C273A] hover:bg-[#25334C] border border-white/15 text-xs font-semibold text-white cursor-pointer flex items-center justify-center gap-2"
              >
                <Mic className="w-4 h-4 text-cyan-400" />
                <span>{micReady ? t.micConnected : t.enableMic}</span>
              </button>
              {micError && <p className="text-[11px] text-amber-400">{micError}</p>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

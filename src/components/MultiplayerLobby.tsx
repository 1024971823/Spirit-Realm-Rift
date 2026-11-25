import { useEffect, useState, useSyncExternalStore, type FormEvent } from 'react';
import { LogOut, Users, X } from 'lucide-react';
import { getRoboMasterLoadStatus, retryRoboMasterLoads, subscribeRoboMasterLoads } from '../game/robomasterModel';
import { useI18n } from '../i18n/LanguageContext';
import { LOBBY_TEXT, MULTIPLAYER_TEXT, multiplayerError } from '../i18n/multiplayer';
import { MAP_I18N, MODE_I18N, translateTeamName } from '../i18n/translations';
import type { MatchOffer, RoomPreview, RoomSettings, RoomView, SessionView } from '../net/clientSocket';
import type { SocialInvite } from '../shared/social';
import type { GameModeId, MapId, TeamId } from '../shared/types';
import { LanguageSwitch } from './LanguageSwitch';
import { RoomChat, type ChatViewProps } from './RoomChat';

import { CopyButton, InviteInbox, LobbyFriends, lobbyField as fieldClass, lobbyAction as actionClass, lobbyAlt as altClass } from './LobbySocial';

function useArenaReadiness(rendererError: boolean) {
  const models = useSyncExternalStore(subscribeRoboMasterLoads, getRoboMasterLoadStatus);
  const assets = Object.values(models);
  const ready = !rendererError && assets.every(asset => asset.state === 'ready');
  const loadFailed = assets.some(asset => asset.state === 'error');
  const loaded = assets.reduce((sum, asset) => sum + asset.loaded, 0);
  const total = assets.reduce((sum, asset) => sum + asset.total, 0);
  return { ready, loadFailed, loaded, total };
}

function ReadinessStatus({ rendererError, className = 'text-xs text-slate-300' }: { rendererError: boolean; className?: string }) {
  const { lang } = useI18n();
  const t = MULTIPLAYER_TEXT[lang];
  const labels = LOBBY_TEXT[lang];
  const { ready, loadFailed, loaded, total } = useArenaReadiness(rendererError);
  return (
    <p data-testid="arena-readiness-status" className={className}>
      <span className={rendererError || loadFailed ? 'text-red-300' : ready ? 'text-emerald-300' : 'text-amber-300'}>
        {rendererError
          ? t.engineError
          : loadFailed
            ? labels.loadFailed
            : ready
              ? labels.modelsReady
              : labels.loadModels + (total ? ' (' + loaded + '/' + total + ')' : '…')}
      </span>
      {loadFailed && (
        <button type="button" className="ml-2 text-cyan-300 underline hover:text-cyan-200 cursor-pointer" onClick={retryRoboMasterLoads}>
          {t.retry}
        </button>
      )}
    </p>
  );
}

export function MatchReady({ offer, connected, rendererError = false, onRespond }: {
  offer: MatchOffer;
  connected: boolean;
  rendererError?: boolean;
  onRespond: (accept: boolean) => void;
}) {
  const { lang } = useI18n();
  const t = MULTIPLAYER_TEXT[lang];
  const readiness = useArenaReadiness(rendererError);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 150);
    return () => clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.ceil((offer.expiresAt - now) / 1_000));
  return <div className="fixed inset-0 z-50 grid place-items-center bg-black/80 p-4">
    <section role="dialog" aria-modal="true" aria-labelledby="ready-title" className="chamfer-panel w-full max-w-sm border border-cyan-400/40 bg-[#0D1726] p-6 text-center shadow-2xl">
      <h2 id="ready-title" className="font-display text-2xl font-bold text-white">{t.ready}</h2>
      <p className="my-3 text-amber-300" role="timer">{t.expires(seconds)}</p>
      <ReadinessStatus rendererError={rendererError} className="mb-3 text-xs text-slate-300" />
      {!readiness.ready && !offer.accepted && <p className="mb-3 text-xs text-amber-200">{t.acceptBlockedByModels}</p>}
      {offer.accepted && <p role="status" className="mb-3 text-sm text-slate-300">{t.accepted}{typeof offer.acceptedCount === 'number' ? ' · ' + offer.acceptedCount + '/6' : ''}</p>}
      <div className="flex justify-center gap-3">
        {!offer.accepted && <button type="button" disabled={!connected || seconds === 0 || !readiness.ready} className={actionClass} onClick={() => onRespond(true)}>{t.accept}</button>}
        <button type="button" disabled={!connected || seconds === 0} className={altClass} onClick={() => onRespond(false)}>{t.decline}</button>
      </div>
    </section>
  </div>;
}

interface LobbyProps {
  view: SessionView;
  playerId: string;
  connected: boolean;
  rendererError: boolean;
  chat: ChatViewProps;
  preview?: RoomPreview;
  inviteCode?: string;
  joining: boolean;
  onClose: () => void;
  onQueue: (join: boolean) => void;
  onPreview: (code: string) => void;
  onConfirmJoin: () => void;
  onDismissPreview: () => void;
  onCreateRoom: (settings: RoomSettings) => void;
  onSettings: (settings: RoomSettings) => void;
  onTeam: (team: TeamId) => void;
  onReady: (ready: boolean) => void;
  onStart: () => void;
  onCancelStart: () => void;
  onLeave: () => void;
  onParty: (create: boolean) => void;
  onInvite: (kind: SocialInvite['kind'], id: string) => void;
  onRespondInvite: (id: string, accept: boolean) => void;
}

function RoomForm({ initial, disabled, submit }: { initial?: RoomSettings; disabled: boolean; submit: (settings: RoomSettings) => void }) {
  const { lang, t: ui } = useI18n();
  const t = MULTIPLAYER_TEXT[lang];
  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    submit({
      name: String(data.get('name') ?? '').trim(),
      mapId: data.get('map') as MapId,
      mode: data.get('mode') as GameModeId,
      botFill: data.get('botFill') === 'on',
      hazardIntensity: data.get('hazardIntensity') === 'overdrive' ? 'overdrive' : 'standard',
      friendlyFire: data.get('friendlyFire') === 'on',
    });
  };
  return <form onSubmit={onSubmit} className="grid gap-2 rounded-lg border border-white/10 bg-white/5 p-3 text-sm">
    {!initial && <h3 className="font-semibold text-white">{t.createRoom}</h3>}
    <fieldset className="grid gap-2" disabled={disabled}>
      <label className="grid gap-1">{t.roomName}<input name="name" maxLength={40} defaultValue={initial?.name} className={fieldClass} /></label>
      <label className="grid gap-1">{t.map}<select name="map" defaultValue={initial?.mapId} className={fieldClass}>{(Object.keys(MAP_I18N[lang]) as MapId[]).map(id => <option key={id} value={id}>{MAP_I18N[lang][id].name}</option>)}</select></label>
      <label className="grid gap-1">{t.mode}<select name="mode" defaultValue={initial?.mode ?? 'team_clash'} className={fieldClass}>{(Object.keys(MODE_I18N[lang]) as GameModeId[]).map(id => <option key={id} value={id}>{MODE_I18N[lang][id].short}</option>)}</select></label>
      <label className="grid gap-1">{ui.hazardIntensity}<select name="hazardIntensity" defaultValue={initial?.hazardIntensity} className={fieldClass}><option value="standard">{ui.hazardStandard}</option><option value="overdrive">{ui.hazardOverdrive}</option></select></label>
      <label className="flex items-center gap-2"><input type="checkbox" name="friendlyFire" defaultChecked={initial?.friendlyFire} />{ui.friendlyFire}</label>
      <label className="flex items-center gap-2"><input type="checkbox" name="botFill" defaultChecked={initial?.botFill} />{t.botFill}</label>
      <button type="submit" className={altClass} disabled={disabled}>{initial ? LOBBY_TEXT[lang].saveSettings : t.create}</button>
    </fieldset>
    {initial && <p className="text-xs text-slate-400">{LOBBY_TEXT[lang].settingsReset}</p>}
  </form>;
}

function SeatGroup({ name, members, slots, room, joinTeam, disabled }: {
  name: string;
  members: RoomView['members'];
  slots: number;
  room: RoomView;
  joinTeam?: () => void;
  disabled?: boolean;
}) {
  const { lang } = useI18n();
  const t = LOBBY_TEXT[lang];
  const common = MULTIPLAYER_TEXT[lang];
  return <section className="min-w-0 rounded border border-white/10 p-2" aria-label={name}>
    <h4 className="mb-2 font-semibold">{name} <span className="text-xs text-slate-400">{members.length}/{slots}</span></h4>
    <ul className="space-y-1">
      {Array.from({ length: slots }, (_, index) => {
        const member = members[index];
        return member ? <li key={member.id} className="rounded bg-white/5 px-2 py-1.5 text-sm">
          <p className="break-all">{member.callsign}</p>
          <p className={'text-xs ' + (member.ready && member.connected ? 'text-emerald-300' : 'text-slate-400')}>
            {[member.id === room.hostId && common.host, member.connected ? member.ready ? t.markedReady : t.awaitingReady : common.offline].filter(Boolean).join(' · ')}
          </p>
        </li> : <li key={index} className="rounded border border-dashed border-white/10 px-2 py-1.5 text-xs text-slate-400">{room.botFill ? t.botSeat : t.emptySeat}</li>;
      })}
    </ul>
    {joinTeam && <button type="button" className={altClass + ' mt-2 w-full text-xs'} disabled={disabled || members.length === slots} onClick={joinTeam}>{t.switchTeam(name)}</button>}
  </section>;
}

function Countdown({ endsAt }: { endsAt: number }) {
  const { lang } = useI18n();
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(timer);
  }, []);
  return <p role="timer" className="text-lg font-bold text-amber-300">{LOBBY_TEXT[lang].countdown(Math.ceil((endsAt - now) / 1000))}</p>;
}

function PrivateRoom({ props, room }: { props: LobbyProps; room: RoomView }) {
  const { lang } = useI18n();
  const t = MULTIPLAYER_TEXT[lang];
  const labels = LOBBY_TEXT[lang];
  const { ready: modelsReady } = useArenaReadiness(props.rendererError);
  const self = room.members.find(member => member.id === props.playerId);
  const isHost = room.hostId === props.playerId;
  const activeCount = room.members.filter(member => member.connected).length;
  const readyCount = room.members.filter(member => member.connected && member.ready).length;
  const minPlayers = room.minPlayers ?? 2;
  const countdown = room.countdownEndsAt != null;
  const editable = props.connected && room.phase === 'waiting' && !countdown && !props.joining;
  const link = new URL('/', window.location.origin);
  link.searchParams.set('invite', room.roomId);
  link.searchParams.set('lang', lang);
  return <div className="grid gap-4 md:grid-cols-2">
    <div className="min-w-0 space-y-3">
      <h3 className="break-all text-lg font-bold">{room.name}</h3>
      <p className="text-sm text-slate-300">{MODE_I18N[lang][room.mode].short} · {MAP_I18N[lang][room.mapId].name}</p>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
        <span>{t.roomCode}:</span><code data-testid="room-invite-code" className="select-all rounded bg-white/10 px-2 py-1 font-mono-tabular text-cyan-300">{room.roomId}</code>
        <CopyButton key={room.roomId} value={room.roomId} label={t.copy} />
        <CopyButton key={link.href} value={link.href} label={labels.copyLink} />
      </div>
      <div className={'grid gap-2 ' + (room.mode === 'ffa' ? 'grid-cols-1' : 'grid-cols-2')}>
        {room.mode === 'ffa'
          ? <SeatGroup name={labels.ffaSeats} slots={6} members={room.members} room={room} />
          : (['cobalt', 'amber'] as const).map(team => <SeatGroup key={team} name={translateTeamName(team, lang)} slots={3} members={room.members.filter(member => member.team === team)} room={room}
              joinTeam={self?.team !== team ? () => props.onTeam(team) : undefined} disabled={!editable} />)}
      </div>
      {room.botFill && <p className="text-xs text-slate-300">{t.botFill}</p>}
      <p role="status" className="text-sm text-slate-300">{labels.readyCount(readyCount, room.members.length)}</p>
      <ReadinessStatus rendererError={props.rendererError} />
      {minPlayers === 1 && <p className="text-xs text-cyan-300">{t.soloTesting}</p>}
      {countdown && <Countdown endsAt={room.countdownEndsAt!} />}
      {!countdown && activeCount < minPlayers && <p className="text-sm text-amber-300">{t.requiredPlayers(minPlayers)}</p>}
      {!countdown && activeCount >= minPlayers && !room.canStart && readyCount === room.members.length && room.mode !== 'ffa' && !room.botFill && room.members.length > 1 && room.members.every(member => member.team === self?.team) &&
        <p className="text-sm text-amber-300">{multiplayerError(lang, 'need_both_teams')}</p>}
      {!countdown && !isHost && room.canStart && <p className="text-sm text-slate-300">{t.waiting}</p>}
      <div className="flex flex-wrap gap-2">
        {room.phase === 'waiting' && <button type="button" className={self?.ready ? altClass : actionClass}
          disabled={!props.connected || props.joining || !self || (!self.ready && (!modelsReady || countdown))}
          onClick={() => props.onReady(!self?.ready)}>{self?.ready ? labels.unready : labels.ready}</button>}
        {isHost && !countdown && <button type="button" className={actionClass} disabled={!editable || !room.canStart} onClick={props.onStart}>{t.start}</button>}
        {isHost && countdown && <button type="button" className={altClass} disabled={!props.connected} onClick={props.onCancelStart}>{labels.cancelCountdown}</button>}
        <button type="button" className={altClass + ' flex items-center gap-2'} disabled={!props.connected || props.joining} onClick={props.onLeave}><LogOut className="h-4 w-4" />{t.leave}</button>
      </div>
      {isHost && <details className="text-sm">
        <summary className="cursor-pointer py-2 text-cyan-300">{labels.editSettings}</summary>
        <RoomForm key={JSON.stringify([room.roomId, room.name, room.mapId, room.mode, room.botFill, room.hazardIntensity, room.friendlyFire])} initial={room} disabled={!editable} submit={props.onSettings} />
      </details>}
    </div>
    <RoomChat {...props.chat} key={room.roomId} disabled={!props.connected} />
  </div>;
}

function InvitePreview({ props }: { props: LobbyProps }) {
  const { lang } = useI18n();
  const t = LOBBY_TEXT[lang];
  const common = MULTIPLAYER_TEXT[lang];
  const { view, playerId, preview, inviteCode, joining } = props;
  if (!inviteCode) return null;
  const queued = view.queuedAt != null;
  const same = inviteCode === view.room?.roomId;
  const busy = !same && Boolean(view.room || view.party || queued || view.offer);
  const blocked = view.room?.phase === 'active' ? t.finishMatch : view.offer ? t.resolveOffer : queued && view.party && view.party.leaderId !== playerId ? t.stopPartyQueue : '';
  return <section aria-label={t.invitePreview} className="space-y-2 rounded-lg border border-cyan-400/30 bg-cyan-500/5 p-3 text-sm">
    <h3 className="font-bold text-white">{t.invitePreview}</h3>
    <p>{common.roomCode}: <code className="select-all text-cyan-300">{inviteCode}</code></p>
    {preview ? <>
      {preview.name && <p className="break-all font-semibold">{preview.name}</p>}
      {preview.mode && preview.mapId && <p className="text-slate-300">{MODE_I18N[lang][preview.mode].short} · {MAP_I18N[lang][preview.mapId].name} · {preview.playerCount}/6</p>}
      {!preview.available && !same && <p className="text-amber-300">{multiplayerError(lang, preview.error)}</p>}
    </> : <p role="status" className="text-slate-300">{t.loadingPreview}</p>}
    {blocked && <p className="text-amber-300">{blocked}</p>}
    <div className="flex flex-wrap gap-2">
      {!same && preview?.available && <button type="button" className={actionClass} disabled={!props.connected || joining || !!blocked}
        onClick={() => { if (!busy || window.confirm(t.confirmSwitch)) props.onConfirmJoin(); }}>{joining ? common.working : busy ? t.switchRoom : common.join}</button>}
      {!same && <button type="button" className={altClass} disabled={!props.connected || joining} onClick={() => props.onPreview(inviteCode)}>{t.refreshPreview}</button>}
      <button type="button" className={altClass} disabled={joining} onClick={props.onDismissPreview}>{common.close}</button>
    </div>
  </section>;
}

export function MultiplayerLobby(props: LobbyProps) {
  const { lang } = useI18n();
  const t = MULTIPLAYER_TEXT[lang];
  const labels = LOBBY_TEXT[lang];
  const { view, connected, playerId } = props;
  const readiness = useArenaReadiness(props.rendererError);
  const room = view.room;
  const party = view.party;
  const queued = view.queuedAt != null;
  const canQueue = !party || party.leaderId === playerId;
  const partyOnline = !party || party.members.every(member => member.connected);
  const [friendsOpen, setFriendsOpen] = useState(false);
  const join = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const code = String(new FormData(event.currentTarget).get('code') ?? '').trim().toUpperCase();
    if (code) props.onPreview(code);
  };
  return <div className="fixed inset-0 z-30 grid place-items-center bg-black/80 p-4">
    <section role="dialog" aria-modal="true" aria-labelledby="multiplayer-title" className="chamfer-panel max-h-[92vh] w-full max-w-3xl overflow-y-auto border border-cyan-400/25 bg-[#0C141F] p-5 shadow-2xl md:p-6">
      <header className="mb-4 flex flex-wrap items-center justify-between gap-3 border-b border-white/10 pb-4">
        <h2 id="multiplayer-title" className="flex items-center gap-2 font-display text-xl font-bold"><Users className="h-5 w-5 text-cyan-300" />{t.lobby}</h2>
        <div className="flex items-center gap-3">
          <button type="button" aria-expanded={friendsOpen} className={altClass + ' text-sm'} onClick={() => setFriendsOpen(value => !value)}>{labels.friends}</button>
          <LanguageSwitch compact /><button type="button" aria-label={t.close} className="rounded bg-white/10 p-2" onClick={props.onClose}><X className="h-4 w-4" /></button>
        </div>
      </header>
      {!connected && <p role="status" className="mb-3 text-sm text-amber-300">{t.reconnecting}</p>}
      <div className="space-y-4">
        {friendsOpen && <div className="rounded-lg border border-white/10 bg-white/5 p-3">
          <LobbyFriends view={view} playerId={playerId} connected={connected} blockedIds={props.chat.blockedIds} onInvite={props.onInvite} />
        </div>}
        <InvitePreview props={props} />
        {!!view.invites?.length && <InviteInbox invites={view.invites.filter(invite => !props.chat.blockedIds.includes(invite.senderId))}
          connected={connected} busy={Boolean(room || party || queued || view.offer || props.joining)} onRespond={props.onRespondInvite} />}
        {room ? <PrivateRoom key={room.roomId} props={props} room={room} /> : <>
          <section className="rounded-lg border border-amber-400/30 bg-amber-500/5 px-4 py-3">
            <h3 className="font-bold text-white">{t.casual}</h3>
            <p className="mt-1 text-sm text-slate-300">{t.casualDescription}</p>
            <ReadinessStatus rendererError={props.rendererError} className="mt-2 text-xs text-slate-300" />
            {!readiness.ready && !queued && <p className="mt-1 text-xs text-amber-200">{t.readinessRequired}</p>}
            {queued && <p role="status" className="mt-2 text-sm text-cyan-300">{t.queued}…</p>}
            {!canQueue && <p className="mt-2 text-sm text-slate-300">{labels.leaderQueues}</p>}
            {!partyOnline && <p className="mt-2 text-sm text-amber-300">{labels.partyNotReady}</p>}
            {canQueue && <button type="button" onClick={() => props.onQueue(!queued)} disabled={!connected || Boolean(view.offer) || props.joining || (!queued && (!partyOnline || !readiness.ready))}
              className={'mt-3 ' + (queued ? altClass : actionClass)}>{queued ? t.cancelQueue : t.findMatch}</button>}
          </section>
          <section className="space-y-2 rounded-lg border border-cyan-400/25 bg-cyan-500/5 px-4 py-3" aria-label={labels.party}>
            <h3 className="font-bold text-white">{labels.party}{party ? ' · ' + party.members.length + '/3' : ''}</h3>
            <p className="text-sm text-slate-300">{labels.partyIntro}</p>
            {party && <ul className="space-y-1">
              {party.members.map(member => <li key={member.id} className="flex flex-wrap justify-between gap-2 rounded bg-white/5 px-2 py-1 text-sm">
                <span className="break-all">{member.callsign}</span><span className="text-xs text-slate-300">{[member.id === party.leaderId && labels.leader, !member.connected && t.offline].filter(Boolean).join(' · ')}</span>
              </li>)}
            </ul>}
            <button type="button" className={altClass} disabled={!connected || queued || Boolean(view.offer) || props.joining} onClick={() => props.onParty(!party)}>
              {party ? labels.leaveParty : labels.createParty}
            </button>
          </section>
          {party && <p className="text-sm text-slate-300">{labels.leavePartyForRoom}</p>}
          <div className="grid items-start gap-4 sm:grid-cols-2">
            <RoomForm disabled={!connected || queued || Boolean(view.offer || party) || props.joining} submit={props.onCreateRoom} />
            <form onSubmit={join} className="grid gap-2 rounded-lg border border-white/10 bg-white/5 p-3 text-sm">
              <h3 className="font-semibold text-white">{t.joinRoom}</h3>
              <label className="grid gap-1">{t.roomCode}<input required name="code" maxLength={24} autoCapitalize="characters" className={fieldClass + ' uppercase'} /></label>
              <button type="submit" disabled={!connected || props.joining} className={altClass}>{labels.previewRoom}</button>
            </form>
          </div>
        </>}
      </div>
    </section>
  </div>;
}

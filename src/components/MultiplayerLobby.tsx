import { useEffect, useState, type FormEvent } from 'react';
import { Check, Copy, LogOut, Users, X } from 'lucide-react';
import { useI18n } from '../i18n/LanguageContext';
import { MULTIPLAYER_TEXT } from '../i18n/multiplayer';
import { MAP_I18N, MODE_I18N } from '../i18n/translations';
import type { MatchOffer, RoomSettings, SessionView } from '../net/clientSocket';
import type { GameModeId, MapId } from '../shared/types';
import { LanguageSwitch } from './LanguageSwitch';
import { RoomChat, type ChatViewProps } from './RoomChat';

const fieldClass = 'min-w-0 rounded border border-white/20 bg-[#080E18] px-3 py-2 text-sm text-white';
const actionClass = 'chamfer-btn bg-amber-400 px-4 py-2 font-bold text-slate-950 hover:bg-amber-300 disabled:opacity-50';
const altClass = 'rounded border border-white/20 bg-[#162235] px-3 py-2 text-slate-100 hover:bg-[#22344E] disabled:opacity-50';

export function MatchReady({ offer, connected, onRespond }: { offer: MatchOffer; connected: boolean; onRespond: (accept: boolean) => void }) {
  const { lang } = useI18n();
  const t = MULTIPLAYER_TEXT[lang];
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
      {offer.accepted && <p role="status" className="mb-3 text-sm text-slate-300">{t.accepted}{typeof offer.acceptedCount === 'number' ? ' · ' + offer.acceptedCount + '/6' : ''}</p>}
      <div className="flex justify-center gap-3">
        {!offer.accepted && <button type="button" disabled={!connected || seconds === 0} className={actionClass} onClick={() => onRespond(true)}>{t.accept}</button>}
        <button type="button" disabled={!connected || seconds === 0} className={altClass} onClick={() => onRespond(false)}>{t.decline}</button>
      </div>
    </section>
  </div>;
}

interface LobbyProps {
  view: SessionView;
  playerId: string;
  connected: boolean;
  chat: ChatViewProps;
  onClose: () => void;
  onQueue: (join: boolean) => void;
  onJoinRoom: (inviteCode: string) => void;
  onCreateRoom: (settings: RoomSettings) => void;
  onStart: () => void;
  onLeave: () => void;
}

export function MultiplayerLobby({ view, playerId, connected, chat, onClose, onQueue, onJoinRoom, onCreateRoom, onStart, onLeave }: LobbyProps) {
  const { lang, t: ui } = useI18n();
  const t = MULTIPLAYER_TEXT[lang];
  const room = view.room;
  const [copied, setCopied] = useState(false);
  const queued = typeof view.queuedAt === 'number';
  const activeCount = room?.members.filter(member => member.connected).length ?? 0;
  const minPlayers = room?.minPlayers ?? 2;
  const isHost = room?.hostId === playerId;
  const create = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    onCreateRoom({
      name: String(data.get('name') ?? '').trim(),
      mapId: data.get('map') as MapId,
      mode: data.get('mode') as GameModeId,
      botFill: data.get('botFill') === 'on',
      hazardIntensity: data.get('hazardIntensity') === 'overdrive' ? 'overdrive' : 'standard',
      friendlyFire: data.get('friendlyFire') === 'on',
    });
  };
  const join = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const code = String(new FormData(event.currentTarget).get('code') ?? '').trim().toUpperCase();
    if (code) onJoinRoom(code);
  };

  return <div className="fixed inset-0 z-30 grid place-items-center bg-black/80 p-4">
    <section role="dialog" aria-modal="true" aria-labelledby="multiplayer-title" className="chamfer-panel max-h-[92vh] w-full max-w-3xl overflow-y-auto border border-cyan-400/25 bg-[#0C141F] p-5 shadow-2xl md:p-6">
      <header className="mb-4 flex items-center justify-between gap-4 border-b border-white/10 pb-4">
        <h2 id="multiplayer-title" className="flex items-center gap-2 font-display text-xl font-bold"><Users className="h-5 w-5 text-cyan-300" />{t.lobby}</h2>
        <div className="flex items-center gap-3"><LanguageSwitch compact /><button type="button" aria-label={t.close} className="rounded bg-white/10 p-2" onClick={onClose}><X className="h-4 w-4" /></button></div>
      </header>
      {!connected && <p role="status" className="mb-3 text-sm text-amber-300">{t.reconnecting}</p>}
      {room ? <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-3">
          <h3 className="break-all text-lg font-bold">{room.name}</h3>
          <p className="text-sm text-slate-300">{MODE_I18N[lang][room.mode].short} · {MAP_I18N[lang][room.mapId].name}</p>
          <div className="flex flex-wrap items-center gap-2 text-sm"><span>{t.roomCode}:</span><code className="select-all rounded bg-white/10 px-2 py-1 font-mono-tabular text-cyan-300">{room.roomId}</code>
            <button type="button" onClick={() => void navigator.clipboard?.writeText(room.roomId).then(() => setCopied(true)).catch(() => setCopied(false))} className="flex items-center gap-1 text-cyan-300"><Copy className="h-3 w-3" />{copied ? t.copied : t.copy}</button>
          </div>
          <ul className="space-y-1" aria-label={lang === 'zh' ? '房间成员' : 'Room members'}>
            {room.members.map(member => <li key={member.id} className="flex items-center justify-between gap-2 rounded bg-white/5 px-2 py-1.5 text-sm">
              <span className="break-all">{member.callsign}</span><span className="shrink-0 text-xs text-slate-400">{[member.id === room.hostId && t.host, !member.connected && t.offline].filter(Boolean).join(' · ')}</span>
            </li>)}
          </ul>
          {room.botFill && <p className="text-xs text-slate-300">{t.botFill}</p>}
          {!isHost && <p role="status" className="text-sm text-slate-300">{t.waiting}</p>}
          {minPlayers === 1 && <p role="status" className="text-sm text-cyan-300">{t.soloTesting}</p>}
          {isHost && activeCount < minPlayers && <p role="status" className="text-sm text-amber-300">{t.requiredPlayers(minPlayers)}</p>}
          <div className="flex flex-wrap gap-2">
            {isHost && <button type="button" className={actionClass} disabled={!connected || activeCount < minPlayers || room.phase === 'active'} onClick={onStart}>{t.start}</button>}
            <button type="button" className={altClass + ' flex items-center gap-2'} disabled={!connected} onClick={onLeave}><LogOut className="h-4 w-4" />{t.leave}</button>
          </div>
        </div>
        <RoomChat {...chat} key={room.roomId} disabled={!connected} />
      </div> : <>
        <section className="mb-4 rounded-lg border border-amber-400/30 bg-amber-500/5 px-4 py-3">
          <h3 className="font-bold text-white">{t.casual}</h3>
          <p className="mt-1 text-sm text-slate-300">{t.casualDescription}</p>
          {queued && <p role="status" className="mt-2 text-sm text-cyan-300">{t.queued}…</p>}
          <button type="button" onClick={() => onQueue(!queued)} disabled={!connected || Boolean(view.offer)} className={'mt-3 ' + (queued ? altClass : actionClass)}>{queued ? t.cancelQueue : t.findMatch}</button>
        </section>
        <div className="grid items-start gap-4 sm:grid-cols-2">
          <form onSubmit={create} className="grid gap-2 rounded-lg border border-white/10 bg-white/5 p-3 text-sm">
            <h3 className="font-semibold text-white">{t.createRoom}</h3>
            <label className="grid gap-1">{t.roomName}<input name="name" maxLength={40} className={fieldClass} /></label>
            <label className="grid gap-1">{t.map}<select name="map" className={fieldClass}>{(Object.keys(MAP_I18N[lang]) as MapId[]).map(id => <option key={id} value={id}>{MAP_I18N[lang][id].name}</option>)}</select></label>
            <label className="grid gap-1">{t.mode}<select name="mode" defaultValue="team_clash" className={fieldClass}>{(Object.keys(MODE_I18N[lang]) as GameModeId[]).map(id => <option key={id} value={id}>{MODE_I18N[lang][id].short}</option>)}</select></label>
            <label className="grid gap-1">{ui.hazardIntensity}<select name="hazardIntensity" className={fieldClass}><option value="standard">{ui.hazardStandard}</option><option value="overdrive">{ui.hazardOverdrive}</option></select></label>
            <label className="flex items-center gap-2"><input type="checkbox" name="friendlyFire" />{ui.friendlyFire}</label>
            <label className="flex items-center gap-2"><input type="checkbox" name="botFill" />{t.botFill}</label>
            <button type="submit" className={altClass} disabled={!connected || queued || Boolean(view.offer)}>{t.create}</button>
          </form>
          <form onSubmit={join} className="grid gap-2 rounded-lg border border-white/10 bg-white/5 p-3 text-sm">
            <h3 className="font-semibold text-white">{t.joinRoom}</h3>
            <label className="grid gap-1">{t.roomCode}<input required name="code" maxLength={30} autoCapitalize="characters" className={fieldClass + ' uppercase'} /></label>
            <button type="submit" disabled={!connected || queued || Boolean(view.offer)} className={altClass + ' flex items-center justify-center gap-2'}><Check className="h-4 w-4" />{t.join}</button>
          </form>
        </div>
      </>}
    </section>
  </div>;
}

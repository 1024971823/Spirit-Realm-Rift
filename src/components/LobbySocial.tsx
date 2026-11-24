import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { useI18n } from '../i18n/LanguageContext';
import { LOBBY_TEXT, MULTIPLAYER_TEXT, multiplayerError } from '../i18n/multiplayer';
import { ApiError, postJson, requestJson } from '../net/account';
import type { SessionView } from '../net/clientSocket';
import type { SocialInvite, SocialView } from '../shared/social';

export const lobbyField = 'min-w-0 rounded border border-white/20 bg-[#080E18] px-3 py-2 text-sm text-white';
export const lobbyAction = 'chamfer-btn bg-amber-400 px-4 py-2 font-bold text-slate-950 hover:bg-amber-300 disabled:opacity-50';
export const lobbyAlt = 'rounded border border-white/20 bg-[#162235] px-3 py-2 text-slate-100 hover:bg-[#22344E] disabled:opacity-50';

export function CopyButton({ value, label }: { value: string; label: string }) {
  const { lang } = useI18n();
  const [result, setResult] = useState<'ok' | 'error'>();
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setResult('ok');
    } catch {
      setResult('error');
    }
  };
  return <span className="inline-flex flex-wrap items-center gap-2">
    <button type="button" onClick={() => void copy()} className="text-cyan-300 underline-offset-2 hover:underline">{label}</button>
    {result === 'ok' && <span role="status" className="text-emerald-300">{MULTIPLAYER_TEXT[lang].copied}</span>}
    {result === 'error' && <span role="status" className="text-amber-300">{LOBBY_TEXT[lang].copyFailed} <code className="break-all select-all">{value}</code></span>}
  </span>;
}

export function InviteInbox({ invites, connected, busy, onRespond }: {
  invites: SocialInvite[];
  connected: boolean;
  busy: boolean;
  onRespond: (id: string, accept: boolean) => void;
}) {
  const { lang } = useI18n();
  const t = LOBBY_TEXT[lang];
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, []);
  const pending = invites.filter(invite => invite.expiresAt > now);
  if (!pending.length) return null;
  return <section className="space-y-2 rounded border border-cyan-400/30 bg-cyan-500/5 p-3" aria-label={t.invites}>
    <h3 className="font-bold text-white">{t.invites}</h3>
    {busy && <p className="text-xs text-amber-300">{t.finishActivity}</p>}
    <ul className="space-y-2">
      {pending.map(invite => <li key={invite.id} className="flex flex-wrap items-center gap-2 text-sm">
        <span className="min-w-0 break-words">{(invite.kind === 'room' ? t.roomInvite : t.partyInvite)(invite.senderName)}</span>
        <span className="mr-auto tabular-nums text-slate-400">{Math.ceil((invite.expiresAt - now) / 1000)}s</span>
        <button type="button" className={lobbyAlt} disabled={!connected || busy} onClick={() => onRespond(invite.id, true)}>{t.acceptInvite}</button>
        <button type="button" className={lobbyAlt} disabled={!connected} onClick={() => onRespond(invite.id, false)}>{t.declineInvite}</button>
      </li>)}
    </ul>
  </section>;
}

export function LobbyFriends({ view, playerId, connected, blockedIds, onInvite }: {
  view: SessionView;
  playerId: string;
  connected: boolean;
  blockedIds: readonly string[];
  onInvite: (kind: SocialInvite['kind'], id: string) => void;
}) {
  const { lang } = useI18n();
  const t = LOBBY_TEXT[lang];
  const common = MULTIPLAYER_TEXT[lang];
  const [social, setSocial] = useState<SocialView>();
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState(false);
  const requestVersion = useRef(0);
  const savingRef = useRef(false);
  const refresh = useCallback(async () => {
    const version = ++requestVersion.current;
    try {
      const data = await requestJson<SocialView>('/api/social');
      if (version === requestVersion.current) setSocial(data);
    } catch (err) {
      if (version === requestVersion.current) {
        setError(err instanceof ApiError ? err.message || 'unavailable' : 'unavailable');
      }
    }
  }, []);
  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => { if (!savingRef.current) void refresh(); }, 5000);
    return () => { window.clearInterval(timer); requestVersion.current++; };
  }, [refresh, blockedIds, connected]);

  const mutate = async (action: 'request' | 'respond' | 'remove' | 'settings', body: object) => {
    if (savingRef.current) return;
    requestVersion.current++;
    savingRef.current = true;
    setSaving(true);
    setError('');
    setMessage('');
    try {
      await postJson('/api/social/' + action, body);
      if (action === 'request') setMessage('requestSent');
      await refresh();
      return true;
    } catch (err) {
      setError(err instanceof ApiError ? err.message || 'unavailable' : 'unavailable');
      return false;
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };
  const sendRequest = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    if (await mutate('request', { friendCode: new FormData(form).get('friendCode') })) form.reset();
  };

  const room = view.room;
  const party = view.party;
  const canInviteRoom = connected && room?.isPrivate && room.phase === 'waiting' && room.countdownEndsAt == null && room.members.length < 6;
  const canInviteParty = connected && party?.leaderId === playerId && party.members.length < 3 && !view.offer && view.queuedAt == null && !room;
  const friends = social?.friends.filter(friend => !blockedIds.includes(friend.id)) ?? [];
  return <section className="space-y-3 text-sm" aria-label={t.friends}>
    {error && <p role="alert" className="text-amber-300">{multiplayerError(lang, error)} <button type="button" className="text-cyan-300" onClick={() => { setError(''); void refresh(); }}>{common.retry}</button></p>}
    {!social ? <p role="status">{t.socialLoading}</p> : <>
      <div className="flex flex-wrap items-center gap-2">
        <span>{t.friendCode}:</span><code data-testid="friend-code" className="break-all select-all text-cyan-300">{social.friendCode}</code>
        <CopyButton key={social.friendCode} value={social.friendCode} label={t.copyFriendCode} />
      </div>
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={social.allowInvites} disabled={saving} onChange={event => void mutate('settings', { allowInvites: event.target.checked })} />{t.allowInvites}
      </label>
      <form onSubmit={event => void sendRequest(event)} className="flex flex-wrap items-end gap-2">
        <label className="grid flex-1 gap-1">{t.friendCode}<input className={lobbyField + ' uppercase'} name="friendCode" maxLength={32} required autoCapitalize="characters" /></label>
        <button type="submit" className={lobbyAlt} disabled={saving}>{t.addFriend}</button>
      </form>
      {message === 'requestSent' && <p role="status" className="text-emerald-300">{t.requestSent}</p>}
      <div className="grid gap-3 sm:grid-cols-2">
        <section aria-label={t.requestsIncoming} className="rounded border border-white/10 p-3">
          <h4 className="mb-2 font-semibold">{t.requestsIncoming}</h4>
          {social.incoming.length === 0 ? <p className="text-slate-400">{t.emptyRequests}</p> : <ul className="space-y-2">
            {social.incoming.map(request => <li key={request.playerId} className="flex flex-wrap items-center gap-2">
              <span className="mr-auto break-all">{request.callsign}</span>
              <button type="button" className="text-cyan-300" disabled={saving} onClick={() => void mutate('respond', { playerId: request.playerId, accept: true })}>{t.friendAccept}</button>
              <button type="button" className="text-slate-300" disabled={saving} onClick={() => void mutate('respond', { playerId: request.playerId, accept: false })}>{t.friendDecline}</button>
            </li>)}
          </ul>}
        </section>
        <section aria-label={t.requestsOutgoing} className="rounded border border-white/10 p-3">
          <h4 className="mb-2 font-semibold">{t.requestsOutgoing}</h4>
          {social.outgoing.length === 0 ? <p className="text-slate-400">{t.emptyRequests}</p> : <ul className="space-y-2">
            {social.outgoing.map(request => <li key={request.playerId} className="flex flex-wrap items-center gap-2">
              <span className="mr-auto break-all">{request.callsign}</span>
              <button type="button" className="text-slate-300" disabled={saving} onClick={() => void mutate('remove', { playerId: request.playerId })}>{t.friendCancel}</button>
            </li>)}
          </ul>}
        </section>
      </div>
      <section aria-label={t.friendList} className="rounded border border-white/10 p-3">
        <h4 className="mb-2 font-semibold">{t.friendList}</h4>
        {!friends.length ? <p className="text-slate-400">{t.emptyFriends}</p> : <ul className="space-y-2">
          {friends.map(friend => {
            const inRoom = room?.members.some(member => member.id === friend.id);
            const inParty = party?.members.some(member => member.id === friend.id);
            return <li key={friend.id} className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <span className="break-all">{friend.callsign}</span>
              <span className="mr-auto text-xs text-slate-400">{inParty ? t.inParty : t.friendStatus[friend.status]}</span>
              {canInviteRoom && !inRoom && friend.status === 'online' && <button type="button" className="text-cyan-300" onClick={() => onInvite('room', friend.id)}>{t.inviteRoom}</button>}
              {canInviteParty && !inParty && friend.status === 'online' && <button type="button" className="text-cyan-300" onClick={() => onInvite('party', friend.id)}>{t.inviteParty}</button>}
              <button type="button" className="text-slate-300" disabled={saving} onClick={() => void mutate('remove', { playerId: friend.id })}>{t.removeFriend}</button>
            </li>;
          })}
        </ul>}
      </section>
    </>}
  </section>;
}

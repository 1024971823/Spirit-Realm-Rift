import { useState, type FormEvent } from 'react';
import { useI18n } from '../i18n/LanguageContext';
import { MULTIPLAYER_TEXT } from '../i18n/multiplayer';
import type { ChatMessage } from '../net/clientSocket';
import { postJson } from '../net/account';

export interface ChatViewProps {
  messages: ChatMessage[];
  playerId: string;
  blockedIds: string[];
  onBlockChanged: (id: string, blocked: boolean) => void;
  onSend: (text: string) => boolean;
  disabled?: boolean;
}

export function RoomChat({ messages, playerId, blockedIds, onBlockChanged, onSend, disabled }: ChatViewProps) {
  const { lang } = useI18n();
  const t = MULTIPLAYER_TEXT[lang];
  const [draft, setDraft] = useState('');
  const [reportId, setReportId] = useState('');
  const [reason, setReason] = useState('');
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState<{ text: string; error?: boolean }>();
  const visible = messages.filter(message => !blockedIds.includes(message.playerId));

  const report = async (event: FormEvent) => {
    event.preventDefault();
    if (pending || !reason.trim()) return;
    setPending(true);
    try {
      await postJson('/api/chat/report', { messageId: reportId, reason: reason.trim() });
      setNotice({ text: t.reported }); setReportId(''); setReason('');
    } catch (err) { setNotice({ text: err instanceof Error && err.message ? err.message : t.error, error: true }); }
    finally { setPending(false); }
  };
  const setBlocked = async (id: string, blocked: boolean) => {
    if (pending) return;
    setPending(true);
    try {
      await postJson('/api/chat/block', { playerId: id, blocked });
      onBlockChanged(id, blocked);
      setNotice({ text: blocked ? t.blocked : t.unblocked });
    } catch (err) { setNotice({ text: err instanceof Error && err.message ? err.message : t.error, error: true }); }
    finally { setPending(false); }
  };

  return <section aria-label={t.roomChat} className="select-text rounded border border-white/10 bg-[#0B1019]/95 p-3 text-xs text-slate-200">
    <h3 className="mb-2 text-sm font-bold text-white">{t.roomChat}</h3>
    <ul className="flex max-h-[28vh] flex-col-reverse gap-1.5 overflow-y-auto" aria-label={t.roomChat}>
      {[...visible].reverse().map(message => <li key={message.id} className="rounded bg-white/5 px-2 py-1.5">
        <p className="break-all"><strong className="text-cyan-300">{message.callsign}: </strong>{message.text}</p>
        {message.playerId !== playerId && <div className="mt-1 flex gap-3 text-slate-400">
          <button type="button" disabled={pending} className="hover:text-white" onClick={() => { setReportId(message.id); setReason(''); }}>{t.report}</button>
          <button type="button" disabled={pending} className="hover:text-white" onClick={() => void setBlocked(message.playerId, true)}>{t.block}</button>
        </div>}
      </li>)}
    </ul>
    {reportId && <form onSubmit={report} className="my-2 flex flex-col gap-2 border-l-2 border-amber-400 p-2">
      <label className="grid gap-1">{t.reportReason}<input required maxLength={200} value={reason} onChange={event => setReason(event.target.value)} className="rounded border border-white/20 bg-slate-950 px-2 py-1.5" /></label>
      <div className="flex gap-3"><button type="submit" disabled={pending} className="text-amber-300">{t.report}</button><button type="button" onClick={() => { setReportId(''); setReason(''); }}>{t.close}</button></div>
    </form>}
    <form onSubmit={event => { event.preventDefault(); if (!draft.trim() || disabled) return; if (onSend(draft.trim())) setDraft(''); }} className="mt-2 flex gap-2">
      <input aria-label={t.chatPlaceholder} placeholder={t.chatPlaceholder} value={draft} onChange={event => setDraft(event.target.value)} maxLength={200} disabled={disabled} className="min-w-0 flex-1 rounded border border-white/20 bg-slate-950 px-2 py-1.5" />
      <button type="submit" disabled={disabled || !draft.trim()} className="rounded bg-cyan-800 px-2 py-1.5 text-white disabled:opacity-50">{t.send}</button>
    </form>
    <details className="mt-2 text-slate-300">
      <summary className="cursor-pointer">{t.viewBlocked} ({blockedIds.length})</summary>
      {blockedIds.length === 0 ? <p className="mt-1">{t.noBlocks}</p> : <ul className="mt-1 space-y-1">{blockedIds.map(id => <li key={id} className="flex justify-between gap-2">
        <span aria-label={id}>{messages.find(message => message.playerId === id)?.callsign ?? id.slice(0, 8)}</span>
        <button type="button" disabled={pending} onClick={() => void setBlocked(id, false)} className="text-cyan-300">{t.unblock}</button>
      </li>)}</ul>}
    </details>
    {notice && <p role={notice.error ? 'alert' : 'status'} className={notice.error ? 'mt-2 text-red-300' : 'mt-2 text-emerald-300'}>{notice.text}</p>}
  </section>;
}

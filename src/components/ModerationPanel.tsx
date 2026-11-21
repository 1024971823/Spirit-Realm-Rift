import { useEffect, useState, type FormEvent } from 'react';
import { useI18n } from '../i18n/LanguageContext';
import { MULTIPLAYER_TEXT } from '../i18n/multiplayer';
import { postJson, requestJson } from '../net/account';

interface Report {
  messageId: string;
  callsign: string;
  text: string;
  timestamp: string;
  reasons: string[];
  reports: number;
}

type Action = 'dismiss' | 'mute' | 'ban';
const COPY = {
  zh: {
    empty: '没有待审举报。', refresh: '刷新', messageId: '消息 ID', reasons: '举报理由',
    reason: '处置理由', confirm: '确认处置', done: '处置已记录。', actions: { dismiss: '驳回举报', mute: '禁言 24 小时', ban: '封禁账号' },
  },
  en: {
    empty: 'No pending reports.', refresh: 'Refresh', messageId: 'Message ID', reasons: 'Report reasons',
    reason: 'Reason for action', confirm: 'Apply action', done: 'Action recorded.', actions: { dismiss: 'Dismiss report', mute: 'Mute for 24 hours', ban: 'Ban account' },
  },
};

export function ModerationPanel({ onClose }: { onClose: () => void }) {
  const { lang } = useI18n();
  const t = MULTIPLAYER_TEXT[lang];
  const c = COPY[lang];
  const [reports, setReports] = useState<Report[] | null>(null);
  const [active, setActive] = useState<{ id: string; action: Action }>();
  const [pending, setPending] = useState(false);
  const [revision, refresh] = useState(0);
  const [notice, setNotice] = useState<{ text: string; error?: boolean }>();
  useEffect(() => {
    const controller = new AbortController();
    void requestJson<{ reports: Report[] }>('/api/moderation/reports', { signal: controller.signal })
      .then(reply => setReports(reply.reports))
      .catch(err => { if (!controller.signal.aborted) setNotice({ text: err instanceof Error && err.message ? err.message : t.error, error: true }); });
    return () => controller.abort();
  }, [revision, t.error]);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!active || pending) return;
    const reason = String(new FormData(event.currentTarget).get('reason') ?? '').trim();
    if (!reason) return;
    setPending(true);
    try {
      await postJson('/api/moderation/actions', { messageId: active.id, action: active.action, reason });
      setReports(old => old?.filter(report => report.messageId !== active.id) ?? null);
      setActive(undefined);
      setNotice({ text: c.done });
    } catch (err) { setNotice({ text: err instanceof Error && err.message ? err.message : t.error, error: true }); }
    finally { setPending(false); }
  };

  return <div className="fixed inset-0 z-30 grid place-items-center bg-black/80 p-4">
    <section role="dialog" aria-modal="true" aria-labelledby="moderation-title" className="chamfer-panel max-h-[88vh] w-full max-w-2xl overflow-y-auto border border-cyan-500/25 bg-[#0C121C] p-5 shadow-2xl">
      <header className="mb-4 flex flex-wrap items-center gap-3 border-b border-white/10 pb-3">
        <h2 id="moderation-title" className="mr-auto text-lg font-bold text-white">{t.moderation}</h2>
        <button type="button" disabled={pending} className="text-sm text-cyan-300" onClick={() => { setNotice(undefined); refresh(value => value + 1); }}>{c.refresh}</button>
        <button type="button" className="text-sm text-slate-300" onClick={onClose}>{t.close}</button>
      </header>
      {notice && <p role={notice.error ? 'alert' : 'status'} className={notice.error ? 'mb-3 text-red-300' : 'mb-3 text-emerald-300'}>{notice.text}</p>}
      {!reports && !notice && <p role="status">{t.working}</p>}
      {reports?.length === 0 && <p className="text-slate-300">{c.empty}</p>}
      <ul className="space-y-3">
        {reports?.map(report => <li key={report.messageId} className="rounded border border-white/10 bg-white/5 p-3 text-sm">
          <p className="break-words"><strong className="text-cyan-300">{report.callsign}</strong>: {report.text}</p>
          <p className="mt-1 break-all text-xs text-slate-300">{c.messageId}: <code className="select-text">{report.messageId}</code> · {new Date(report.timestamp).toLocaleString(lang === 'zh' ? 'zh-CN' : 'en')}</p>
          <details className="mt-2 text-xs text-slate-300"><summary className="cursor-pointer">{c.reasons} ({report.reports})</summary><ul className="ml-4 mt-2 list-disc">{report.reasons.map((reason, index) => <li key={index} className="break-words">{reason}</li>)}</ul></details>
          <div className="mt-3 flex flex-wrap gap-3">{(Object.keys(c.actions) as Action[]).map(action => <button type="button" key={action} disabled={pending} className={action === 'ban' ? 'text-red-300' : 'text-cyan-300'} onClick={() => setActive({ id: report.messageId, action })}>{c.actions[action]}</button>)}</div>
          {active?.id === report.messageId && <form onSubmit={submit} className="mt-2 space-y-2 border-l border-amber-400 px-3 py-2">
            <label className="grid gap-1 text-slate-200">{c.reason} · {c.actions[active.action]}<input key={active.action} name="reason" required maxLength={300} className="rounded border border-white/20 bg-[#080E18] px-2 py-1.5" /></label>
            <div className="flex gap-3"><button type="submit" disabled={pending} className="text-amber-300">{c.confirm}</button><button type="button" disabled={pending} onClick={() => setActive(undefined)} className="text-slate-300">{t.close}</button></div>
          </form>}
        </li>)}
      </ul>
    </section>
  </div>;
}

import { useEffect, useState, type FormEvent } from 'react';
import { useI18n } from '../i18n/LanguageContext';
import { LOBBY_TEXT, MULTIPLAYER_TEXT } from '../i18n/multiplayer';
import { postJson, requestJson, type AccountSession } from '../net/account';
import { LanguageSwitch } from './LanguageSwitch';

type AccountMode = 'login' | 'register' | 'forgot' | 'resend' | 'verify' | 'reset';

export function accountActionFromUrl(): { mode: 'verify' | 'reset'; token: string } | undefined {
  const params = new URLSearchParams(window.location.search);
  for (const mode of ['verify', 'reset'] as const) {
    const token = params.get(mode);
    if (token) return { mode, token };
  }
}

function clearAccountLink() {
  const url = new URL(window.location.href);
  url.searchParams.delete('verify');
  url.searchParams.delete('reset');
  window.history.replaceState(null, '', url);
}

export function AccountPanel({ onSignIn, inviteCode, onDismissInvite }: {
  onSignIn: (session: AccountSession) => void;
  inviteCode?: string;
  onDismissInvite?: () => void;
}) {
  const { lang } = useI18n();
  const t = MULTIPLAYER_TEXT[lang];
  const [action] = useState(accountActionFromUrl);
  const [mode, setMode] = useState<AccountMode>(action?.mode ?? 'login');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [pending, setPending] = useState(false);
  const [standalone, setStandalone] = useState(false);
  const [ephemeral, setEphemeral] = useState(false);
  const labels = { login: t.signIn, register: t.register, forgot: t.forgot, resend: t.resend, verify: t.verify, reset: t.reset };

  useEffect(() => {
    let active = true;
    void requestJson<{ standalone?: boolean; ephemeral?: boolean }>('/api/auth/mode')
      .then(res => {
        if (!active) return;
        if (res.standalone) setStandalone(true);
        if (res.ephemeral) setEphemeral(true);
      })
      .catch(() => {});
    return () => { active = false; };
  }, []);

  const guestSignIn = async () => {
    if (pending) return;
    setError('');
    setMessage('');
    setPending(true);
    try {
      const result = await postJson<AccountSession>('/api/auth/guest', {});
      if ('playerId' in result) { onSignIn(result); return; }
      throw new Error(t.error);
    } catch (err) { setError(err instanceof Error && err.message ? err.message : t.error); }
    finally { setPending(false); }
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (pending) return;
    const form = new FormData(event.currentTarget);
    const email = form.get('email');
    const password = form.get('password');
    const callsign = form.get('callsign');
    const key = String(form.get('testKey') ?? '').trim();
    const payload = mode === 'login' ? { email, password } : mode === 'register' ? { email, password, callsign }
      : mode === 'forgot' || mode === 'resend' ? { email } : mode === 'verify' ? { token: action?.token } : { token: action?.token, password };
    setError('');
    setMessage('');
    setPending(true);
    try {
      const result = await postJson<AccountSession | { ok: true }>('/api/auth/' + mode, payload, key ? { 'x-playtest-key': key } : undefined);
      if ((mode === 'login' || mode === 'register') && 'playerId' in result) { onSignIn(result); return; }
      if (mode === 'login') throw new Error(t.error);
      setMessage({ register: t.registerDone, forgot: t.forgotDone, resend: t.registerDone, verify: t.verifyDone, reset: t.resetDone }[mode]);
      clearAccountLink();
      setMode('login');
    } catch (err) { setError(err instanceof Error && err.message ? err.message : t.error); }
    finally { setPending(false); }
  };

  const changeMode = (next: AccountMode) => { clearAccountLink(); setMode(next); setError(''); setMessage(''); };
  const emailField = mode === 'login' || mode === 'register' || mode === 'forgot' || mode === 'resend';
  const passwordField = mode === 'login' || mode === 'register' || mode === 'reset';
  const field = 'w-full rounded border border-white/20 bg-[#070D16] px-3 py-2.5 text-sm text-white';

  return (
    <main className="absolute inset-0 grid place-items-center overflow-auto bg-[radial-gradient(ellipse_at_top_left,#163347,#080C14_70%)] p-4">
      <section className="chamfer-panel w-full max-w-md border border-cyan-400/30 bg-[#0D1522] p-6 md:p-8" aria-labelledby="account-title">
        <div className="mb-4 flex items-center justify-between gap-2 text-xs font-mono-tabular text-cyan-400">
          <span>PRISM BREACH</span><LanguageSwitch compact />
        </div>
        <h1 id="account-title" className="font-display text-2xl font-bold text-white">{labels[mode]}</h1>
        <p className="mt-2 text-sm text-slate-400">{mode === 'verify' ? t.verifyInstruction : t.accountIntro}</p>
        {ephemeral && (
          <p role="note" data-testid="ephemeral-demo-notice" className="mt-3 rounded border border-amber-400/30 bg-amber-500/8 px-3 py-2 text-xs text-amber-200 leading-relaxed">
            {t.ephemeralDemoNotice}
          </p>
        )}
        {inviteCode && <section aria-label={LOBBY_TEXT[lang].invitePreview} className="mt-4 space-y-1 rounded border border-cyan-400/25 bg-cyan-500/5 p-3 text-sm">
          <p className="font-semibold">{LOBBY_TEXT[lang].invitePreview} · <code className="break-all text-cyan-300">{inviteCode}</code></p>
          <p className="text-slate-300">{LOBBY_TEXT[lang].inviteLogin}</p>
          {onDismissInvite && <button type="button" className="text-cyan-300" onClick={() => onDismissInvite()}>{t.close}</button>}
        </section>}
        <form key={mode} onSubmit={submit} className="mt-5 flex flex-col gap-3.5">
          {emailField && <label className="grid gap-1 text-sm">{t.email}<input className={field} name="email" type="email" autoComplete="email" maxLength={254} required /></label>}
          {passwordField && <label className="grid gap-1 text-sm">{t.password}
            <input className={field} name="password" type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} minLength={mode === 'login' ? undefined : 12} maxLength={256} required />
          </label>}
          {mode === 'register' && <>
            <label className="grid gap-1 text-sm">{t.callsign}<input className={field} name="callsign" autoComplete="nickname" minLength={2} maxLength={18} required /></label>
            <label className="grid gap-1 text-sm">{t.testKey}<input className={field} name="testKey" type="password" autoComplete="off" maxLength={200} /></label>
          </>}
          <button type="submit" disabled={pending} className="chamfer-btn bg-amber-400 px-4 py-2.5 font-bold text-slate-950 hover:bg-amber-300 disabled:opacity-60">{pending ? t.working : labels[mode]}</button>
          {standalone && mode === 'login' && (
            <button type="button" disabled={pending} onClick={() => void guestSignIn()} className="chamfer-sm border border-cyan-400/45 bg-cyan-500/12 px-4 py-2.5 text-sm font-semibold text-cyan-200 hover:bg-cyan-500/20 disabled:opacity-60 cursor-pointer">
              {t.quickPlay}
            </button>
          )}
        </form>
        {error && <p role="alert" className="mt-3 text-sm text-red-300">{error}</p>}
        {message && <p role="status" className="mt-3 text-sm text-emerald-300">{message}</p>}
        <nav className="mt-4 flex flex-wrap gap-4 text-sm text-cyan-300">
          {mode !== 'login' && <button type="button" disabled={pending} onClick={() => changeMode('login')}>{t.signIn}</button>}
          {mode === 'login' && <>
            <button type="button" disabled={pending} onClick={() => changeMode('register')}>{t.register}</button>
            <button type="button" disabled={pending} onClick={() => changeMode('forgot')}>{t.forgot}</button>
            <button type="button" disabled={pending} onClick={() => changeMode('resend')}>{t.resend}</button>
          </>}
        </nav>
      </section>
    </main>
  );
}

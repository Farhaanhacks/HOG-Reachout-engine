'use client';

import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Wordmark } from './logo';

/** Shows the app once this browser is logged in; otherwise a full-screen login. */
export function AuthGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<'checking' | 'in' | 'out'>('checking');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch('/api/session')
      .then((r) => r.json())
      .then((d: { ok?: boolean }) => setState(d.ok ? 'in' : 'out'))
      .catch(() => setState('out'));
  }, []);

  async function login(e: FormEvent) {
    e.preventDefault();
    if (!password) return setError('Enter the team password.');
    setBusy(true);
    setError('');
    const res = await fetch('/api/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }) });
    setBusy(false);
    if (res.ok) setState('in');
    else setError('That password is not right. Try again.');
  }

  if (state === 'checking') return <div className="loading-screen">Loading…</div>;
  if (state === 'in') return <>{children}</>;
  return (
    <div className="login-screen">
      <form className="login-card" onSubmit={login}>
        <Wordmark />
        <p>Log in with the team password.</p>
        <label className="field">
          Password
          <input id="app-password" type="password" value={password} onChange={(e) => { setPassword(e.target.value); setError(''); }} autoFocus autoComplete="current-password" />
        </label>
        {error && <p className="alert" role="alert">{error}</p>}
        <button className="primary block" type="submit" disabled={busy}>{busy ? 'Checking…' : 'Log in'}</button>
      </form>
    </div>
  );
}

'use client';

import { useEffect, useState, type FormEvent, type ReactNode } from 'react';

/** Shows the page once this browser is logged in; otherwise a password form. */
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
    if (!password) return setError('Enter the app password.');
    setBusy(true);
    setError('');
    const res = await fetch('/api/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }) });
    setBusy(false);
    if (res.ok) setState('in');
    else setError('That password is not right. Try again.');
  }

  if (state === 'checking') return <p className="muted">Loading…</p>;
  if (state === 'in') return <>{children}</>;
  return (
    <form className="card login" onSubmit={login}>
      <h1>Log in</h1>
      <p className="muted">Enter the team password to use the lead engine.</p>
      <label className="field">
        Password
        <input id="app-password" type="password" value={password} onChange={(e) => { setPassword(e.target.value); setError(''); }} autoFocus />
      </label>
      {error && <p className="alert" role="alert">{error}</p>}
      <button className="primary" type="submit" disabled={busy}>{busy ? 'Checking…' : 'Log in'}</button>
    </form>
  );
}

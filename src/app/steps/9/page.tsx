'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { EnrichStatus, EnrichSummary } from '../../../lib/enrich';
import type { SavedPerson } from '../../../lib/store';

export default function Step9() {
  const [password, setPassword] = useState('');
  const [limit, setLimit] = useState(10);
  const [status, setStatus] = useState<EnrichStatus | null>(null);
  const [preview, setPreview] = useState<SavedPerson[] | null>(null);
  const [done, setDone] = useState<SavedPerson[] | null>(null);
  const [summary, setSummary] = useState<EnrichSummary | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const headers = { 'content-type': 'application/json', 'x-app-password': password };

  async function call(init?: RequestInit) {
    const res = await fetch('/api/steps/9', { headers, ...init });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? `Error ${res.status}`);
    return data;
  }

  async function refresh() {
    const data = await call();
    setStatus(data.status);
    setDone(data.people);
  }

  async function act(fn: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
  }

  const doPreview = () => act(async () => {
    setSummary(null);
    const data = await call({ method: 'POST', body: JSON.stringify({ action: 'preview', limit }) });
    setPreview(data.people);
    setStatus(data.status);
  });

  const doRun = () => act(async () => {
    const data = await call({ method: 'POST', body: JSON.stringify({ action: 'run', limit, confirm: true }) });
    setSummary(data.summary);
    setPreview(null);
    await refresh();
  });

  const cell = { padding: '6px 8px', borderBottom: '1px solid #2c2e32', textAlign: 'left' as const, verticalAlign: 'top' as const };

  return (
    <>
      <p><Link href="/tools">Back to tools</Link></p>
      <h1>Step 9: Apollo emails</h1>
      <p>Done when: saved target people get an email from Apollo, each person is looked up once, and the daily cap stops the run. "Preview" spends nothing. "Enrich" spends Apollo credits.</p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <button onClick={() => act(refresh)} disabled={busy} style={{ padding: '8px 16px' }}>Show status</button>
        <label>People to look up <input type="number" min={1} max={100} value={limit} onChange={(e) => setLimit(Number(e.target.value))} style={{ width: 70, padding: 6 }} /></label>
        <button onClick={doPreview} disabled={busy} style={{ padding: '8px 16px' }}>Preview (free)</button>
        <button onClick={doRun} disabled={busy || !preview?.length} style={{ padding: '8px 16px' }} title="Preview first">Enrich with Apollo</button>
      </div>
      {error && <p role="alert" style={{ color: '#f07f78' }}>{error}</p>}
      {status && (
        <p>
          {status.pending} waiting · {status.checked} looked up · {status.withEmail} with a confident email · today {status.usedToday}/{status.dailyLimit} lookups, {status.creditsToday} credits.
        </p>
      )}
      {summary && (
        <p role="status">
          Sent {summary.requested} to Apollo: {summary.matched} matched, {summary.withEmail} with a confident email, {summary.credits} credits used.{summary.stopped ? ` Stopped: ${summary.stopped}` : ''}
        </p>
      )}
      {preview && (
        <>
          <h2>Would look up {preview.length}</h2>
          <p><small>Only people tagged founder, C-suite, owner or partner, not based outside the country, never looked up before.</small></p>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 14 }}>
              <thead><tr>{['Name', 'Title', 'Company', 'Profile'].map((h) => <th key={h} style={cell}>{h}</th>)}</tr></thead>
              <tbody>{preview.map((p) => <tr key={String(p.id)}><td style={cell}>{p.name}</td><td style={cell}>{p.title || '—'}</td><td style={cell}>{p.company || '—'}</td><td style={cell}><a href={p.linkedin_url}>open</a></td></tr>)}</tbody>
            </table>
          </div>
        </>
      )}
      {done && (
        <>
          <h2>Looked up ({done.length})</h2>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 14 }}>
              <thead><tr>{['Name', 'Company', 'Email', 'Email status', 'Result', 'Confidence', 'Tier'].map((h) => <th key={h} style={cell}>{h}</th>)}</tr></thead>
              <tbody>
                {done.map((p) => (
                  <tr key={String(p.id)}>
                    <td style={cell}><a href={p.linkedin_url}>{p.name}</a></td>
                    <td style={cell}>{p.company || '—'}</td>
                    <td style={cell}>{p.email || '—'}</td>
                    <td style={cell}>{p.email_status || '—'}</td>
                    <td style={cell}>{p.apollo_status}</td>
                    <td style={cell}>{p.apollo_confidence || '—'}</td>
                    <td style={cell}>{p.apollo_tier || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}

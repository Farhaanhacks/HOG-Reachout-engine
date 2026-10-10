'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { DomainCandidate } from '../../../lib/website';

export default function Step5() {
  const [company, setCompany] = useState('DAMAC Properties');
  const [city, setCity] = useState('Dubai');
  const [geo, setGeo] = useState<'ae' | 'us'>('ae');
  const [password, setPassword] = useState('');
  const [out, setOut] = useState<{ query: string; domain: string; candidates: DomainCandidate[] } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true);
    setError('');
    setOut(null);
    const res = await fetch('/api/steps/5', { method: 'POST', headers: { 'content-type': 'application/json', 'x-app-password': password }, body: JSON.stringify({ company, geo, city }) });
    const data = await res.json();
    if (!res.ok) setError(data.error ?? `Error ${res.status}`);
    else setOut(data);
    setBusy(false);
  }

  const cell = { padding: '6px 8px', borderBottom: '1px solid #d8e0e5', textAlign: 'left' as const };

  return (
    <>
      <p><Link href="/">Back to steps</Link></p>
      <h1>Step 5: Company domain resolver</h1>
      <p>Done when: the company's own domain is found, and directories such as LinkedIn, Crunchbase and ZoomInfo are never chosen. Try a company from your Step 3 results.</p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <input value={company} onChange={(e) => setCompany(e.target.value)} style={{ flex: '1 1 240px', padding: 8 }} aria-label="Company" />
        <input value={city} onChange={(e) => setCity(e.target.value)} style={{ width: 140, padding: 8 }} aria-label="City" placeholder="City (optional)" />
        <select value={geo} onChange={(e) => setGeo(e.target.value as 'ae' | 'us')} style={{ padding: 8 }} aria-label="Country">
          <option value="ae">UAE</option>
          <option value="us">United States</option>
        </select>
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} placeholder="App password" style={{ padding: 8 }} aria-label="App password" />
        <button onClick={run} disabled={busy} style={{ padding: '8px 16px' }}>{busy ? 'Searching…' : 'Find website'}</button>
      </div>
      {error && <p role="alert" style={{ color: '#a3302b' }}>{error}</p>}
      {out && (
        <>
          <h2>{out.domain ? `Domain: ${out.domain}` : 'No convincing domain found'}</h2>
          <p><small>Search: {out.query}</small></p>
          <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 14 }}>
            <thead><tr>{['Domain', 'Score (0 = rejected)', 'Result'].map((h) => <th key={h} style={cell}>{h}</th>)}</tr></thead>
            <tbody>
              {out.candidates.map((c) => (
                <tr key={c.domain}>
                  <td style={cell}>{c.domain}</td>
                  <td style={cell}>{c.score}</td>
                  <td style={cell}><a href={c.link}>{c.link}</a></td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </>
  );
}

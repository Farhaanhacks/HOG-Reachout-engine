'use client';

import Link from 'next/link';
import { useState } from 'react';
import { geoShort } from '../../../lib/geo';
import type { SavedPerson } from '../../../lib/store';

type Summary = { found: number; excludedOutsideCountry: number; inserted: number; updated: number };

export default function Step6() {
  const [query, setQuery] = useState('site:linkedin.com/in ("Founder" OR "CEO" OR "Co-Founder") "Dubai"');
  const [geo, setGeo] = useState<'ae' | 'us'>('ae');
  const [password, setPassword] = useState('');
  const [summary, setSummary] = useState<Summary | null>(null);
  const [people, setPeople] = useState<SavedPerson[] | null>(null);
  const [targetsOnly, setTargetsOnly] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const headers = { 'content-type': 'application/json', 'x-app-password': password };

  async function load(targets = targetsOnly) {
    const res = await fetch(`/api/steps/6?targets=${targets ? 1 : 0}`, { headers });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? `Error ${res.status}`);
    setPeople(data.people);
  }

  async function run() {
    setBusy(true);
    setError('');
    setSummary(null);
    try {
      const res = await fetch('/api/steps/6', { method: 'POST', headers, body: JSON.stringify({ query, geo }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `Error ${res.status}`);
      setSummary(data);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
  }

  async function show() {
    setBusy(true);
    setError('');
    try {
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
  }

  const cell = { padding: '6px 8px', borderBottom: '1px solid #2c2e32', textAlign: 'left' as const, verticalAlign: 'top' as const };

  return (
    <>
      <p><Link href="/tools">Back to tools</Link></p>
      <h1>Step 6: Dedupe and store</h1>
      <p>Done when: running the same search twice saves nobody the second time ("0 new, N already saved"), and each LinkedIn profile appears once.</p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <input value={query} onChange={(e) => setQuery(e.target.value)} style={{ flex: '1 1 320px', padding: 8 }} aria-label="Query" />
        <select value={geo} onChange={(e) => setGeo(e.target.value as 'ae' | 'us')} style={{ padding: 8 }} aria-label="Country">
          <option value="ae">UAE</option>
          <option value="us">United States</option>
        </select>
        <button onClick={run} disabled={busy} style={{ padding: '8px 16px' }}>{busy ? 'Working…' : 'Search and save'}</button>
        <button onClick={show} disabled={busy} style={{ padding: '8px 16px' }}>Show saved</button>
      </div>
      {error && <p role="alert" style={{ color: '#f07f78' }}>{error}</p>}
      {summary && (
        <p>
          Found {summary.found} profiles. {summary.excludedOutsideCountry} based outside the country were skipped. <strong>{summary.inserted} new</strong>, {summary.updated} already saved.
        </p>
      )}
      {people && (
        <>
          <label>
            <input type="checkbox" checked={targetsOnly} onChange={(e) => { setTargetsOnly(e.target.checked); load(e.target.checked).catch((err) => setError(err.message)); }} /> Only founders, C-suite, owners and partners
          </label>
          <p>{people.length} saved people shown.</p>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 14 }}>
              <thead><tr>{['Name', 'Title', 'Company', 'Labels', 'Country', 'Seen', 'Profile'].map((h) => <th key={h} style={cell}>{h}</th>)}</tr></thead>
              <tbody>
                {people.map((p) => (
                  <tr key={String(p.id)}>
                    <td style={cell}>{p.name}</td>
                    <td style={cell}>{p.title || '—'}</td>
                    <td style={cell}>{p.company || '—'}</td>
                    <td style={cell}>{p.labels || '—'}</td>
                    <td style={cell}>{geoShort(p.geo)} ({p.geo_match})</td>
                    <td style={cell}>{p.seen_count}×</td>
                    <td style={cell}><a href={p.linkedin_url}>open</a></td>
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

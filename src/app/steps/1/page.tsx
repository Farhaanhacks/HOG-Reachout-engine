'use client';

import Link from 'next/link';
import { useState } from 'react';

type Result = { title?: string; link?: string; snippet?: string; subtitle?: string };

export default function Step1() {
  const [query, setQuery] = useState('site:linkedin.com/in founder Dubai');
  const [geo, setGeo] = useState<'ae' | 'us'>('ae');
  const [results, setResults] = useState<Result[] | null>(null);
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function run() {
    setBusy(true);
    setError('');
    setResults(null);
    const res = await fetch('/api/steps/1', { method: 'POST', headers: { 'content-type': 'application/json', 'x-app-password': password }, body: JSON.stringify({ query, geo }) });
    const data = await res.json();
    if (!res.ok) setError(data.error ?? `Error ${res.status}`);
    else setResults(data.results);
    setBusy(false);
  }

  return (
    <>
      <p><Link href="/tools">Back to tools</Link></p>
      <h1>Step 1: Serper search by country</h1>
      <p>Done when: 10 results come back for the UAE and for the US, and they differ.</p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <input value={query} onChange={(e) => setQuery(e.target.value)} style={{ flex: '1 1 320px', padding: 8 }} aria-label="Query" />
        <select value={geo} onChange={(e) => setGeo(e.target.value as 'ae' | 'us')} style={{ padding: 8 }} aria-label="Country">
          <option value="ae">UAE</option>
          <option value="us">United States</option>
        </select>
        <button onClick={run} disabled={busy} style={{ padding: '8px 16px' }}>{busy ? 'Searching…' : 'Search'}</button>
      </div>
      {error && <p role="alert" style={{ color: '#f07f78' }}>{error}</p>}
      {results && (
        <>
          <p>{results.length} results</p>
          <ul style={{ paddingLeft: 18 }}>
            {results.map((r, i) => (
              <li key={i} style={{ margin: '12px 0' }}>
                <strong>{r.title}</strong>
                <br />
                <a href={r.link}>{r.link}</a>
                <br />
                <small>{r.subtitle} {r.snippet}</small>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}

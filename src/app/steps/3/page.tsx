'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { Person } from '../../../lib/linkedin';
import { tagTitle } from '../../../lib/seniority';

export default function Step3() {
  const [query, setQuery] = useState('site:linkedin.com/in ("Founder" OR "CEO" OR "Co-Founder") "Dubai"');
  const [geo, setGeo] = useState<'ae' | 'us'>('ae');
  const [password, setPassword] = useState('');
  const [people, setPeople] = useState<Person[] | null>(null);
  const [rawCount, setRawCount] = useState(0);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [showOther, setShowOther] = useState(false);

  async function run() {
    setBusy(true);
    setError('');
    setPeople(null);
    const res = await fetch('/api/steps/3', { method: 'POST', headers: { 'content-type': 'application/json', 'x-app-password': password }, body: JSON.stringify({ query, geo }) });
    const data = await res.json();
    if (!res.ok) setError(data.error ?? `Error ${res.status}`);
    else {
      setPeople(data.people);
      setRawCount(data.results.length);
    }
    setBusy(false);
  }

  const cell = { padding: '6px 8px', borderBottom: '1px solid #d8e0e5', textAlign: 'left' as const, verticalAlign: 'top' as const };
  const excluded = people?.filter((p) => p.geoMatch === 'other').length ?? 0;
  const shown = (people ?? []).filter((p) => showOther || p.geoMatch !== 'other');
  const complete = shown.filter((p) => p.name && p.title && p.company).length;
  const badge = (m: Person['geoMatch']) => ({ match: '✓ in country', other: '✗ elsewhere', unknown: '? no location' })[m];

  return (
    <>
      <p><Link href="/tools">Back to tools</Link></p>
      <h1>Step 3: LinkedIn snippet parser</h1>
      <p>Done when: name, title and company are read for 8 of every 10 results, and people outside the country are flagged.</p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <input value={query} onChange={(e) => setQuery(e.target.value)} style={{ flex: '1 1 320px', padding: 8 }} aria-label="Query" />
        <select value={geo} onChange={(e) => setGeo(e.target.value as 'ae' | 'us')} style={{ padding: 8 }} aria-label="Country">
          <option value="ae">UAE</option>
          <option value="us">United States</option>
        </select>
        <button onClick={run} disabled={busy} style={{ padding: '8px 16px' }}>{busy ? 'Searching…' : 'Search and parse'}</button>
      </div>
      {error && <p role="alert" style={{ color: '#a3302b' }}>{error}</p>}
      {people && (
        <>
          <p>{rawCount} results, {people.length} profiles, {excluded} based outside the searched country{showOther ? '' : ' (hidden)'}. Of the {shown.length} shown, {complete} have name, title and company ({shown.length ? Math.round((complete / shown.length) * 100) : 0}%).</p>
          <p><small>* guessed from the result's description text, not its title: check before relying on it.</small></p>
          <label><input type="checkbox" checked={showOther} onChange={(e) => setShowOther(e.target.checked)} /> Show people based elsewhere</label>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 14 }}>
              <thead>
                <tr>{['Name', 'Title', 'Seniority', 'Company', 'Location', 'Country', 'Profile'].map((h) => <th key={h} style={cell}>{h}</th>)}</tr>
              </thead>
              <tbody>
                {shown.map((p) => (
                  <tr key={p.linkedin}>
                    <td style={cell}>{p.name}</td>
                    <td style={cell}>{p.title || '—'}</td>
                    <td style={cell}>{tagTitle(p.title, p.company).labels.join(', ') || '—'}</td>
                    <td style={cell}>{p.company || '—'}{p.companyTruncated ? ' (cut off)' : ''}{p.inferred && p.company ? ' *' : ''}</td>
                    <td style={cell}>{p.location || '—'}</td>
                    <td style={cell}>{badge(p.geoMatch)}</td>
                    <td style={cell}><a href={p.linkedin}>open</a></td>
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

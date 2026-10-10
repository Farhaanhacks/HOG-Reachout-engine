'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { GEOS, type Geo } from '../../../lib/geo';
import { buildQueries } from '../../../lib/queries';

export default function Step2() {
  const [geo, setGeo] = useState<Geo>('ae');
  const [titles, setTitles] = useState('Founder, CEO, Co-Founder, Managing Partner, Chairman, CIO');
  const [keywords, setKeywords] = useState('');
  const [cities, setCities] = useState('');

  const list = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);
  const queries = useMemo(() => buildQueries({ geo, titles: list(titles), keywords: list(keywords), cities: list(cities) }), [geo, titles, keywords, cities]);
  const field = { padding: 8, width: '100%', boxSizing: 'border-box' as const };

  return (
    <>
      <p><Link href="/">Back to steps</Link></p>
      <h1>Step 2: Query builder</h1>
      <p>Done when: a brief gives distinct <code>site:linkedin.com/in</code> queries per title group and city. Copy one into Step 1 or Step 3 to try it.</p>
      <div style={{ display: 'grid', gap: 8 }}>
        <label>Country
          <select value={geo} onChange={(e) => setGeo(e.target.value as Geo)} style={field}>
            {(Object.keys(GEOS) as Geo[]).map((g) => <option key={g} value={g}>{GEOS[g].label}</option>)}
          </select>
        </label>
        <label>Titles (comma separated)<input value={titles} onChange={(e) => setTitles(e.target.value)} style={field} /></label>
        <label>Words every profile must contain (optional, e.g. hedge fund)<input value={keywords} onChange={(e) => setKeywords(e.target.value)} style={field} /></label>
        <label>Cities (blank = {GEOS[geo].cities.join(', ')})<input value={cities} onChange={(e) => setCities(e.target.value)} style={field} /></label>
      </div>
      <h2>{queries.length} queries</h2>
      <ol style={{ paddingLeft: 20 }}>
        {queries.map((q) => <li key={q} style={{ margin: '6px 0', wordBreak: 'break-word' }}><code>{q}</code></li>)}
      </ol>
    </>
  );
}

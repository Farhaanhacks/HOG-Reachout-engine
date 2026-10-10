'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { tagTitle } from '../../../lib/seniority';

const EXAMPLES = ['Founder & CEO', 'Chief Technology Officer', 'Co-Founder & Chairman', 'Managing Partner | Acme Capital', 'Chief Investment Officer | Zeta Capital', 'Managing Director', 'Vice President, Sales', 'Head of Operations', 'Former CEO', 'Chief of Staff', 'Partner Success Manager', 'Owner'].join('\n');

export default function Step4() {
  const [text, setText] = useState(EXAMPLES);
  const rows = useMemo(
    () =>
      text.split('\n').map((l) => l.trim()).filter(Boolean).map((line) => {
        const [title, company = ''] = line.split('|').map((s) => s.trim());
        return { title, company, tag: tagTitle(title, company) };
      }),
    [text],
  );
  const cell = { padding: '6px 8px', borderBottom: '1px solid #d8e0e5', textAlign: 'left' as const, verticalAlign: 'top' as const };

  return (
    <>
      <p><Link href="/tools">Back to tools</Link></p>
      <h1>Step 4: Title normaliser and seniority tag</h1>
      <p>Done when: "Co-Founder &amp; CEO" is a founder and C-suite target, and "Former CEO" or "Chief of Staff" is not. One title per line; add <code>| Company</code> to test fund detection.</p>
      <textarea value={text} onChange={(e) => setText(e.target.value)} rows={8} style={{ width: '100%', boxSizing: 'border-box', padding: 8, fontFamily: 'inherit' }} aria-label="Titles" />
      <div style={{ overflowX: 'auto' }}>
        <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 14, marginTop: 12 }}>
          <thead>
            <tr>{['Title', 'Labels', 'Target', 'Fund principal', 'Search keywords'].map((h) => <th key={h} style={cell}>{h}</th>)}</tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td style={cell}>{r.title}{r.company ? <small> ({r.company})</small> : null}</td>
                <td style={cell}>{r.tag.current ? r.tag.labels.join(', ') || '—' : 'not current / not the person'}</td>
                <td style={cell}>{r.tag.isTarget ? 'yes' : 'no'}</td>
                <td style={cell}>{r.tag.fundPrincipal ? 'yes' : '—'}</td>
                <td style={cell}>{r.tag.keywords.join(', ') || '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

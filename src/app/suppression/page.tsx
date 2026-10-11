'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, parseCsv, post } from '../../lib/client';
import type { ImportRow, ImportSummary, SuppressionSource, SuppressionStatus } from '../../lib/suppression';

/** Which column of the file holds what, guessed from the headers ("Work Email", "Company Website", "LinkedIn URL"…). */
const COLUMNS: { key: keyof ImportRow; test: RegExp }[] = [
  { key: 'email', test: /e-?mail/i },
  { key: 'linkedin', test: /linkedin/i },
  { key: 'website', test: /website|domain|url|site/i },
  { key: 'company', test: /company|organi[sz]ation|account|business|brand|firm/i },
  { key: 'name', test: /name/i },
];

function guessColumns(headers: string[]): Partial<Record<keyof ImportRow, number>> {
  const out: Partial<Record<keyof ImportRow, number>> = {};
  const used = new Set<number>();
  for (const { key, test } of COLUMNS) {
    const i = headers.findIndex((h, j) => !used.has(j) && test.test(h) && !(key === 'website' && /linkedin|e-?mail/i.test(h)) && !(key === 'name' && /company|organi/i.test(h)));
    if (i >= 0) {
      out[key] = i;
      used.add(i);
    }
  }
  return out;
}

const SOURCE_LABEL: Record<string, string> = { client: 'Clients', contacted: 'Previously contacted', manual: 'Added by hand' };
const KIND_LABEL: Record<string, string> = { email: 'emails', domain: 'company domains', linkedin: 'LinkedIn profiles', company: 'company names' };

export default function SuppressionPage() {
  const [status, setStatus] = useState<SuppressionStatus | null>(null);
  const [source, setSource] = useState<SuppressionSource>('client');
  const [file, setFile] = useState<{ name: string; headers: string[]; rows: string[][] } | null>(null);
  const [columns, setColumns] = useState<Partial<Record<keyof ImportRow, number>>>({});
  const [result, setResult] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api<SuppressionStatus>('/api/suppression').then(setStatus).catch((e: Error) => setError(e.message));
  }, []);
  useEffect(load, [load]);

  async function readFile(f: File | undefined) {
    setResult('');
    setError('');
    if (!f) return;
    if (/\.xlsx?$/i.test(f.name)) {
      setError('This is an Excel file. In Excel or Google Sheets choose File, Save as (or Download), CSV, then pick the CSV here.');
      return;
    }
    const rows = parseCsv(await f.text());
    if (rows.length < 2) {
      setError('The file has no rows under its header line.');
      return;
    }
    const headers = rows[0].map((h) => h.trim());
    setFile({ name: f.name, headers, rows: rows.slice(1) });
    setColumns(guessColumns(headers));
  }

  async function importFile() {
    if (!file) return;
    setBusy(true);
    setError('');
    const cell = (r: string[], key: keyof ImportRow) => (columns[key] === undefined ? '' : (r[columns[key] as number] ?? '').trim());
    const rows: ImportRow[] = file.rows.map((r) => ({ email: cell(r, 'email'), linkedin: cell(r, 'linkedin'), website: cell(r, 'website'), company: cell(r, 'company'), name: cell(r, 'name') }));
    const total: ImportSummary = { rows: 0, added: 0, alreadyListed: 0, unusable: 0 };
    try {
      for (let i = 0; i < rows.length; i += 2000) {
        setResult(`Importing… ${i} of ${rows.length} rows`);
        const d = await api<{ summary: ImportSummary; status: SuppressionStatus }>('/api/suppression', post({ action: 'import', source, rows: rows.slice(i, i + 2000), note: file.name }));
        total.rows += d.summary.rows;
        total.added += d.summary.added;
        total.alreadyListed += d.summary.alreadyListed;
        total.unusable += d.summary.unusable;
        setStatus(d.status);
      }
      setResult(`Imported ${total.rows} rows from ${file.name}: ${total.added} new entries, ${total.alreadyListed} already on the list${total.unusable ? `, ${total.unusable} rows had nothing usable (no email, LinkedIn, website or company)` : ''}.`);
      setFile(null);
    } catch (e) {
      setError(`${(e as Error).message}. Rows imported before this are kept; import the file again to finish (nothing is added twice).`);
    }
    setBusy(false);
  }

  async function clear(s: SuppressionSource) {
    if (!window.confirm(`Remove every "${SOURCE_LABEL[s]}" entry from the suppression list? Leads they blocked could then be emailed. Re-import the corrected file straight after.`)) return;
    setBusy(true);
    try {
      const d = await api<{ removed: number; status: SuppressionStatus }>('/api/suppression', post({ action: 'clear', source: s }));
      setStatus(d.status);
      setResult(`Removed ${d.removed} entries.`);
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
  }

  const sources = [...new Set(status?.bySource.map((r) => r.source) ?? [])];
  const usable = file && (columns.email !== undefined || columns.linkedin !== undefined || columns.website !== undefined || columns.company !== undefined);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Suppression list</h1>
          <p className="sub">Clients and everyone contacted before. Nobody on this list is ever looked up, saved as ready or emailed: it is checked before paying Apollo, when a lead is saved, and again right before every send.</p>
        </div>
      </div>

      {error && <p className="alert" role="alert">{error}</p>}

      <div className="stats">
        <div className="stat"><div className="n">{status?.total ?? '—'}</div><div className="l">Entries on the list</div></div>
        <div className="stat"><div className="n">{status?.blockedLeads ?? '—'}</div><div className="l">Saved leads it blocks</div></div>
      </div>

      <div className="grid-run">
        <section className="card">
          <h2>Import a list</h2>
          <div className="segmented" role="radiogroup" aria-label="What the list is" style={{ gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' }}>
            <button role="radio" aria-checked={source === 'client'} className={source === 'client' ? 'on' : ''} onClick={() => setSource('client')} disabled={busy}>
              <b>Client list</b>
              <span>Blocks the whole company: its website, email domain and name</span>
            </button>
            <button role="radio" aria-checked={source === 'contacted'} className={source === 'contacted' ? 'on' : ''} onClick={() => setSource('contacted')} disabled={busy}>
              <b>Previously contacted</b>
              <span>Blocks each person: their email and LinkedIn</span>
            </button>
          </div>
          <label className="field">
            CSV file
            <input id="suppression-file" type="file" accept=".csv,text/csv,.txt,.xlsx,.xls" onChange={(e) => readFile(e.target.files?.[0])} disabled={busy} />
            <span className="hint">Any columns work: the page finds the email, LinkedIn, website and company columns from the headers. Excel files need saving as CSV first.</span>
          </label>
          {file && (
            <>
              <p className="muted small">{file.name}: {file.rows.length} rows. Check the columns:</p>
              <div className="form">
                {(['email', 'linkedin', 'website', 'company'] as const).map((key) => (
                  <label key={key} className="field">
                    {key === 'email' ? 'Email' : key === 'linkedin' ? 'LinkedIn' : key === 'website' ? 'Website or domain' : 'Company name'}
                    <select value={columns[key] ?? ''} onChange={(e) => setColumns((c) => ({ ...c, [key]: e.target.value === '' ? undefined : Number(e.target.value) }))}>
                      <option value="">Not in this file</option>
                      {file.headers.map((h, i) => <option key={i} value={i}>{h || `Column ${i + 1}`}</option>)}
                    </select>
                  </label>
                ))}
              </div>
              <div className="row">
                <button className="primary" onClick={importFile} disabled={busy || !usable}>{busy ? 'Importing…' : `Import ${file.rows.length} rows as ${SOURCE_LABEL[source].toLowerCase()}`}</button>
                <button onClick={() => setFile(null)} disabled={busy}>Cancel</button>
              </div>
            </>
          )}
          {result && <p className="note small" role="status">{result}</p>}
        </section>

        <section className="card">
          <h2>On the list</h2>
          {sources.length ? (
            sources.map((s) => (
              <div key={s} className="draft">
                <div className="card-head">
                  <b>{SOURCE_LABEL[s] ?? s}</b>
                  <button className="link small danger" onClick={() => clear(s as SuppressionSource)} disabled={busy}>Remove all</button>
                </div>
                <p className="muted small">
                  {status?.bySource.filter((r) => r.source === s).map((r) => `${r.n.toLocaleString()} ${KIND_LABEL[r.kind] ?? r.kind}`).join(' · ')}
                </p>
              </div>
            ))
          ) : (
            <p className="muted">Nothing yet. Import the client list and the previously contacted list before the first send.</p>
          )}
        </section>
      </div>
    </div>
  );
}

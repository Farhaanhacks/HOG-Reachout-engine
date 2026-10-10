'use client';

import { useCallback, useEffect, useState } from 'react';
import { EmailBadge } from '../../components/badges';
import { api, post } from '../../lib/client';
import type { EnrichStatus, EnrichSummary } from '../../lib/enrich';
import type { SavedPerson } from '../../lib/store';

export default function EmailsPage() {
  const [limit, setLimit] = useState(10);
  const [status, setStatus] = useState<EnrichStatus | null>(null);
  const [preview, setPreview] = useState<SavedPerson[] | null>(null);
  const [done, setDone] = useState<SavedPerson[] | null>(null);
  const [summary, setSummary] = useState<EnrichSummary | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const d = await api<{ status: EnrichStatus; people: SavedPerson[] }>('/api/steps/9');
    setStatus(d.status);
    setDone(d.people);
  }, []);

  useEffect(() => {
    refresh().catch((e: Error) => setError(e.message));
  }, [refresh]);

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

  const doPreview = () =>
    act(async () => {
      setSummary(null);
      const d = await api<{ people: SavedPerson[]; status: EnrichStatus }>('/api/steps/9', post({ action: 'preview', limit }));
      setPreview(d.people);
      setStatus(d.status);
    });

  const doRun = () =>
    act(async () => {
      const d = await api<{ summary: EnrichSummary }>('/api/steps/9', post({ action: 'run', limit, confirm: true }));
      setSummary(d.summary);
      setPreview(null);
      await refresh();
    });

  const left = status ? status.dailyLimit - status.usedToday : 0;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Emails (Apollo)</h1>
          <p className="sub">Apollo turns saved LinkedIn profiles into emails. Only founders, C-suite, owners and partners are sent, each person once, oldest first.</p>
        </div>
      </div>

      <div className="stats">
        <div className="stat"><div className="n">{status?.pending ?? '—'}</div><div className="l">Waiting</div></div>
        <div className="stat"><div className="n">{status?.checked ?? '—'}</div><div className="l">Looked up</div></div>
        <div className="stat"><div className="n">{status?.withEmail ?? '—'}</div><div className="l">Emails ready</div></div>
        <div className="stat"><div className="n">{status ? `${status.usedToday}/${status.dailyLimit}` : '—'}</div><div className="l">Lookups today</div></div>
        <div className="stat"><div className="n">{status?.creditsToday ?? '—'}</div><div className="l">Credits today</div></div>
      </div>

      <section className="card">
        <h2>Get emails</h2>
        <div className="row">
          <label className="check">
            Look up
            <input id="emails-limit" type="number" min={1} max={100} value={limit} onChange={(e) => { setLimit(Math.max(1, Math.min(100, Number(e.target.value) || 1))); setPreview(null); }} style={{ width: 80 }} />
            people
          </label>
          <button onClick={doPreview} disabled={busy}>Preview (free)</button>
          <button className="primary" onClick={doRun} disabled={busy || !preview?.length} title={preview?.length ? '' : 'Preview first'}>
            {busy ? 'Working…' : `Get ${preview?.length ?? ''} emails`}
          </button>
        </div>
        <p className="muted small">Preview spends nothing. Getting emails spends about 1 Apollo credit per person found. {status ? `${Math.max(0, left)} lookups left today.` : ''}</p>
        {error && <p className="alert" role="alert">{error}</p>}
        {summary && (
          <p className={summary.stopped ? 'warn-note' : 'note'} role="status">
            Looked up {summary.requested}: {summary.withEmail} emails ready, {summary.credits} credits used.{summary.stopped ? ` Stopped: ${summary.stopped}` : ''}
          </p>
        )}
        {preview && (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Would look up</th><th>Title</th><th>Company</th></tr></thead>
              <tbody>
                {preview.map((p) => (
                  <tr key={String(p.id)}><td><a href={p.linkedin_url} target="_blank" rel="noreferrer">{p.name}</a></td><td>{p.title || '—'}</td><td>{p.company || '—'}</td></tr>
                ))}
              </tbody>
            </table>
            {!preview.length && <p className="empty">Nobody is waiting. Find more leads first.</p>}
          </div>
        )}
      </section>

      <section className="card">
        <h2>Looked up</h2>
        <p className="muted small">"Low match" means Apollo found an email but is less sure it belongs to this person. These are still counted as ready and will be emailed.</p>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Name</th><th>Company</th><th>Email</th><th>Result</th><th>Apollo confidence</th></tr></thead>
            <tbody>
              {done?.map((p) => (
                <tr key={String(p.id)}>
                  <td><a href={p.linkedin_url} target="_blank" rel="noreferrer">{p.name}</a></td>
                  <td>{p.company || '—'}</td>
                  <td>{p.email || <span className="muted">—</span>}</td>
                  <td><EmailBadge status={p.apollo_status} /></td>
                  <td>{p.apollo_confidence || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {done && !done.length && <p className="empty">No one looked up yet.</p>}
        </div>
      </section>
    </div>
  );
}

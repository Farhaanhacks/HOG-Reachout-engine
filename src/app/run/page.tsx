'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { RunBadge } from '../../components/badges';
import { api, countryName, formatDate, post } from '../../lib/client';
import type { EnrichSummary } from '../../lib/enrich';
import { SEGMENTS, segmentById } from '../../lib/icp';
import type { Run } from '../../lib/run';

const ratio = (a: number, b: number) => (b ? (a / b).toFixed(1) : '—');

const SIZES = [
  { searches: 10, label: 'Quick', hint: '10 searches' },
  { searches: 30, label: 'Standard', hint: '30 searches' },
  { searches: 60, label: 'Large', hint: '60 searches' },
];

/** Every title the ICP looks for, once each, for the summary. */
const ALL_TITLES = [...new Set(SEGMENTS.flatMap((s) => s.titles))];

export default function RunPage() {
  const [size, setSize] = useState(30);
  const [withApollo, setWithApollo] = useState(false);
  const [apolloLimit, setApolloLimit] = useState(20);

  const [run, setRun] = useState<Run | null>(null);
  const [history, setHistory] = useState<Run[]>([]);
  const [log, setLog] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const stop = useRef(false);

  const loadHistory = useCallback(() => {
    api<{ runs: Run[] }>('/api/runs').then((d) => setHistory(d.runs)).catch(() => {});
  }, []);
  useEffect(loadHistory, [loadHistory]);

  const say = (line: string) => setLog((l) => [...l, line]);

  async function drive(start: Run, apollo: number | null) {
    stop.current = false;
    setBusy(true);
    setError('');
    let r = start;
    setRun(r);
    try {
      while (r.status === 'running' && r.next_index < r.queries.length) {
        if (stop.current) {
          r = (await api<{ run: Run }>(`/api/runs/${r.id}/finish`, post({ status: 'stopped' }))).run;
          setRun(r);
          say('Stopped. Everyone found so far is saved.');
          return;
        }
        const before = r;
        const q = r.queries[r.next_index];
        r = (await api<{ run: Run }>(`/api/runs/${r.id}/step`, post())).run;
        setRun(r);
        say(`${r.next_index}/${r.queries.length} · ${countryName(q.geo)} · ${segmentById(q.segment)?.label ?? 'Search'}${q.startPage > 1 ? ` (from page ${q.startPage})` : ''}: ${r.inserted - before.inserted} new, ${r.updated - before.updated} already saved, ${r.excluded - before.excluded} based elsewhere`);
      }
      if (r.status === 'running' && apollo) {
        say('Getting emails from Apollo…');
        const d = await api<{ run: Run; summary: EnrichSummary }>(`/api/runs/${r.id}/enrich`, post({ limit: apollo, confirm: true }));
        r = d.run;
        setRun(r);
        say(`Apollo: ${d.summary.requested} looked up, ${d.summary.withEmail} emails ready, ${d.summary.credits} credits${d.summary.stopped ? `. ${d.summary.stopped}` : ''}`);
      }
      if (r.status === 'running') {
        r = (await api<{ run: Run }>(`/api/runs/${r.id}/finish`, post({ status: 'done' }))).run;
        setRun(r);
        say('Done.');
      }
    } catch (e) {
      setError(`${(e as Error).message} Nothing found so far is lost. Press Continue to retry.`);
      say(`Paused: ${(e as Error).message}`);
    } finally {
      setBusy(false);
      loadHistory();
    }
  }

  async function start() {
    setLog([]);
    setError('');
    try {
      const d = await api<{ run: Run }>('/api/runs', post({ maxQueries: size, pages: 2 }));
      say(`Started: ${d.run.queries.length} searches across the UAE and the US.`);
      await drive(d.run, withApollo ? apolloLimit : null);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  function resume(r: Run) {
    setLog([`Continuing the run from ${formatDate(r.created_at)}.`]);
    drive(r, withApollo ? apolloLimit : null);
  }

  const done = run ? run.next_index : 0;
  const totalQ = run ? run.queries.length : 0;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Find leads</h1>
          <p className="sub">One click finds successful people in the UAE and the US: the founder, CEO or managing director of a company, and the CIO or managing partner of a fund. Each run searches somewhere new, so running it again keeps finding new people.</p>
        </div>
      </div>

      <div className="grid-run">
        <section className="card">
          <h2>Start a run</h2>
          <div>
            <div className="section-label">Run size</div>
            <div className="segmented" role="radiogroup" aria-label="Run size">
              {SIZES.map((s) => (
                <button key={s.searches} role="radio" aria-checked={size === s.searches} className={size === s.searches ? 'on' : ''} onClick={() => setSize(s.searches)} disabled={busy}>
                  <b>{s.label}</b>
                  <span>{s.hint}</span>
                </button>
              ))}
            </div>
          </div>
          <div className="row">
            <label className="check"><input id="run-apollo" type="checkbox" checked={withApollo} onChange={(e) => setWithApollo(e.target.checked)} disabled={busy} /> Then get emails from Apollo for up to</label>
            <input id="run-apollo-limit" type="number" min={1} max={100} value={apolloLimit} onChange={(e) => setApolloLimit(Math.max(1, Math.min(100, Number(e.target.value) || 1)))} disabled={busy || !withApollo} style={{ width: 90 }} aria-label="Apollo lookups" />
            <span className="muted small">people</span>
          </div>
          <p className="muted small">Uses up to {size * 2} Serper credits{withApollo ? ` and about ${apolloLimit} Apollo credits` : ''}.</p>
          <div className="row">
            <button className="primary big" onClick={start} disabled={busy}>{busy ? 'Finding leads…' : 'Find leads'}</button>
            {busy && <button className="danger" onClick={() => (stop.current = true)}>Stop after this search</button>}
            {run && run.status === 'running' && !busy && <button onClick={() => resume(run)}>Continue</button>}
          </div>
          {error && <p className="alert" role="alert">{error}</p>}
        </section>

        <section className="card">
          <h2>Who we look for</h2>
          <p className="muted small">Successful people who lead a company, in the <b>UAE</b> and the <b>United States</b>. People based anywhere else are skipped.</p>
          <div className="chips">
            {ALL_TITLES.map((t) => <span key={t} className="chip">{t}</span>)}
          </div>
          <p className="muted small">Across {SEGMENTS.map((s) => s.label.toLowerCase()).join(', ')}.</p>
        </section>
      </div>

      {run && (
        <section className="card">
          <div className="card-head">
            <h2>This run</h2>
            <RunBadge status={run.status} error={busy ? '' : run.error} />
          </div>
          <div className="progress" aria-label="Progress"><div style={{ width: `${totalQ ? (done / totalQ) * 100 : 0}%` }} /></div>
          <p className="muted small">{done} of {totalQ} searches done</p>
          <div className="stats">
            <div className="stat"><div className="n">{run.inserted}</div><div className="l">New people</div></div>
            <div className="stat"><div className="n">{run.updated}</div><div className="l">Already saved</div></div>
            <div className="stat"><div className="n">{run.excluded}</div><div className="l">Based elsewhere, skipped</div></div>
            <div className="stat"><div className="n">{run.apollo_with_email}</div><div className="l">Emails ready</div></div>
            <div className="stat"><div className="n">{run.searches}</div><div className="l">Serper searches</div></div>
            <div className="stat"><div className="n">{run.apollo_credits}</div><div className="l">Apollo credits</div></div>
            <div className="stat"><div className="n">{ratio(run.searches, run.inserted)}</div><div className="l">Searches per new person</div></div>
            <div className="stat"><div className="n">{ratio(run.apollo_credits, run.apollo_with_email)}</div><div className="l">Credits per email</div></div>
          </div>
          {log.length > 0 && <div className="log" aria-live="polite">{log.join('\n')}</div>}
        </section>
      )}

      <section className="card">
        <h2>Past runs</h2>
        {history.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Started</th><th>Countries</th><th className="num">Searches</th><th className="num">New people</th><th className="num">Emails</th><th className="num">Apollo credits</th><th>Status</th><th></th></tr>
              </thead>
              <tbody>
                {history.map((r) => (
                  <tr key={String(r.id)}>
                    <td>{formatDate(r.created_at)}</td>
                    <td>{countryName(r.geo)}</td>
                    <td className="num">{r.next_index}/{r.queries.length}</td>
                    <td className="num">{r.inserted}</td>
                    <td className="num">{r.apollo_with_email}</td>
                    <td className="num">{r.apollo_credits}</td>
                    <td><RunBadge status={r.status} error={r.error} /></td>
                    <td>{r.status === 'running' && !busy ? <button className="link" onClick={() => resume(r)}>Continue</button> : null}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted">No runs yet. Press Find leads to start.</p>
        )}
      </section>
    </div>
  );
}

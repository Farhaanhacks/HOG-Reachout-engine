'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RunBadge } from '../../components/badges';
import { api, countryName, formatDate, post } from '../../lib/client';
import type { EnrichSummary } from '../../lib/enrich';
import { GEOS, type Geo } from '../../lib/geo';
import { buildQueries } from '../../lib/queries';
import type { Run } from '../../lib/run';

const list = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);
const ratio = (a: number, b: number) => (b ? (a / b).toFixed(1) : '—');

export default function RunPage() {
  const [geo, setGeo] = useState<Geo>('ae');
  const [titles, setTitles] = useState('Founder, CEO, Co-Founder, Managing Partner, Chairman, Owner');
  const [keywords, setKeywords] = useState('');
  const [cities, setCities] = useState('');
  const [pages, setPages] = useState(2);
  const [maxQueries, setMaxQueries] = useState(10);
  const [withApollo, setWithApollo] = useState(false);
  const [apolloLimit, setApolloLimit] = useState(20);

  const [run, setRun] = useState<Run | null>(null);
  const [history, setHistory] = useState<Run[]>([]);
  const [log, setLog] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const stop = useRef(false);

  const planned = useMemo(() => buildQueries({ geo, titles: list(titles), keywords: list(keywords), cities: list(cities) }), [geo, titles, keywords, cities]);
  const queryCount = Math.min(planned.length, maxQueries);

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
          say('Stopped. People found so far are saved.');
          return;
        }
        const before = r;
        r = (await api<{ run: Run }>(`/api/runs/${r.id}/step`, post())).run;
        setRun(r);
        say(`Search ${r.next_index}/${r.queries.length}: ${r.inserted - before.inserted} new, ${r.updated - before.updated} already saved, ${r.excluded - before.excluded} based elsewhere`);
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
    if (!list(titles).length) return setError('Add at least one title.');
    setLog([]);
    try {
      const d = await api<{ run: Run }>('/api/runs', post({ geo, titles: list(titles), keywords: list(keywords), cities: list(cities), pages, maxQueries }));
      say(`Started: ${d.run.queries.length} searches in ${countryName(geo)}.`);
      await drive(d.run, withApollo ? apolloLimit : null);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  function resume(r: Run) {
    setLog([`Continuing run from ${formatDate(r.created_at)}.`]);
    drive(r, withApollo ? apolloLimit : null);
  }

  const done = run ? run.next_index : 0;
  const totalQ = run ? run.queries.length : 0;
  const canResume = run && run.status === 'running' && !busy;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Find leads</h1>
          <p className="sub">Describe who you want. The engine searches Google for their LinkedIn profiles, keeps people based in the chosen country, saves each person once, and can then ask Apollo for their emails.</p>
        </div>
      </div>

      <section className="card">
        <h2>Who to find</h2>
        <div className="form">
          <label className="field">
            Country
            <select id="run-geo" value={geo} onChange={(e) => setGeo(e.target.value as Geo)} disabled={busy}>
              {(Object.keys(GEOS) as Geo[]).map((g) => <option key={g} value={g}>{GEOS[g].label}</option>)}
            </select>
          </label>
          <label className="field wide">
            Job titles <span className="hint">comma separated</span>
            <input id="run-titles" value={titles} onChange={(e) => setTitles(e.target.value)} disabled={busy} />
          </label>
          <label className="field">
            Must mention <span className="hint">optional, e.g. hedge fund, real estate</span>
            <input id="run-keywords" value={keywords} onChange={(e) => setKeywords(e.target.value)} disabled={busy} />
          </label>
          <label className="field">
            Cities <span className="hint">blank = {GEOS[geo].cities.join(', ')}</span>
            <input id="run-cities" value={cities} onChange={(e) => setCities(e.target.value)} disabled={busy} />
          </label>
          <label className="field">
            Result pages per search <span className="hint">more pages, more people, more searches</span>
            <select id="run-pages" value={pages} onChange={(e) => setPages(Number(e.target.value))} disabled={busy}>
              <option value={1}>1 page (up to 10 results)</option>
              <option value={2}>2 pages (up to 20)</option>
              <option value={3}>3 pages (up to 30)</option>
            </select>
          </label>
          <label className="field">
            Most searches this run
            <input id="run-max" type="number" min={1} max={30} value={maxQueries} onChange={(e) => setMaxQueries(Math.max(1, Math.min(30, Number(e.target.value) || 1)))} disabled={busy} />
          </label>
        </div>
        <div className="row">
          <label className="check"><input id="run-apollo" type="checkbox" checked={withApollo} onChange={(e) => setWithApollo(e.target.checked)} disabled={busy} /> Then get emails from Apollo for up to</label>
          <input id="run-apollo-limit" type="number" min={1} max={100} value={apolloLimit} onChange={(e) => setApolloLimit(Math.max(1, Math.min(100, Number(e.target.value) || 1)))} disabled={busy || !withApollo} style={{ width: 80 }} aria-label="Apollo lookups" />
          <span className="muted small">people (spends Apollo credits)</span>
        </div>
        <p className="muted small">
          This plan makes {queryCount} search{queryCount === 1 ? '' : 'es'}, up to {queryCount * pages} Serper credits.
          {planned.length > maxQueries ? ` The brief has ${planned.length} combinations; raise "Most searches" to cover them all.` : ''}
        </p>
        <div className="row">
          <button className="primary" onClick={start} disabled={busy || !queryCount}>{busy ? 'Running…' : 'Start'}</button>
          {busy && <button className="danger" onClick={() => (stop.current = true)}>Stop after this search</button>}
          {run && canResume && <button onClick={() => resume(run)}>Continue</button>}
        </div>
        {error && <p className="alert" role="alert">{error}</p>}
      </section>

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
          </div>
          <h3>Cost</h3>
          <div className="stats">
            <div className="stat"><div className="n">{run.searches}</div><div className="l">Serper searches</div></div>
            <div className="stat"><div className="n">{run.apollo_credits}</div><div className="l">Apollo credits ({run.apollo_requested} lookups)</div></div>
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
                <tr><th>Started</th><th>Country</th><th>Titles</th><th className="num">Searches</th><th className="num">New</th><th className="num">Emails</th><th className="num">Credits</th><th>Status</th><th></th></tr>
              </thead>
              <tbody>
                {history.map((r) => (
                  <tr key={String(r.id)}>
                    <td>{formatDate(r.created_at)}</td>
                    <td>{countryName(r.geo)}</td>
                    <td className="small">{r.brief.titles.join(', ')}{r.brief.keywords?.length ? ` · ${r.brief.keywords.join(', ')}` : ''}</td>
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
          <p className="muted">No runs yet.</p>
        )}
      </section>
    </div>
  );
}

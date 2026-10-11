'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { RunBadge } from '../../components/badges';
import { api, countryName, formatDate, personalizeWaiting, post } from '../../lib/client';
import type { EnrichStatus } from '../../lib/enrich';
import { MARKETS, MARKET_LIST, marketShort } from '../../lib/markets';
import type { Run, StepSummary } from '../../lib/run';
import type { Settings } from '../../lib/settings';
import { SECTORS, SECTOR_LABEL } from '../../lib/targeting';

const ratio = (a: number, b: number) => (b ? (a / b).toFixed(1) : '—');

const TARGETS = [
  { n: 100, label: 'Quick', hint: '100 new leads' },
  { n: 250, label: 'Half day', hint: '250 new leads' },
  { n: 500, label: 'Full day', hint: '500 new leads' },
];

export default function RunPage() {
  const [target, setTarget] = useState(500);
  const [run, setRun] = useState<Run | null>(null);
  const [history, setHistory] = useState<Run[]>([]);
  const [enrich, setEnrich] = useState<EnrichStatus | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const stop = useRef(false);

  const load = useCallback(() => {
    api<{ runs: Run[] }>('/api/runs').then((d) => setHistory(d.runs)).catch(() => {});
    api<{ enrich: EnrichStatus }>('/api/overview').then((d) => setEnrich(d.enrich)).catch(() => {});
  }, []);
  useEffect(() => {
    load();
    api<{ settings: Settings }>('/api/settings').then((d) => setSettings(d.settings)).catch(() => {});
  }, [load]);

  const say = (line: string) => setLog((l) => [...l, line]);

  async function drive(start: Run) {
    stop.current = false;
    setBusy(true);
    setError('');
    let r = start;
    setRun(r);
    const goal = r.brief.target || target;
    const readyAtStart = r.apollo_with_email;
    try {
      while (r.status === 'running' && r.next_index < r.queries.length && r.apollo_with_email < goal) {
        if (stop.current) {
          say('Stopped. Everyone found so far is saved.');
          break;
        }
        const q = r.queries[r.next_index];
        const d = await api<{ run: Run; summary: StepSummary }>(`/api/runs/${r.id}/step`, post());
        r = d.run;
        setRun(r);
        const s = d.summary;
        say(
          `${r.next_index}/${r.queries.length} · ${marketShort(q.market)} · ${q.label}${q.page > 1 ? ` · page ${q.page}` : ''}: ${s.searched} found, ${s.wanted} with a target title, ${s.lookedUp} looked up, ${s.ready} new ready to email`,
        );
        if (s.stopped) {
          say(s.stopped);
          break;
        }
      }
      const fresh = r.apollo_with_email - readyAtStart;
      if (fresh > 0) {
        // Every new lead gets its personal opener from the news straight away.
        say(`Reading the news to personalize ${fresh} new emails…`);
        try {
          const p = await personalizeWaiting(fresh, (done) => setLog((l) => [...l.slice(0, -1), `Personalizing from the news… ${done} of ${fresh} done.`]));
          say(`Personalized ${p.done} emails${p.failed ? `; ${p.failed} failed (${p.error}) and are retried on the Outreach page` : ''}.`);
        } catch (e) {
          say(`Could not personalize: ${(e as Error).message}. It runs again when the Outreach page opens.`);
        }
      }
      if (r.status === 'running') {
        const done = stop.current || r.apollo_with_email >= goal || r.next_index >= r.queries.length;
        if (done) {
          r = (await api<{ run: Run }>(`/api/runs/${r.id}/finish`, post({ status: stop.current ? 'stopped' : 'done' }))).run;
          setRun(r);
          say(r.apollo_with_email >= goal ? `Done: ${r.apollo_with_email} new leads ready to email.` : 'Done.');
        }
      }
    } catch (e) {
      setError(`${(e as Error).message} Nothing found so far is lost. Press Continue to retry.`);
      say(`Paused: ${(e as Error).message}`);
    } finally {
      setBusy(false);
      load();
    }
  }

  async function start() {
    setLog([]);
    setError('');
    try {
      const d = await api<{ run: Run }>('/api/runs', post({ target }));
      say(`Started: up to ${d.run.queries.length} searches across ${countryName(d.run.geo)}, until ${target} new leads are ready to email.`);
      await drive(d.run);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  function resume(r: Run) {
    setLog([`Continuing the run from ${formatDate(r.created_at)}.`]);
    drive(r);
  }

  const goal = run?.brief.target || target;
  const left = enrich ? Math.max(0, enrich.dailyLimit - enrich.usedToday) : null;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Find leads</h1>
          <p className="sub">
            One click finds company leaders in Africa, Europe, the US and the UAE through Apollo. The title is picked by each company&apos;s size and industry, clients and anyone contacted before are skipped, and every lead comes with a verified email, website, LinkedIn, company size, industry and country.
          </p>
        </div>
      </div>

      <div className="grid-run">
        <section className="card">
          <h2>Start a run</h2>
          <div>
            <div className="section-label">How many new leads</div>
            <div className="segmented" role="radiogroup" aria-label="New leads">
              {TARGETS.map((t) => (
                <button key={t.n} role="radio" aria-checked={target === t.n} className={target === t.n ? 'on' : ''} onClick={() => setTarget(t.n)} disabled={busy}>
                  <b>{t.label}</b>
                  <span>{t.hint}</span>
                </button>
              ))}
            </div>
          </div>
          <p className="muted small">
            Searching is free. Each person looked up costs about 1 Apollo credit, and only people with a target title and a verified email on record are looked up.{' '}
            {left !== null && <>{left} lookups left today (limit {enrich?.dailyLimit}, set by <code>APOLLO_DAILY_LIMIT</code>).</>}
          </p>
          <div className="row">
            <button className="primary big" onClick={start} disabled={busy}>{busy ? 'Finding leads…' : 'Find leads'}</button>
            {busy && <button className="danger" onClick={() => (stop.current = true)}>Stop after this search</button>}
            {run && run.status === 'running' && !busy && <button onClick={() => resume(run)}>Continue</button>}
          </div>
          {error && <p className="alert" role="alert">{error}</p>}
        </section>

        <section className="card">
          <div className="card-head">
            <h2>Who we look for</h2>
            <Link href="/targeting" className="small">Change the rules</Link>
          </div>
          <p className="muted small">
            Based in {MARKET_LIST.map((m) => MARKETS[m].label).join(', ')} (Africa and Europe searched twice as often). Small firms are up to 50 employees.
          </p>
          {settings && (
            <div className="table-wrap">
              <table>
                <thead><tr><th>Industry</th><th>Small firms</th><th>Large firms</th></tr></thead>
                <tbody>
                  {SECTORS.map((s) => (
                    <tr key={s}>
                      <td><b>{SECTOR_LABEL[s]}</b></td>
                      <td className="small">{settings.rules[s].small.join(', ')}</td>
                      <td className="small">{settings.rules[s].large.join(', ')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>

      {run && (
        <section className="card">
          <div className="card-head">
            <h2>This run</h2>
            <RunBadge status={run.status} error={busy ? '' : run.error} />
          </div>
          <div className="progress" aria-label="Progress"><div style={{ width: `${Math.min(100, goal ? (run.apollo_with_email / goal) * 100 : 0)}%` }} /></div>
          <p className="muted small">{run.apollo_with_email} of {goal} new leads ready to email · {run.next_index} of {run.queries.length} searches done</p>
          <div className="stats">
            <div className="stat"><div className="n">{run.apollo_with_email}</div><div className="l">New leads ready to email</div></div>
            <div className="stat"><div className="n">{run.inserted}</div><div className="l">New leads saved</div></div>
            <div className="stat"><div className="n">{run.results}</div><div className="l">People searched</div></div>
            <div className="stat"><div className="n">{run.found}</div><div className="l">With a target title</div></div>
            <div className="stat"><div className="n">{run.apollo_requested}</div><div className="l">Looked up in Apollo</div></div>
            <div className="stat"><div className="n">{run.apollo_credits}</div><div className="l">Apollo credits</div></div>
            <div className="stat"><div className="n">{ratio(run.apollo_credits, run.apollo_with_email)}</div><div className="l">Credits per ready lead</div></div>
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
                <tr><th>Started</th><th>Markets</th><th className="num">Searches</th><th className="num">New leads</th><th className="num">Ready to email</th><th className="num">Apollo credits</th><th>Status</th><th></th></tr>
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
                    <td>{r.status === 'running' && !busy && r.queries[0]?.titles.length ? <button className="link" onClick={() => resume(r)}>Continue</button> : null}</td>
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

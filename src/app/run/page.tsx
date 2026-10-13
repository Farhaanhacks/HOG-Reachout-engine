'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { RunBadge } from '../../components/badges';
import type { Sequence } from '../../lib/apollo-sequences';
import { BRAND_LIST, BRANDS, quotasFor, type Brand, type Quotas } from '../../lib/brands';
import { api, countryName, formatDate, personalizeWaiting, post } from '../../lib/client';
import type { EnrichStatus } from '../../lib/enrich';
import { marketShort } from '../../lib/markets';
import type { PushSummary } from '../../lib/outreach';
import type { AutopilotStatus } from '../../lib/autopilot';
import type { Run, StepSummary } from '../../lib/run';

type BrandSetup = {
  id: Brand;
  label: string;
  domain: string;
  regionLabel: string;
  share: number;
  sequenceId: string;
  sequenceActive: boolean | null;
  inboxes: number;
  usableInboxes: number;
  room: number;
};
type Setup = {
  configured: boolean;
  aiConfigured: boolean;
  apolloError: string;
  missingFields: string[];
  sequences: Sequence[];
  enrich: EnrichStatus;
  sendingRoomToday: number;
  brands: BrandSetup[];
};

/** Test sizes for now; the full day comes back later as a scheduled run. */
const TARGETS = [10, 20, 50];

const need = (quotas: Quotas, ready: Partial<Quotas>) => Object.fromEntries(BRAND_LIST.map((b) => [b, Math.max(0, quotas[b] - (ready[b] ?? 0))])) as Quotas;
const split = (q: Quotas) => BRAND_LIST.map((b) => `${q[b]} ${BRANDS[b].label}`).join(' · ');

export default function RunWorkflowPage() {
  const [target, setTarget] = useState(20);
  const [setup, setSetup] = useState<Setup | null>(null);
  const [run, setRun] = useState<Run | null>(null);
  const [history, setHistory] = useState<Run[]>([]);
  const [stage, setStage] = useState('');
  const [sent, setSent] = useState<Partial<Quotas>>({});
  const [log, setLog] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const stop = useRef(false);
  const [auto, setAuto] = useState<(AutopilotStatus & { secretSet: boolean }) | null>(null);
  const [siteUrl, setSiteUrl] = useState('');

  const loadSetup = useCallback(() => {
    api<Setup>('/api/workflow').then(setSetup).catch((e: Error) => setError(e.message));
  }, []);
  const loadHistory = useCallback(() => {
    api<{ runs: Run[] }>('/api/runs').then((d) => setHistory(d.runs)).catch(() => {});
  }, []);
  const loadAuto = useCallback(() => {
    api<AutopilotStatus & { secretSet: boolean }>('/api/autopilot').then(setAuto).catch(() => {});
  }, []);
  useEffect(() => {
    loadSetup();
    loadHistory();
    loadAuto();
    setSiteUrl(window.location.origin);
    // The autopilot works in the background; keep its status fresh while the page is open.
    const t = setInterval(() => {
      loadAuto();
      loadHistory();
    }, 30_000);
    return () => clearInterval(t);
  }, [loadSetup, loadHistory, loadAuto]);

  async function setAutopilot(change: { enabled?: boolean; perHour?: number }) {
    if (change.enabled && !window.confirm(`Switch the autopilot on? Every hour, around the clock, it finds ${auto?.autopilot.perHour ?? 30} leads and sends them through Apollo with nobody watching. Each hour uses about as many Apollo credits as leads.`)) return;
    try {
      setAuto(await api('/api/autopilot', post(change)));
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const say = (line: string) => setLog((l) => [...l, line]);

  async function chooseSequence(brand: Brand, sequenceId: string) {
    try {
      await api('/api/settings', post({ sequences: { [brand]: sequenceId } }));
      loadSetup();
    } catch (e) {
      setError((e as Error).message);
    }
  }

  const quotas = quotasFor(target);
  const blockers: string[] = [];
  if (setup && !setup.configured) blockers.push('APOLLO_API_KEY is not set in Vercel.');
  if (setup?.apolloError) blockers.push(`Apollo cannot be reached: ${setup.apolloError}`);
  if (setup && !setup.aiConfigured) blockers.push('DEEPSEEK_API_KEY is not set, so emails cannot be personalized.');
  if (setup?.missingFields.length) blockers.push(`Create these contact fields in Apollo: ${setup.missingFields.join(', ')}.`);
  const notReady = (setup?.brands ?? []).filter((b) => !b.sequenceId || !b.usableInboxes);

  /** The whole pipeline: find (Apollo search and lookups), personalize, then send each brand's leads into its own sequence. */
  async function runWorkflow() {
    if (!setup) return;
    const waitNote = notReady.length ? `\n\n${notReady.map((b) => b.label).join(' and ')} cannot send yet (no sequence or no inbox): their leads will be found and wait on the Outreach page.` : '';
    if (!window.confirm(`Run the workflow for ${target} leads (${split(quotas)})?\n\nThis finds them, writes their emails and sends them through Apollo: real emails go out.${waitNote}`)) return;
    stop.current = false;
    setBusy(true);
    setError('');
    setLog([]);
    setSent({});
    let r: Run | null = null;
    try {
      // 1. Find
      setStage('Finding leads');
      r = (await api<{ run: Run }>('/api/runs', post({ target }))).run;
      setRun(r);
      say(`Finding ${target} leads: ${split(r.brief.quotas ?? quotas)}.`);
      while (r.status === 'running' && r.next_index < r.queries.length && Object.values(need(r.brief.quotas ?? quotas, r.brand_ready)).some((n) => n > 0)) {
        if (stop.current) throw new Error('Stopped. Everyone found so far is saved and waits on the Outreach page.');
        const q = r.queries[r.next_index];
        const d: { run: Run; summary: StepSummary } = await api(`/api/runs/${r.id}/step`, post());
        r = d.run;
        setRun(r);
        if (d.summary.searched) say(`${marketShort(q.market)} · ${q.label}: ${d.summary.searched} found, ${d.summary.lookedUp} looked up, ${d.summary.ready} ready to email`);
        if (d.summary.stopped) {
          say(d.summary.stopped);
          break;
        }
      }
      const found = r.apollo_with_email;
      say(`Found ${found} leads ready to email (${BRAND_LIST.map((b) => `${r?.brand_ready[b] ?? 0} ${BRANDS[b].label}`).join(', ')}).`);

      // 2. Personalize
      if (found > 0) {
        setStage('Writing the emails');
        const p = await personalizeWaiting(found, (done) => setStage(`Writing the emails: ${done} of ${found}`), r.id);
        say(`Wrote ${p.done} personal emails from the news${p.failed ? `; ${p.failed} could not be done now (${p.error}) and are retried before sending` : ''}.`);
      }

      // 3. Send, brand by brand, from each brand's own inboxes into its own sequence
      const totals: Partial<Quotas> = {};
      for (const b of setup.brands) {
        if (stop.current) throw new Error('Stopped before sending everyone. The rest wait on the Outreach page.');
        if (!(r.brand_ready[b.id] ?? 0)) continue;
        if (!b.sequenceId) {
          say(`${b.label}: no sequence chosen, so its ${r.brand_ready[b.id]} leads wait. Choose one under Sending setup.`);
          continue;
        }
        setStage(`Sending: ${b.label}`);
        for (let i = 0; i < 10; i++) {
          const d = await api<{ summary: PushSummary }>('/api/outreach', post({ action: 'push', brand: b.id, sequenceId: b.sequenceId, runId: r.id, limit: 25, confirm: true }));
          const s = d.summary;
          totals[b.id] = (totals[b.id] ?? 0) + s.added;
          setSent({ ...totals });
          if (s.added || s.skipped || s.failed) {
            say(
              `${b.label}: added ${s.added} to the sequence${s.skipped ? `, Apollo declined ${s.skipped}` : ''}${s.failed ? `, ${s.failed} failed (${s.error})` : ''}${Object.keys(s.byInbox).length ? ` (from ${Object.keys(s.byInbox).join(', ')})` : ''}.`,
            );
          }
          if (s.paused.length) say(`Paused for bounces or spam: ${s.paused.map((x) => x.email).join(', ')}.`);
          if (s.stopped) {
            say(`${b.label}: ${s.stopped}.`);
            break;
          }
          if (!s.requested || s.failed) break;
        }
      }
      const total = Object.values(totals).reduce((n, v) => n + (v ?? 0), 0);
      r = (await api<{ run: Run }>(`/api/runs/${r.id}/finish`, post({ status: 'done' }))).run;
      setRun(r);
      setStage('Done');
      say(`Done: ${total} people added to their brand's sequence. Apollo sends within each sequence's schedule.`);
    } catch (e) {
      setError((e as Error).message);
      say((e as Error).message);
      if (r?.status === 'running' && stop.current) await api(`/api/runs/${r.id}/finish`, post({ status: 'stopped' })).catch(() => {});
      setStage('Stopped');
    } finally {
      setBusy(false);
      loadHistory();
      loadSetup();
    }
  }

  const runQuotas = run?.brief.quotas ?? quotas;
  const left = setup ? Math.max(0, setup.enrich.dailyLimit - setup.enrich.usedToday) : null;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Run workflow</h1>
          <p className="sub">
            One click finds the leads (split 40% Gulf Icons, 30% Humans of Globe, 30% CIO Minds), gets their LinkedIn, website and verified email from Apollo, writes each email from the news, and sends each brand&apos;s leads into its own sequence from its own inboxes.
          </p>
        </div>
      </div>

      {error && <p className="alert" role="alert">{error}</p>}
      {blockers.map((b) => <p key={b} className="warn-note">{b}</p>)}

      <div className="grid-run">
        <section className="card">
          <h2>Run</h2>
          <div>
            <div className="section-label">How many leads</div>
            <div className="segmented" role="radiogroup" aria-label="Leads">
              {TARGETS.map((n) => (
                <button key={n} role="radio" aria-checked={target === n} className={target === n ? 'on' : ''} onClick={() => setTarget(n)} disabled={busy}>
                  <b>{n} leads</b>
                  <span>{split(quotasFor(n))}</span>
                </button>
              ))}
            </div>
          </div>
          <p className="muted small">
            Searching is free; each person looked up costs about 1 Apollo credit, and a run looks up about as many as it needs.{' '}
            {left !== null && <>{left} lookups left today.</>} Only leads this run finds are sent; older waiting leads stay on the <Link href="/outreach">Outreach</Link> page.
          </p>
          <div className="row">
            <button className="primary big" onClick={runWorkflow} disabled={busy || !setup || blockers.length > 0}>{busy ? stage || 'Working…' : `Run workflow (${target})`}</button>
            {busy && <button className="danger" onClick={() => (stop.current = true)}>Stop</button>}
          </div>
        </section>

        <section className="card">
          <div className="card-head">
            <h2>Sending setup</h2>
            <Link href="/deliverability" className="small">Inboxes</Link>
          </div>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Brand</th><th>Sequence</th><th>Inboxes</th></tr></thead>
              <tbody>
                {setup?.brands.map((b) => (
                  <tr key={b.id}>
                    <td><b>{b.label}</b><div className="faint small">{Math.round(b.share * 100)}% · {b.regionLabel}</div></td>
                    <td>
                      <select value={b.sequenceId} onChange={(e) => chooseSequence(b.id, e.target.value)} disabled={busy} aria-label={`${b.label} sequence`} style={{ maxWidth: 220 }}>
                        <option value="">Choose a sequence</option>
                        {setup.sequences.map((s) => <option key={s.id} value={s.id}>{s.name}{s.active ? '' : ' (not active)'}</option>)}
                      </select>
                      {b.sequenceId && b.sequenceActive === false && <div className="badge warn" style={{ marginTop: 4 }}>Not active in Apollo</div>}
                    </td>
                    <td className="small">
                      {b.usableInboxes ? <>{b.usableInboxes} of {b.inboxes} @{b.domain}<div className="faint">{b.room} more today</div></> : <span className="badge bad">None can send</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="faint small">Each brand needs its own sequence with its own version A and B (Outreach page, Set up Apollo once) and at least one inbox on its domain. Title rules: <Link href="/targeting">Targeting</Link>.</p>
        </section>
      </div>

      <section className="card">
        <div className="card-head">
          <h2>Autopilot</h2>
          {auto && (auto.autopilot.enabled ? <span className="badge ok">On · {auto.autopilot.perHour} leads every hour, 24/7</span> : <span className="badge">Off</span>)}
        </div>
        <p className="muted small">
          Runs the whole workflow every hour, around the clock, with nobody watching: finds the leads (split 40/30/30), writes the emails and sends each brand&apos;s leads into its sequence. Leads an inbox has no room for today go out later on their own. It needs an outside scheduler to call the site every 2 minutes (below).
        </p>
        <div className="row">
          <label className="check">
            Leads every hour
            <input
              key={auto?.autopilot.perHour}
              type="number"
              min={1}
              max={100}
              defaultValue={auto?.autopilot.perHour ?? 30}
              onBlur={(e) => Number(e.target.value) !== auto?.autopilot.perHour && setAutopilot({ perHour: Number(e.target.value) })}
              style={{ width: 80 }}
            />
          </label>
          {auto?.autopilot.enabled ? (
            <button className="danger" onClick={() => setAutopilot({ enabled: false })}>Switch autopilot off</button>
          ) : (
            <button className="primary" onClick={() => setAutopilot({ enabled: true })} disabled={!auto?.secretSet || blockers.length > 0}>Switch autopilot on</button>
          )}
        </div>
        {auto && !auto.secretSet && <p className="warn-note">Add <code>CRON_SECRET</code> in Vercel (a long random string, at least 16 characters), redeploy, then set up the scheduler below.</p>}
        {auto && (
          <div className="stats">
            <div className="stat"><div className="n">{auto.today.runs}</div><div className="l">Runs today</div></div>
            <div className="stat"><div className="n">{auto.today.found}</div><div className="l">Leads found today</div></div>
            <div className="stat"><div className="n">{auto.current ? (auto.current.status === 'running' ? auto.current.phase || 'running' : auto.current.status) : '—'}</div><div className="l">Latest run</div></div>
            <div className="stat"><div className="n">{auto.lastTick ? formatDate(auto.lastTick.at) : 'never'}</div><div className="l">Last scheduler call</div></div>
          </div>
        )}
        {auto?.lastTick?.log.length ? <div className="log">{auto.lastTick.log.join('\n')}</div> : null}
        <details>
          <summary>Set up the scheduler (cron-job.org, free)</summary>
          <ol className="muted small steps-list">
            <li>Sign up at cron-job.org and click <b>Create cronjob</b>.</li>
            <li>URL: <code>{siteUrl || 'https://your-site'}/api/cron/tick</code></li>
            <li>Schedule: <b>every 2 minutes</b>.</li>
            <li>Under Advanced, add a header <code>Authorization</code> with the value <code>Bearer </code> followed by your <code>CRON_SECRET</code>. (No header option? Use the URL <code>…/api/cron/tick?key=</code> followed by the secret.)</li>
            <li>Save, then switch the autopilot on here. &quot;Last scheduler call&quot; updates within two minutes.</li>
          </ol>
        </details>
      </section>

      {run && (
        <section className="card">
          <div className="card-head">
            <h2>This run</h2>
            <span className="row"><span className="muted small">{busy ? stage : ''}</span> <RunBadge status={run.status} error={busy ? '' : run.error} /></span>
          </div>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Brand</th><th className="num">Wanted</th><th className="num">Found, ready to email</th><th className="num">Sent to sequence</th></tr></thead>
              <tbody>
                {BRAND_LIST.map((b) => (
                  <tr key={b}>
                    <td><b>{BRANDS[b].label}</b></td>
                    <td className="num">{runQuotas[b]}</td>
                    <td className="num">{run.brand_ready[b] ?? 0}</td>
                    <td className="num">{sent[b] ?? 0}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="muted small">{run.results} people searched · {run.apollo_requested} looked up · {run.apollo_credits} Apollo credits</p>
          {log.length > 0 && <div className="log" aria-live="polite">{log.join('\n')}</div>}
        </section>
      )}

      <section className="card">
        <h2>Past runs</h2>
        {history.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr><th>Started</th><th>By</th><th>Markets</th><th className="num">Leads</th>{BRAND_LIST.map((b) => <th key={b} className="num">{BRANDS[b].label}</th>)}<th className="num">Credits</th><th>Status</th></tr>
              </thead>
              <tbody>
                {history.map((h) => (
                  <tr key={String(h.id)}>
                    <td>{formatDate(h.created_at)}</td>
                    <td className="small">{h.auto ? <span className="badge accent">Autopilot</span> : 'Button'}</td>
                    <td className="small">{countryName(h.geo)}</td>
                    <td className="num">{h.apollo_with_email}{h.brief.target ? `/${h.brief.target}` : ''}</td>
                    {BRAND_LIST.map((b) => <td key={b} className="num">{h.brand_ready[b] ?? '—'}</td>)}
                    <td className="num">{h.apollo_credits}</td>
                    <td><RunBadge status={h.status} error={h.error} /></td>
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

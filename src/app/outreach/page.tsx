'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { EmailBadge } from '../../components/badges';
import { api, formatDate, post } from '../../lib/client';
import type { Campaign, InstantlyLead } from '../../lib/instantly';
import { CAMPAIGN_STATUS } from '../../lib/instantly';
import type { OutreachStatus, PushSummary } from '../../lib/outreach';
import type { PersonalizeSummary } from '../../lib/personalize';
import type { SavedPerson } from '../../lib/store';

type Overview = {
  configured: boolean;
  aiConfigured: boolean;
  defaultCampaignId: string;
  campaigns: Campaign[];
  campaignError: string;
  status: OutreachStatus;
  held: SavedPerson[];
  sent: SavedPerson[];
};
type Preview = SavedPerson & { lead: InstantlyLead };

const CAMPAIGN_KEY = 'hog-instantly-campaign';

export default function OutreachPage() {
  const [data, setData] = useState<Overview | null>(null);
  const [campaignId, setCampaignId] = useState('');
  const [limit, setLimit] = useState(25);
  const [personalizeCount, setPersonalizeCount] = useState(30);
  const [progress, setProgress] = useState('');
  const [preview, setPreview] = useState<Preview[] | null>(null);
  const [openRow, setOpenRow] = useState('');
  const [summary, setSummary] = useState<PushSummary | null>(null);
  const [testEmail, setTestEmail] = useState('');
  const [testResult, setTestResult] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const stop = useRef(false);

  const load = useCallback(async () => {
    const d = await api<Overview>('/api/outreach');
    setData(d);
    setCampaignId((current) => {
      if (current) return current;
      let saved = '';
      try {
        saved = localStorage.getItem(CAMPAIGN_KEY) ?? '';
      } catch {}
      const ids = d.campaigns.map((c) => c.id);
      return [saved, d.defaultCampaignId].find((id) => id && ids.includes(id)) ?? '';
    });
  }, []);

  useEffect(() => {
    load().catch((e: Error) => setError(e.message));
  }, [load]);

  function chooseCampaign(id: string) {
    setCampaignId(id);
    try {
      localStorage.setItem(CAMPAIGN_KEY, id);
    } catch {}
  }

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

  /** Personalizes in batches of 10 (each batch is one short request) until the count is reached or nobody is left. */
  const doPersonalize = () =>
    act(async () => {
      stop.current = false;
      const total = { done: 0, none: 0, failed: 0, searches: 0 };
      let lastError = '';
      while (total.done + total.none < personalizeCount && !stop.current) {
        const d = await api<{ summary: PersonalizeSummary; status: OutreachStatus }>('/api/outreach', post({ action: 'personalize', limit: Math.min(10, personalizeCount - total.done - total.none) }));
        total.done += d.summary.done;
        total.none += d.summary.none;
        total.failed += d.summary.failed;
        total.searches += d.summary.searches;
        if (d.summary.error) lastError = d.summary.error;
        setProgress(`${total.done} personalized, ${total.none} held back (nothing specific found)${total.failed ? `, ${total.failed} failed` : ''}.`);
        setData((prev) => (prev ? { ...prev, status: d.status } : prev));
        if (d.summary.done + d.summary.none === 0) break; // nobody left, or every attempt failed
      }
      if (lastError && total.failed) setError(`Some leads could not be personalized: ${lastError}. They will be tried again next time.`);
      setPreview(null);
      await load();
    });

  const doPreview = () =>
    act(async () => {
      setSummary(null);
      const d = await api<{ people: Preview[] }>('/api/outreach', post({ action: 'preview', limit }));
      setPreview(d.people);
    });

  const doPush = () =>
    act(async () => {
      const d = await api<{ summary: PushSummary }>('/api/outreach', post({ action: 'push', limit, campaignId, confirm: true }));
      setSummary(d.summary);
      setPreview(null);
      await load();
    });

  const doTest = () =>
    act(async () => {
      setTestResult('');
      const d = await api<{ added: boolean; skipped: number }>('/api/outreach', post({ action: 'test', campaignId, testEmail }));
      setTestResult(d.added ? `Added ${testEmail} to the campaign with a real personalized email. It arrives when the campaign sends.` : `Instantly did not add ${testEmail} (already in this campaign). Delete it in Instantly to test again.`);
    });

  const saveOpener = (personId: string, opener: string) =>
    act(async () => {
      await api('/api/outreach', post({ action: 'opener', personId, opener }));
      await load();
    });

  const campaign = data?.campaigns.find((c) => c.id === campaignId);
  const left = data ? Math.max(0, data.status.dailyLimit - data.status.sentToday) : 0;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Outreach (Instantly)</h1>
          <p className="sub">Every email opens with something specific about that person, written from their LinkedIn profile and their company&apos;s recent news. Only personalized emails are sent. Instantly does the sending, paces each mailbox and stops the sequence when someone replies.</p>
        </div>
      </div>

      {error && <p className="alert" role="alert">{error}</p>}

      <div className="stats">
        <div className="stat"><div className="n">{data?.status.toPersonalize ?? '—'}</div><div className="l">Waiting to be personalized</div></div>
        <div className="stat"><div className="n">{data?.status.waiting ?? '—'}</div><div className="l">Personalized, ready to send</div></div>
        <div className="stat"><div className="n">{data?.status.noOpener ?? '—'}</div><div className="l">Held back (nothing specific)</div></div>
        <div className="stat"><div className="n">{data?.status.sent ?? '—'}</div><div className="l">In Instantly</div></div>
        <div className="stat"><div className="n">{data ? `${data.status.sentToday}/${data.status.dailyLimit}` : '—'}</div><div className="l">Sent to Instantly today</div></div>
      </div>

      <div className="grid-run">
        <section className="card">
          <h2>1. Personalize</h2>
          {data && !data.aiConfigured && <p className="warn-note">Add <code>DEEPSEEK_API_KEY</code> in Vercel to write personal openers.</p>}
          <p className="muted small">For each person: one news search on their company, then DeepSeek writes one or two sentences using only what it found. Their name and email are never sent to DeepSeek. If nothing specific turns up, the person is held back for you to write a line by hand.</p>
          <div className="row">
            <label className="check">
              Personalize the next
              <input id="personalize-count" type="number" min={1} max={200} value={personalizeCount} onChange={(e) => setPersonalizeCount(Math.max(1, Math.min(200, Number(e.target.value) || 1)))} style={{ width: 90 }} />
              people
            </label>
            <button className="primary" onClick={doPersonalize} disabled={busy || !data?.aiConfigured || !data?.status.toPersonalize}>{busy && progress ? 'Personalizing…' : 'Personalize'}</button>
            {busy && <button className="danger" onClick={() => (stop.current = true)}>Stop</button>}
          </div>
          <p className="muted small">Uses about one Serper credit and one small DeepSeek request per person.</p>
          {progress && <p className="note small" role="status">{progress}</p>}
        </section>

        <section className="card">
          <h2>2. Send to Instantly</h2>
          {data && !data.configured ? (
            <p className="muted">Add <code>INSTANTLY_API_KEY</code> in Vercel (Settings, Environment Variables), then redeploy.</p>
          ) : (
            <>
              <label className="field">
                Campaign
                <select id="outreach-campaign" value={campaignId} onChange={(e) => chooseCampaign(e.target.value)} disabled={busy}>
                  <option value="">Choose a campaign</option>
                  {data?.campaigns.map((c) => <option key={c.id} value={c.id}>{c.name} ({CAMPAIGN_STATUS[String(c.status)] ?? c.status})</option>)}
                </select>
              </label>
              {data?.campaignError && <p className="alert">Could not load campaigns: {data.campaignError}</p>}
              {campaign && campaign.status !== 1 && <p className="warn-note">This campaign is {CAMPAIGN_STATUS[String(campaign.status)] ?? 'not active'}. Leads are added but nothing is sent until you start it in Instantly.</p>}
              <div className="row">
                <label className="check">
                  Send the next
                  <input id="outreach-limit" type="number" min={1} max={500} value={limit} onChange={(e) => { setLimit(Math.max(1, Math.min(500, Number(e.target.value) || 1))); setPreview(null); }} style={{ width: 90 }} />
                  people
                </label>
                <button onClick={doPreview} disabled={busy}>Preview</button>
                <button className="primary" onClick={doPush} disabled={busy || !campaignId || !preview?.length} title={!campaignId ? 'Choose a campaign' : preview?.length ? '' : 'Preview first'}>
                  {busy && !progress ? 'Working…' : `Send ${preview?.length ?? ''} to Instantly`}
                </button>
              </div>
              <p className="muted small">Only personalized emails go. Main decision-makers first; anyone already in Instantly is skipped. {left} more can go today.</p>
              {summary && (
                <p className={summary.stopped ? 'warn-note' : 'note'} role="status">
                  Sent {summary.requested}: {summary.added} added to the campaign{summary.skipped ? `, ${summary.skipped} declined by Instantly (already there, invalid or blocklisted)` : ''}.
                  {summary.remainingInPlan != null ? ` ${summary.remainingInPlan} leads left in your Instantly plan.` : ''}
                  {summary.stopped ? ` ${summary.stopped}.` : ''}
                </p>
              )}
              <div className="row">
                <input id="outreach-test" type="email" placeholder="your@inbox.com" value={testEmail} onChange={(e) => setTestEmail(e.target.value)} style={{ flex: '1 1 200px' }} aria-label="Test email address" />
                <button onClick={doTest} disabled={busy || !campaignId || !testEmail}>Send a test</button>
              </div>
              {testResult && <p className="note small">{testResult}</p>}
              <p className="faint small">Campaign setup in Instantly: subject <code>{'{{subject}}'}</code>, body <code>{'{{body_html}}'}</code>.</p>
            </>
          )}
        </section>
      </div>

      {preview && (
        <section className="card">
          <h2>Next {preview.length} to send</h2>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Name</th><th>Company</th><th>Personal opener</th><th></th></tr></thead>
              <tbody>
                {preview.map((p) => {
                  const open = openRow === String(p.id);
                  return <PreviewRows key={String(p.id)} p={p} open={open} onToggle={() => setOpenRow(open ? '' : String(p.id))} />;
                })}
              </tbody>
            </table>
            {!preview.length && <p className="empty">Nobody is personalized and waiting. Personalize first.</p>}
          </div>
        </section>
      )}

      {data && data.held.length > 0 && (
        <section className="card">
          <h2>Held back: write an opener by hand</h2>
          <p className="muted small">Nothing specific was found for these people. Write one sentence about them and save it, and they join the send queue. Leave it empty to keep them out.</p>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Name</th><th>Title and company</th><th>Opener</th></tr></thead>
              <tbody>
                {data.held.map((p) => <HeldRow key={String(p.id)} p={p} busy={busy} onSave={(text) => saveOpener(String(p.id), text)} />)}
              </tbody>
            </table>
          </div>
        </section>
      )}

      <section className="card">
        <h2>Sent to Instantly</h2>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Name</th><th>Company</th><th>Email</th><th>Result</th><th>When</th></tr></thead>
            <tbody>
              {data?.sent.map((p) => (
                <tr key={String(p.id)}>
                  <td><a href={p.linkedin_url} target="_blank" rel="noreferrer">{p.name}</a></td>
                  <td>{p.company || '—'}</td>
                  <td>{p.email}<div><EmailBadge status={p.apollo_status} /></div></td>
                  <td>{p.instantly_status === 'added' ? <span className="badge ok">In campaign</span> : <span className="badge">Declined</span>}</td>
                  <td className="small muted">{formatDate(p.instantly_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {data && !data.sent.length && <p className="empty">Nobody sent yet.</p>}
        </div>
      </section>
    </div>
  );
}

function PreviewRows({ p, open, onToggle }: { p: Preview; open: boolean; onToggle: () => void }) {
  const vars = p.lead.custom_variables ?? {};
  return (
    <>
      <tr>
        <td><a href={p.linkedin_url} target="_blank" rel="noreferrer">{p.name}</a><div className="faint small">{p.email}</div></td>
        <td>{p.company || '—'}</td>
        <td>{p.opener}{p.opener_fact ? <div className="faint small">Based on: {p.opener_fact}</div> : null}</td>
        <td><button className="link small" onClick={onToggle}>{open ? 'Hide email' : 'Full email'}</button></td>
      </tr>
      {open && (
        <tr>
          <td colSpan={4}>
            <div className="draft">
              <div><span className="muted small">Subject</span> <b>{vars.subject}</b></div>
              <pre>{vars.body}</pre>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function HeldRow({ p, busy, onSave }: { p: SavedPerson; busy: boolean; onSave: (text: string) => void }) {
  const [text, setText] = useState('');
  return (
    <tr>
      <td><a href={p.linkedin_url} target="_blank" rel="noreferrer">{p.name}</a></td>
      <td className="small">{[p.title, p.company].filter(Boolean).join(' at ') || '—'}</td>
      <td>
        <div className="row">
          <input id={`opener-${p.id}`} value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. Your move into Saudi Arabia this year caught our eye." style={{ flex: '1 1 260px' }} aria-label={`Opener for ${p.name}`} />
          <button onClick={() => onSave(text)} disabled={busy || !text.trim()}>Save</button>
        </div>
      </td>
    </tr>
  );
}

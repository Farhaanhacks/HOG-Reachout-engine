'use client';

import { useCallback, useEffect, useState } from 'react';
import { EmailBadge } from '../../components/badges';
import { api, formatDate, post } from '../../lib/client';
import type { Campaign, InstantlyLead } from '../../lib/instantly';
import { CAMPAIGN_STATUS } from '../../lib/instantly';
import type { OutreachStatus, PushSummary } from '../../lib/outreach';
import type { SavedPerson } from '../../lib/store';

type Overview = { configured: boolean; defaultCampaignId: string; campaigns: Campaign[]; campaignError: string; status: OutreachStatus; sent: SavedPerson[] };
type Preview = SavedPerson & { lead: InstantlyLead };

const CAMPAIGN_KEY = 'hog-instantly-campaign';

export default function OutreachPage() {
  const [data, setData] = useState<Overview | null>(null);
  const [campaignId, setCampaignId] = useState('');
  const [limit, setLimit] = useState(25);
  const [preview, setPreview] = useState<Preview[] | null>(null);
  const [openRow, setOpenRow] = useState('');
  const [summary, setSummary] = useState<PushSummary | null>(null);
  const [testEmail, setTestEmail] = useState('');
  const [testResult, setTestResult] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

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
      setTestResult(d.added ? `Added ${testEmail} to the campaign. It arrives when the campaign sends.` : `Instantly did not add ${testEmail} (already in this campaign). Delete it in Instantly to test again.`);
    });

  const campaign = data?.campaigns.find((c) => c.id === campaignId);
  const left = data ? Math.max(0, data.status.dailyLimit - data.status.sentToday) : 0;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Outreach (Instantly)</h1>
          <p className="sub">Sends people with an email ready into an Instantly campaign, each with their own Humans of Globe invitation. Instantly does the sending, pacing each mailbox and stopping the sequence when someone replies.</p>
        </div>
      </div>

      {error && <p className="alert" role="alert">{error}</p>}

      {data && !data.configured && (
        <section className="card">
          <h2>Connect Instantly</h2>
          <p className="muted">Add <code>INSTANTLY_API_KEY</code> in Vercel (Settings, Environment Variables), then redeploy. Create the key in Instantly under Settings, Integrations, API, with permission to read campaigns and create leads.</p>
        </section>
      )}

      <div className="stats">
        <div className="stat"><div className="n">{data?.status.waiting ?? '—'}</div><div className="l">Emails ready, not sent</div></div>
        <div className="stat"><div className="n">{data?.status.sent ?? '—'}</div><div className="l">In Instantly</div></div>
        <div className="stat"><div className="n">{data?.status.skipped ?? '—'}</div><div className="l">Declined by Instantly</div></div>
        <div className="stat"><div className="n">{data ? `${data.status.sentToday}/${data.status.dailyLimit}` : '—'}</div><div className="l">Sent to Instantly today</div></div>
      </div>

      {data?.configured && (
        <div className="grid-run">
          <section className="card">
            <h2>Send to Instantly</h2>
            <label className="field">
              Campaign
              <select id="outreach-campaign" value={campaignId} onChange={(e) => chooseCampaign(e.target.value)} disabled={busy}>
                <option value="">Choose a campaign</option>
                {data.campaigns.map((c) => <option key={c.id} value={c.id}>{c.name} ({CAMPAIGN_STATUS[String(c.status)] ?? c.status})</option>)}
              </select>
            </label>
            {data.campaignError && <p className="alert">Could not load campaigns: {data.campaignError}</p>}
            {campaign && campaign.status !== 1 && <p className="warn-note">This campaign is {CAMPAIGN_STATUS[String(campaign.status)] ?? 'not active'}. Leads are added but nothing is sent until you start it in Instantly.</p>}
            <div className="row">
              <label className="check">
                Send the next
                <input id="outreach-limit" type="number" min={1} max={500} value={limit} onChange={(e) => { setLimit(Math.max(1, Math.min(500, Number(e.target.value) || 1))); setPreview(null); }} style={{ width: 90 }} />
                people
              </label>
              <button onClick={doPreview} disabled={busy}>Preview</button>
              <button className="primary" onClick={doPush} disabled={busy || !campaignId || !preview?.length} title={!campaignId ? 'Choose a campaign' : preview?.length ? '' : 'Preview first'}>
                {busy ? 'Working…' : `Send ${preview?.length ?? ''} to Instantly`}
              </button>
            </div>
            <p className="muted small">Main decision-makers go first. Anyone already in your Instantly workspace is skipped, so nobody gets the email twice. {left} more can go today.</p>
            {summary && (
              <p className={summary.stopped ? 'warn-note' : 'note'} role="status">
                Sent {summary.requested}: {summary.added} added to the campaign{summary.skipped ? `, ${summary.skipped} declined by Instantly (already there, invalid or blocklisted)` : ''}.
                {summary.remainingInPlan != null ? ` ${summary.remainingInPlan} leads left in your Instantly plan.` : ''}
                {summary.stopped ? ` ${summary.stopped}.` : ''}
              </p>
            )}
          </section>

          <section className="card">
            <h2>Set up the campaign once</h2>
            <ol className="muted small steps-list">
              <li>In Instantly, create a campaign and connect your sending mailboxes.</li>
              <li>In its first step, set the subject to <code>{'{{subject}}'}</code> and the body to <code>{'{{body_html}}'}</code>. Each lead then gets their own invitation.</li>
              <li>Add follow-up steps in Instantly if you want them, and set the schedule and daily limits there.</li>
              <li>Send a test below, check it in your inbox, then start the campaign.</li>
            </ol>
            <div className="row">
              <input id="outreach-test" type="email" placeholder="your@inbox.com" value={testEmail} onChange={(e) => setTestEmail(e.target.value)} style={{ flex: '1 1 200px' }} aria-label="Test email address" />
              <button onClick={doTest} disabled={busy || !campaignId || !testEmail}>Send a test</button>
            </div>
            {testResult && <p className="note small">{testResult}</p>}
          </section>
        </div>
      )}

      {preview && (
        <section className="card">
          <h2>Next {preview.length} to send</h2>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Name</th><th>Company</th><th>Email</th><th>Subject</th><th></th></tr></thead>
              <tbody>
                {preview.map((p) => {
                  const open = openRow === String(p.id);
                  return (
                    <PreviewRows key={String(p.id)} p={p} open={open} onToggle={() => setOpenRow(open ? '' : String(p.id))} />
                  );
                })}
              </tbody>
            </table>
            {!preview.length && <p className="empty">Nobody is waiting. Get more emails on the Emails page first.</p>}
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
        <td><a href={p.linkedin_url} target="_blank" rel="noreferrer">{p.name}</a></td>
        <td>{p.company || '—'}</td>
        <td>{p.email}</td>
        <td>{vars.subject}</td>
        <td><button className="link small" onClick={onToggle}>{open ? 'Hide email' : 'See email'}</button></td>
      </tr>
      {open && (
        <tr>
          <td colSpan={5}>
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

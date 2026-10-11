'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { EmailBadge } from '../../components/badges';
import type { EmailAccount, Sequence } from '../../lib/apollo-sequences';
import { api, formatDate, personalizeWaiting, post } from '../../lib/client';
import type { OutreachStatus, PushSummary } from '../../lib/outreach';
import { CUSTOM_FIELDS } from '../../lib/pitch';
import type { SavedPerson } from '../../lib/store';

type Overview = {
  configured: boolean;
  aiConfigured: boolean;
  defaultSequenceId: string;
  defaultEmailAccountId: string;
  sequences: Sequence[];
  emailAccounts: EmailAccount[];
  missingFields: string[];
  template: { subject: string; body: string };
  apolloError: string;
  status: OutreachStatus;
  held: SavedPerson[];
  sent: SavedPerson[];
};
type Preview = SavedPerson & { preview: { subject: string; body: string } };

const SEQUENCE_KEY = 'hog-apollo-sequence';
const MAILBOX_KEY = 'hog-apollo-mailbox';

const remembered = (key: string) => {
  try {
    return localStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
};
const remember = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {}
};

export default function OutreachPage() {
  const [data, setData] = useState<Overview | null>(null);
  const [sequenceId, setSequenceId] = useState('');
  const [mailboxId, setMailboxId] = useState('');
  const [limit, setLimit] = useState(25);
  const [progress, setProgress] = useState('');
  const [preview, setPreview] = useState<Preview[] | null>(null);
  const [openRow, setOpenRow] = useState('');
  const [summary, setSummary] = useState<PushSummary | null>(null);
  const [testEmail, setTestEmail] = useState('');
  const [testResult, setTestResult] = useState('');
  const [copied, setCopied] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const autoStarted = useRef(false);

  const load = useCallback(async () => {
    const d = await api<Overview>('/api/outreach');
    setData(d);
    const seqIds = d.sequences.map((s) => s.id);
    const boxIds = d.emailAccounts.filter((a) => a.active).map((a) => a.id);
    setSequenceId((current) => current || [remembered(SEQUENCE_KEY), d.defaultSequenceId].find((id) => id && seqIds.includes(id)) || '');
    setMailboxId(
      (current) =>
        current ||
        [remembered(MAILBOX_KEY), d.defaultEmailAccountId, d.emailAccounts.find((a) => a.isDefault && a.active)?.id].find((id) => id && boxIds.includes(id)) ||
        '',
    );
  }, []);

  useEffect(() => {
    load().catch((e: Error) => setError(e.message));
  }, [load]);

  /**
   * Personalization is automatic: whenever this page opens with emails still waiting, it reads their news and writes
   * their openers in the background (batches of 10), then refreshes the counts.
   */
  useEffect(() => {
    if (!data || !data.aiConfigured || data.status.toPersonalize === 0 || autoStarted.current) return;
    autoStarted.current = true;
    setProgress(`Personalizing ${data.status.toPersonalize} emails from the news…`);
    personalizeWaiting(data.status.toPersonalize, (done) => setProgress(`Personalizing from the news… ${done} of ${data.status.toPersonalize} done.`))
      .then((r) => {
        setProgress(`Personalized ${r.done} emails.${r.failed ? ` ${r.failed} could not be done right now (${r.error}); they are retried automatically.` : ''}`);
        return load();
      })
      // Once per page visit: anything that fails is retried on the next visit or just before sending.
      .catch((e: Error) => setProgress(`Personalization paused: ${e.message}. It retries when this page is opened again.`));
  }, [data, load]);

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
      const d = await api<{ summary: PushSummary }>('/api/outreach', post({ action: 'push', limit, sequenceId, emailAccountId: mailboxId, confirm: true }));
      setSummary(d.summary);
      setPreview(null);
      await load();
    });

  const doTest = () =>
    act(async () => {
      setTestResult('');
      const d = await api<{ added: boolean; reason?: string }>('/api/outreach', post({ action: 'test', sequenceId, emailAccountId: mailboxId, testEmail }));
      setTestResult(
        d.added
          ? `Added ${testEmail} to the sequence with a real personalized email. It arrives when the sequence's first step sends.`
          : `Apollo did not add ${testEmail}: ${d.reason ?? 'no reason given'}. Remove that contact from the sequence in Apollo to test again.`,
      );
    });

  const saveOpener = (personId: string, opener: string) =>
    act(async () => {
      await api('/api/outreach', post({ action: 'opener', personId, opener }));
      await load();
    });

  async function copy(label: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(label);
      setTimeout(() => setCopied(''), 2000);
    } catch {
      setCopied('');
      setError('Copying was blocked by the browser. Select the text and copy it by hand.');
    }
  }

  const sequence = data?.sequences.find((s) => s.id === sequenceId);
  const left = data ? Math.max(0, data.status.dailyLimit - data.status.sentToday) : 0;
  const ready = !!data && data.configured && !data.apolloError && data.missingFields.length === 0;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Outreach (Apollo)</h1>
          <p className="sub">Every email opens with something specific about that person and ends with a working unsubscribe link. People are added to your Apollo sequence, which sends from your connected mailbox, paces the sending and stops when someone replies.</p>
        </div>
      </div>

      {error && <p className="alert" role="alert">{error}</p>}
      {data && !data.configured && <p className="warn-note">Add <code>APOLLO_API_KEY</code> in Vercel (a master key, since adding to sequences needs one), then redeploy.</p>}
      {data?.apolloError && <p className="alert">Could not reach Apollo: {data.apolloError}</p>}

      <div className="stats">
        <div className="stat"><div className="n">{data?.status.toPersonalize ?? '—'}</div><div className="l">Being personalized</div></div>
        <div className="stat"><div className="n">{data?.status.waiting ?? '—'}</div><div className="l">Personalized, ready to send</div></div>
        <div className="stat"><div className="n">{data?.status.sent ?? '—'}</div><div className="l">In an Apollo sequence</div></div>
        <div className="stat"><div className="n">{data?.status.skipped ?? '—'}</div><div className="l">Declined by Apollo</div></div>
        <div className="stat"><div className="n">{data?.status.unsubscribed ?? '—'}</div><div className="l">Unsubscribed</div></div>
        <div className="stat"><div className="n">{data ? `${data.status.sentToday}/${data.status.dailyLimit}` : '—'}</div><div className="l">Added today</div></div>
      </div>

      <div className="grid-run">
        <section className="card">
          <h2>Send through Apollo</h2>
          {data && data.missingFields.length > 0 && data.configured && !data.apolloError && (
            <p className="warn-note">Create these custom contact fields in Apollo first (see setup): {data.missingFields.join(', ')}.</p>
          )}
          <label className="field">
            Sequence
            <select id="outreach-sequence" value={sequenceId} onChange={(e) => { setSequenceId(e.target.value); remember(SEQUENCE_KEY, e.target.value); }} disabled={busy}>
              <option value="">Choose a sequence</option>
              {data?.sequences.map((s) => <option key={s.id} value={s.id}>{s.name}{s.active ? '' : ' (not active)'}</option>)}
            </select>
          </label>
          {sequence && !sequence.active && <p className="warn-note">This sequence is not active. People are added, but nothing sends until you activate it in Apollo.</p>}
          <label className="field">
            Send from
            <select id="outreach-mailbox" value={mailboxId} onChange={(e) => { setMailboxId(e.target.value); remember(MAILBOX_KEY, e.target.value); }} disabled={busy}>
              <option value="">Choose a mailbox</option>
              {data?.emailAccounts.filter((a) => a.active).map((a) => <option key={a.id} value={a.id}>{a.email}</option>)}
            </select>
          </label>
          {data && data.configured && !data.apolloError && data.emailAccounts.filter((a) => a.active).length === 0 && (
            <p className="warn-note">No mailbox is connected in Apollo yet. Connect one under Settings, Mailboxes.</p>
          )}
          <div className="row">
            <label className="check">
              Send the next
              <input id="outreach-limit" type="number" min={1} max={50} value={limit} onChange={(e) => { setLimit(Math.max(1, Math.min(50, Number(e.target.value) || 1))); setPreview(null); }} style={{ width: 90 }} />
              people
            </label>
            <button onClick={doPreview} disabled={busy}>Preview</button>
            <button className="primary" onClick={doPush} disabled={busy || !ready || !sequenceId || !mailboxId || !preview?.length} title={!sequenceId || !mailboxId ? 'Choose a sequence and a mailbox' : preview?.length ? '' : 'Preview first'}>
              {busy ? 'Working…' : `Add ${preview?.length ?? ''} to the sequence`}
            </button>
          </div>
          <p className="muted small">Main decision-makers first. People already in another Apollo sequence are skipped, so nobody gets two sequences. {left} more can be added today.</p>
          {summary && (
            <p className={summary.stopped || summary.failed ? 'warn-note' : 'note'} role="status">
              Added {summary.added} to the sequence
              {summary.skipped ? `; Apollo declined ${summary.skipped} (${Object.entries(summary.reasons).map(([why, n]) => `${n} ${why}`).join(', ')})` : ''}
              {summary.failed ? `; ${summary.failed} could not be created in Apollo (${summary.error}) and will go next time` : ''}.
              {summary.stopped ? ` ${summary.stopped}.` : ''}
            </p>
          )}
          <div className="row">
            <input id="outreach-test" type="email" placeholder="your@inbox.com" value={testEmail} onChange={(e) => setTestEmail(e.target.value)} style={{ flex: '1 1 200px' }} aria-label="Test email address" />
            <button onClick={doTest} disabled={busy || !ready || !sequenceId || !mailboxId || !testEmail}>Send a test</button>
          </div>
          {testResult && <p className="note small">{testResult}</p>}
          <p className="faint small">{progress || (data && data.status.toPersonalize === 0 ? `All ${data.status.waiting} emails waiting to send are personalized.` : '')}</p>
        </section>

        <section className="card">
          <h2>Set up Apollo once</h2>
          <ol className="muted small steps-list">
            <li>
              In Apollo, open Settings, Objects and fields, Contact, and create three custom <b>text</b> fields named exactly:{' '}
              {Object.values(CUSTOM_FIELDS).map((f, i) => (
                <span key={f}><code>{f}</code>{i < 2 ? ', ' : ''}</span>
              ))}
              .{' '}
              {data && data.configured && !data.apolloError && (data.missingFields.length ? <span className="badge warn">{data.missingFields.length} missing</span> : <span className="badge ok">All found</span>)}
            </li>
            <li>Connect your sending mailbox under Settings, Mailboxes, and let it warm up.</li>
            <li>
              Create a sequence with one automatic email step. Paste the subject and body below. Re-insert each <code>{'{{…}}'}</code> field with Apollo&apos;s <code>{'{ }'}</code> variable picker if it does not turn into a variable.
            </li>
            <li>Send a test to your own inbox, check it, then activate the sequence.</li>
          </ol>
          {data && (
            <>
              <div className="row">
                <span className="muted small">Subject</span>
                <code>{data.template.subject}</code>
                <button className="link small" onClick={() => copy('subject', data.template.subject)}>{copied === 'subject' ? 'Copied' : 'Copy'}</button>
              </div>
              <div className="draft">
                <pre>{data.template.body}</pre>
              </div>
              <button onClick={() => copy('body', data.template.body)}>{copied === 'body' ? 'Copied' : 'Copy the email body'}</button>
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
            {!preview.length && <p className="empty">Nobody is personalized and waiting yet. Personalization runs automatically; check back in a minute.</p>}
          </div>
        </section>
      )}

      {data && data.held.length > 0 && (
        <section className="card">
          <h2>Write an opener by hand</h2>
          <p className="muted small">These were held back under an earlier rule. Write one sentence and save it, or leave them: they are personalized automatically on the next run.</p>
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
        <h2>Sent to Apollo</h2>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Name</th><th>Company</th><th>Email</th><th>Result</th><th>When</th></tr></thead>
            <tbody>
              {data?.sent.map((p) => (
                <tr key={String(p.id)}>
                  <td><a href={p.linkedin_url} target="_blank" rel="noreferrer">{p.name}</a></td>
                  <td>{p.company || '—'}</td>
                  <td>{p.email}<div><EmailBadge status={p.apollo_status} /></div></td>
                  <td>{p.sequence_status === 'added' ? <span className="badge ok">In sequence</span> : <span className="badge" title={p.sequence_note}>Declined{p.sequence_note ? `: ${p.sequence_note}` : ''}</span>}</td>
                  <td className="small muted">{formatDate(p.sequenced_at)}</td>
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
              <div><span className="muted small">Subject</span> <b>{p.preview.subject}</b></div>
              <pre>{p.preview.body}</pre>
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

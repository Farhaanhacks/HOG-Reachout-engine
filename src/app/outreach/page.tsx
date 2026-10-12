'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { EmailBadge, PersonName } from '../../components/badges';
import type { Sequence } from '../../lib/apollo-sequences';
import { api, formatDate, personalizeWaiting, post } from '../../lib/client';
import type { OutreachStatus, PushSummary } from '../../lib/outreach';
import type { Brand } from '../../lib/brands';
import { CUSTOM_FIELDS, unsubscribeButtonHtml, type UnsubscribeStyle } from '../../lib/pitch';
import type { SavedPerson } from '../../lib/store';

type Inbox = { id: string; email: string; domain: string; usable: boolean; room: number; newToday: number; addedToday: number; paused: string };
type BrandInfo = { id: Brand; label: string; domain: string; regionLabel: string };
type Overview = {
  brand: Brand;
  brands: BrandInfo[];
  configured: boolean;
  aiConfigured: boolean;
  defaultSequenceId: string;
  sequences: Sequence[];
  inboxes: Inbox[];
  room: number;
  emailsPerPerson: number;
  unsubscribeStyle: UnsubscribeStyle;
  missingFields: string[];
  template: { subject: string; body: string; html: string };
  apolloError: string;
  status: OutreachStatus;
  held: SavedPerson[];
  sent: SavedPerson[];
};
type Preview = SavedPerson & { preview: { subject: string; body: string } };

const BRAND_KEY = 'hog-outreach-brand';
/** Each brand has its own sequence (its own template and wording), remembered separately. */
const sequenceKey = (brand: string) => `hog-apollo-sequence-${brand}`;

const STYLES: { id: UnsubscribeStyle; label: string; hint: string }[] = [
  { id: 'button', label: 'Unsubscribe button', hint: 'A real button at the bottom of every email, opening their own unsubscribe page' },
  { id: 'apollo', label: "Apollo's Unsubscribe link", hint: 'A clickable "Unsubscribe" word that Apollo adds after the signature' },
  { id: 'link', label: 'Our own link, as text', hint: 'The unsubscribe address written out in the email' },
  { id: 'reply', label: 'Reply to unsubscribe', hint: 'No link in the email at all' },
];

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
  const [brand, setBrand] = useState<Brand>(() => (remembered(BRAND_KEY) as Brand) || 'hog');
  const [sequenceId, setSequenceId] = useState('');
  const [testInbox, setTestInbox] = useState('');
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
    const d = await api<Overview>(`/api/outreach?brand=${brand}`);
    setData(d);
    const seqIds = d.sequences.map((s) => s.id);
    setSequenceId((current) => current || [remembered(sequenceKey(d.brand)), d.brand === 'hog' ? d.defaultSequenceId : ''].find((id) => id && seqIds.includes(id)) || '');
  }, [brand]);

  function switchBrand(next: Brand) {
    if (next === brand) return;
    remember(BRAND_KEY, next);
    setBrand(next);
    setData(null);
    setSequenceId('');
    setTestInbox('');
    setPreview(null);
    setSummary(null);
    setTestResult('');
  }

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
      const d = await api<{ people: Preview[] }>('/api/outreach', post({ action: 'preview', limit, brand }));
      setPreview(d.people);
    });

  const doPush = () =>
    act(async () => {
      const d = await api<{ summary: PushSummary }>('/api/outreach', post({ action: 'push', limit, sequenceId, confirm: true, brand }));
      setSummary(d.summary);
      setPreview(null);
      await load();
    });

  /** Adds batches of 25 until nobody personalized is waiting, today's room is used up, or something stops it. */
  const doSendAll = () =>
    act(async () => {
      setPreview(null);
      const total: PushSummary = { requested: 0, added: 0, skipped: 0, failed: 0, reasons: {}, byInbox: {}, paused: [] };
      for (let i = 0; i < 40; i++) {
        setProgress(`Sending… ${total.added} added so far.`);
        const d = await api<{ summary: PushSummary }>('/api/outreach', post({ action: 'push', limit: 25, sequenceId, confirm: true, brand }));
        const s = d.summary;
        total.requested += s.requested;
        total.added += s.added;
        total.skipped += s.skipped;
        total.failed += s.failed;
        for (const [k, v] of Object.entries(s.reasons)) total.reasons[k] = (total.reasons[k] ?? 0) + v;
        for (const [k, v] of Object.entries(s.byInbox)) total.byInbox[k] = (total.byInbox[k] ?? 0) + v;
        total.paused.push(...s.paused);
        if (s.error) total.error = s.error;
        if (s.stopped) total.stopped = s.stopped;
        setSummary({ ...total });
        if (s.stopped || s.requested === 0 || s.failed) break;
      }
      setProgress('');
      await load();
    });

  const doTest = () =>
    act(async () => {
      setTestResult('');
      const d = await api<{ added: boolean; reason?: string; from: string; to: string }>('/api/outreach', post({ action: 'test', sequenceId, emailAccountId: testInbox, testEmail, brand }));
      setTestResult(
        d.added
          ? `Added ${d.to} to the sequence with a real personalized email, sending from ${d.from}. It arrives in your ${testEmail} inbox when the sequence's first step sends (its delay and sending hours apply).`
          : `Apollo did not add ${d.to}: ${d.reason ?? 'no reason given'}. Use a different test address, or remove that contact from the sequence in Apollo.`,
      );
    });

  const setStyle = (unsubscribeStyle: UnsubscribeStyle) =>
    act(async () => {
      await api('/api/settings', post({ unsubscribeStyle }));
      setPreview(null);
      await load();
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
  const ready = !!data && data.configured && !data.apolloError && data.missingFields.length === 0;
  const usable = data?.inboxes.filter((i) => i.usable) ?? [];
  const domains = new Set(usable.map((i) => i.domain));

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Outreach (Apollo)</h1>
          <p className="sub">Each brand sends only its own leads, from its own domain&apos;s inboxes, through its own sequence. Every email opens with something specific about that person and ends with a working unsubscribe. Only verified emails are sent, each inbox within its warm-up limit.</p>
        </div>
      </div>

      <div className="segmented" role="radiogroup" aria-label="Brand">
        {(data?.brands ?? [
          { id: 'hog', label: 'Humans of Globe', domain: 'humansofglobe.com', regionLabel: '' },
          { id: 'gulficons', label: 'Gulf Icons', domain: 'gulficons.com', regionLabel: '' },
          { id: 'ciominds', label: 'CIO Minds', domain: 'ciominds.com', regionLabel: '' },
        ]).map((b) => (
          <button key={b.id} role="radio" aria-checked={brand === b.id} className={brand === b.id ? 'on' : ''} onClick={() => switchBrand(b.id as Brand)} disabled={busy}>
            <b>{b.label}</b>
            <span>@{b.domain}{b.regionLabel ? ` · ${b.regionLabel}` : ''}</span>
          </button>
        ))}
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
        <div className="stat"><div className="n">{data?.status.notSendable ?? '—'}</div><div className="l">Unverified or not a target · not sent</div></div>
        <div className="stat"><div className="n">{data?.status.suppressed ?? '—'}</div><div className="l">Suppressed</div></div>
        <div className="stat"><div className="n">{data ? `${data.status.sentToday} · ${data.room} left` : '—'}</div><div className="l">Added today · room left</div></div>
      </div>

      <div className="grid-run">
        <section className="card">
          <h2>Send through Apollo</h2>
          {data && data.missingFields.length > 0 && data.configured && !data.apolloError && (
            <p className="warn-note">Create these custom contact fields in Apollo first (see setup): {data.missingFields.join(', ')}.</p>
          )}
          <label className="field">
            Sequence
            <select id="outreach-sequence" value={sequenceId} onChange={(e) => { setSequenceId(e.target.value); remember(sequenceKey(brand), e.target.value); }} disabled={busy}>
              <option value="">Choose a sequence</option>
              {data?.sequences.map((s) => <option key={s.id} value={s.id}>{s.name}{s.active ? '' : ' (not active)'}</option>)}
            </select>
          </label>
          {sequence && !sequence.active && <p className="warn-note">This sequence is not active. People are added, but nothing sends until you activate it in Apollo.</p>}
          <div>
            <div className="section-label">Sending from</div>
            {data && !data.inboxes.length && <p className="warn-note">No inbox is connected in Apollo yet. Connect your 6 inboxes under Settings, Mailboxes in Apollo, then reload.</p>}
            <div className="chips" style={{ marginTop: 8 }}>
              {data?.inboxes.map((i) => (
                <span key={i.id} className={`chip ${i.usable ? '' : 'off'}`} title={i.paused || (i.usable ? `${i.addedToday} of ${i.newToday} new people today` : 'Turned off')}>
                  {i.email} · {i.usable ? `${i.room} left` : i.paused ? 'paused' : 'off'}
                </span>
              ))}
            </div>
            {data && data.inboxes.length > 0 && (
              <p className="muted small" style={{ marginTop: 8 }}>
                Rotating across {usable.length} inboxes on {domains.size} {domains.size === 1 ? 'domain' : 'domains'}. With {data.emailsPerPerson} emails per person, {data.room} more people can start today. <Link href="/deliverability">Limits and health</Link>
              </p>
            )}
          </div>
          <div className="row">
            <label className="check">
              Send the next
              <input id="outreach-limit" type="number" min={1} max={50} value={limit} onChange={(e) => { setLimit(Math.max(1, Math.min(50, Number(e.target.value) || 1))); setPreview(null); }} style={{ width: 90 }} />
              people
            </label>
            <button onClick={doPreview} disabled={busy}>Preview</button>
            <button onClick={doPush} disabled={busy || !ready || !sequenceId || !usable.length || !preview?.length} title={!sequenceId ? 'Choose a sequence' : preview?.length ? '' : 'Preview first'}>
              {`Add ${preview?.length ?? ''} to the sequence`}
            </button>
            <button className="primary" onClick={doSendAll} disabled={busy || !ready || !sequenceId || !usable.length || !data?.room || !data?.status.waiting}>
              {busy ? 'Working…' : `Send all ready (${Math.min(data?.room ?? 0, data?.status.waiting ?? 0)})`}
            </button>
          </div>
          <p className="muted small">Main decision-makers first. People already in another Apollo sequence are skipped, so nobody gets two sequences. Inboxes over the bounce or spam limits are paused automatically before each send.</p>
          {summary && (
            <p className={summary.stopped || summary.failed ? 'warn-note' : 'note'} role="status">
              Added {summary.added} to the sequence
              {Object.keys(summary.byInbox).length ? ` (${Object.entries(summary.byInbox).map(([inbox, n]) => `${n} from ${inbox}`).join(', ')})` : ''}
              {summary.skipped ? `; Apollo declined ${summary.skipped} (${Object.entries(summary.reasons).map(([why, n]) => `${n} ${why}`).join(', ')})` : ''}
              {summary.failed ? `; ${summary.failed} could not be created in Apollo (${summary.error}) and will go next time` : ''}.
              {summary.stopped ? ` ${summary.stopped}.` : ''}
              {summary.paused.length ? ` Paused: ${summary.paused.map((x) => `${x.email} (${x.reason})`).join('; ')}.` : ''}
            </p>
          )}
          <div className="row">
            <input id="outreach-test" type="email" placeholder="your@inbox.com" value={testEmail} onChange={(e) => setTestEmail(e.target.value)} style={{ flex: '1 1 200px' }} aria-label="Test email address" />
            <select id="outreach-test-inbox" value={testInbox} onChange={(e) => setTestInbox(e.target.value)} aria-label="Send the test from">
              <option value="">From the first inbox that can send</option>
              {data?.inboxes.map((i) => <option key={i.id} value={i.id}>From {i.email}</option>)}
            </select>
            <button onClick={doTest} disabled={busy || !ready || !sequenceId || !data?.inboxes.length || !testEmail}>Send a test</button>
          </div>
          {testResult && <p className="note small">{testResult}</p>}
          <p className="faint small">{progress || (data && data.status.toPersonalize === 0 ? `All ${data.status.waiting} emails waiting to send are personalized.` : '')}</p>
        </section>

        <section className="card">
          <h2>Set up Apollo once</h2>
          <ol className="muted small steps-list">
            <li>
              In Apollo, open Settings, Objects and fields, Contact, and create these custom <b>text</b> fields, named exactly:{' '}
              {Object.values(CUSTOM_FIELDS).map((f, i, all) => (
                <span key={f}><code>{f}</code>{i < all.length - 1 ? ', ' : ''}</span>
              ))}
              .{' '}
              {data && data.configured && !data.apolloError && (data.missingFields.length ? <span className="badge warn">{data.missingFields.length} missing</span> : <span className="badge ok">All found</span>)}
            </li>
            <li>Connect all 6 inboxes under Settings, Mailboxes, and turn on warm-up for each one. Set each inbox&apos;s daily limit in Apollo to match the Deliverability page.</li>
            <li>
              Create a sequence with automatic email steps ({data?.emailsPerPerson ?? 3} emails per person, as set on the Targeting page). Paste the subject and body below into the first step, and keep the unsubscribe line in every step. Re-insert each <code>{'{{…}}'}</code> field with Apollo&apos;s <code>{'{ }'}</code> variable picker if it does not turn into a variable.
            </li>
            <li>Send a test to your own inbox, check it, then activate the sequence.</li>
          </ol>
          {data && (
            <>
              <div>
                <div className="section-label">How people unsubscribe</div>
                <div className="segmented" role="radiogroup" aria-label="How people unsubscribe">
                  {STYLES.map((st) => (
                    <button key={st.id} role="radio" aria-checked={data.unsubscribeStyle === st.id} className={data.unsubscribeStyle === st.id ? 'on' : ''} onClick={() => setStyle(st.id)} disabled={busy}>
                      <b>{st.label}</b>
                      <span>{st.hint}</span>
                    </button>
                  ))}
                </div>
                {data.unsubscribeStyle === 'button' && (
                  <p className="muted small" style={{ marginTop: 8 }}>
                    In Apollo: Settings, Profile, Email settings, keep <b>one-click unsubscribe headers</b> on, turn <b>Append a sequences opt-out message</b> off (the button replaces it) and turn open and click tracking off. In each sequence step, open the editor&apos;s raw HTML view and paste the HTML below. Put this site on your own domain (<code>APP_URL</code>) so the button does not point to a vercel.app address.
                  </p>
                )}
                {data.unsubscribeStyle === 'apollo' && (
                  <p className="muted small" style={{ marginTop: 8 }}>
                    In Apollo, open Settings, Profile, Email settings: keep <b>Include one-click unsubscribe headers</b> on, keep <b>Append a sequences opt-out message after my signature</b> on with the text <code>No longer interested in these messages? &lt;%Unsubscribe%&gt;</code>, and turn open and click tracking off. Every email then ends with a clickable Unsubscribe, and opt-outs are copied back here automatically.
                  </p>
                )}
                {data.unsubscribeStyle === 'reply' && (
                  <p className="muted small" style={{ marginTop: 8 }}>
                    Apollo stops the sequence on any reply, and anyone whose reply Apollo reads as unsubscribe or not interested is never contacted again.
                  </p>
                )}
              </div>
              <div className="row">
                <span className="muted small">Subject</span>
                <code>{data.template.subject}</code>
                <button className="link small" onClick={() => copy('subject', data.template.subject)}>{copied === 'subject' ? 'Copied' : 'Copy'}</button>
              </div>
              <div className="draft">
                <pre>{data.template.body}</pre>
              </div>
              {data.template.html ? (
                <>
                  <div className="row">
                    <button className="primary" onClick={() => copy('html', data.template.html)}>{copied === 'html' ? 'Copied' : 'Copy the HTML (with the button)'}</button>
                    <button onClick={() => copy('body', data.template.body)}>{copied === 'body' ? 'Copied' : 'Copy as plain text'}</button>
                  </div>
                  <div className="section-label">How the button looks</div>
                  <div style={{ background: '#ffffff', color: '#222222', borderRadius: 9, padding: '14px 16px' }} dangerouslySetInnerHTML={{ __html: unsubscribeButtonHtml('#') }} />
                </>
              ) : (
                <button onClick={() => copy('body', data.template.body)}>{copied === 'body' ? 'Copied' : 'Copy the email body'}</button>
              )}
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
            <thead><tr><th>Name</th><th>Company</th><th>Email</th><th>Result</th><th>Sent from</th><th>When</th></tr></thead>
            <tbody>
              {data?.sent.map((p) => (
                <tr key={String(p.id)}>
                  <td><PersonName p={p} /></td>
                  <td>{p.company || '—'}</td>
                  <td>{p.email}<div><EmailBadge status={p.apollo_status} emailStatus={p.email_status} /></div></td>
                  <td>{p.sequence_status === 'added' ? <span className="badge ok">In sequence</span> : <span className="badge" title={p.sequence_note}>Declined{p.sequence_note ? `: ${p.sequence_note}` : ''}</span>}</td>
                  <td className="small">{p.sent_from_email || '—'}</td>
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
        <td><PersonName p={p} /><div className="faint small">{p.email}</div></td>
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
      <td><PersonName p={p} /></td>
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

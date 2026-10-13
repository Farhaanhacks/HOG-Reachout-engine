'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, formatDate, pct, post } from '../../lib/client';
import { guessSenderName, type DomainCheck, type Health, type MailboxState } from '../../lib/deliverability';
import type { SyncSummary } from '../../lib/tracking';

type Data = {
  inboxes: MailboxState[];
  domains: { domain: string; inboxes: number; usable: number; health: Health }[];
  paused: { email: string; reason: string }[];
  sync: SyncSummary | null;
  lastSync: string;
  apolloError: string;
  emailsPerPerson: number;
  autoPause: boolean;
  rules: { rampStart: number; rampStep: number; bounceLimit: number; spamLimit: number; minSent: number; windowDays: number };
};

/** Green under half the limit, amber up to it, red over it. */
function RateBadge({ n, of, limit }: { n: number; of: number; limit: number }) {
  if (!of) return <span className="faint">—</span>;
  const r = n / of;
  const tone = r > limit ? 'bad' : r > limit / 2 ? 'warn' : 'ok';
  return <span className={`badge ${tone}`}>{pct(n, of)}</span>;
}

function Check({ ok, label, detail }: { ok: boolean; label: string; detail: string }) {
  return (
    <div>
      <span className={`badge ${ok ? 'ok' : 'bad'}`}>{ok ? '✓' : '✗'} {label}</span>
      <div className="faint small" style={{ wordBreak: 'break-all' }}>{detail}</div>
    </div>
  );
}

export default function DeliverabilityPage() {
  const [data, setData] = useState<Data | null>(null);
  const [checks, setChecks] = useState<DomainCheck[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await api<Data>('/api/deliverability'));
    } catch (e) {
      setError((e as Error).message);
    }
    setLoading(false);
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  async function update(id: string, change: Record<string, unknown>) {
    setBusy(true);
    setError('');
    try {
      const d = await api<Pick<Data, 'inboxes' | 'domains'>>('/api/deliverability', post({ action: 'update', id, ...change }));
      setData((x) => (x ? { ...x, ...d } : x));
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
  }

  async function setAutoPause(on: boolean) {
    setBusy(true);
    setError('');
    try {
      await api('/api/settings', post({ autoPause: on }));
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
  }

  async function checkDns() {
    if (!data) return;
    setBusy(true);
    setError('');
    try {
      setChecks((await api<{ checks: DomainCheck[] }>('/api/deliverability', post({ action: 'dns', domains: data.domains.map((d) => d.domain) }))).checks);
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
  }

  const r = data?.rules;
  const totalToday = data?.inboxes.reduce((n, i) => n + (i.usable ? i.emailsToday : 0), 0) ?? 0;
  const newToday = data?.inboxes.reduce((n, i) => n + (i.usable ? i.newToday : 0), 0) ?? 0;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Deliverability</h1>
          <p className="sub">
            Each brand&apos;s inboxes take turns. Each starts at {r?.rampStart ?? 20} emails a day and adds {r?.rampStep ?? 3} a day up to its own limit (warm-up ramp). Bounces and spam blocks are read from Apollo every time this page opens and before every send; red means an inbox is over {r ? r.bounceLimit * 100 : 3}% bounces or {r ? r.spamLimit * 100 : 1}% spam blocks over {r?.windowDays ?? 7} days.
          </p>
        </div>
        <button onClick={load} disabled={loading || busy}>{loading ? 'Reading Apollo…' : 'Refresh'}</button>
      </div>

      {error && <p className="alert" role="alert">{error}</p>}
      {data && (
        <section className="card">
          <div className="card-head">
            <h2>Auto-pause on bounces</h2>
            {data.autoPause ? <span className="badge ok">On</span> : <span className="badge warn">Off</span>}
          </div>
          <p className="muted small">
            {data.autoPause
              ? `On: an inbox (or a whole domain) over ${r ? r.bounceLimit * 100 : 3}% bounces or ${r ? r.spamLimit * 100 : 1}% spam blocks stops getting new people until you resume it.`
              : 'Off: bounces never stop sending. Keep an eye on the bounce rates below; if they climb past about 3%, Gmail and Outlook start sending the whole domain to spam. Apollo’s own Bounce Guard (Settings, Email setup and health, Sending policies) can still pause a sequence on a big spike.'}
          </p>
          <div className="row">
            <button onClick={() => setAutoPause(!data.autoPause)} disabled={busy}>{data.autoPause ? 'Switch auto-pause off' : 'Switch auto-pause on'}</button>
          </div>
        </section>
      )}
      {data?.apolloError && <p className="alert">Could not reach Apollo: {data.apolloError}</p>}
      {data?.paused.map((p) => <p key={p.email} className="alert">Paused {p.email}: {p.reason}. Nobody new is given to it until you resume it.</p>)}

      <div className="stats">
        <div className="stat"><div className="n">{data ? `${data.inboxes.filter((i) => i.usable).length}/${data.inboxes.length}` : '—'}</div><div className="l">Inboxes sending</div></div>
        <div className="stat"><div className="n">{data ? totalToday : '—'}</div><div className="l">Emails they may send today</div></div>
        <div className="stat"><div className="n">{data ? newToday : '—'}</div><div className="l">New people per day at {data?.emailsPerPerson ?? 3} emails each</div></div>
        <div className="stat"><div className="n">{data?.lastSync ? formatDate(data.lastSync) : '—'}</div><div className="l">Last read from Apollo</div></div>
      </div>

      <section className="card">
        <div className="card-head">
          <h2>Domains</h2>
          <button onClick={checkDns} disabled={busy || !data?.domains.length}>Check SPF, DKIM and DMARC</button>
        </div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Domain</th><th className="num">Inboxes</th><th className="num">Sent ({r?.windowDays ?? 7} days)</th><th>Bounced</th><th>Spam blocked</th><th className="num">Replies</th><th className="num">Unsubscribed</th></tr></thead>
            <tbody>
              {data?.domains.map((d) => (
                <tr key={d.domain}>
                  <td><b>{d.domain || '—'}</b></td>
                  <td className="num">{d.usable}/{d.inboxes}</td>
                  <td className="num">{d.health.sent}</td>
                  <td><RateBadge n={d.health.bounced} of={d.health.sent} limit={r?.bounceLimit ?? 0.03} /></td>
                  <td><RateBadge n={d.health.spam} of={d.health.sent + d.health.spam} limit={r?.spamLimit ?? 0.01} /></td>
                  <td className="num">{d.health.replied}</td>
                  <td className="num">{d.health.unsubscribed}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {data && !data.domains.length && <p className="empty">No inboxes connected in Apollo yet.</p>}
        </div>
        {checks && (
          <div className="grid-2">
            {checks.map((c) => (
              <div key={c.domain} className="draft">
                <b>{c.domain}</b>
                {c.error ? (
                  <p className="alert small">{c.error}</p>
                ) : (
                  <>
                    <Check ok={c.spf.ok} label="SPF" detail={c.spf.record || 'No SPF record: add one from your email provider (e.g. v=spf1 include:_spf.google.com ~all).'} />
                    <Check ok={c.dkim.ok} label="DKIM" detail={c.dkim.ok ? `Found for: ${c.dkim.selectors.join(', ')}` : 'No DKIM key found on the usual selectors: turn on DKIM signing in Google Workspace or Microsoft 365 and add the DNS record it gives you.'} />
                    <Check
                      ok={c.dmarc.ok && c.dmarc.policy !== 'none'}
                      label={`DMARC${c.dmarc.policy ? ` (p=${c.dmarc.policy})` : ''}`}
                      detail={!c.dmarc.ok ? 'No DMARC record: add a TXT record at _dmarc with v=DMARC1; p=quarantine; rua=mailto:you@yourdomain.' : c.dmarc.policy === 'none' ? 'p=none only reports; move to p=quarantine once SPF and DKIM pass.' : c.dmarc.record}
                    />
                  </>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="card">
        <h2>Inboxes</h2>
        <p className="muted small">Type each inbox&apos;s full name under <b>Signs as</b> (it signs every email it sends, e.g. &quot;John Cooper&quot;; the grey text is a guess from the address). Set each inbox&apos;s top daily limit (50 to 100 once warmed up). Turn warm-up on in Apollo for every inbox too: this page paces how many new people each inbox starts, Apollo&apos;s warm-up builds its reputation.</p>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Inbox</th><th>Signs as</th><th>Status</th><th className="num">Emails today</th><th>Top limit</th><th>Warm-up ramp</th><th className="num">New today</th><th>Bounced</th><th>Spam blocked</th><th className="num">Replies</th><th></th></tr></thead>
            <tbody>
              {data?.inboxes.map((i) => (
                <tr key={i.id}>
                  <td><b>{i.email}</b></td>
                  <td>
                    <input
                      key={`${i.id}-${i.sender_name}`}
                      defaultValue={i.sender_name}
                      placeholder={guessSenderName(i.email) || 'Full name'}
                      style={{ width: 170, padding: '7px 10px' }}
                      aria-label={`Name ${i.email} signs its emails with`}
                      onBlur={(e) => e.target.value.trim() !== i.sender_name && update(i.id, { senderName: e.target.value })}
                      disabled={busy}
                    />
                  </td>
                  <td>
                    {i.paused_reason ? <span className="badge bad" title={i.paused_reason}>Paused</span> : !i.apollo_active ? <span className="badge warn">Not active in Apollo</span> : i.enabled ? <span className="badge ok">Sending</span> : <span className="badge">Off</span>}
                    {i.paused_reason && <div className="faint small">{i.paused_reason}</div>}
                  </td>
                  <td className="num">{i.emailsToday}</td>
                  <td>
                    <input key={`${i.id}-${i.max_per_day}`} type="number" min={1} max={200} defaultValue={i.max_per_day} style={{ width: 80, padding: '7px 10px' }} aria-label={`Top daily limit for ${i.email}`} onBlur={(e) => Number(e.target.value) !== i.max_per_day && update(i.id, { maxPerDay: Number(e.target.value) })} disabled={busy} />
                  </td>
                  <td className="small">
                    {i.ramp ? (i.emailsToday < i.max_per_day ? `Day ${i.ramp_days + 1}: ${i.emailsToday}/${i.max_per_day}` : 'Fully ramped') : 'Off'}
                    <div>
                      <button className="link small" onClick={() => update(i.id, { ramp: !i.ramp })} disabled={busy}>{i.ramp ? 'Turn off' : 'Turn on'}</button>
                      {' · '}
                      <button className="link small" onClick={() => update(i.id, { restartRamp: true })} disabled={busy}>Restart</button>
                    </div>
                  </td>
                  <td className="num">{i.addedToday}/{i.newToday}</td>
                  <td><RateBadge n={i.health.bounced} of={i.health.sent} limit={r?.bounceLimit ?? 0.03} /></td>
                  <td><RateBadge n={i.health.spam} of={i.health.sent + i.health.spam} limit={r?.spamLimit ?? 0.01} /></td>
                  <td className="num">{i.health.replied}</td>
                  <td>
                    {i.paused_reason ? (
                      <button className="link small" onClick={() => update(i.id, { resume: true })} disabled={busy}>Resume</button>
                    ) : (
                      <button className="link small" onClick={() => update(i.id, { enabled: !i.enabled })} disabled={busy}>{i.enabled ? 'Turn off' : 'Turn on'}</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {data && !data.inboxes.length && <p className="empty">Connect your inboxes in Apollo (Settings, Mailboxes), then refresh.</p>}
          {!data && loading && <p className="empty">Reading inboxes and the latest bounces from Apollo…</p>}
        </div>
        {data?.sync && !data.sync.complete && <p className="faint small">Still reading older emails from Apollo{data.sync.error ? ` (${data.sync.error})` : ''}; refresh to continue.</p>}
      </section>
    </div>
  );
}

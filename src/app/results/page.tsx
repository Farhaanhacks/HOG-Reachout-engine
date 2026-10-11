'use client';

import { useCallback, useEffect, useState } from 'react';
import { api, formatDate, pct } from '../../lib/client';
import type { GroupRow, Metrics, Reply } from '../../lib/tracking';

type Data = {
  days: number;
  lastSync: string;
  sync: { complete?: boolean; error?: string } | null;
  totals: Metrics;
  groups: { key: string; label: string; rows: GroupRow[] }[];
  replies: Reply[];
};

const REPLY_LABEL: Record<string, [string, string]> = {
  willing_to_meet: ['ok', 'Wants to meet'],
  follow_up_question: ['ok', 'Asked a question'],
  person_referral: ['ok', 'Referred someone'],
  out_of_office: ['', 'Out of office'],
  already_left_company_or_not_right_person: ['', 'Left / wrong person'],
  not_interested: ['bad', 'Not interested'],
  unsubscribe: ['bad', 'Unsubscribe'],
  none_of_the_above: ['', 'Other reply'],
};

const PERIODS = [7, 30, 90];

/** One horizontal bar per group: the reply rate, with the counts beside it. */
function Breakdown({ rows }: { rows: GroupRow[] }) {
  const max = Math.max(0.0001, ...rows.map((r) => (r.people ? r.replied / r.people : 0)));
  return (
    <div className="table-wrap">
      <table>
        <thead><tr><th>Group</th><th className="num">Emailed</th><th style={{ width: '30%' }}>Reply rate</th><th className="num">Interested</th><th className="num">Bounced</th><th className="num">Opened*</th><th className="num">Unsubscribed</th></tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.group}>
              <td><b>{r.group}</b></td>
              <td className="num">{r.people}</td>
              <td>
                <div className="bar"><div style={{ width: `${((r.people ? r.replied / r.people : 0) / max) * 100}%` }} /></div>
                <span className="small muted">{pct(r.replied, r.people)} ({r.replied})</span>
              </td>
              <td className="num">{r.interested} <span className="faint small">{pct(r.interested, r.people)}</span></td>
              <td className="num">{r.bounced} <span className="faint small">{pct(r.bounced, r.people)}</span></td>
              <td className="num">{pct(r.opened, r.people)}</td>
              <td className="num">{r.unsubscribed}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {!rows.length && <p className="empty">No emails sent in this period yet.</p>}
    </div>
  );
}

export default function ResultsPage() {
  const [days, setDays] = useState(30);
  const [group, setGroup] = useState('segment');
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async (d: number, sync: boolean) => {
    setLoading(true);
    setError('');
    try {
      setData(await api<Data>(`/api/results?days=${d}${sync ? '' : '&sync=0'}`));
    } catch (e) {
      setError((e as Error).message);
    }
    setLoading(false);
  }, []);
  useEffect(() => {
    load(30, true);
  }, [load]);

  const t = data?.totals;
  const current = data?.groups.find((g) => g.key === group);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Results</h1>
          <p className="sub">What happened to every email sent through the engine, read from Apollo, broken down by segment, company size, market, country, title, opener and inbox. Replies, interest and bounces are the numbers to trust; opens include automatic opens by Apple Mail and spam scanners.</p>
        </div>
        <div className="row">
          <div className="segmented" role="radiogroup" aria-label="Period" style={{ marginTop: 0 }}>
            {PERIODS.map((p) => (
              <button key={p} role="radio" aria-checked={days === p} className={days === p ? 'on' : ''} onClick={() => { setDays(p); load(p, false); }} disabled={loading} style={{ padding: '8px 14px' }}>
                <b>{p} days</b>
              </button>
            ))}
          </div>
          <button onClick={() => load(days, true)} disabled={loading}>{loading ? 'Reading Apollo…' : 'Refresh'}</button>
        </div>
      </div>

      {error && <p className="alert" role="alert">{error}</p>}
      {data?.sync?.error && <p className="warn-note">Could not read everything from Apollo: {data.sync.error}. Showing what was read before.</p>}

      <div className="stats">
        <div className="stat"><div className="n">{t?.people ?? '—'}</div><div className="l">People emailed</div></div>
        <div className="stat"><div className="n">{t?.emails ?? '—'}</div><div className="l">Emails sent</div></div>
        <div className="stat"><div className="n">{t ? pct(t.replied, t.people) : '—'}</div><div className="l">Replied ({t?.replied ?? 0})</div></div>
        <div className="stat"><div className="n">{t ? pct(t.interested, t.people) : '—'}</div><div className="l">Interested ({t?.interested ?? 0})</div></div>
        <div className="stat"><div className="n">{t ? pct(t.bounced, t.people) : '—'}</div><div className="l">Bounced ({t?.bounced ?? 0})</div></div>
        <div className="stat"><div className="n">{t?.spam ?? '—'}</div><div className="l">Blocked as spam</div></div>
        <div className="stat"><div className="n">{t?.unsubscribed ?? '—'}</div><div className="l">Unsubscribed</div></div>
        <div className="stat"><div className="n">{t ? pct(t.opened, t.people) : '—'}</div><div className="l">Opened*</div></div>
      </div>

      <section className="card">
        <div className="card-head">
          <h2>Breakdown</h2>
          <select id="results-group" value={group} onChange={(e) => setGroup(e.target.value)} aria-label="Break down by">
            {data?.groups.map((g) => <option key={g.key} value={g.key}>By {g.label.toLowerCase()}</option>)}
          </select>
        </div>
        {current ? <Breakdown rows={current.rows} /> : <p className="empty">{loading ? 'Reading the latest from Apollo…' : 'No data yet.'}</p>}
        <p className="faint small">* Opens include automatic opens by Apple Mail and corporate spam scanners. Last read from Apollo: {data?.lastSync ? formatDate(data.lastSync) : 'never'}.</p>
      </section>

      <section className="card">
        <h2>Replies</h2>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Name</th><th>Company</th><th>Email</th><th>Segment</th><th>Reply</th><th>Inbox</th><th>When</th></tr></thead>
            <tbody>
              {data?.replies.map((r) => {
                const [tone, label] = REPLY_LABEL[r.reply_class] ?? ['', r.reply_class || 'Replied'];
                return (
                  <tr key={String(r.id)}>
                    <td><b>{r.name}</b><div className="faint small">{r.title}</div></td>
                    <td>{r.company}<div className="faint small">{r.country}</div></td>
                    <td className="small">{r.email}</td>
                    <td className="small">{r.segment || '—'}</td>
                    <td><span className={`badge ${tone}`}>{label}</span></td>
                    <td className="small">{r.from_email}</td>
                    <td className="small muted">{formatDate(r.at)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {data && !data.replies.length && <p className="empty">No replies yet.</p>}
        </div>
      </section>
    </div>
  );
}

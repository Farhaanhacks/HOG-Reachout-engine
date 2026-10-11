'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { CountryBadge, EmailBadge, PersonName, RunBadge, SizeBadge } from '../components/badges';
import { api, countryName, formatDate } from '../lib/client';
import type { EnrichStatus } from '../lib/enrich';
import { MARKET_LIST, marketShort } from '../lib/markets';
import type { Run } from '../lib/run';
import type { SavedPerson } from '../lib/store';

type Overview = {
  people: { geo: string; total: number; targets: number; main: number; ready: number }[];
  enrich: EnrichStatus;
  runs: Run[];
  latest: SavedPerson[];
  emails: SavedPerson[];
};

const sum = (rows: Overview['people'], key: 'total' | 'ready') => rows.reduce((n, p) => n + p[key], 0);

export default function OverviewPage() {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api<Overview>('/api/overview').then(setData).catch((e: Error) => setError(e.message));
  }, []);

  const n = (v: number | string | null | undefined) => (data ? (v ?? 0) : '—');
  const byMarket = (geo: string) => data?.people.find((p) => p.geo === geo);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Overview</h1>
          <p className="sub">Company leaders in Africa, Europe, the US and the UAE, with verified emails, ready for personalized outreach.</p>
        </div>
        <Link href="/run" className="btn primary big">Find leads</Link>
      </div>

      {error && <p className="alert" role="alert">{error}</p>}

      <div className="stats">
        <div className="stat"><div className="n">{n(data && sum(data.people, 'total'))}</div><div className="l">Leads saved</div></div>
        <Link href="/leads?ready=1" className="stat stat-link"><div className="n">{n(data && sum(data.people, 'ready'))}</div><div className="l">Ready to email →</div></Link>
        {MARKET_LIST.map((g) => <div key={g} className="stat"><div className="n">{n(byMarket(g)?.ready ?? 0)}</div><div className="l">Ready in {marketShort(g)}</div></div>)}
        <div className="stat"><div className="n">{n(data ? `${data.enrich.usedToday}/${data.enrich.dailyLimit}` : '')}</div><div className="l">Apollo lookups today</div></div>
      </div>

      <section className="card">
        <div className="card-head">
          <h2>Newest leads ready to email</h2>
          <Link href="/leads?ready=1" className="small">See all</Link>
        </div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Name</th><th>Title</th><th>Company</th><th>Industry</th><th>Email</th><th>Country</th></tr></thead>
            <tbody>
              {data?.emails.map((p) => (
                <tr key={String(p.id)}>
                  <td><PersonName p={p} /></td>
                  <td>{p.title || <span className="faint">—</span>}</td>
                  <td>{p.company || <span className="faint">—</span>}<div><SizeBadge size={p.company_size} employees={p.company_employees} firmSize={p.firm_size} /></div></td>
                  <td className="small">{p.industry || <span className="faint">—</span>}</td>
                  <td><div>{p.email}</div><EmailBadge status={p.apollo_status} emailStatus={p.email_status} /></td>
                  <td><CountryBadge geo={p.geo} match={p.geo_match} country={p.country} /></td>
                </tr>
              ))}
            </tbody>
          </table>
          {data && !data.emails.length && <p className="empty">No leads ready yet. Press Find leads to start.</p>}
          {!data && !error && <p className="empty">Loading…</p>}
        </div>
      </section>

      <section className="card">
        <div className="card-head">
          <h2>Recent runs</h2>
          <Link href="/run" className="small">All runs</Link>
        </div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Started</th><th>Markets</th><th className="num">Searches</th><th className="num">New leads</th><th className="num">Ready to email</th><th>Status</th></tr></thead>
            <tbody>
              {data?.runs.map((r) => (
                <tr key={String(r.id)}>
                  <td>{formatDate(r.created_at)}</td>
                  <td>{countryName(r.geo)}</td>
                  <td className="num">{r.next_index}/{r.queries.length}</td>
                  <td className="num">{r.inserted}</td>
                  <td className="num">{r.apollo_with_email}</td>
                  <td><RunBadge status={r.status} error={r.error} /></td>
                </tr>
              ))}
            </tbody>
          </table>
          {data && !data.runs.length && <p className="empty">No runs yet.</p>}
        </div>
      </section>
    </div>
  );
}

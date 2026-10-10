'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { CountryBadge, EmailBadge, RunBadge } from '../components/badges';
import { api, countryName, formatDate } from '../lib/client';
import type { EnrichStatus } from '../lib/enrich';
import type { Run } from '../lib/run';
import type { SavedPerson } from '../lib/store';

type Overview = {
  people: { geo: string; total: number; targets: number; main: number }[];
  enrich: EnrichStatus;
  runs: Run[];
  latest: SavedPerson[];
};

const sum = (rows: Overview['people'], key: 'total' | 'targets' | 'main') => rows.reduce((n, p) => n + p[key], 0);

export default function OverviewPage() {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api<Overview>('/api/overview').then(setData).catch((e: Error) => setError(e.message));
  }, []);

  const n = (v: number | string | null | undefined) => (data ? (v ?? 0) : '—');
  const byGeo = (geo: string) => data?.people.find((p) => p.geo === geo);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Overview</h1>
          <p className="sub">Successful people in the UAE and the US, their LinkedIn profiles, and the emails Apollo has found for them.</p>
        </div>
        <Link href="/run" className="btn primary big">Find leads</Link>
      </div>

      {error && <p className="alert" role="alert">{error}</p>}

      <div className="stats">
        <div className="stat"><div className="n">{n(data && sum(data.people, 'total'))}</div><div className="l">People saved</div></div>
        <div className="stat"><div className="n">{n(data && sum(data.people, 'main'))}</div><div className="l">Main decision-makers</div></div>
        <div className="stat"><div className="n">{n(byGeo('ae')?.total ?? 0)}</div><div className="l">In the UAE</div></div>
        <div className="stat"><div className="n">{n(byGeo('us')?.total ?? 0)}</div><div className="l">In the US</div></div>
        <div className="stat"><div className="n">{n(data?.enrich.withEmail)}</div><div className="l">Emails ready</div></div>
        <div className="stat"><div className="n">{n(data ? `${data.enrich.usedToday}/${data.enrich.dailyLimit}` : '')}</div><div className="l">Apollo lookups today</div></div>
      </div>

      <section className="card">
        <div className="card-head">
          <h2>Newest main decision-makers</h2>
          <Link href="/leads" className="small">See all leads</Link>
        </div>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Name</th><th>Title</th><th>Company</th><th>Country</th><th>Email</th><th>Found</th></tr></thead>
            <tbody>
              {data?.latest.map((p) => (
                <tr key={String(p.id)}>
                  <td><a href={p.linkedin_url} target="_blank" rel="noreferrer">{p.name}</a></td>
                  <td>{p.title || <span className="faint">—</span>}</td>
                  <td>{p.company || <span className="faint">—</span>}</td>
                  <td><CountryBadge geo={p.geo} match={p.geo_match} /></td>
                  <td>{p.email ? <div>{p.email}</div> : null}<EmailBadge status={p.apollo_status} /></td>
                  <td className="small muted">{formatDate(p.first_seen)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {data && !data.latest.length && <p className="empty">No one yet. Press Find leads to start.</p>}
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
            <thead><tr><th>Started</th><th>Countries</th><th className="num">Searches</th><th className="num">New people</th><th className="num">Emails</th><th>Status</th></tr></thead>
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

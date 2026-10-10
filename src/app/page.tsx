'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { RunBadge } from '../components/badges';
import { api, countryName, formatDate } from '../lib/client';
import type { EnrichStatus } from '../lib/enrich';
import type { Run } from '../lib/run';

type Overview = { people: { geo: string; total: number; targets: number }[]; enrich: EnrichStatus; runs: Run[] };

export default function OverviewPage() {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api<Overview>('/api/overview').then(setData).catch((e: Error) => setError(e.message));
  }, []);

  const total = data?.people.reduce((n, p) => n + p.total, 0) ?? 0;
  const targets = data?.people.reduce((n, p) => n + p.targets, 0) ?? 0;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Overview</h1>
          <p className="sub">Senior people found in the UAE and the US, their LinkedIn profiles, and the emails Apollo has found for them.</p>
        </div>
        <Link href="/run" className="btn primary">Find leads</Link>
      </div>

      {error && <p className="alert" role="alert">{error}</p>}

      <div className="stats">
        <div className="stat"><div className="n">{data ? total : '—'}</div><div className="l">People saved</div></div>
        <div className="stat"><div className="n">{data ? targets : '—'}</div><div className="l">Founders, C-suite, owners, partners</div></div>
        <div className="stat"><div className="n">{data ? data.enrich.withEmail : '—'}</div><div className="l">Emails ready</div></div>
        <div className="stat"><div className="n">{data ? data.enrich.pending : '—'}</div><div className="l">Waiting for Apollo</div></div>
        <div className="stat"><div className="n">{data ? `${data.enrich.usedToday}/${data.enrich.dailyLimit}` : '—'}</div><div className="l">Apollo lookups today</div></div>
      </div>

      <div className="grid-2">
        <section className="card">
          <div className="card-head">
            <h2>By country</h2>
            <Link href="/leads" className="small">See all leads</Link>
          </div>
          {data && data.people.length ? (
            <div className="table-wrap">
              <table>
                <thead><tr><th>Country</th><th className="num">People</th><th className="num">Targets</th></tr></thead>
                <tbody>
                  {data.people.map((p) => (
                    <tr key={p.geo}><td>{countryName(p.geo)}</td><td className="num">{p.total}</td><td className="num">{p.targets}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="muted">{data ? 'No one saved yet. Start with Find leads.' : 'Loading…'}</p>
          )}
        </section>

        <section className="card">
          <div className="card-head">
            <h2>Recent runs</h2>
            <Link href="/run" className="small">All runs</Link>
          </div>
          {data && data.runs.length ? (
            <div className="table-wrap">
              <table>
                <thead><tr><th>Started</th><th>Country</th><th className="num">New people</th><th className="num">Emails</th><th>Status</th></tr></thead>
                <tbody>
                  {data.runs.map((r) => (
                    <tr key={String(r.id)}>
                      <td>{formatDate(r.created_at)}</td>
                      <td>{countryName(r.geo)}</td>
                      <td className="num">{r.inserted}</td>
                      <td className="num">{r.apollo_with_email}</td>
                      <td><RunBadge status={r.status} error={r.error} /></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="muted">{data ? 'No runs yet.' : 'Loading…'}</p>
          )}
        </section>
      </div>
    </div>
  );
}

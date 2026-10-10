'use client';

import { Fragment, useEffect, useMemo, useState } from 'react';
import { CountryBadge, EmailBadge, RankBadge, SizeBadge } from '../../components/badges';
import { api, formatDate } from '../../lib/client';
import { GEOS, GEO_LIST } from '../../lib/geo';
import { draftEmail } from '../../lib/pitch';
import type { SavedPerson } from '../../lib/store';

/** Filters a link can set, e.g. /leads?ready=1 from the Overview's "Emails ready". */
const linkParams = () => new URLSearchParams(typeof window === 'undefined' ? '' : window.location.search);

export default function LeadsPage() {
  const [geo, setGeo] = useState('');
  // Showing emails means showing everyone who has one, not only the main person of each company.
  const [who, setWho] = useState<'top' | 'targets' | 'all'>(() => (linkParams().get('ready') === '1' ? 'all' : 'top'));
  const [ready, setReady] = useState(() => linkParams().get('ready') === '1');
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [people, setPeople] = useState<SavedPerson[] | null>(null);
  const [error, setError] = useState('');
  const [openDraft, setOpenDraft] = useState('');

  const params = useMemo(() => {
    const p = new URLSearchParams();
    if (geo) p.set('geo', geo);
    if (who === 'top') p.set('top', '1');
    if (who === 'targets') p.set('targets', '1');
    if (ready) p.set('ready', '1');
    if (query) p.set('q', query);
    return p.toString();
  }, [geo, who, ready, query]);

  useEffect(() => {
    let current = true; // ignore answers to filters the user has already changed
    setError('');
    api<{ people: SavedPerson[] }>(`/api/leads?${params}`)
      .then((d) => current && setPeople(d.people))
      .catch((e: Error) => current && setError(e.message));
    return () => {
      current = false;
    };
  }, [params]);

  // Search as the user types, a moment after they stop.
  useEffect(() => {
    const t = setTimeout(() => setQuery(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Leads</h1>
          <p className="sub">Everyone the engine has saved. Download the list as a spreadsheet for the team or for an email tool.</p>
        </div>
        <a className="btn primary" href={`/api/leads/csv?${params}`}>Download CSV</a>
      </div>

      <section className="card">
        <div className="row">
          <input id="leads-search" placeholder="Search name, title or company" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: '1 1 260px' }} aria-label="Search" />
          <select id="leads-geo" value={geo} onChange={(e) => setGeo(e.target.value)} aria-label="Country">
            <option value="">All countries</option>
            {GEO_LIST.map((g) => <option key={g} value={g}>{GEOS[g].label}</option>)}
          </select>
          <select id="leads-who" value={who} onChange={(e) => setWho(e.target.value as 'top' | 'targets' | 'all')} aria-label="Who">
            <option value="top">Main person of each company</option>
            <option value="targets">All founders, C-suite and partners</option>
            <option value="all">Everyone saved</option>
          </select>
          <label className="check"><input id="leads-ready" type="checkbox" checked={ready} onChange={(e) => setReady(e.target.checked)} /> Email ready</label>
        </div>
        {error && <p className="alert" role="alert">{error}</p>}
        <p className="muted small">{people ? `${people.length} ${people.length === 1 ? 'person' : 'people'}${people.length === 500 ? ' (first 500; narrow the filters or download the CSV)' : ''}` : 'Loading…'}</p>
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Name</th><th>Title</th><th>Company</th><th>Country</th><th>Email</th><th>Found</th><th></th></tr>
            </thead>
            <tbody>
              {people?.map((p) => {
                const open = openDraft === String(p.id);
                const d = open ? draftEmail(p) : null;
                return (
                  <Fragment key={String(p.id)}>
                    <tr>
                      <td><a href={p.linkedin_url} target="_blank" rel="noreferrer">{p.name}</a></td>
                      <td>{p.title || <span className="muted">—</span>} <RankBadge rank={p.rank} /></td>
                      <td>
                        {p.company || <span className="muted">—</span>}
                        <div><SizeBadge size={p.company_size} employees={p.company_employees} /></div>
                      </td>
                      <td><CountryBadge geo={p.geo} match={p.geo_match} /></td>
                      <td>
                        {p.email ? <div>{p.email}</div> : null}
                        <EmailBadge status={p.apollo_status} /> {p.instantly_status === 'added' && <span className="badge ok">In Instantly</span>}
                      </td>
                      <td className="small muted">{formatDate(p.first_seen)}</td>
                      <td><button className="link small" onClick={() => setOpenDraft(open ? '' : String(p.id))}>{open ? 'Hide email' : 'Email draft'}</button></td>
                    </tr>
                    {d && (
                      <tr>
                        <td colSpan={7}>
                          <div className="draft">
                            <div><span className="muted small">Subject</span> <b>{d.subject}</b></div>
                            <pre>{d.body}</pre>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
          {people && !people.length && <p className="empty">No one matches these filters.</p>}
        </div>
      </section>
    </div>
  );
}

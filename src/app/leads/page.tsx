'use client';

import { Fragment, useEffect, useMemo, useState } from 'react';
import { CountryBadge, EmailBadge, FitBadge, PersonName, SizeBadge, SuppressedBadge } from '../../components/badges';
import { api, formatDate, post } from '../../lib/client';
import { BRANDS, BRAND_LIST, brandLabel } from '../../lib/brands';
import { MARKETS, MARKET_LIST } from '../../lib/markets';
import { draftEmail } from '../../lib/pitch';
import type { Settings } from '../../lib/settings';
import type { SavedPerson } from '../../lib/store';
import { editionFor, type Edition } from '../../lib/targeting';

/** The website as a link without the https:// in front. */
function Website({ url }: { url?: string }) {
  if (!url) return null;
  const href = /^https?:\/\//i.test(url) ? url : `https://${url}`;
  return <a className="small" href={href} target="_blank" rel="noreferrer">{url.replace(/^https?:\/\/(www\.)?/i, '').replace(/\/$/, '')}</a>;
}

/** Filters a link can set, e.g. /leads?ready=1 from the Overview's "Emails ready". */
const linkParams = () => new URLSearchParams(typeof window === 'undefined' ? '' : window.location.search);

export default function LeadsPage() {
  const [geo, setGeo] = useState('');
  const [brand, setBrand] = useState(() => linkParams().get('brand') ?? '');
  // Showing emails means showing everyone who has one, not only the main person of each company.
  const [who, setWho] = useState<'top' | 'targets' | 'all'>('all');
  const [editions, setEditions] = useState<Edition[] | undefined>(undefined);
  const [ready, setReady] = useState(() => linkParams().get('ready') === '1');
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [people, setPeople] = useState<SavedPerson[] | null>(null);
  const [error, setError] = useState('');
  const [openDraft, setOpenDraft] = useState('');
  const [personalizing, setPersonalizing] = useState('');

  /** Researches one person's news and writes their opener, then shows the personalized draft. */
  async function personalize(id: string) {
    setPersonalizing(id);
    setError('');
    try {
      const r = await api<{ status: string; opener: string; fact: string }>('/api/outreach', post({ action: 'personalize-one', personId: id }));
      setPeople((list) => list?.map((x) => (String(x.id) === id ? { ...x, opener: r.opener, opener_fact: r.fact, opener_status: r.status } : x)) ?? list);
    } catch (e) {
      setError((e as Error).message);
    }
    setPersonalizing('');
  }

  useEffect(() => {
    api<{ settings: Settings }>('/api/settings').then((d) => setEditions(d.settings.editions)).catch(() => {});
  }, []);

  // Opening a draft that is not personalized yet personalizes it straight away: nobody has to press anything.
  useEffect(() => {
    const p = people?.find((x) => String(x.id) === openDraft);
    if (p && p.opener_status !== 'done' && !personalizing) personalize(openDraft);
    // Runs when a draft is opened; `people` changes after personalizing and must not trigger it again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openDraft]);

  const params = useMemo(() => {
    const p = new URLSearchParams();
    if (geo) p.set('geo', geo);
    if (brand) p.set('brand', brand);
    if (who === 'top') p.set('top', '1');
    if (who === 'targets') p.set('targets', '1');
    if (ready) p.set('ready', '1');
    if (query) p.set('q', query);
    return p.toString();
  }, [geo, brand, who, ready, query]);

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
          <p className="sub">Every lead with name, title, company, website, LinkedIn, email, company size, industry and country. Download the list as a spreadsheet.</p>
        </div>
        <a className="btn primary" href={`/api/leads/csv?${params}`}>Download CSV</a>
      </div>

      <section className="card">
        <div className="row">
          <input id="leads-search" placeholder="Search name, title, company or industry" value={q} onChange={(e) => setQ(e.target.value)} style={{ flex: '1 1 260px' }} aria-label="Search" />
          <select id="leads-brand" value={brand} onChange={(e) => setBrand(e.target.value)} aria-label="Brand">
            <option value="">All brands</option>
            {BRAND_LIST.map((b) => <option key={b} value={b}>{BRANDS[b].label}</option>)}
          </select>
          <select id="leads-geo" value={geo} onChange={(e) => setGeo(e.target.value)} aria-label="Country">
            <option value="">All markets</option>
            {MARKET_LIST.map((g) => <option key={g} value={g}>{MARKETS[g].label}</option>)}
          </select>
          <select id="leads-who" value={who} onChange={(e) => setWho(e.target.value as 'top' | 'targets' | 'all')} aria-label="Who">
            <option value="all">Everyone saved</option>
            <option value="top">Main person of each company</option>
            <option value="targets">All founders, C-suite and partners</option>
          </select>
          <label className="check"><input id="leads-ready" type="checkbox" checked={ready} onChange={(e) => setReady(e.target.checked)} /> Ready to email</label>
        </div>
        {error && <p className="alert" role="alert">{error}</p>}
        <p className="muted small">{people ? `${people.length} ${people.length === 1 ? 'person' : 'people'}${people.length === 500 ? ' (first 500; narrow the filters or download the CSV)' : ''}` : 'Loading…'}</p>
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>Brand</th><th>Name</th><th>Title</th><th>Company</th><th>Industry</th><th>Country</th><th>Email</th><th>Found</th><th></th></tr>
            </thead>
            <tbody>
              {people?.map((p) => {
                const open = openDraft === String(p.id);
                const e = open ? editionFor(p.industry, editions) : null;
                const d = e ? draftEmail({ ...p, edition: e.edition, industryLine: e.industryLine }) : null;
                return (
                  <Fragment key={String(p.id)}>
                    <tr>
                      <td className="small"><span className="badge accent">{brandLabel(p.brand)}</span></td>
                      <td><PersonName p={p} />{!p.linkedin_url && <div className="faint small">No LinkedIn on record</div>}</td>
                      <td>{p.title || <span className="muted">—</span>}<div><FitBadge fit={p.icp_fit} note={p.icp_note} title={p.target_title} /></div></td>
                      <td>
                        {p.company || <span className="muted">—</span>}
                        <div><Website url={p.company_website} /></div>
                        <div><SizeBadge size={p.company_size} employees={p.company_employees} firmSize={p.firm_size} /></div>
                      </td>
                      <td className="small">{p.industry || <span className="muted">—</span>}{p.segment ? <div className="faint">{p.segment} edition</div> : null}</td>
                      <td><CountryBadge geo={p.geo} match={p.geo_match} country={p.country} /></td>
                      <td>
                        {p.email ? <div>{p.email}</div> : null}
                        <EmailBadge status={p.apollo_status} emailStatus={p.email ? p.email_status : undefined} /> <SuppressedBadge reason={p.suppressed_reason} />{' '}
                        {p.sequence_status === 'added' && <span className="badge ok">In Apollo sequence</span>}
                      </td>
                      <td className="small muted">{formatDate(p.first_seen)}</td>
                      <td><button className="link small" onClick={() => setOpenDraft(open ? '' : String(p.id))}>{open ? 'Hide email' : 'Email draft'}</button></td>
                    </tr>
                    {d && (
                      <tr>
                        <td colSpan={9}>
                          <div className="draft">
                            {p.opener_status === 'done' && p.opener ? (
                              <p className="note small">Personalized{p.opener_fact ? ` from: ${p.opener_fact}` : ''}.</p>
                            ) : (
                              <p className="warn-note small">
                                {personalizing === String(p.id) ? (
                                  'Reading the news and personalizing this email…'
                                ) : (
                                  <>
                                    Could not personalize this one yet.{' '}
                                    <button className="link small" onClick={() => personalize(String(p.id))} disabled={!!personalizing}>Try again</button>
                                  </>
                                )}
                              </p>
                            )}
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

'use client';

import { useEffect, useRef, useState } from 'react';
import { BRANDS, eligibleBrands } from '../../lib/brands';
import { api, post } from '../../lib/client';
import { AFRICA_SHARE, ICPS } from '../../lib/icps';
import type { Settings } from '../../lib/settings';
import { SECTORS, SECTOR_LABEL, SMALL_MAX_EMPLOYEES, type Edition, type TitleRules } from '../../lib/targeting';

const list = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);

export default function TargetingPage() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [rules, setRules] = useState<TitleRules | null>(null);
  const [editions, setEditions] = useState<Edition[]>([]);
  const [emailsPerPerson, setEmailsPerPerson] = useState(3);
  const [saved, setSaved] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // Comma lists are edited as free text and read when the field is left, so typing a comma never loses it.
  const [version, setVersion] = useState(0);
  // The latest values, updated as each field is left, so a Save clicked straight after typing saves what was typed.
  const latest = useRef<{ rules: TitleRules | null; editions: Edition[] }>({ rules: null, editions: [] });

  function apply(s: Settings) {
    setVersion((v) => v + 1);
    setSettings(s);
    latest.current = { rules: structuredClone(s.rules), editions: structuredClone(s.editions) };
    setRules(latest.current.rules);
    setEditions(latest.current.editions);
    setEmailsPerPerson(s.emailsPerPerson);
  }

  useEffect(() => {
    api<{ settings: Settings }>('/api/settings').then((d) => apply(d.settings)).catch((e: Error) => setError(e.message));
  }, []);

  async function save(body: Record<string, unknown>, what: string) {
    setBusy(true);
    setError('');
    setSaved('');
    try {
      apply((await api<{ settings: Settings }>('/api/settings', post(body))).settings);
      setSaved(`${what} saved. New runs and sends use them straight away.`);
    } catch (e) {
      setError((e as Error).message);
    }
    setBusy(false);
  }

  function changeRules(fn: (r: TitleRules) => TitleRules) {
    if (!latest.current.rules) return;
    latest.current.rules = fn(latest.current.rules);
    setRules(latest.current.rules);
  }
  function changeEditions(next: Edition[]) {
    latest.current.editions = next;
    setEditions(next);
  }
  const setTitles = (sector: (typeof SECTORS)[number], size: 'small' | 'large', value: string) => changeRules((r) => ({ ...r, [sector]: { ...r[sector], [size]: list(value) } }));
  const setKeywords = (sector: 'healthcare' | 'hospitality', value: string) =>
    changeRules((r) => ({ ...r, sectorKeywords: { ...r.sectorKeywords, [sector]: list(value).map((k) => k.toLowerCase()) } }));
  const setEdition = (i: number, change: Partial<Edition>) => changeEditions(latest.current.editions.map((e, j) => (j === i ? { ...e, ...change } : e)));

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Targeting</h1>
          <p className="sub">Leads are found for five ideal customer profiles (ICPs), shared equally in every run. Africa keeps the size-and-industry title rules below and goes to Humans of Globe only.</p>
        </div>
      </div>

      {error && <p className="alert" role="alert">{error}</p>}
      {saved && <p className="note" role="status">{saved}</p>}

      <section className="card">
        <div className="card-head">
          <h2>Ideal customer profiles</h2>
          <span className="badge">Each about {Math.round(100 / ICPS.length)}% of every run</span>
        </div>
        <p className="muted small">
          Each is an Apollo People Search: people with one of the titles and seniorities, at companies Apollo tags with one of the keywords, of that size, based in
          those countries. Only verified emails. A lead goes to one brand for good: Gulf Icons (Gulf), CIO Minds (US, Europe, Singapore) or Humans of Globe (Gulf, US, Europe).
        </p>
        <div className="table-wrap">
          <table>
            <thead><tr><th>ICP</th><th>Company keywords</th><th>Titles</th><th>Seniority</th><th>Employees</th><th>Countries</th><th>Brands</th><th>Edition</th></tr></thead>
            <tbody>
              {ICPS.map((icp) => {
                const europe = icp.countries.length > 10;
                const brands = [...new Set(icp.countries.flatMap((c) => eligibleBrands(c)))].map((b) => BRANDS[b].label);
                return (
                  <tr key={icp.id}>
                    <td><b>{icp.label}</b></td>
                    <td className="small">{icp.keywords.join(', ')}</td>
                    <td className="small">{icp.titles.join(', ')}</td>
                    <td className="small">{icp.seniorities.map((s) => (s === 'c_suite' ? 'C-suite' : s[0].toUpperCase() + s.slice(1))).join(', ')}</td>
                    <td className="small">{icp.employees[0]}–{icp.employees[1]}</td>
                    <td className="small">{europe ? icp.countries.filter((c) => ['United States', 'United Arab Emirates', 'Saudi Arabia', 'Singapore'].includes(c)).concat('all of Europe').join(', ') : icp.countries.join(', ')}</td>
                    <td className="small">{brands.join(', ')}</td>
                    <td className="small">{icp.edition.replace('{year}', String(new Date().getFullYear()))}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="faint small">&quot;Partner&quot; means a partner of the firm, never a Partner Manager or Channel Partner Director. The edition is used when the news research names none for the company.</p>
      </section>

      <section className="card">
        <div className="card-head">
          <h2>Africa: title rules (Humans of Globe only)</h2>
          <div className="row">
            <button onClick={() => save({ reset: 'rules' }, 'Default title rules')} disabled={busy || !settings}>Back to defaults</button>
            <button className="primary" onClick={() => latest.current.rules && save({ rules: latest.current.rules }, 'Title rules')} disabled={busy || !rules}>Save title rules</button>
          </div>
        </div>
        <p className="muted small">Used only for Africa, about {Math.round(AFRICA_SHARE * 100)}% of every run on top of the ICPs. Small firms are up to {SMALL_MAX_EMPLOYEES} employees. Comma-separated. &quot;CEO&quot; also matches &quot;Chief Executive Officer&quot;, &quot;Founder&quot; matches &quot;Co-Founder &amp; CEO&quot;; deputies, assistants and former holders never match.</p>
        {rules && (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Industry</th><th>Small firms (up to {SMALL_MAX_EMPLOYEES})</th><th>Large firms</th><th>Apollo industry words that put a company here</th></tr></thead>
              <tbody>
                {SECTORS.map((s) => (
                  <tr key={s}>
                    <td><b>{SECTOR_LABEL[s]}</b></td>
                    <td><input key={`${version}-${s}-small`} defaultValue={rules[s].small.join(', ')} onBlur={(e) => setTitles(s, 'small', e.target.value)} style={{ width: '100%' }} aria-label={`${SECTOR_LABEL[s]} small-firm titles`} /></td>
                    <td><input key={`${version}-${s}-large`} defaultValue={rules[s].large.join(', ')} onBlur={(e) => setTitles(s, 'large', e.target.value)} style={{ width: '100%' }} aria-label={`${SECTOR_LABEL[s]} large-firm titles`} /></td>
                    <td>
                      {s === 'general' ? (
                        <span className="muted small">Every industry not listed below</span>
                      ) : (
                        <input key={`${version}-${s}-kw`} defaultValue={rules.sectorKeywords[s].join(', ')} onBlur={(e) => setKeywords(s, e.target.value)} style={{ width: '100%' }} aria-label={`${SECTOR_LABEL[s]} industry words`} />
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card">
        <div className="card-head">
          <h2>Editions by segment</h2>
          <div className="row">
            <button onClick={() => save({ reset: 'editions' }, 'Default editions')} disabled={busy || !settings}>Back to defaults</button>
            <button onClick={() => changeEditions([...latest.current.editions, { segment: '', keywords: [], edition: '', industryLine: '' }])} disabled={busy}>Add a segment</button>
            <button className="primary" onClick={() => save({ editions: latest.current.editions }, 'Editions')} disabled={busy || !editions.length}>Save editions</button>
          </div>
        </div>
        <p className="muted small">
          The edition title and industry line go into each contact&apos;s <code>HOG Edition</code> and <code>HOG Industry</code> fields in Apollo, so the template never hardcodes them. The first row whose words appear in a lead&apos;s industry wins; leads matching none get &quot;Global Leaders Edition&quot; and &quot;Business Leaders&quot;.
        </p>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Segment</th><th>Industry words</th><th>Edition title</th><th>Industry line</th><th></th></tr></thead>
            <tbody>
              {editions.map((e, i) => (
                <tr key={i}>
                  <td><input value={e.segment} onChange={(x) => setEdition(i, { segment: x.target.value })} style={{ width: '100%' }} aria-label="Segment" /></td>
                  <td><input key={`${version}-${i}-${editions.length}`} defaultValue={e.keywords.join(', ')} onBlur={(x) => setEdition(i, { keywords: list(x.target.value) })} style={{ width: '100%' }} aria-label="Industry words" /></td>
                  <td><input value={e.edition} onChange={(x) => setEdition(i, { edition: x.target.value })} style={{ width: '100%' }} aria-label="Edition title" /></td>
                  <td><input value={e.industryLine} onChange={(x) => setEdition(i, { industryLine: x.target.value })} style={{ width: '100%' }} aria-label="Industry line" /></td>
                  <td><button className="link small danger" onClick={() => changeEditions(latest.current.editions.filter((_, j) => j !== i))} disabled={busy}>Remove</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="card">
        <h2>Emails per person</h2>
        <div className="row">
          <label className="check">
            Each person gets
            <input id="emails-per-person" type="number" min={1} max={10} value={emailsPerPerson} onChange={(e) => setEmailsPerPerson(Math.max(1, Math.min(10, Number(e.target.value) || 1)))} style={{ width: 80 }} />
            emails in the sequence
          </label>
          <button className="primary" onClick={() => save({ emailsPerPerson }, 'Emails per person')} disabled={busy || emailsPerPerson === settings?.emailsPerPerson}>Save</button>
        </div>
        <p className="muted small">Match the number of email steps in your Apollo sequence. An inbox sending 60 emails a day can start 60 ÷ {emailsPerPerson} = {Math.floor(60 / emailsPerPerson)} new people a day, so its follow-ups still fit in later days.</p>
      </section>
    </div>
  );
}

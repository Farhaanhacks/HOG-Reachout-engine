import { geoShort } from '../lib/geo';

const RUN: Record<string, [string, string]> = {
  running: ['accent', 'Running'],
  done: ['ok', 'Done'],
  stopped: ['warn', 'Stopped'],
};

export function RunBadge({ status, error }: { status: string; error?: string }) {
  if (status === 'running' && error) return <span className="badge bad">Paused</span>;
  const [tone, label] = RUN[status] ?? ['', status];
  return <span className={`badge ${tone}`}>{label}</span>;
}

const EMAIL: Record<string, [string, string]> = {
  none: ['', 'Not looked up'],
  matched: ['ok', 'Email ready'],
  low_confidence: ['warn', 'Email ready · low match'],
  no_email: ['', 'No email'],
  no_match: ['', 'Not in Apollo'],
};

export function EmailBadge({ status }: { status: string }) {
  const [tone, label] = EMAIL[status] ?? ['', status];
  return <span className={`badge ${tone}`}>{label}</span>;
}

/** The company's size against the ICP's 25–10,000 employees, once Apollo has looked the person up. */
export function SizeBadge({ size, employees }: { size: string; employees: number | null }) {
  if (size === 'fit') return <span className="badge" title="Within 25–10,000 employees">{employees ? `${employees.toLocaleString()} employees` : 'Size fits'}</span>;
  if (size === 'big_enough') return <span className="badge" title="No employee count, but revenue, funding or a listing shows a real company">Established company</span>;
  if (size === 'too_small') return <span className="badge bad" title="Fewer than 25 employees: not emailed">{employees ? `${employees} employees · too small` : 'Too small'}</span>;
  if (size === 'too_large') return <span className="badge bad" title="More than 10,000 employees: not emailed">{employees ? `${employees.toLocaleString()} employees · too large` : 'Too large'}</span>;
  return null;
}

/** Marks the main person of a company. */
export function RankBadge({ rank }: { rank: number | null | undefined }) {
  if (rank === 1) return <span className="badge accent" title="The main decision-maker at the company">Main person</span>;
  if (rank === 2) return <span className="badge" title="C-suite or partner">Leadership</span>;
  return null;
}

export function CountryBadge({ geo, match }: { geo: string; match?: string }) {
  const name = geoShort(geo);
  return <span className={`badge ${match === 'match' ? 'accent' : ''}`} title={match === 'match' ? 'Location confirmed' : 'No location on the profile'}>{name}{match === 'match' ? '' : '?'}</span>;
}

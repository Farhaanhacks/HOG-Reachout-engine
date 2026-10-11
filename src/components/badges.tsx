import { marketShort } from '../lib/markets';

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

/** The email's state. Only verified emails are sent, so anything else says so. */
export function EmailBadge({ status, emailStatus }: { status: string; emailStatus?: string }) {
  if ((status === 'matched' || status === 'low_confidence') && emailStatus !== undefined && emailStatus !== 'verified') {
    return <span className="badge warn" title="Only verified emails are sent, to protect the sending domains">Not verified · not sent</span>;
  }
  const [tone, label] = status === 'matched' || status === 'low_confidence' ? ['ok', 'Verified email'] : (EMAIL[status] ?? ['', status]);
  return <span className={`badge ${tone}`}>{label}</span>;
}

/** The person's name, linked to their LinkedIn profile when there is one. */
export function PersonName({ p }: { p: { name: string; linkedin_url: string | null } }) {
  const name = p.name || 'Unnamed';
  return p.linkedin_url ? <a href={p.linkedin_url} target="_blank" rel="noreferrer">{name}</a> : <span>{name}</span>;
}

/** Company size: small (up to 50 employees) or large, from Apollo. */
export function SizeBadge({ size, employees, firmSize }: { size: string; employees: number | null; firmSize?: string }) {
  const count = employees ? `${employees.toLocaleString()} employees` : '';
  if (firmSize === 'small') return <span className="badge" title="Up to 50 employees: Owner, CEO or Founder">{count || 'Small firm'} · small</span>;
  if (firmSize === 'large') return <span className="badge" title="Over 50 employees: Managing Director, President and similar">{count || 'Large firm'} · large</span>;
  if (size === 'fit' || size === 'too_small' || size === 'too_large') return count ? <span className="badge">{count}</span> : null;
  if (size === 'big_enough') return <span className="badge" title="No employee count, but revenue, funding or a listing shows a real company">Established company</span>;
  return null;
}

/** Marks the main person of a company. */
export function RankBadge({ rank }: { rank: number | null | undefined }) {
  if (rank === 1) return <span className="badge accent" title="The main decision-maker at the company">Main person</span>;
  if (rank === 2) return <span className="badge" title="C-suite or partner">Leadership</span>;
  return null;
}

/** Where they are: their country when Apollo gave one, otherwise the market they were found in. */
export function CountryBadge({ geo, match, country }: { geo: string; match?: string; country?: string }) {
  if (country) return <span className="badge accent" title={marketShort(geo)}>{country}</span>;
  const name = marketShort(geo);
  return <span className={`badge ${match === 'match' ? 'accent' : ''}`} title={match === 'match' ? 'Location confirmed' : 'No location on the profile'}>{name}{match === 'match' ? '' : '?'}</span>;
}

/** Whether the person's title is one the rules want at their kind of company. */
export function FitBadge({ fit, note, title }: { fit: boolean | null | undefined; note?: string; title?: string }) {
  if (fit === false) return <span className="badge bad" title={note}>Not the target title</span>;
  if (fit && title) return <span className="badge ok" title="Picked by the title rules for this company's size and industry">Target: {title}</span>;
  return null;
}

export function SuppressedBadge({ reason }: { reason?: string }) {
  return reason ? <span className="badge bad" title="On the suppression list: never contacted">Suppressed · {reason}</span> : null;
}

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

/** Marks the main person of a company. */
export function RankBadge({ rank }: { rank: number | null | undefined }) {
  if (rank === 1) return <span className="badge accent" title="The main decision-maker at the company">Main person</span>;
  if (rank === 2) return <span className="badge" title="C-suite or partner">Leadership</span>;
  return null;
}

export function CountryBadge({ geo, match }: { geo: string; match?: string }) {
  const name = geo === 'ae' ? 'UAE' : geo === 'us' ? 'US' : geo;
  return <span className={`badge ${match === 'match' ? 'accent' : ''}`} title={match === 'match' ? 'Location confirmed' : 'No location on the profile'}>{name}{match === 'match' ? '' : '?'}</span>;
}

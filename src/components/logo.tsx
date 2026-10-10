/** A globe mark in the accent blue. */
export function Logo() {
  return (
    <svg className="logo" viewBox="0 0 32 32" aria-hidden="true">
      <circle cx="16" cy="16" r="13" fill="#4a84e2" />
      <g fill="none" stroke="#dbe7fb" strokeWidth="1.6">
        <circle cx="16" cy="16" r="13" />
        <ellipse cx="16" cy="16" rx="5.5" ry="13" />
        <path d="M3.5 12h25M3.5 20h25" />
      </g>
    </svg>
  );
}

export function Wordmark() {
  return (
    <div className="wordmark">
      <Logo />
      <b>Humans of Globe</b>
      <span>Lead Engine</span>
    </div>
  );
}

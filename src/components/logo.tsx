/* eslint-disable @next/next/no-img-element -- a small static logo; next/image adds nothing here */

/** The Humans of Globe logo in white, for the dark app (public/logo-white.png; a black version is public/logo-black.png). */
export function Logo() {
  return <img className="logo" src="/logo-white.png" alt="Humans of Globe" width={247} height={94} />;
}

export function Wordmark() {
  return (
    <div className="wordmark">
      <Logo />
      <span>Lead Engine</span>
    </div>
  );
}

'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const LINKS = [
  { href: '/', label: 'Overview' },
  { href: '/run', label: 'Find leads' },
  { href: '/leads', label: 'Leads' },
  { href: '/emails', label: 'Emails (Apollo)' },
  { href: '/tools', label: 'Tools' },
];

export function Nav() {
  const path = usePathname();
  const active = (href: string) => (href === '/' ? path === '/' : path === href || path.startsWith(`${href}/`) || (href === '/tools' && path.startsWith('/steps')));

  async function logout() {
    await fetch('/api/session', { method: 'DELETE' }).catch(() => {});
    window.location.href = '/';
  }

  return (
    <>
      <nav className="nav" aria-label="Sections">
        {LINKS.map((l) => (
          <Link key={l.href} href={l.href} className={active(l.href) ? 'active' : ''}>
            {l.label}
          </Link>
        ))}
      </nav>
      <div className="side-foot">
        <button className="link small" onClick={logout}>Log out</button>
      </div>
    </>
  );
}

import type { ReactNode } from 'react';
import './globals.css';
import { AuthGate } from '../components/auth-gate';
import { Nav } from '../components/nav';

export const metadata = { title: 'Humans of Globe Lead Engine' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="shell">
          <aside className="side">
            <div className="brand">
              <b>Humans of Globe</b>
              <span>Lead engine</span>
            </div>
            <Nav />
          </aside>
          <main className="main">
            <AuthGate>{children}</AuthGate>
          </main>
        </div>
      </body>
    </html>
  );
}

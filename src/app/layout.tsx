import type { ReactNode } from 'react';
import './globals.css';
import { AuthGate } from '../components/auth-gate';
import { Wordmark } from '../components/logo';
import { Nav } from '../components/nav';

export const metadata = { title: 'Humans of Globe Lead Engine' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <AuthGate>
          <div className="shell">
            <aside className="side">
              <Wordmark />
              <Nav />
            </aside>
            <main className="main">{children}</main>
          </div>
        </AuthGate>
      </body>
    </html>
  );
}

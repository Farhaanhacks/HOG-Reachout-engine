import type { ReactNode } from 'react';

export const metadata = { title: 'Humans of Globe Lead Engine' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: 'system-ui, sans-serif', margin: 0, padding: '32px 16px', background: '#f5f7f8', color: '#13222d' }}>
        <main style={{ maxWidth: 880, margin: '0 auto' }}>{children}</main>
      </body>
    </html>
  );
}

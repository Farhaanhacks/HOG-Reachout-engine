import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // The public unsubscribe link in every email: a short address for the API route that serves the page.
  async rewrites() {
    return [{ source: '/unsubscribe', destination: '/api/unsubscribe' }];
  },
};

export default nextConfig;

import { NextResponse } from 'next/server';

export const dynamic = 'force-dynamic';

/** Which settings the server sees. Shows only whether each is set, never a value. */
export function GET() {
  const set = (name: string) => Boolean(process.env[name]);
  return NextResponse.json({
    vercelEnv: process.env.VERCEL_ENV ?? 'not on Vercel',
    commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? '',
    APP_PASSWORD: set('APP_PASSWORD'),
    SERPER_API_KEY: set('SERPER_API_KEY'),
    JINA_API_KEY: set('JINA_API_KEY'),
    DEEPSEEK_API_KEY: set('DEEPSEEK_API_KEY'),
  });
}

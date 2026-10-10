import { NextResponse } from 'next/server';
import { getDb } from '../../../lib/db';

export const dynamic = 'force-dynamic';

/** Which settings the server sees, and whether the database answers. Shows only yes/no, never a value. */
export async function GET() {
  const set = (name: string) => Boolean(process.env[name]);
  let database = 'not set';
  if (set('DATABASE_URL') || set('POSTGRES_URL')) {
    try {
      await getDb().query('SELECT 1');
      database = 'ok';
    } catch (e) {
      const code = (e as { code?: string })?.code;
      database = `failed${code ? ` (${code})` : ''}`;
    }
  }
  return NextResponse.json({
    vercelEnv: process.env.VERCEL_ENV ?? 'not on Vercel',
    commit: process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) ?? '',
    APP_PASSWORD: set('APP_PASSWORD'),
    SERPER_API_KEY: set('SERPER_API_KEY'),
    JINA_API_KEY: set('JINA_API_KEY'),
    DEEPSEEK_API_KEY: set('DEEPSEEK_API_KEY'),
    APOLLO_API_KEY: set('APOLLO_API_KEY'),
    database,
  });
}

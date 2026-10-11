import { ensureSchema, type Db } from './store';
import { DEFAULT_EDITIONS, DEFAULT_RULES, cleanEditions, cleanRules, type Edition, type TitleRules } from './targeting';

/**
 * Settings the team changes on the site (kept in the database, so a change needs no redeploy): the title rules, the
 * edition table, and how many emails each person gets in the sequence (used to turn an inbox's daily email limit into how
 * many new people it can start each day).
 */
export type Settings = { rules: TitleRules; editions: Edition[]; emailsPerPerson: number };

export const DEFAULT_SETTINGS: Settings = { rules: DEFAULT_RULES, editions: DEFAULT_EDITIONS, emailsPerPerson: 3 };

export function cleanEmailsPerPerson(v: unknown): number {
  return Math.max(1, Math.min(10, Math.round(Number(v)) || DEFAULT_SETTINGS.emailsPerPerson));
}

async function read(db: Db, key: string): Promise<unknown> {
  const [row] = await db.query<{ value: string }>('SELECT value FROM settings WHERE key = $1', [key]);
  if (!row) return undefined;
  try {
    return JSON.parse(row.value);
  } catch {
    return undefined;
  }
}

export async function getSetting<T>(db: Db, key: string, fallback: T): Promise<T> {
  await ensureSchema(db);
  const v = await read(db, key);
  return v === undefined ? fallback : (v as T);
}

export async function setSetting(db: Db, key: string, value: unknown): Promise<void> {
  await ensureSchema(db);
  await db.query(
    `INSERT INTO settings (key, value, updated_at) VALUES ($1, $2, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [key, JSON.stringify(value)],
  );
}

export async function getSettings(db: Db): Promise<Settings> {
  await ensureSchema(db);
  const [rules, editions, emailsPerPerson] = await Promise.all([read(db, 'rules'), read(db, 'editions'), read(db, 'emailsPerPerson')]);
  return {
    rules: rules === undefined ? DEFAULT_RULES : cleanRules(rules),
    editions: editions === undefined ? DEFAULT_EDITIONS : cleanEditions(editions),
    emailsPerPerson: emailsPerPerson === undefined ? DEFAULT_SETTINGS.emailsPerPerson : cleanEmailsPerPerson(emailsPerPerson),
  };
}

/** Saves whichever settings are given, cleaned. `reset` puts one back to its default. */
export async function saveSettings(db: Db, input: Partial<Record<keyof Settings, unknown>> & { reset?: keyof Settings }): Promise<Settings> {
  await ensureSchema(db);
  if (input.reset) await db.query('DELETE FROM settings WHERE key = $1', [input.reset]);
  if (input.rules !== undefined) await setSetting(db, 'rules', cleanRules(input.rules));
  if (input.editions !== undefined) await setSetting(db, 'editions', cleanEditions(input.editions));
  if (input.emailsPerPerson !== undefined) await setSetting(db, 'emailsPerPerson', cleanEmailsPerPerson(input.emailsPerPerson));
  return getSettings(db);
}

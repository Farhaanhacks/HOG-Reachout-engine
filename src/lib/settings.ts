import { isBrand, type Brand } from './brands';
import { UNSUBSCRIBE_STYLES, type UnsubscribeStyle } from './pitch';
import { ensureSchema, type Db } from './store';
import { DEFAULT_EDITIONS, DEFAULT_RULES, cleanEditions, cleanRules, type Edition, type TitleRules } from './targeting';

/**
 * Settings the team changes on the site (kept in the database, so a change needs no redeploy): the title rules, the
 * edition table, and how many emails each person gets in the sequence (used to turn an inbox's daily email limit into how
 * many new people it can start each day), and how the email lets people opt out.
 */
export type Settings = {
  rules: TitleRules;
  editions: Edition[];
  emailsPerPerson: number;
  unsubscribeStyle: UnsubscribeStyle;
  /** Each brand's Apollo sequence, used by Run workflow and the Outreach page. */
  sequences: Partial<Record<Brand, string>>;
};

export const DEFAULT_SETTINGS: Settings = { rules: DEFAULT_RULES, editions: DEFAULT_EDITIONS, emailsPerPerson: 3, unsubscribeStyle: 'button', sequences: {} };

export function cleanSequences(v: unknown): Partial<Record<Brand, string>> {
  const out: Partial<Record<Brand, string>> = {};
  for (const [k, id] of Object.entries((v ?? {}) as Record<string, unknown>)) if (isBrand(k) && typeof id === 'string' && /^[\w-]{0,64}$/.test(id)) out[k] = id;
  return out;
}

export function cleanUnsubscribeStyle(v: unknown): UnsubscribeStyle {
  return UNSUBSCRIBE_STYLES.find((s) => s === v) ?? DEFAULT_SETTINGS.unsubscribeStyle;
}

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
  const [rules, editions, emailsPerPerson, unsubscribeStyle, sequences] = await Promise.all([
    read(db, 'rules'),
    read(db, 'editions'),
    read(db, 'emailsPerPerson'),
    read(db, 'unsubscribeStyle'),
    read(db, 'sequences'),
  ]);
  return {
    rules: rules === undefined ? DEFAULT_RULES : cleanRules(rules),
    editions: editions === undefined ? DEFAULT_EDITIONS : cleanEditions(editions),
    emailsPerPerson: emailsPerPerson === undefined ? DEFAULT_SETTINGS.emailsPerPerson : cleanEmailsPerPerson(emailsPerPerson),
    unsubscribeStyle: cleanUnsubscribeStyle(unsubscribeStyle),
    sequences: cleanSequences(sequences),
  };
}

/** Saves whichever settings are given, cleaned. `reset` puts one back to its default. */
export async function saveSettings(db: Db, input: Partial<Record<keyof Settings, unknown>> & { reset?: keyof Settings }): Promise<Settings> {
  await ensureSchema(db);
  if (input.reset) await db.query('DELETE FROM settings WHERE key = $1', [input.reset]);
  if (input.rules !== undefined) await setSetting(db, 'rules', cleanRules(input.rules));
  if (input.editions !== undefined) await setSetting(db, 'editions', cleanEditions(input.editions));
  if (input.emailsPerPerson !== undefined) await setSetting(db, 'emailsPerPerson', cleanEmailsPerPerson(input.emailsPerPerson));
  if (input.unsubscribeStyle !== undefined) await setSetting(db, 'unsubscribeStyle', cleanUnsubscribeStyle(input.unsubscribeStyle));
  // One brand's sequence can be changed without touching the others.
  if (input.sequences !== undefined) await setSetting(db, 'sequences', { ...(await getSettings(db)).sequences, ...cleanSequences(input.sequences) });
  return getSettings(db);
}

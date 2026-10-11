import { CUSTOM_FIELDS } from './pitch';
import { getJson, type Services } from './services';

/**
 * Sending through Apollo sequences: list the team's sequences and mailboxes, create each lead as an Apollo contact
 * (with their personal subject, opener and unsubscribe link in custom fields), add them to a sequence, and stop them
 * when they unsubscribe. None of these calls spends Apollo credits. Adding to and stopping sequences needs a master key.
 */

const BASE = 'https://api.apollo.io/api/v1';

function headers(svc: Services): Record<string, string> {
  const key = svc.keys.apollo;
  if (!key) throw new Error('APOLLO_API_KEY is not set');
  return { 'x-api-key': key, 'content-type': 'application/json', accept: 'application/json', 'cache-control': 'no-cache' };
}

/** Query string with repeated array keys, as Apollo expects: contact_ids[]=a&contact_ids[]=b. */
function query(params: Record<string, string | boolean | string[]>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (Array.isArray(v)) for (const item of v) parts.push(`${encodeURIComponent(`${k}[]`)}=${encodeURIComponent(item)}`);
    else parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  return parts.join('&');
}

export type Sequence = { id: string; name: string; active: boolean; archived: boolean };

/** The team's sequences (up to 500), skipping archived ones. */
export async function listSequences(svc: Services): Promise<Sequence[]> {
  const out: Sequence[] = [];
  for (let page = 1; page <= 5; page++) {
    const res = await getJson<{ emailer_campaigns?: { id: string; name?: string; active?: boolean; archived?: boolean }[]; pagination?: { total_pages?: number } }>(
      svc,
      `${BASE}/emailer_campaigns/search?${query({ per_page: '100', page: String(page) })}`,
      { method: 'POST', headers: headers(svc), body: '{}' },
    );
    for (const c of res.emailer_campaigns ?? []) {
      if (!c.archived) out.push({ id: String(c.id), name: String(c.name ?? ''), active: !!c.active, archived: !!c.archived });
    }
    if (!res.pagination?.total_pages || page >= res.pagination.total_pages) break;
  }
  return out;
}

export type EmailAccount = { id: string; email: string; active: boolean; isDefault: boolean };

/** The mailboxes connected to Apollo that can send. */
export async function listEmailAccounts(svc: Services): Promise<EmailAccount[]> {
  const res = await getJson<{ email_accounts?: { id: string; email?: string; active?: boolean; default?: boolean }[] }>(svc, `${BASE}/email_accounts`, { headers: headers(svc) });
  return (res.email_accounts ?? []).map((a) => ({ id: String(a.id), email: String(a.email ?? ''), active: a.active !== false, isDefault: !!a.default }));
}

export type FieldIds = Partial<Record<keyof typeof CUSTOM_FIELDS, string>>;

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

/** Finds the ids of the custom contact fields (see CUSTOM_FIELDS) by name. Missing ones are left undefined. */
export async function findCustomFields(svc: Services): Promise<FieldIds> {
  const res = await getJson<{ typed_custom_fields?: { id: string; name?: string; modality?: string }[] }>(svc, `${BASE}/typed_custom_fields`, { headers: headers(svc) });
  const fields = (res.typed_custom_fields ?? []).filter((f) => !f.modality || f.modality === 'contact');
  const idOf = (name: string) => fields.find((f) => norm(f.name ?? '') === norm(name))?.id;
  const ids: FieldIds = {};
  for (const k of Object.keys(CUSTOM_FIELDS) as (keyof typeof CUSTOM_FIELDS)[]) ids[k] = idOf(CUSTOM_FIELDS[k]);
  return ids;
}

/** The custom fields still to be created in Apollo, by name. */
export function missingFields(ids: FieldIds): string[] {
  return (Object.keys(CUSTOM_FIELDS) as (keyof typeof CUSTOM_FIELDS)[]).filter((k) => !ids[k]).map((k) => CUSTOM_FIELDS[k]);
}

export type ApolloContactInput = {
  email: string;
  first_name?: string;
  last_name?: string;
  organization_name?: string;
  title?: string;
  label_names: string[];
  typed_custom_fields: Record<string, string>;
};

/**
 * Creates the person as an Apollo contact, or updates the existing contact with the same email (run_dedupe), so their
 * custom fields always hold the latest subject, opener and unsubscribe link. Returns the contact id.
 */
export async function createContact(svc: Services, input: ApolloContactInput): Promise<string> {
  const res = await getJson<{ contact?: { id?: string } }>(svc, `${BASE}/contacts`, {
    method: 'POST',
    headers: headers(svc),
    body: JSON.stringify({ ...input, run_dedupe: true }),
  });
  const id = res.contact?.id;
  if (!id) throw new Error('Apollo did not return a contact id');
  return String(id);
}

export type SequenceAddResult = {
  /** Contact ids Apollo added to the sequence. */
  added: string[];
  /** Contact id to Apollo's reason for skipping it (e.g. already in another sequence). */
  skipped: Record<string, string>;
};

/**
 * Adds contacts to a sequence, sending from one mailbox. Only verified emails are sequenced (bounces burn the sending
 * domains). People active or finished in another sequence are skipped, so nobody is emailed twice.
 */
export async function addToSequence(svc: Services, sequenceId: string, contactIds: string[], emailAccountId: string, opts: { allowUnverified?: boolean } = {}): Promise<SequenceAddResult> {
  if (!sequenceId) throw new Error('Choose an Apollo sequence first.');
  if (!emailAccountId) throw new Error('Choose the mailbox to send from first.');
  const res = await getJson<{ contacts?: { id: string }[]; skipped_contact_ids?: Record<string, string> }>(
    svc,
    `${BASE}/emailer_campaigns/${encodeURIComponent(sequenceId)}/add_contact_ids?${query({
      emailer_campaign_id: sequenceId,
      contact_ids: contactIds,
      send_email_from_email_account_id: emailAccountId,
      // Only the team's own test address is allowed through unverified.
      sequence_unverified_email: !!opts.allowUnverified,
      sequence_active_in_other_campaigns: false,
      sequence_finished_in_other_campaigns: false,
    })}`,
    { method: 'POST', headers: headers(svc) },
  );
  const skipped = res.skipped_contact_ids ?? {};
  const added = (res.contacts ?? []).map((c) => String(c.id)).filter((id) => !(id in skipped));
  return { added, skipped };
}

/** Stops contacts in sequences (used when someone unsubscribes). */
export async function stopInSequences(svc: Services, sequenceIds: string[], contactIds: string[]): Promise<void> {
  await getJson(svc, `${BASE}/emailer_campaigns/remove_or_stop_contact_ids?${query({ emailer_campaign_ids: sequenceIds, contact_ids: contactIds, mode: 'stop' })}`, {
    method: 'POST',
    headers: headers(svc),
  });
}

/** Apollo's skip codes in plain words: "contacts_without_email" gives "contacts without email". */
export function skipReason(code: string): string {
  return code.replace(/_/g, ' ');
}

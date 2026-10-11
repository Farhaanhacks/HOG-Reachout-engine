import { NextResponse } from 'next/server';
import { checkPassword } from '../../../../lib/auth';
import { toCsv } from '../../../../lib/csv';
import { getDb } from '../../../../lib/db';
import { marketShort } from '../../../../lib/markets';
import { filtersFrom } from '../../../../lib/lead-filters';
import { draftEmail, unsubscribeLine } from '../../../../lib/pitch';
import { unsubscribeUrl } from '../../../../lib/unsubscribe';
import { getSettings } from '../../../../lib/settings';
import { listPeople } from '../../../../lib/store';
import { editionFor } from '../../../../lib/targeting';

export const dynamic = 'force-dynamic';

/** The leads shown on the Leads page, as a spreadsheet file (up to 1,000 rows). */
export async function GET(req: Request) {
  const denied = checkPassword(req);
  if (denied) return denied;
  try {
    const db = getDb();
    const { editions, unsubscribeStyle } = await getSettings(db);
    const people = await listPeople(db, { ...filtersFrom(new URL(req.url)), limit: 1000 });
    const csv = toCsv(
      [
        'Name', 'First name', 'Designation', 'Company', 'Company website', 'LinkedIn', 'Email', 'Email status', 'Employees', 'Company size', 'Industry',
        'Country', 'Market', 'Target title', 'Fits the title rules', 'Segment', 'Edition', 'Suppressed', 'Sent from', 'Personal opener', 'Email subject',
        'Email body', 'Unsubscribe link', 'Unsubscribed', 'First seen',
      ],
      people.map((p) => {
        const e = editionFor(p.industry, editions);
        const d = draftEmail({ ...p, edition: e.edition, industryLine: e.industryLine });
        return [
          p.name, d.firstName, p.title, p.company, p.company_website ?? '', p.linkedin_url ?? '', p.email, p.email_status, p.company_employees ?? '',
          p.firm_size || p.company_size, p.industry ?? '', p.country || p.location, marketShort(p.geo), p.target_title ?? '',
          p.icp_fit === false ? 'no' : p.icp_fit ? 'yes' : '', p.segment ?? '', e.edition, p.suppressed_reason ?? '', p.sent_from_email ?? '', p.opener ?? '',
          d.subject, `${d.body}\n\n${unsubscribeLine(unsubscribeStyle, unsubscribeUrl(p.id))}`, unsubscribeUrl(p.id), p.unsubscribed_at ? 'yes' : '', p.first_seen,
        ];
      }),
    );
    return new Response(csv, {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="hog-leads-${new Date().toISOString().slice(0, 10)}.csv"`,
      },
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}

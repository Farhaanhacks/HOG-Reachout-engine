import { NextResponse } from 'next/server';
import { checkPassword } from '../../../../lib/auth';
import { toCsv } from '../../../../lib/csv';
import { getDb } from '../../../../lib/db';
import { geoShort } from '../../../../lib/geo';
import { filtersFrom } from '../../../../lib/lead-filters';
import { draftEmail } from '../../../../lib/pitch';
import { listPeople } from '../../../../lib/store';

export const dynamic = 'force-dynamic';

/** The leads shown on the Leads page, as a spreadsheet file (up to 1,000 rows). */
export async function GET(req: Request) {
  const denied = checkPassword(req);
  if (denied) return denied;
  try {
    const people = await listPeople(getDb(), { ...filtersFrom(new URL(req.url)), limit: 1000 });
    const csv = toCsv(
      ['Name', 'First name', 'Title', 'Company', 'Location', 'Country', 'Labels', 'LinkedIn', 'Email', 'Email status', 'Apollo result', 'Apollo confidence', 'Employees', 'Company size', 'Email subject', 'Email body', 'First seen'],
      people.map((p) => {
        const d = draftEmail(p);
        return [p.name, d.firstName, p.title, p.company, p.location, geoShort(p.geo), p.labels, p.linkedin_url, p.email, p.email_status, p.apollo_status, p.apollo_confidence, p.company_employees ?? '', p.company_size, d.subject, d.body, p.first_seen];
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

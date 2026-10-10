import Link from 'next/link';

// The build steps (see PLAN.md). Each page runs one piece on its own, which is how to find where something breaks.
const STEPS = [
  { href: '/steps/1', title: 'Step 1: Search one query', what: 'Raw Google results from Serper for one country.' },
  { href: '/steps/2', title: 'Step 2: Query builder', what: 'The searches a brief turns into. Spends nothing.' },
  { href: '/steps/3', title: 'Step 3: Read people from results', what: 'Name, title, company, location and country check for one search.' },
  { href: '/steps/4', title: 'Step 4: Seniority tags', what: 'How job titles are labelled. Spends nothing.' },
  { href: '/steps/5', title: 'Step 5: Company website', what: "Finds a company's own domain." },
  { href: '/steps/6', title: 'Step 6: Search and save', what: 'One search saved to the database, each LinkedIn profile once.' },
  { href: '/steps/9', title: 'Step 9: Apollo', what: 'The raw Apollo lookup page.' },
];

export default function ToolsPage() {
  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Tools</h1>
          <p className="sub">Each build step on its own, for testing and for finding where a problem is. Day-to-day work happens in Find leads, Leads and Emails.</p>
        </div>
      </div>
      <section className="card">
        <div className="table-wrap">
          <table>
            <tbody>
              {STEPS.map((s) => (
                <tr key={s.href}><td><Link href={s.href}>{s.title}</Link></td><td className="muted">{s.what}</td></tr>
              ))}
              <tr><td><a href="/api/health">Health check</a></td><td className="muted">Which keys the server sees and whether the database answers.</td></tr>
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

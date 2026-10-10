import Link from 'next/link';

// One row per build step (see PLAN.md). A step's page runs only that step, so a failure points at it.
const STEPS = [
  { n: 1, title: 'Serper search by country', href: '/steps/1', built: true },
  { n: 2, title: 'Query builder', href: '/steps/2', built: true },
  { n: 3, title: 'LinkedIn snippet parser', href: '/steps/3', built: true },
  { n: 4, title: 'Title normaliser and seniority tag', href: '/steps/4', built: true },
  { n: 5, title: 'Company domain resolver', href: '/steps/5', built: true },
  { n: 6, title: 'Dedupe and store', href: '/steps/6', built: true },
  { n: 7, title: 'Full run with cost log', href: '', built: false },
  { n: 8, title: 'Review screen and CSV export', href: '', built: false },
  { n: 9, title: 'Apollo emails', href: '/steps/9', built: true },
];

export default function Home() {
  return (
    <>
      <h1>Humans of Globe Lead Engine</h1>
      <p>Each step has its own page. Run them in order.</p>
      <ol>
        {STEPS.map((s) => (
          <li key={s.n} style={{ margin: '8px 0' }}>
            {s.built ? <Link href={s.href}>{s.title}</Link> : <span style={{ color: '#888' }}>{s.title} (not built yet)</span>}
          </li>
        ))}
      </ol>
    </>
  );
}

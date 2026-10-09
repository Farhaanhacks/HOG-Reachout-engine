import { isGeo } from '../src/lib/geo';
import { googleSearch, keysFromEnv } from '../src/lib/services';

// Usage: npm run step:1 -- "site:linkedin.com/in founder Dubai" ae
const [query, geo = 'ae'] = process.argv.slice(2);
if (!query || !isGeo(geo)) {
  console.error('Usage: npm run step:1 -- "<query>" <ae|us>');
  process.exit(1);
}

const svc = { fetch, keys: keysFromEnv() };
const results = await googleSearch(svc, query, geo);
console.log(`${results.length} results for "${query}" (${geo})\n`);
for (const r of results) console.log(`- ${r.title}\n  ${r.link}\n  ${r.subtitle ?? ''} ${r.snippet ?? ''}\n`);

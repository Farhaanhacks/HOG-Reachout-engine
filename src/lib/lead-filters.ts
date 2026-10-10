import { isGeo } from './geo';
import type { ListOptions } from './store';

/** Leads filters from the address (geo, targets=1, ready=1, q), shared by the Leads list and its CSV export. */
export function filtersFrom(url: URL): ListOptions {
  const geo = url.searchParams.get('geo') ?? '';
  return {
    geo: isGeo(geo) ? geo : undefined,
    targetOnly: url.searchParams.get('targets') === '1',
    ready: url.searchParams.get('ready') === '1',
    topOnly: url.searchParams.get('top') === '1',
    q: url.searchParams.get('q') ?? '',
  };
}

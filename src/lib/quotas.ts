import { BRAND_LIST, BRANDS, type Brand, type Quotas } from './brands';
import type { Market } from './markets';

/**
 * How a run's leads are shared out, as cells of one magazine (brand) in one region: each brand's share of the run
 * (35/30/35) is split equally between its regions, so Humans of Globe gets as many Gulf as US, European and African leads,
 * and CIO Minds as many US as European and Singapore leads. On top of that each lane (each ICP, and Africa) may take only
 * its cap, so the ICPs share every run equally.
 *
 * When a region has no searches left in the run, its unfilled share moves to the same brand's other regions, equally, so
 * a small pool such as Singapore never leaves the run short; a lane that runs dry passes on only what the run would
 * otherwise be short of, so the ICPs stay equal whenever the searches allow. Everything here is
 * worked out from the quotas, what has been found so far and the searches still to come, so nothing extra is stored.
 */

export type CellKey = `${Brand}:${Market}`;
export const cellKey = (b: Brand, m: Market): CellKey => `${b}:${m}`;

/** Splits n into `parts` near-equal whole numbers; the extra ones go to the parts starting at `offset`. */
export function splitEqually(n: number, parts: number, offset = 0): number[] {
  if (parts <= 0) return [];
  const base = Math.floor(n / parts);
  const extra = n - base * parts;
  return Array.from({ length: parts }, (_, i) => {
    const position = (((i - offset) % parts) + parts) % parts;
    return position < extra ? base + 1 : base;
  });
}

/**
 * Each brand's quota split equally between its regions that the run searches. A brand none of whose regions is searched
 * gets no cells (its share cannot be found in this run). `offset` rotates which regions get the odd extra lead, so over
 * many runs no region is favoured.
 */
export function regionQuotas(quotas: Quotas, markets: Market[], offset = 0): Record<CellKey, number> {
  const out = {} as Record<CellKey, number>;
  for (const b of BRAND_LIST) {
    const regions = BRANDS[b].regions.filter((m) => markets.includes(m));
    splitEqually(quotas[b], regions.length, offset).forEach((n, i) => {
      out[cellKey(b, regions[i])] = n;
    });
  }
  return out;
}

/** Gives `n` more to the keys in `keys`, one at a time, each to the one with the least `have` so far. */
function shareOut(n: number, keys: string[], have: (k: string) => number, into: Record<string, number>): void {
  if (!keys.length) return;
  for (let i = 0; i < n; i++) {
    const k = [...keys].sort((a, b) => have(a) + (into[a] ?? 0) - (have(b) + (into[b] ?? 0)) || keys.indexOf(a) - keys.indexOf(b))[0];
    into[k] = (into[k] ?? 0) + 1;
  }
}

export type Needs = {
  /** How many more leads each cell (brand:region) should take now. */
  cells: Record<string, number>;
  /** How many more each lane may take now; null when the run has no lane caps. */
  lanes: Record<string, number> | null;
  /** Total still to find: the sum of the cells. 0 means the run has found all it can. */
  left: number;
};

/**
 * What a run still needs, given its quotas, what it has found and the searches still to come (`remaining`, in order).
 *  1. Lanes: each may take its cap minus what it found. A lane with no useful searches left passes its unused cap on to
 *     the lanes still searching, equally, but only as much as the run would otherwise fall short by.
 *  2. Cells: a region is still searchable when a search of it remains in a lane that may still take leads. Each brand's
 *     remaining total (its quota minus all it found) is spread over its searchable regions, topping up the ones that have
 *     found the least, so the regions stay as equal as the searches allow.
 */
export function needs(args: {
  regions: Record<string, number>;
  regionReady: Record<string, number>;
  lanes?: Record<string, number>;
  laneReady: Record<string, number>;
  remaining: { lane?: string; market: Market }[];
}): Needs {
  const { regionReady, laneReady, remaining } = args;
  const caps = args.lanes;
  if (!caps) return { ...cellNeeds(args.regions, regionReady, remaining, null), lanes: null };

  // A lane is useful while one of its remaining searches is in a region that still needs leads. Lanes that are not can
  // pass their unused cap on, but only when the useful lanes' own room would leave the run short; that can close regions
  // and so more lanes, so this repeats until it settles (it only ever closes lanes, so it always ends).
  const keys = Object.keys(caps);
  let alive = keys.filter((k) => remaining.some((q) => q.lane === k));
  for (let round = 0; ; round++) {
    const lanes: Record<string, number> = {};
    let spare = 0;
    for (const k of keys) {
      const left = Math.max(0, caps[k] - (laneReady[k] ?? 0));
      if (alive.includes(k)) lanes[k] = left;
      else {
        lanes[k] = 0;
        spare += left;
      }
    }
    // Only as much as the run would otherwise fall short by, so the ICPs stay equal whenever their own caps suffice.
    const room = Object.values(lanes).reduce((n, v) => n + v, 0);
    const short = Math.max(0, cellNeeds(args.regions, regionReady, remaining, lanes).left - room);
    shareOut(Math.min(spare, short), alive, (k) => laneReady[k] ?? 0, lanes);
    const result = cellNeeds(args.regions, regionReady, remaining, lanes);
    const regionNeeds = (m: Market) => Object.entries(result.cells).some(([c, n]) => n > 0 && c.endsWith(`:${m}`));
    const useful = alive.filter((k) => remaining.some((q) => q.lane === k && regionNeeds(q.market)));
    if (useful.length === alive.length || round >= keys.length) return { ...result, lanes };
    alive = useful;
  }
}

/** The cells part of `needs`, for given lane room (null: no lane caps). */
function cellNeeds(
  regions: Record<string, number>,
  regionReady: Record<string, number>,
  remaining: { lane?: string; market: Market }[],
  lanes: Record<string, number> | null,
): { cells: Record<string, number>; left: number } {
  const searchable = (m: Market) => remaining.some((q) => q.market === m && (!lanes || !q.lane || (lanes[q.lane] ?? 0) > 0));
  const cells: Record<string, number> = {};
  for (const b of BRAND_LIST) {
    const own = Object.keys(regions).filter((k) => k.startsWith(`${b}:`));
    if (!own.length) continue;
    const quota = own.reduce((n, k) => n + regions[k], 0);
    const found = own.reduce((n, k) => n + (regionReady[k] ?? 0), 0);
    let left = Math.max(0, quota - found);
    for (const k of own) cells[k] = 0;
    const open = own.filter((k) => searchable(k.slice(b.length + 1) as Market));
    // First each open region's own shortfall, the regions that have found least first, while the brand still needs any…
    const byFound = [...open].sort((x, y) => (regionReady[x] ?? 0) - (regionReady[y] ?? 0) || own.indexOf(x) - own.indexOf(y));
    for (const k of byFound) {
      const n = Math.min(left, Math.max(0, regions[k] - (regionReady[k] ?? 0)));
      cells[k] = n;
      left -= n;
    }
    // …then what the closed regions could not find, shared out to keep the open ones level.
    shareOut(left, byFound, (k) => regionReady[k] ?? 0, cells);
  }
  return { cells, left: Object.values(cells).reduce((n, v) => n + v, 0) };
}

/** What each brand still needs in a region, for picking a lead's brand. */
export function needIn(cells: Record<string, number>, market: Market): Partial<Quotas> {
  const out: Partial<Quotas> = {};
  for (const b of BRAND_LIST) if (cellKey(b, market) in cells) out[b] = cells[cellKey(b, market)];
  return out;
}

import { describe, expect, it } from 'vitest';
import { quotasFor } from '../src/lib/brands';
import { laneCaps } from '../src/lib/icps';
import type { Market } from '../src/lib/markets';
import { needIn, needs, regionQuotas, splitEqually } from '../src/lib/quotas';

const ALL: Market[] = ['gcc', 'eu', 'us', 'sg', 'af'];
const q = (market: Market, lane?: string) => ({ market, lane });

describe('splitEqually', () => {
  it('splits into near-equal whole numbers and rotates who gets the extra', () => {
    expect(splitEqually(9, 4)).toEqual([3, 2, 2, 2]);
    expect(splitEqually(9, 4, 1)).toEqual([2, 3, 2, 2]);
    expect(splitEqually(10, 3, 2)).toEqual([3, 3, 4]);
    expect(splitEqually(0, 3)).toEqual([0, 0, 0]);
    expect(splitEqually(5, 0)).toEqual([]);
    for (let n = 0; n < 40; n++) for (let p = 1; p < 6; p++) for (let o = 0; o < 6; o++) {
      const s = splitEqually(n, p, o);
      expect(s.reduce((a, b) => a + b, 0)).toBe(n);
      expect(Math.max(...s) - Math.min(...s)).toBeLessThanOrEqual(1);
    }
  });
});

describe('regionQuotas', () => {
  it("splits each magazine's share equally between its regions", () => {
    expect(regionQuotas(quotasFor(30), ALL)).toEqual({
      'gulficons:gcc': 11,
      'hog:gcc': 3, 'hog:us': 2, 'hog:eu': 2, 'hog:af': 2,
      'ciominds:us': 4, 'ciominds:eu': 3, 'ciominds:sg': 3,
    });
  });

  it('only splits over the regions the run searches', () => {
    expect(regionQuotas(quotasFor(10), ['af'])).toEqual({ 'hog:af': 3 });
    expect(regionQuotas(quotasFor(10), ['gcc', 'us'])).toEqual({ 'gulficons:gcc': 4, 'hog:gcc': 2, 'hog:us': 1, 'ciominds:us': 3 });
  });

  it('always adds up to each brand quota', () => {
    for (let t = 1; t <= 120; t++) {
      const quotas = quotasFor(t);
      const cells = regionQuotas(quotas, ALL, t);
      for (const b of ['gulficons', 'hog', 'ciominds'] as const) {
        const own = Object.entries(cells).filter(([k]) => k.startsWith(`${b}:`)).map(([, n]) => n);
        expect(own.reduce((a, c) => a + c, 0)).toBe(quotas[b]);
        expect(Math.max(...own) - Math.min(...own)).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('needs', () => {
  const regions = regionQuotas(quotasFor(30), ALL);
  const everywhere = ALL.map((m) => q(m, 'x'));

  it('is the quotas minus what was found while every region can still be searched', () => {
    const n = needs({ regions, regionReady: { 'hog:us': 2, 'ciominds:sg': 1 }, laneReady: {}, remaining: everywhere });
    expect(n.cells).toMatchObject({ 'hog:us': 0, 'hog:gcc': 3, 'ciominds:sg': 2, 'gulficons:gcc': 11 });
    expect(n.left).toBe(30 - 3);
    expect(n.lanes).toBeNull();
  });

  it("moves a region's share to the brand's other regions, equally, once it has no searches left", () => {
    const remaining = everywhere.filter((x) => x.market !== 'sg');
    const n = needs({ regions, regionReady: {}, laneReady: {}, remaining });
    expect(n.cells['ciominds:sg']).toBe(0);
    expect(n.cells['ciominds:us'] + n.cells['ciominds:eu']).toBe(10);
    expect(Math.abs(n.cells['ciominds:us'] - n.cells['ciominds:eu'])).toBeLessThanOrEqual(1);
    expect(n.left).toBe(30);
  });

  it('keeps the regions level when topping up, counting what each has found', () => {
    const remaining = everywhere.filter((x) => x.market !== 'af');
    // Humans of Globe: 9 wanted; Africa closed; GCC has found 3 (its share), the US and Europe none.
    const n = needs({ regions, regionReady: { 'hog:gcc': 3 }, laneReady: {}, remaining });
    expect([n.cells['hog:gcc'], n.cells['hog:us'], n.cells['hog:eu'], n.cells['hog:af']]).toEqual([0, 3, 3, 0]);
  });

  it('never asks a brand for more than its quota, even when a region found more than its share', () => {
    const n = needs({ regions, regionReady: { 'hog:us': 8 }, laneReady: {}, remaining: everywhere });
    const hog = n.cells['hog:gcc'] + n.cells['hog:us'] + n.cells['hog:eu'] + n.cells['hog:af'];
    expect(hog).toBe(1);
  });

  it('a region counts as searchable only through a lane that may still take leads, and full lanes pass nothing on', () => {
    const lanes = laneCaps(30); // 6 per ICP, Africa 3
    const remaining = [q('sg', 'fintech'), q('us', 'channel'), q('gcc', 'channel'), q('eu', 'channel'), q('us', 'cyber'), q('us', 'ai'), q('us', 'health'), q('af', 'africa')];
    const n = needs({ regions, regionReady: {}, lanes, laneReady: { fintech: 6 }, remaining });
    expect(n.lanes?.fintech).toBe(0);
    expect(n.cells['ciominds:sg']).toBe(0); // only the full fintech lane searches Singapore
    expect(n.cells['ciominds:us'] + n.cells['ciominds:eu']).toBe(10);
  });

  it("shares a finished lane's unused cap between the lanes still searching", () => {
    const lanes = { a: 6, b: 6, c: 6 };
    const n = needs({ regions, regionReady: {}, lanes, laneReady: { a: 2, b: 6 }, remaining: [q('us', 'c')] });
    // a found 2 of 6 and has no searches left: its 4 go to c (b is full and has none left either).
    expect(n.lanes).toEqual({ a: 0, b: 0, c: 10 });
  });

  it('passes on the cap of a lane whose remaining searches are all in regions that are already full', () => {
    // Lane a found the 2 US leads and has only US searches left; lane b searches the Gulf, which still needs 4.
    const n = needs({ regions: { 'hog:us': 2, 'hog:gcc': 4 }, regionReady: { 'hog:us': 2 }, lanes: { a: 3, b: 3 }, laneReady: { a: 2 }, remaining: [q('us', 'a'), q('gcc', 'b')] });
    expect(n.lanes).toEqual({ a: 0, b: 4 });
    expect(n.cells).toEqual({ 'hog:us': 0, 'hog:gcc': 4 });
  });

  it('is 0 when nothing is left to search', () => {
    expect(needs({ regions, regionReady: {}, laneReady: {}, remaining: [] }).left).toBe(0);
  });

  it('tells each brand what it still needs in one region', () => {
    const n = needs({ regions, regionReady: {}, laneReady: {}, remaining: everywhere });
    expect(needIn(n.cells, 'gcc')).toEqual({ gulficons: 11, hog: 3 });
    expect(needIn(n.cells, 'sg')).toEqual({ ciominds: 3 });
    expect(needIn(n.cells, 'af')).toEqual({ hog: 2 });
  });
});

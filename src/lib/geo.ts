/** The markets the engine searches. `gl` is Google's country code, which Serper takes as-is. */
export type Geo = 'ae' | 'us' | 'uk' | 'ca';

export const GEOS: Record<Geo, { gl: string; label: string; short: string; cities: string[] }> = {
  ae: { gl: 'ae', label: 'UAE', short: 'UAE', cities: ['Dubai', 'Abu Dhabi', 'Sharjah', 'Ras Al Khaimah'] },
  us: { gl: 'us', label: 'United States', short: 'US', cities: ['New York', 'San Francisco', 'Los Angeles', 'Miami', 'Chicago', 'Boston', 'Austin'] },
  uk: { gl: 'uk', label: 'United Kingdom', short: 'UK', cities: ['London', 'Manchester', 'Birmingham', 'Edinburgh'] },
  ca: { gl: 'ca', label: 'Canada', short: 'Canada', cities: ['Toronto', 'Vancouver', 'Montreal', 'Calgary'] },
};

export const GEO_LIST = Object.keys(GEOS) as Geo[];

export function isGeo(value: string): value is Geo {
  return Object.prototype.hasOwnProperty.call(GEOS, value);
}

/** "ae" gives "UAE"; unknown codes are returned as they are. */
export function geoShort(geo: string): string {
  return isGeo(geo) ? GEOS[geo].short : geo;
}

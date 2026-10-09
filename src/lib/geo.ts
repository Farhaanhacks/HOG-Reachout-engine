/** The markets the engine searches. `gl` is Google's country code, which Serper takes as-is. */
export type Geo = 'ae' | 'us';

export const GEOS: Record<Geo, { gl: string; label: string; cities: string[] }> = {
  ae: { gl: 'ae', label: 'UAE', cities: ['Dubai', 'Abu Dhabi', 'Sharjah', 'Ras Al Khaimah'] },
  us: { gl: 'us', label: 'United States', cities: ['New York', 'San Francisco', 'Los Angeles', 'Miami', 'Chicago', 'Boston', 'Austin'] },
};

export function isGeo(value: string): value is Geo {
  return value === 'ae' || value === 'us';
}

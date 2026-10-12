import { geoShort } from './geo';

/**
 * The markets leads come from: the Middle East, Europe, the US and Africa. Each market is a list of countries, searched
 * together in Apollo by where the person is based. Which brand a lead goes to depends on their country (see brands.ts).
 */
export type Market = 'me' | 'eu' | 'us' | 'af';

/** The six Gulf Cooperation Council countries: "the Gulf" for CIO Minds. */
export const GCC = ['United Arab Emirates', 'Saudi Arabia', 'Qatar', 'Kuwait', 'Bahrain', 'Oman'];

/** The wider Middle East (Gulf Icons and Humans of Globe). Iran and Syria are left out: they are under sanctions. */
export const MIDDLE_EAST = [...GCC, 'Jordan', 'Lebanon', 'Iraq', 'Egypt', 'Turkey', 'Israel', 'Palestine', 'Yemen'];

export const EUROPE = [
  'Albania', 'Andorra', 'Austria', 'Belgium', 'Bosnia and Herzegovina', 'Bulgaria', 'Croatia', 'Cyprus', 'Czech Republic', 'Denmark',
  'Estonia', 'Finland', 'France', 'Germany', 'Greece', 'Hungary', 'Iceland', 'Ireland', 'Italy', 'Kosovo', 'Latvia', 'Liechtenstein',
  'Lithuania', 'Luxembourg', 'Malta', 'Moldova', 'Monaco', 'Montenegro', 'Netherlands', 'North Macedonia', 'Norway', 'Poland',
  'Portugal', 'Romania', 'San Marino', 'Serbia', 'Slovakia', 'Slovenia', 'Spain', 'Sweden', 'Switzerland', 'Ukraine', 'United Kingdom',
];

export const AFRICA = [
  'Algeria', 'Angola', 'Benin', 'Botswana', 'Burkina Faso', 'Burundi', 'Cape Verde', 'Cameroon', 'Central African Republic', 'Chad',
  'Comoros', 'Democratic Republic of the Congo', 'Republic of the Congo', 'Djibouti', 'Equatorial Guinea', 'Eritrea', 'Eswatini',
  'Ethiopia', 'Gabon', 'Gambia', 'Ghana', 'Guinea', 'Guinea-Bissau', "Cote d'Ivoire", 'Kenya', 'Lesotho', 'Liberia', 'Libya',
  'Madagascar', 'Malawi', 'Mali', 'Mauritania', 'Mauritius', 'Morocco', 'Mozambique', 'Namibia', 'Niger', 'Nigeria', 'Rwanda',
  'Sao Tome and Principe', 'Senegal', 'Seychelles', 'Sierra Leone', 'Somalia', 'South Africa', 'South Sudan', 'Sudan', 'Tanzania', 'Togo',
  'Tunisia', 'Uganda', 'Zambia', 'Zimbabwe',
];

// Egypt is searched with the Middle East (it is in Gulf Icons' region), not with Africa.
export const MARKETS: Record<Market, { label: string; short: string; countries: string[] }> = {
  me: { label: 'Middle East', short: 'Middle East', countries: MIDDLE_EAST },
  eu: { label: 'Europe', short: 'Europe', countries: EUROPE },
  us: { label: 'United States', short: 'US', countries: ['United States'] },
  af: { label: 'Africa', short: 'Africa', countries: AFRICA },
};

export const MARKET_LIST = Object.keys(MARKETS) as Market[];

/**
 * The order searches take turns in. The Middle East, Europe and the US get two turns for every one Africa gets: every
 * brand needs them (Gulf Icons only has the Middle East), while Africa is for Humans of Globe alone.
 */
export const MARKET_TURNS: Market[] = ['me', 'eu', 'us', 'me', 'af', 'eu', 'us'];

export function isMarket(value: string): value is Market {
  return Object.prototype.hasOwnProperty.call(MARKETS, value);
}

const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z]+/g, ' ').trim();

const ALIASES: Record<string, Market> = {
  'united states of america': 'us', usa: 'us', 'u s': 'us', uae: 'me', 'kingdom of saudi arabia': 'me', 'turkiye': 'me', 'state of palestine': 'me', 'czechia': 'eu', 'ivory coast': 'af', 'cabo verde': 'af', 'swaziland': 'af',
  'dr congo': 'af', 'congo': 'af', england: 'eu', scotland: 'eu', wales: 'eu', 'northern ireland': 'eu', uk: 'eu', 'great britain': 'eu',
};

const BY_COUNTRY = new Map<string, Market>();
for (const m of MARKET_LIST) for (const c of MARKETS[m].countries) BY_COUNTRY.set(norm(c), m);
for (const [k, m] of Object.entries(ALIASES)) BY_COUNTRY.set(norm(k), m);

/** Which market a country belongs to ("Nigeria" gives "af"), or null for countries outside every market. */
export function marketOf(country: string | null | undefined): Market | null {
  return BY_COUNTRY.get(norm(country ?? '')) ?? null;
}

/** "af" gives "Africa"; the older country codes (ae, us, uk, ca) keep their names. */
export function marketShort(id: string): string {
  return isMarket(id) ? MARKETS[id].short : geoShort(id);
}

/** Google's country code for a country, so news searches look in the right place. Unlisted countries use the US. */
const GL: Record<string, string> = {
  'united states': 'us', 'united arab emirates': 'ae', 'united kingdom': 'uk', ireland: 'ie', germany: 'de', france: 'fr', netherlands: 'nl',
  spain: 'es', italy: 'it', portugal: 'pt', belgium: 'be', switzerland: 'ch', austria: 'at', sweden: 'se', norway: 'no', denmark: 'dk',
  finland: 'fi', poland: 'pl', greece: 'gr', romania: 'ro', 'czech republic': 'cz', hungary: 'hu', ukraine: 'ua', nigeria: 'ng',
  'south africa': 'za', kenya: 'ke', egypt: 'eg', ghana: 'gh', morocco: 'ma', tanzania: 'tz', uganda: 'ug', ethiopia: 'et', rwanda: 'rw',
  senegal: 'sn', tunisia: 'tn', algeria: 'dz', zambia: 'zm', zimbabwe: 'zw', botswana: 'bw', namibia: 'na', mauritius: 'mu', cameroon: 'cm',
  'saudi arabia': 'sa', qatar: 'qa', kuwait: 'kw', bahrain: 'bh', oman: 'om', jordan: 'jo', lebanon: 'lb', iraq: 'iq', turkey: 'tr', israel: 'il',
};

/** Whether a country is one of the six GCC countries. */
export function isGcc(country: string | null | undefined): boolean {
  const n = norm(country ?? '');
  return !!n && (GCC.some((c) => norm(c) === n) || n === 'uae' || n === 'kingdom of saudi arabia');
}

export function glForCountry(country: string | null | undefined): string {
  return GL[norm(country ?? '')] ?? 'us';
}

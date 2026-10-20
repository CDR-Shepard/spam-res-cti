/**
 * Places for rep routing: which booking region a geocoded property is in, and whether a Salesforce Event Location is an
 * address a rep can be driven to. Event Locations and seller addresses are PII: nothing here logs.
 */
import type { BookingRegion, BookingRouting } from '@cti/contracts';
import type { Geocoded } from './maps.js';

const MIN_ADDRESS_CHARS = 8;
const MAX_ADDRESS_CHARS = 200;
/**
 * A house number, an optional directional, then a street word or a numbered street: "1234 Oak", "77B Palm", "1234 N Main",
 * "100 N. Tustin", "456 3rd", "1200 E 7th". A phone number ("555 123 4567") or a bare "Zoom" has none of these.
 */
const STREET_ADDRESS = /\b\d{1,6}[A-Za-z]?(?:-\d+)?\s+(?:(?:[NSEW]|North|South|East|West)\.?\s+)?(?:\d{1,4}(?:st|nd|rd|th)\b|[A-Za-z]{2,})/i;
/** A link or a meeting room, even one that carries a street-like number ("www.example.com/123 Main"); "Calle Zoomar" is a street. */
const NOT_A_PLACE = /(https?:|www\.|\bzoom\b|zoom\.us|teams\.|meet\.google|webex)/i;
/** Booking regions are California counties. */
const ROUTING_STATE = 'CA';

/**
 * The Event Location as an address Google can be asked to route to (spaces collapsed), or null when it is empty, a link, a
 * phone number or a word such as "Zoom" or "Office": the rep is then taken to be at the office.
 */
export function usableAddress(location: string | null | undefined): string | null {
  const text = (location ?? '').replace(/\s+/g, ' ').trim();
  if (text.length < MIN_ADDRESS_CHARS || text.length > MAX_ADDRESS_CHARS) return null;
  return STREET_ADDRESS.test(text) && !NOT_A_PLACE.test(text) ? text : null;
}

/** A county name as a comparison key: 'San Diego County' → 'san diego'. */
export function countyKey(name: string): string {
  return name.replace(/\s+/g, ' ').trim().toLowerCase().replace(/ county$/, '');
}

/** The region that covers the property's county, or null (not California, no county, or a county no region covers). */
export function regionFor(geo: Geocoded, routing: BookingRouting): BookingRegion | null {
  if (geo.state?.toUpperCase() !== ROUTING_STATE || geo.county === null) return null;
  const county = countyKey(geo.county);
  return routing.regions.find((region) => region.counties.some((c) => countyKey(c) === county)) ?? null;
}

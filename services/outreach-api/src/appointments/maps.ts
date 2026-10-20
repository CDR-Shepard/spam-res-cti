/**
 * Google Maps for Sam's booking: geocode a property (county and point) and time drives between places.
 *
 * Seller addresses are PII and Geocoding takes the key as a query parameter, so this module never logs, and a
 * MapsUnavailableError carries a short code only: never an address, a URL or the key. Caches live for the process.
 */
import { z } from 'zod';

export interface GeoPoint {
  lat: number;
  lng: number;
}
export type Place = { address: string } | { point: GeoPoint };
export interface Geocoded {
  point: GeoPoint;
  county: string | null;
  state: string | null;
}
export interface RouteMatrix {
  /** Whole minutes per origin x destination; null = Google found no route. */
  minutes: (number | null)[][];
  /** Route elements Google was asked for this call (cache hits are free). */
  requestedElements: number;
}

/** `code` only: 'timeout' | 'network' | 'http_<status>' | 'bad_response' | a Google status such as 'OVER_QUERY_LIMIT'. Never an address or URL. */
export class MapsUnavailableError extends Error {
  constructor(readonly code: string) {
    super(`maps unavailable: ${code}`);
    this.name = 'MapsUnavailableError';
  }
}

export interface MapsClient {
  /** null = Google found nothing. */
  geocode(address: string): Promise<Geocoded | null>;
  routeMinutes(origins: readonly Place[], destinations: readonly Place[], departure: Date): Promise<RouteMatrix>;
}

export const GEOCODE_URL = 'https://maps.googleapis.com/maps/api/geocode/json';
export const ROUTE_MATRIX_URL = 'https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix';
export const MAPS_TIMEOUT_MS = 4_000;

const CACHE_TTL_MS = 24 * 3_600_000;
const GEOCODE_CACHE_MAX = 2_000;
const ROUTE_CACHE_MAX = 10_000;
const MIN_LEAD_MS = 60_000;
const HOUR_MS = 3_600_000;
const ROUTE_FIELD_MASK = 'originIndex,destinationIndex,duration,condition,status';
/** A Google status or enum name. Anything else in that position could be echoing the request, so it is not trusted as a code. */
const GOOGLE_STATUS = /^[A-Z][A-Z_]{0,39}$/;

/** Oldest-inserted-first eviction past `max`; an entry also lapses `ttlMs` after it was set. */
class TtlCache<V> {
  private readonly entries = new Map<string, { value: V; expiresAt: number }>();
  constructor(
    private readonly max: number,
    private readonly ttlMs: number,
    private readonly now: () => Date,
  ) {}

  /** Boxed so a cached `null` is told apart from a miss. */
  get(key: string): { value: V } | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= this.now().getTime()) {
      this.entries.delete(key);
      return undefined;
    }
    return { value: entry.value };
  }

  set(key: string, value: V): void {
    this.entries.delete(key);
    this.entries.set(key, { value, expiresAt: this.now().getTime() + this.ttlMs });
    while (this.entries.size > this.max) this.entries.delete(this.entries.keys().next().value as string);
  }
}

const normalizeAddress = (address: string): string => address.trim().replace(/\s+/g, ' ').toLowerCase();
const placeKey = (place: Place): string => ('address' in place ? `a:${normalizeAddress(place.address)}` : `p:${place.point.lat.toFixed(6)},${place.point.lng.toFixed(6)}`);
const hourStart = (t: Date): string => new Date(Math.floor(t.getTime() / HOUR_MS) * HOUR_MS).toISOString();

function waypoint(place: Place): { waypoint: object } {
  return 'address' in place ? { waypoint: { address: place.address } } : { waypoint: { location: { latLng: { latitude: place.point.lat, longitude: place.point.lng } } } };
}

const errorName = (err: unknown): string => (err instanceof Error || err instanceof DOMException ? err.name : '');
const isTimeout = (err: unknown): boolean => errorName(err) === 'TimeoutError' || errorName(err) === 'AbortError';

const GeocodeStatus = z.object({ status: z.string() });
const GeocodeOk = z.object({
  results: z
    .array(
      z.object({
        address_components: z.array(z.object({ long_name: z.string(), short_name: z.string(), types: z.array(z.string()) })).default([]),
        geometry: z.object({ location: z.object({ lat: z.number(), lng: z.number() }) }),
      }),
    )
    .min(1),
});
const RouteElements = z.array(
  z.object({
    // protobuf JSON leaves out a zero, so the first origin or destination can arrive without its index.
    originIndex: z.number().int().min(0).default(0),
    destinationIndex: z.number().int().min(0).default(0),
    duration: z.string().optional(),
    condition: z.string().optional(),
    status: z.object({ code: z.number().optional() }).optional(),
  }),
);

function parseGeocode(body: unknown): Geocoded | null {
  const head = GeocodeStatus.safeParse(body);
  if (!head.success) throw new MapsUnavailableError('bad_response');
  const { status } = head.data;
  if (status === 'ZERO_RESULTS') return null;
  if (status !== 'OK') throw new MapsUnavailableError(GOOGLE_STATUS.test(status) ? status : 'bad_response');
  const ok = GeocodeOk.safeParse(body);
  if (!ok.success) throw new MapsUnavailableError('bad_response');
  const first = ok.data.results[0]!;
  const component = (type: string) => first.address_components.find((c) => c.types.includes(type));
  const county = component('administrative_area_level_2')?.long_name.replace(/\s+County$/i, '');
  return { point: first.geometry.location, county: county ?? null, state: component('administrative_area_level_1')?.short_name ?? null };
}

/** NOT_FOUND in google.rpc.Code: Google could not place one of the addresses. A definitive answer, unlike 4, 8, 13 or 14. */
const NOT_FOUND = 5;

/**
 * "1530s" -> 26. Whole minutes, rounded up: a drive time is never understated. `definitive` says Google answered
 * (a duration, no route, or an address it can't place); anything else is null for now but is not worth remembering.
 */
function parseElement(el: z.infer<typeof RouteElements>[number]): { minutes: number | null; definitive: boolean } {
  const code = el.status?.code ?? 0;
  if (code !== 0) return { minutes: null, definitive: code === NOT_FOUND };
  if (el.condition !== undefined && el.condition !== 'ROUTE_EXISTS') return { minutes: null, definitive: el.condition === 'ROUTE_NOT_FOUND' };
  const seconds = /^(\d+(?:\.\d+)?)s$/.exec(el.duration ?? '')?.[1];
  return seconds === undefined ? { minutes: null, definitive: false } : { minutes: Math.ceil(Number(seconds) / 60), definitive: true };
}

export function googleMaps(apiKey: string, opts: { fetch?: typeof fetch; now?: () => Date } = {}): MapsClient {
  const fetchImpl = opts.fetch ?? fetch;
  const now = opts.now ?? (() => new Date());
  const geocodes = new TtlCache<Geocoded | null>(GEOCODE_CACHE_MAX, CACHE_TTL_MS, now);
  const routes = new TtlCache<number | null>(ROUTE_CACHE_MAX, CACHE_TTL_MS, now);

  /** One bounded request to Google; every failure becomes a MapsUnavailableError with a code. */
  async function requestJson(url: string, init: RequestInit): Promise<unknown> {
    let res: Response;
    try {
      res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(MAPS_TIMEOUT_MS) });
    } catch (err) {
      throw new MapsUnavailableError(isTimeout(err) ? 'timeout' : 'network');
    }
    if (!res.ok) {
      void res.body?.cancel().catch(() => undefined);
      throw new MapsUnavailableError(`http_${res.status}`);
    }
    try {
      return await res.json();
    } catch (err) {
      throw new MapsUnavailableError(isTimeout(err) ? 'timeout' : 'bad_response');
    }
  }

  /** Never less than a minute from now: Google refuses a traffic-aware departure that has passed by the time it is processed. */
  const effectiveDeparture = (departure: Date): Date => {
    const earliest = now().getTime() + MIN_LEAD_MS;
    return departure.getTime() < earliest ? new Date(earliest) : departure;
  };

  return {
    async geocode(address) {
      const key = normalizeAddress(address);
      const hit = geocodes.get(key);
      if (hit) return hit.value;
      const url = new URL(GEOCODE_URL);
      url.searchParams.set('address', address);
      url.searchParams.set('components', 'country:US');
      url.searchParams.set('key', apiKey);
      const found = parseGeocode(await requestJson(url.toString(), { method: 'GET' }));
      geocodes.set(key, found);
      return found;
    },

    async routeMinutes(origins, destinations, departure) {
      if (origins.length === 0 || destinations.length === 0) return { minutes: origins.map(() => []), requestedElements: 0 };
      const when = effectiveDeparture(departure);
      const hour = hourStart(when);
      const originKeys = origins.map(placeKey);
      const destinationKeys = destinations.map(placeKey);
      const keyOf = (o: number, d: number): string => `${originKeys[o]}>${destinationKeys[d]}@${hour}`;

      const known = new Map<string, number | null>();
      const missingOrigins = new Set<number>();
      const missingDestinations = new Set<number>();
      origins.forEach((_, o) =>
        destinations.forEach((__, d) => {
          const hit = routes.get(keyOf(o, d));
          if (hit) known.set(keyOf(o, d), hit.value);
          else {
            missingOrigins.add(o);
            missingDestinations.add(d);
          }
        }),
      );

      // Ask only for the origins and destinations that still have a pair we don't know.
      const askOrigins = [...missingOrigins].sort((a, b) => a - b);
      const askDestinations = [...missingDestinations].sort((a, b) => a - b);
      if (askOrigins.length > 0) {
        const body = await requestJson(ROUTE_MATRIX_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': apiKey, 'X-Goog-FieldMask': ROUTE_FIELD_MASK },
          body: JSON.stringify({
            origins: askOrigins.map((o) => waypoint(origins[o]!)),
            destinations: askDestinations.map((d) => waypoint(destinations[d]!)),
            travelMode: 'DRIVE',
            routingPreference: 'TRAFFIC_AWARE',
            departureTime: when.toISOString(),
          }),
        });
        const elements = RouteElements.safeParse(body);
        if (!elements.success) throw new MapsUnavailableError('bad_response');
        for (const el of elements.data) {
          const o = askOrigins[el.originIndex];
          const d = askDestinations[el.destinationIndex];
          if (o === undefined || d === undefined) throw new MapsUnavailableError('bad_response');
          const { minutes, definitive } = parseElement(el);
          known.set(keyOf(o, d), minutes);
          if (definitive) routes.set(keyOf(o, d), minutes);
        }
      }

      return {
        minutes: origins.map((_, o) => destinations.map((__, d) => known.get(keyOf(o, d)) ?? null)),
        requestedElements: askOrigins.length * askDestinations.length,
      };
    },
  };
}

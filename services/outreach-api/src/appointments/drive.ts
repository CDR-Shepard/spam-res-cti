/**
 * Drive times for rep routing. Google Routes first; when it is unavailable, straight-line estimates so the caller still
 * gets times. Addresses are PII: the only thing ever logged is the error code.
 */
import { MapsUnavailableError, type GeoPoint, type MapsClient, type Place } from './maps.js';

/** A road is longer than the crow flies, and a rep averages this speed. Only the fallback uses them. */
export const FALLBACK_ROAD_FACTOR = 1.3;
export const FALLBACK_MPH = 45;
const EARTH_RADIUS_MILES = 3958.8;

const radians = (degrees: number): number => (degrees * Math.PI) / 180;

/** ceil(haversine miles x FALLBACK_ROAD_FACTOR / FALLBACK_MPH x 60). */
export function straightLineMinutes(a: GeoPoint, b: GeoPoint): number {
  const dLat = radians(b.lat - a.lat);
  const dLng = radians(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(radians(a.lat)) * Math.cos(radians(b.lat)) * Math.sin(dLng / 2) ** 2;
  const miles = 2 * EARTH_RADIUS_MILES * Math.asin(Math.min(1, Math.sqrt(h)));
  return Math.ceil(((miles * FALLBACK_ROAD_FACTOR) / FALLBACK_MPH) * 60);
}

export interface DriveTimer {
  /**
   * Minutes per origin x destination (null = no route). Falls back to straight lines when Google Routes is unavailable,
   * and after the first such failure stays on straight lines for the rest of this timer's life.
   * Rejects with MapsUnavailableError only when that fallback cannot place an address either (Geocoding is down too).
   */
  matrix(origins: readonly Place[], destinations: readonly Place[], departure: Date): Promise<(number | null)[][]>;
  /** Route elements this timer has asked Google for (cache hits and fallback estimates are free). */
  spent(): number;
}

export function driveTimer(maps: MapsClient, office: Place, log: { warn(o: Record<string, unknown>, m: string): void }): DriveTimer {
  let spentElements = 0;
  // Once Google has failed, this timer stops asking: a hung Routes would cost its full timeout on every later matrix.
  let routesDown = false;

  async function straightLines(origins: readonly Place[], destinations: readonly Place[]): Promise<number[][]> {
    // An address Google can't find is treated as the office; the office, if it is an address, is looked up only then.
    let officePoint: Promise<GeoPoint> | undefined;
    const locateOffice = (): Promise<GeoPoint> => {
      officePoint ??= (async () => {
        if ('point' in office) return office.point;
        const found = await maps.geocode(office.address);
        if (!found) throw new MapsUnavailableError('ZERO_RESULTS');
        return found.point;
      })();
      return officePoint;
    };
    const byAddress = new Map<string, Promise<GeoPoint>>();
    const locate = (place: Place): Promise<GeoPoint> => {
      if ('point' in place) return Promise.resolve(place.point);
      const known = byAddress.get(place.address);
      if (known) return known;
      const looked = maps.geocode(place.address).then((found) => found?.point ?? locateOffice());
      byAddress.set(place.address, looked);
      return looked;
    };
    const [from, to] = await Promise.all([Promise.all(origins.map(locate)), Promise.all(destinations.map(locate))]);
    return from.map((a) => to.map((b) => straightLineMinutes(a, b)));
  }

  return {
    async matrix(origins, destinations, departure) {
      if (routesDown) return straightLines(origins, destinations);
      try {
        const result = await maps.routeMinutes(origins, destinations, departure);
        spentElements += result.requestedElements;
        return result.minutes;
      } catch (err) {
        if (!(err instanceof MapsUnavailableError)) throw err;
        routesDown = true;
        log.warn({ code: err.code }, 'Google Routes unavailable: using straight-line drive times');
        return straightLines(origins, destinations);
      }
    },
    spent: () => spentElements,
  };
}

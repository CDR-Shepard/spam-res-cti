import { describe, expect, it, vi } from 'vitest';
import { FALLBACK_MPH, FALLBACK_ROAD_FACTOR, driveTimer, straightLineMinutes } from './drive.js';
import { MapsUnavailableError, type GeoPoint, type Geocoded, type MapsClient, type Place } from './maps.js';

const IRVINE: GeoPoint = { lat: 33.6846, lng: -117.8265 };
const SAN_DIEGO: GeoPoint = { lat: 32.7157, lng: -117.1611 };
const LA: GeoPoint = { lat: 34.0522, lng: -118.2437 };
const OFFICE: Place = { point: IRVINE };
const DEPARTURE = new Date('2026-10-20T16:00:00.000Z');

const FAKE_HOME = '12 Fake Maple Ct, Testville, CA 90001';
const FAKE_UNKNOWN = '99 Nowhere Rd';

const geocoded = (point: GeoPoint): Geocoded => ({ point, county: null, state: null });

/** A fake MapsClient: Routes is down with `routesCode`, and geocoding answers from `known` (anything else = not found). */
function fakeMaps(opts: { known?: Record<string, GeoPoint>; routesCode?: string; geocodeThrows?: string } = {}) {
  const geocode = vi.fn(async (address: string): Promise<Geocoded | null> => {
    if (opts.geocodeThrows) throw new MapsUnavailableError(opts.geocodeThrows);
    const point = opts.known?.[address];
    return point ? geocoded(point) : null;
  });
  const routeMinutes = vi.fn(async () => {
    throw new MapsUnavailableError(opts.routesCode ?? 'http_503');
  });
  return { maps: { geocode, routeMinutes } as MapsClient, geocode, routeMinutes };
}
const logger = () => {
  const warn = vi.fn<(o: Record<string, unknown>, m: string) => void>();
  return { log: { warn }, warn };
};

describe('straightLineMinutes', () => {
  it('uses the documented road factor and speed', () => {
    expect(FALLBACK_ROAD_FACTOR).toBe(1.3);
    expect(FALLBACK_MPH).toBe(45);
  });

  it('is 120 minutes for one degree of longitude on the equator, and 0 for the same point', () => {
    expect(straightLineMinutes({ lat: 0, lng: 0 }, { lat: 0, lng: 1 })).toBe(120);
    expect(straightLineMinutes(IRVINE, IRVINE)).toBe(0);
  });

  it('rounds up and does not care about direction', () => {
    const there = straightLineMinutes(IRVINE, SAN_DIEGO);
    expect(there).toBe(straightLineMinutes(SAN_DIEGO, IRVINE));
    // About 77 straight-line miles x 1.3 at 45 mph is just over two hours.
    expect(there).toBeGreaterThan(130);
    expect(there).toBeLessThan(140);
    expect(Number.isInteger(there)).toBe(true);
  });
});

describe('driveTimer with Google answering', () => {
  it('returns Google\'s minutes, counts the elements asked, and does not warn', async () => {
    const { log, warn } = logger();
    const routeMinutes = vi.fn(async () => ({ minutes: [[12, null]], requestedElements: 2 }));
    const geocode = vi.fn();
    const timer = driveTimer({ geocode, routeMinutes } as unknown as MapsClient, OFFICE, log);
    expect(timer.spent()).toBe(0);
    expect(await timer.matrix([OFFICE], [{ address: FAKE_HOME }, { point: LA }], DEPARTURE)).toEqual([[12, null]]);
    expect(routeMinutes).toHaveBeenCalledWith([OFFICE], [{ address: FAKE_HOME }, { point: LA }], DEPARTURE);
    routeMinutes.mockResolvedValueOnce({ minutes: [[7]], requestedElements: 0 });
    await timer.matrix([OFFICE], [{ point: LA }], DEPARTURE);
    routeMinutes.mockResolvedValueOnce({ minutes: [[7]], requestedElements: 3 });
    await timer.matrix([OFFICE], [{ point: LA }], DEPARTURE);
    expect(timer.spent()).toBe(5);
    expect(geocode).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('driveTimer when Google Routes is unavailable', () => {
  it('geocodes each address and returns straight-line minutes, spending nothing', async () => {
    const f = fakeMaps({ known: { [FAKE_HOME]: SAN_DIEGO } });
    const { log } = logger();
    const timer = driveTimer(f.maps, OFFICE, log);
    const result = await timer.matrix([{ address: FAKE_HOME }, { point: LA }], [{ point: IRVINE }, { address: FAKE_HOME }], DEPARTURE);
    expect(result).toEqual([
      [straightLineMinutes(SAN_DIEGO, IRVINE), 0],
      [straightLineMinutes(LA, IRVINE), straightLineMinutes(LA, SAN_DIEGO)],
    ]);
    expect(f.routeMinutes).toHaveBeenCalledTimes(1);
    expect(timer.spent()).toBe(0);
  });

  it('stops asking Google once it has failed: later matrices go straight to straight lines', async () => {
    const f = fakeMaps({ known: { [FAKE_HOME]: SAN_DIEGO } });
    const { log, warn } = logger();
    const timer = driveTimer(f.maps, OFFICE, log);
    await timer.matrix([{ address: FAKE_HOME }], [{ point: LA }], DEPARTURE);
    expect(f.routeMinutes).toHaveBeenCalledTimes(1);
    const second = await timer.matrix([{ address: FAKE_HOME }, { point: IRVINE }], [{ point: LA }], DEPARTURE);
    await timer.matrix([{ point: SAN_DIEGO }], [{ point: LA }], DEPARTURE);
    expect(f.routeMinutes).toHaveBeenCalledTimes(1);
    expect(second).toEqual([[straightLineMinutes(SAN_DIEGO, LA)], [straightLineMinutes(IRVINE, LA)]]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(timer.spent()).toBe(0);
  });

  it('still asks Google on a fresh timer after another timer\'s failure', async () => {
    const f = fakeMaps();
    await driveTimer(f.maps, OFFICE, logger().log).matrix([{ point: LA }], [{ point: IRVINE }], DEPARTURE);
    await driveTimer(f.maps, OFFICE, logger().log).matrix([{ point: LA }], [{ point: IRVINE }], DEPARTURE);
    expect(f.routeMinutes).toHaveBeenCalledTimes(2);
  });

  it('asks for each distinct address once per matrix', async () => {
    const f = fakeMaps({ known: { [FAKE_HOME]: SAN_DIEGO } });
    const timer = driveTimer(f.maps, OFFICE, logger().log);
    await timer.matrix([{ address: FAKE_HOME }], [{ address: FAKE_HOME }, { address: FAKE_HOME }], DEPARTURE);
    expect(f.geocode).toHaveBeenCalledTimes(1);
  });

  it('uses the office point for an address Google cannot find', async () => {
    const f = fakeMaps({ known: {} });
    const timer = driveTimer(f.maps, OFFICE, logger().log);
    const result = await timer.matrix([{ address: FAKE_UNKNOWN }], [{ point: LA }], DEPARTURE);
    expect(result).toEqual([[straightLineMinutes(IRVINE, LA)]]);
  });

  it('geocodes an office given as an address, and only when something needs it', async () => {
    const OFFICE_ADDRESS = '1 Fake Office Pkwy, Testville, CA 90001';
    const f = fakeMaps({ known: { [OFFICE_ADDRESS]: IRVINE, [FAKE_HOME]: SAN_DIEGO } });
    const timer = driveTimer(f.maps, { address: OFFICE_ADDRESS }, logger().log);
    await timer.matrix([{ address: FAKE_HOME }], [{ point: LA }], DEPARTURE);
    expect(f.geocode).not.toHaveBeenCalledWith(OFFICE_ADDRESS);
    expect(await timer.matrix([{ address: FAKE_UNKNOWN }], [{ point: LA }], DEPARTURE)).toEqual([[straightLineMinutes(IRVINE, LA)]]);
    expect(f.geocode).toHaveBeenCalledWith(OFFICE_ADDRESS);
  });

  it('warns once per timer, with the code only', async () => {
    const f = fakeMaps({ routesCode: 'OVER_QUERY_LIMIT', known: { [FAKE_HOME]: SAN_DIEGO } });
    const { log, warn } = logger();
    const timer = driveTimer(f.maps, OFFICE, log);
    await timer.matrix([{ address: FAKE_HOME }], [{ point: LA }], DEPARTURE);
    await timer.matrix([{ address: FAKE_HOME }], [{ point: LA }], DEPARTURE);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toEqual({ code: 'OVER_QUERY_LIMIT' });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('Fake Maple');
    const other = logger();
    await driveTimer(f.maps, OFFICE, other.log).matrix([{ point: LA }], [{ point: IRVINE }], DEPARTURE);
    expect(other.warn).toHaveBeenCalledTimes(1);
  });

  it('lets the error out when geocoding is down too, so the caller can offer no times', async () => {
    const f = fakeMaps({ geocodeThrows: 'OVER_QUERY_LIMIT' });
    const timer = driveTimer(f.maps, OFFICE, logger().log);
    await expect(timer.matrix([{ address: FAKE_HOME }], [{ point: LA }], DEPARTURE)).rejects.toMatchObject({ code: 'OVER_QUERY_LIMIT' });
    expect(timer.spent()).toBe(0);
  });

  it('lets the error out when the office address itself cannot be found', async () => {
    const f = fakeMaps({ known: {} });
    const timer = driveTimer(f.maps, { address: '1 Fake Office Pkwy' }, logger().log);
    await expect(timer.matrix([{ address: FAKE_UNKNOWN }], [{ point: LA }], DEPARTURE)).rejects.toBeInstanceOf(MapsUnavailableError);
  });

  it('does not swallow an error that is not MapsUnavailableError', async () => {
    const { log, warn } = logger();
    const routeMinutes = vi.fn(async () => {
      throw new TypeError('a bug');
    });
    const timer = driveTimer({ geocode: vi.fn(), routeMinutes } as unknown as MapsClient, OFFICE, log);
    await expect(timer.matrix([OFFICE], [{ point: LA }], DEPARTURE)).rejects.toThrow('a bug');
    expect(warn).not.toHaveBeenCalled();
  });

  it('answers an empty matrix', async () => {
    const timer = driveTimer(fakeMaps().maps, OFFICE, logger().log);
    expect(await timer.matrix([], [{ point: LA }], DEPARTURE)).toEqual([]);
    expect(await timer.matrix([OFFICE], [], DEPARTURE)).toEqual([[]]);
  });
});

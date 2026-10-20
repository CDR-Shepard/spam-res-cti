import { afterEach, describe, expect, it, vi } from 'vitest';
import { GEOCODE_URL, MAPS_TIMEOUT_MS, MapsUnavailableError, ROUTE_MATRIX_URL, googleMaps, type Place } from './maps.js';

const KEY = 'test-key-not-real';
const ADDRESS = '4321 Fake Orchard Way, Testville, CA 90001';
/** Monday 2026-10-19 12:00 UTC. */
const NOW = new Date('2026-10-19T12:00:00.000Z');
const HOUR = 3_600_000;
const SECOND = 1_000;

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const geocodeBody = (over: { county?: string | null; state?: string | null; lat?: number; lng?: number } = {}) => ({
  status: 'OK',
  results: [
    {
      address_components: [
        { long_name: 'Testville', short_name: 'Testville', types: ['locality', 'political'] },
        ...(over.county === null ? [] : [{ long_name: over.county ?? 'San Diego County', short_name: 'San Diego County', types: ['administrative_area_level_2', 'political'] }]),
        ...(over.state === null ? [] : [{ long_name: 'California', short_name: over.state ?? 'CA', types: ['administrative_area_level_1', 'political'] }]),
      ],
      geometry: { location: { lat: over.lat ?? 32.7157, lng: over.lng ?? -117.1611 } },
    },
  ],
});

type Call = [string, RequestInit & { headers?: Record<string, string> }];
/** A fake fetch that answers each call in turn (the last answer repeats), recording the calls. */
function fakeFetch(...answers: Array<Response | Error | (() => Response)>) {
  const fn = vi.fn(async () => {
    const answer = answers[Math.min(fn.mock.calls.length - 1, answers.length - 1)]!;
    if (answer instanceof Error) throw answer;
    return typeof answer === 'function' ? answer() : answer.clone();
  });
  const calls = (): Call[] => fn.mock.calls as unknown as Call[];
  return { fetch: fn as unknown as typeof fetch, fn, calls };
}

const clock = (start = NOW) => {
  let t = start.getTime();
  return { now: () => new Date(t), advance: (ms: number) => void (t += ms) };
};

afterEach(() => vi.restoreAllMocks());

describe('MapsUnavailableError', () => {
  it('carries the code and nothing else in its message', () => {
    const err = new MapsUnavailableError('http_500');
    expect(err.code).toBe('http_500');
    expect(err.message).toBe('maps unavailable: http_500');
    expect(err).toBeInstanceOf(Error);
  });
});

describe('googleMaps.geocode', () => {
  it('GETs the geocoding url with the address, the US restriction and the key', async () => {
    const f = fakeFetch(json(geocodeBody()));
    await googleMaps(KEY, { fetch: f.fetch }).geocode(ADDRESS);
    expect(f.fn).toHaveBeenCalledTimes(1);
    const [url, init] = f.calls()[0]!;
    const u = new URL(url);
    expect(`${u.origin}${u.pathname}`).toBe(GEOCODE_URL);
    expect(u.searchParams.get('address')).toBe(ADDRESS);
    expect(u.searchParams.get('components')).toBe('country:US');
    expect(u.searchParams.get('key')).toBe(KEY);
    expect(init.method ?? 'GET').toBe('GET');
  });

  it('gives each request a MAPS_TIMEOUT_MS timeout signal', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const f = fakeFetch(json(geocodeBody()));
    await googleMaps(KEY, { fetch: f.fetch }).geocode(ADDRESS);
    expect(MAPS_TIMEOUT_MS).toBe(4_000);
    expect(timeout).toHaveBeenCalledWith(MAPS_TIMEOUT_MS);
    expect(f.calls()[0]![1].signal).toBeInstanceOf(AbortSignal);
  });

  it('reads the county (without the word County), the state and the point', async () => {
    const f = fakeFetch(json(geocodeBody()));
    expect(await googleMaps(KEY, { fetch: f.fetch }).geocode(ADDRESS)).toEqual({ county: 'San Diego', state: 'CA', point: { lat: 32.7157, lng: -117.1611 } });
  });

  it('leaves county and state null when Google gives no such component', async () => {
    const f = fakeFetch(json(geocodeBody({ county: null, state: null })));
    expect(await googleMaps(KEY, { fetch: f.fetch }).geocode(ADDRESS)).toEqual({ county: null, state: null, point: { lat: 32.7157, lng: -117.1611 } });
  });

  it('answers a repeat of the same address, differing only in case or whitespace, from the cache', async () => {
    const f = fakeFetch(json(geocodeBody()));
    const maps = googleMaps(KEY, { fetch: f.fetch });
    const first = await maps.geocode(ADDRESS);
    expect(await maps.geocode(`  ${ADDRESS.toUpperCase().replace(/ /g, '   ')}\n`)).toEqual(first);
    expect(f.fn).toHaveBeenCalledTimes(1);
    await maps.geocode('9 Another Fake Rd, Testville, CA 90001');
    expect(f.fn).toHaveBeenCalledTimes(2);
  });

  it('forgets a geocode after 24 hours', async () => {
    const f = fakeFetch(json(geocodeBody()));
    const c = clock();
    const maps = googleMaps(KEY, { fetch: f.fetch, now: c.now });
    await maps.geocode(ADDRESS);
    c.advance(24 * HOUR - SECOND);
    await maps.geocode(ADDRESS);
    expect(f.fn).toHaveBeenCalledTimes(1);
    c.advance(2 * SECOND);
    await maps.geocode(ADDRESS);
    expect(f.fn).toHaveBeenCalledTimes(2);
  });

  it('keeps at most 2,000 geocodes, evicting the oldest first', async () => {
    const f = fakeFetch(json(geocodeBody()));
    const maps = googleMaps(KEY, { fetch: f.fetch });
    for (let i = 0; i <= 2_000; i += 1) await maps.geocode(`${i} Fake Way`);
    expect(f.fn).toHaveBeenCalledTimes(2_001);
    await maps.geocode('2000 Fake Way');
    expect(f.fn).toHaveBeenCalledTimes(2_001);
    await maps.geocode('0 Fake Way');
    expect(f.fn).toHaveBeenCalledTimes(2_002);
  });

  it('returns null for ZERO_RESULTS and remembers that answer', async () => {
    const f = fakeFetch(json({ status: 'ZERO_RESULTS', results: [] }));
    const maps = googleMaps(KEY, { fetch: f.fetch });
    expect(await maps.geocode(ADDRESS)).toBeNull();
    expect(await maps.geocode(ADDRESS)).toBeNull();
    expect(f.fn).toHaveBeenCalledTimes(1);
  });

  const codeOf = async (p: Promise<unknown>): Promise<string> => {
    const err = await p.then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(MapsUnavailableError);
    return (err as MapsUnavailableError).code;
  };

  it('throws MapsUnavailableError carrying the Google status', async () => {
    const f = fakeFetch(json({ status: 'OVER_QUERY_LIMIT', results: [], error_message: `quota for ${ADDRESS}` }));
    expect(await codeOf(googleMaps(KEY, { fetch: f.fetch }).geocode(ADDRESS))).toBe('OVER_QUERY_LIMIT');
  });

  it('throws http_<status> for a non-2xx answer', async () => {
    const f = fakeFetch(json({ status: 'OK' }, 500));
    expect(await codeOf(googleMaps(KEY, { fetch: f.fetch }).geocode(ADDRESS))).toBe('http_500');
  });

  it.each([
    ['TimeoutError', 'timeout'],
    ['AbortError', 'timeout'],
  ])('throws timeout for an aborted fetch (%s)', async (name, code) => {
    const f = fakeFetch(new DOMException('The operation was aborted', name));
    expect(await codeOf(googleMaps(KEY, { fetch: f.fetch }).geocode(ADDRESS))).toBe(code);
  });

  it('throws network when the fetch itself fails', async () => {
    const f = fakeFetch(new TypeError('fetch failed'));
    expect(await codeOf(googleMaps(KEY, { fetch: f.fetch }).geocode(ADDRESS))).toBe('network');
  });

  it.each([
    ['a body that is not JSON', () => new Response('<html>nope</html>', { status: 200 })],
    ['an OK with no results', () => json({ status: 'OK', results: [] })],
    ['an OK result with no location', () => json({ status: 'OK', results: [{ address_components: [] }] })],
    ['a body with no status', () => json({ results: [] })],
    ['a status that is not a status code', () => json({ status: `bad ${ADDRESS}` })],
  ])('throws bad_response for %s', async (_label, answer) => {
    const f = fakeFetch(answer);
    expect(await codeOf(googleMaps(KEY, { fetch: f.fetch }).geocode(ADDRESS))).toBe('bad_response');
  });

  it('does not cache a failure: the next call asks Google again', async () => {
    const f = fakeFetch(json({ status: 'OVER_QUERY_LIMIT' }), json(geocodeBody()));
    const maps = googleMaps(KEY, { fetch: f.fetch });
    await expect(maps.geocode(ADDRESS)).rejects.toBeInstanceOf(MapsUnavailableError);
    expect((await maps.geocode(ADDRESS))?.county).toBe('San Diego');
    expect(f.fn).toHaveBeenCalledTimes(2);
  });

  it('never puts the address, the url or the key in an error message', async () => {
    const leaky = new TypeError(`fetch failed: ${GEOCODE_URL}?address=${encodeURIComponent(ADDRESS)}&key=${KEY}`);
    const answers: Array<Response | Error | (() => Response)> = [leaky, json({ status: 'REQUEST_DENIED', error_message: `${ADDRESS} ${KEY}` }), json({}, 403), new Response(`${ADDRESS} ${KEY}`)];
    for (const answer of answers) {
      const err = await googleMaps(KEY, { fetch: fakeFetch(answer).fetch })
        .geocode(ADDRESS)
        .then(
          () => null,
          (e: unknown) => e as Error,
        );
      expect(err).toBeInstanceOf(MapsUnavailableError);
      const shown = `${err!.message} ${err!.stack ?? ''} ${JSON.stringify(err)} ${String((err as { cause?: unknown }).cause ?? '')}`;
      expect(shown).not.toContain(KEY);
      expect(shown).not.toContain('Fake Orchard');
      expect(shown).not.toContain('googleapis');
    }
  });
});

describe('googleMaps.routeMinutes', () => {
  const A: Place = { address: '1 Fake Alpha St, Testville, CA 90001' };
  const B: Place = { point: { lat: 33.5, lng: -117.7 } };
  const C: Place = { address: '3 Fake Gamma Ave, Testville, CA 90001' };
  const D: Place = { point: { lat: 32.9, lng: -117.2 } };
  const departure = new Date('2026-10-20T16:30:00.000Z');

  const element = (originIndex: number, destinationIndex: number, seconds: number) => ({ originIndex, destinationIndex, duration: `${seconds}s`, condition: 'ROUTE_EXISTS' });
  const bodyOf = (call: Call) => JSON.parse(call[1].body as string) as {
    origins: unknown[];
    destinations: unknown[];
    travelMode: string;
    routingPreference: string;
    departureTime: string;
  };

  it('POSTs the route matrix with the key and field mask headers and a DRIVE, traffic-aware body', async () => {
    const f = fakeFetch(json([element(0, 0, 600)]));
    await googleMaps(KEY, { fetch: f.fetch, now: () => NOW }).routeMinutes([A], [B], departure);
    expect(f.fn).toHaveBeenCalledTimes(1);
    const call = f.calls()[0]!;
    expect(call[0]).toBe(ROUTE_MATRIX_URL);
    expect(call[1].method).toBe('POST');
    expect(call[1].headers).toMatchObject({
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': KEY,
      'X-Goog-FieldMask': 'originIndex,destinationIndex,duration,condition,status',
    });
    expect(call[1].signal).toBeInstanceOf(AbortSignal);
    const body = bodyOf(call);
    expect(body.travelMode).toBe('DRIVE');
    expect(body.routingPreference).toBe('TRAFFIC_AWARE');
    expect(body.origins).toEqual([{ waypoint: { address: A.address } }]);
    expect(body.destinations).toEqual([{ waypoint: { location: { latLng: { latitude: 33.5, longitude: -117.7 } } } }]);
  });

  it('sends addresses as address waypoints and points as latLng waypoints, in order', async () => {
    const f = fakeFetch(json([]));
    await googleMaps(KEY, { fetch: f.fetch, now: () => NOW }).routeMinutes([A, B], [C, D], departure);
    const body = bodyOf(f.calls()[0]!);
    expect(body.origins).toEqual([{ waypoint: { address: A.address } }, { waypoint: { location: { latLng: { latitude: 33.5, longitude: -117.7 } } } }]);
    expect(body.destinations).toEqual([{ waypoint: { address: C.address } }, { waypoint: { location: { latLng: { latitude: 32.9, longitude: -117.2 } } } }]);
  });

  it('sends the departure as an ISO string', async () => {
    const f = fakeFetch(json([]));
    await googleMaps(KEY, { fetch: f.fetch, now: () => NOW }).routeMinutes([A], [B], departure);
    expect(bodyOf(f.calls()[0]!).departureTime).toBe('2026-10-20T16:30:00.000Z');
  });

  it('sends a departure in the past as now plus 60 seconds', async () => {
    const f = fakeFetch(json([]));
    await googleMaps(KEY, { fetch: f.fetch, now: () => NOW }).routeMinutes([A], [B], new Date('2026-10-19T08:00:00.000Z'));
    expect(bodyOf(f.calls()[0]!).departureTime).toBe('2026-10-19T12:01:00.000Z');
  });

  it.each([
    ['now', 0, '2026-10-19T12:01:00.000Z'],
    ['30 seconds from now', 30 * SECOND, '2026-10-19T12:01:00.000Z'],
    ['59.999 seconds from now', 59_999, '2026-10-19T12:01:00.000Z'],
    ['exactly 60 seconds from now', 60 * SECOND, '2026-10-19T12:01:00.000Z'],
    ['61 seconds from now', 61 * SECOND, '2026-10-19T12:01:01.000Z'],
  ])('sends max(departure, now + 60 s) for a departure %s', async (_label, offsetMs, sent) => {
    const f = fakeFetch(json([]));
    await googleMaps(KEY, { fetch: f.fetch, now: () => NOW }).routeMinutes([A], [B], new Date(NOW.getTime() + offsetMs));
    expect(bodyOf(f.calls()[0]!).departureTime).toBe(sent);
  });

  it('places elements by originIndex and destinationIndex, whatever order they arrive in', async () => {
    const f = fakeFetch(json([element(1, 1, 3_000), element(0, 1, 1_530), element(1, 0, 120), element(0, 0, 60)]));
    const result = await googleMaps(KEY, { fetch: f.fetch, now: () => NOW }).routeMinutes([A, B], [C, D], departure);
    expect(result.minutes).toEqual([
      [1, 26],
      [2, 50],
    ]);
  });

  it('rounds seconds up to whole minutes', async () => {
    const f = fakeFetch(json([element(0, 0, 1_501), element(0, 1, 1_500), element(0, 2, 0)]));
    const result = await googleMaps(KEY, { fetch: f.fetch, now: () => NOW }).routeMinutes([A], [B, C, D], departure);
    expect(result.minutes).toEqual([[26, 25, 0]]);
  });

  it('reads an omitted index as 0, as protobuf JSON leaves out a zero', async () => {
    const f = fakeFetch(json([{ duration: '600s', condition: 'ROUTE_EXISTS' }, { destinationIndex: 1, duration: '900s', condition: 'ROUTE_EXISTS' }]));
    const result = await googleMaps(KEY, { fetch: f.fetch, now: () => NOW }).routeMinutes([A], [B, C], departure);
    expect(result.minutes).toEqual([[10, 15]]);
  });

  it('gives null for ROUTE_NOT_FOUND, for an element status error, and for an element Google left out', async () => {
    const f = fakeFetch(
      json([
        { originIndex: 0, destinationIndex: 0, condition: 'ROUTE_NOT_FOUND' },
        { originIndex: 0, destinationIndex: 1, status: { code: 5, message: 'not found' } },
        element(0, 2, 600),
      ]),
    );
    const result = await googleMaps(KEY, { fetch: f.fetch, now: () => NOW }).routeMinutes([A], [B, C, D, A], departure);
    expect(result.minutes).toEqual([[null, null, 10, null]]);
  });

  it('counts the elements it asked for, and answers an identical repeat from the cache without a fetch', async () => {
    const f = fakeFetch(json([element(0, 0, 60), element(0, 1, 120), element(1, 0, 180), element(1, 1, 240)]));
    const maps = googleMaps(KEY, { fetch: f.fetch, now: () => NOW });
    const first = await maps.routeMinutes([A, B], [C, D], departure);
    expect(first.requestedElements).toBe(4);
    const again = await maps.routeMinutes([A, B], [C, D], new Date(departure.getTime() + 20 * 60_000));
    expect(again).toEqual({ minutes: first.minutes, requestedElements: 0 });
    expect(f.fn).toHaveBeenCalledTimes(1);
  });

  it('treats a different clock hour as a different route', async () => {
    const f = fakeFetch(json([element(0, 0, 60)]));
    const maps = googleMaps(KEY, { fetch: f.fetch, now: () => NOW });
    await maps.routeMinutes([A], [B], new Date('2026-10-20T16:30:00.000Z'));
    await maps.routeMinutes([A], [B], new Date('2026-10-20T17:00:00.000Z'));
    expect(f.fn).toHaveBeenCalledTimes(2);
  });

  it('recognises an address regardless of case and spacing', async () => {
    const f = fakeFetch(json([element(0, 0, 60)]));
    const maps = googleMaps(KEY, { fetch: f.fetch, now: () => NOW });
    await maps.routeMinutes([A], [B], departure);
    const result = await maps.routeMinutes([{ address: `  ${A.address.toUpperCase()}  ` }], [B], departure);
    expect(result.requestedElements).toBe(0);
    expect(f.fn).toHaveBeenCalledTimes(1);
  });

  it('forgets a route element after 24 hours', async () => {
    const f = fakeFetch(json([element(0, 0, 60)]));
    const c = clock();
    const maps = googleMaps(KEY, { fetch: f.fetch, now: c.now });
    const later = new Date(NOW.getTime() + 48 * HOUR);
    await maps.routeMinutes([A], [B], later);
    c.advance(24 * HOUR - SECOND);
    await maps.routeMinutes([A], [B], later);
    expect(f.fn).toHaveBeenCalledTimes(1);
    c.advance(2 * SECOND);
    await maps.routeMinutes([A], [B], later);
    expect(f.fn).toHaveBeenCalledTimes(2);
  });

  it('asks only for the destinations that still have a missing pair', async () => {
    const f = fakeFetch(json([element(0, 0, 60), element(0, 1, 120), element(1, 0, 180), element(1, 1, 240)]), json([element(0, 0, 300), element(1, 0, 360)]));
    const maps = googleMaps(KEY, { fetch: f.fetch, now: () => NOW });
    await maps.routeMinutes([A, B], [C, D], departure);
    const result = await maps.routeMinutes([A, B], [C, D, A], departure);
    const body = bodyOf(f.calls()[1]!);
    expect(body.origins).toHaveLength(2);
    expect(body.destinations).toEqual([{ waypoint: { address: A.address } }]);
    expect(result.requestedElements).toBe(2);
    expect(result.minutes).toEqual([
      [1, 2, 5],
      [3, 4, 6],
    ]);
  });

  it('asks only for the origins that still have a missing pair', async () => {
    const f = fakeFetch(json([element(0, 0, 60), element(0, 1, 120)]), json([element(0, 0, 300), element(0, 1, 360)]));
    const maps = googleMaps(KEY, { fetch: f.fetch, now: () => NOW });
    await maps.routeMinutes([A], [C, D], departure);
    const result = await maps.routeMinutes([A, B], [C, D], departure);
    const body = bodyOf(f.calls()[1]!);
    expect(body.origins).toEqual([{ waypoint: { location: { latLng: { latitude: 33.5, longitude: -117.7 } } } }]);
    expect(body.destinations).toHaveLength(2);
    expect(result.requestedElements).toBe(2);
    expect(result.minutes).toEqual([
      [1, 2],
      [5, 6],
    ]);
  });

  it('keeps null answers in the cache too', async () => {
    const f = fakeFetch(json([{ originIndex: 0, destinationIndex: 0, condition: 'ROUTE_NOT_FOUND' }]));
    const maps = googleMaps(KEY, { fetch: f.fetch, now: () => NOW });
    await maps.routeMinutes([A], [B], departure);
    expect((await maps.routeMinutes([A], [B], departure)).minutes).toEqual([[null]]);
    expect(f.fn).toHaveBeenCalledTimes(1);
  });

  it.each([4, 8, 13, 14])('does not cache a transient element status (code %i): it is null now and asked for again next time', async (code) => {
    const f = fakeFetch(json([{ originIndex: 0, destinationIndex: 0, status: { code, message: 'try later' } }]), json([element(0, 0, 600)]));
    const maps = googleMaps(KEY, { fetch: f.fetch, now: () => NOW });
    const first = await maps.routeMinutes([A], [B], departure);
    expect(first).toEqual({ minutes: [[null]], requestedElements: 1 });
    const again = await maps.routeMinutes([A], [B], departure);
    expect(again).toEqual({ minutes: [[10]], requestedElements: 1 });
    expect(f.fn).toHaveBeenCalledTimes(2);
  });

  it('does cache the definitive nulls: status code 5 (NOT_FOUND) and ROUTE_NOT_FOUND', async () => {
    const f = fakeFetch(
      json([
        { originIndex: 0, destinationIndex: 0, status: { code: 5, message: 'not found' } },
        { originIndex: 0, destinationIndex: 1, condition: 'ROUTE_NOT_FOUND' },
      ]),
    );
    const maps = googleMaps(KEY, { fetch: f.fetch, now: () => NOW });
    await maps.routeMinutes([A], [B, C], departure);
    expect(await maps.routeMinutes([A], [B, C], departure)).toEqual({ minutes: [[null, null]], requestedElements: 0 });
    expect(f.fn).toHaveBeenCalledTimes(1);
  });

  it('does not cache an element it could not read (no usable duration)', async () => {
    const f = fakeFetch(json([{ originIndex: 0, destinationIndex: 0, condition: 'ROUTE_EXISTS' }]), json([element(0, 0, 600)]));
    const maps = googleMaps(KEY, { fetch: f.fetch, now: () => NOW });
    expect((await maps.routeMinutes([A], [B], departure)).minutes).toEqual([[null]]);
    expect((await maps.routeMinutes([A], [B], departure)).minutes).toEqual([[10]]);
  });

  it('makes no request for an empty matrix', async () => {
    const f = fakeFetch(json([]));
    const maps = googleMaps(KEY, { fetch: f.fetch, now: () => NOW });
    expect(await maps.routeMinutes([], [B], departure)).toEqual({ minutes: [], requestedElements: 0 });
    expect(await maps.routeMinutes([A, B], [], departure)).toEqual({ minutes: [[], []], requestedElements: 0 });
    expect(f.fn).not.toHaveBeenCalled();
  });

  it('keeps at most 10,000 route elements, evicting the oldest first', async () => {
    const f = fakeFetch(() => json([element(0, 0, 60)]));
    const maps = googleMaps(KEY, { fetch: f.fetch, now: () => NOW });
    const at = (i: number): Place => ({ point: { lat: 33 + i / 100_000, lng: -117 } });
    for (let i = 0; i <= 10_000; i += 1) await maps.routeMinutes([at(i)], [B], departure);
    expect(f.fn).toHaveBeenCalledTimes(10_001);
    await maps.routeMinutes([at(10_000)], [B], departure);
    expect(f.fn).toHaveBeenCalledTimes(10_001);
    await maps.routeMinutes([at(0)], [B], departure);
    expect(f.fn).toHaveBeenCalledTimes(10_002);
  });

  const codeOf = async (p: Promise<unknown>): Promise<string> => {
    const err = await p.then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(MapsUnavailableError);
    return (err as MapsUnavailableError).code;
  };

  it.each([
    ['http_503', () => json({ error: { message: 'down' } }, 503)],
    ['http_400', () => json({ error: {} }, 400)],
    ['bad_response', () => new Response('not json')],
    ['bad_response', () => json({ error: { code: 400 } })],
    ['bad_response', () => json([{ originIndex: 7, destinationIndex: 0, duration: '60s' }])],
    ['bad_response', () => json([{ originIndex: 'x' }])],
  ])('throws %s for a failing answer', async (code, answer) => {
    const f = fakeFetch(answer);
    expect(await codeOf(googleMaps(KEY, { fetch: f.fetch, now: () => NOW }).routeMinutes([A], [B], departure))).toBe(code);
  });

  it('throws timeout and network for transport failures', async () => {
    expect(await codeOf(googleMaps(KEY, { fetch: fakeFetch(new DOMException('x', 'TimeoutError')).fetch, now: () => NOW }).routeMinutes([A], [B], departure))).toBe('timeout');
    expect(await codeOf(googleMaps(KEY, { fetch: fakeFetch(new TypeError('fetch failed')).fetch, now: () => NOW }).routeMinutes([A], [B], departure))).toBe('network');
  });

  it('does not cache a failure', async () => {
    const f = fakeFetch(json({}, 500), json([element(0, 0, 600)]));
    const maps = googleMaps(KEY, { fetch: f.fetch, now: () => NOW });
    await expect(maps.routeMinutes([A], [B], departure)).rejects.toBeInstanceOf(MapsUnavailableError);
    expect((await maps.routeMinutes([A], [B], departure)).minutes).toEqual([[10]]);
  });

  it('never puts an address or the key in an error message', async () => {
    const leaky = new TypeError(`fetch failed ${KEY} ${A.address}`);
    for (const answer of [leaky, json({ error: { message: `${A.address} ${KEY}` } }, 400)]) {
      const err = await googleMaps(KEY, { fetch: fakeFetch(answer).fetch, now: () => NOW })
        .routeMinutes([A], [B], departure)
        .then(
          () => null,
          (e: unknown) => e as Error,
        );
      const shown = `${err!.message} ${err!.stack ?? ''} ${JSON.stringify(err)}`;
      expect(shown).not.toContain(KEY);
      expect(shown).not.toContain('Fake Alpha');
      expect(shown).not.toContain('googleapis');
    }
  });
});

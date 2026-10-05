/**
 * Where cti-api listens. '::' is dual-stack on Linux: public traffic (IPv4) is unchanged,
 * and Railway private networking (IPv6-only in older environments) can reach the internal
 * AI call routes (plan 1C). The port is cfg.API_PORT, which config.ts takes from PORT.
 */
export const LISTEN_HOST = '::';

export function listenOptions(port: number): { port: number; host: string } {
  return { port, host: LISTEN_HOST };
}

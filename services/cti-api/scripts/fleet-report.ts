#!/usr/bin/env npx tsx
/** The sub-project-A acceptance gate: every active number fully provisioned, every rep at 6 LA / 6 SD, pool at 50. */
import pg from 'pg';
import { classifyArea } from '../src/fleet/plan.js';
const PROFILE = 'BUfffd7ec178a44a108e81f2a1e03d0b2d', SHAKEN = 'BU9aacbc2ad2856cd5a8167c8d556d3a16';
const ACCOUNT = process.env.TWILIO_ACCOUNT_SID!, TOKEN = process.env.TWILIO_AUTH_TOKEN!;
const auth = 'Basic ' + Buffer.from(`${ACCOUNT}:${TOKEN}`).toString('base64');
async function all(url: string, key: string): Promise<any[]> {
  let out: any[] = [], next: string | null = url;
  while (next) { const r = await fetch(next, { headers: { Authorization: auth } }); const j: any = await r.json(); if (!r.ok) throw new Error(`${r.status} ${next}`); out = out.concat(j[key] ?? []); next = j.meta?.next_page_url ?? (j.next_page_uri ? 'https://api.twilio.com' + j.next_page_uri : null); }
  return out;
}
const c = new pg.Client({ connectionString: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await c.connect();
const db = (await c.query(`select n.e164, n.kind, n.twilio_sid, n.health_source, u.email from outbound_numbers n left join users u on u.id = n.assigned_user_id where n.active order by n.kind, u.email nulls last, n.e164`)).rows;
const tw = new Map((await all(`https://api.twilio.com/2010-04-01/Accounts/${ACCOUNT}/IncomingPhoneNumbers.json?PageSize=100`, 'incoming_phone_numbers')).map((n: any) => [n.phone_number, n]));
const inProfile = new Set((await all(`https://trusthub.twilio.com/v1/CustomerProfiles/${PROFILE}/ChannelEndpointAssignments?PageSize=100`, 'results')).map((a: any) => a.channel_endpoint_sid));
const inShaken = new Set((await all(`https://trusthub.twilio.com/v1/TrustProducts/${SHAKEN}/ChannelEndpointAssignments?PageSize=100`, 'results')).map((a: any) => a.channel_endpoint_sid));
let fail = 0;
const perRep = new Map<string, { LA: number; SD: number }>();
for (const n of db) {
  const t: any = tw.get(n.e164);
  const webhookOk = !!t && /\/telephony\/twilio\/inbound$/.test(t.voice_url ?? '');
  const checks = { db: true, twilio: !!t, webhook: webhookOk, trusthub: !!t && inProfile.has(t.sid), shaken: !!t && inShaken.has(t.sid) };
  if (Object.values(checks).some((v) => !v)) fail++;
  const area = classifyArea(n.e164);
  if (n.email && n.kind === 'agent' && area !== 'other') { const p = perRep.get(n.email) ?? { LA: 0, SD: 0 }; p[area]++; perRep.set(n.email, p); }
  console.log([n.e164, n.kind, n.email ?? '-', area, ...Object.entries(checks).map(([k, v]) => `${k}${v ? '✓' : '✗'}`), n.health_source === 'numberverifier' ? 'nv:yes' : 'nv:pending'].join(' | '));
}
for (const [email, p] of perRep) console.log(`REP ${email}: ${p.LA}/6 LA, ${p.SD}/6 SD ${p.LA >= 6 && p.SD >= 6 ? '✓' : '✗ SHORT'}`);
const pool = db.filter((n) => n.kind === 'dialer_pool').length;
console.log(`POOL: ${pool}/50 ${pool >= 50 ? '✓' : '✗ SHORT'}`);
console.log(fail ? `FAIL: ${fail} number(s) not fully provisioned` : 'ALL PROVISIONED');
await c.end();
process.exit(fail ? 1 : 0);

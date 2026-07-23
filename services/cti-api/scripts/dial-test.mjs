// Power-dialer test harness for GG Homes prod.
//
// Standing test data (already created in SF org gghsd):
//   - Opportunities "CTI DIAL TEST 1/2/3", each with a primary Contact whose
//     Mobile + Phone = +12054303297.
//   - +12054303297 ("CTI TEST TARGET") is a Twilio number we own with inbound
//     DISABLED, so a dial to it is answered benignly by /telephony/twilio/inbound
//     ("this line cannot accept inbound calls" + hangup) and rings NO rep. Its
//     recorded greeting reads to AMD as a machine → a clean no_connect, so a run
//     advances through all three opps.
//
// Usage (DB creds come from the Postgres service):
//   MODE=trigger railway run -s Postgres node scripts/dial-test.mjs
//       → queues a Power Dial handoff for the rep; their OPEN softphone claims it
//         within ~5s and dials the three test opps. NOTE the softphone only
//         auto-claims when it is NOT already showing a run — reload it / click
//         "Start another run" first. Cleaner alternative: the rep picks a
//         "CTI Dial Test" list view in the softphone's Power Dial tab.
//   railway run -s Postgres node scripts/dial-test.mjs         (default: report)
//       → prints the rep's latest run + every item (number dialed, pool DID,
//         outcome). Cross-check the actual Twilio calls with the Twilio console
//         or the API (from the @cti/api service, which holds the Twilio creds).
//
// GOTCHA: the dialer only calls during 8am-9pm in the TARGET number's timezone
// (+1205 = Central). Outside that window every item is skipped 'out_of_hours' —
// this is the TCPA guard working, not a bug. Run the test during business hours.
import pg from 'pg';

const REP_USER_ID = 'c9c45940-0f17-4c1e-bb3e-d084ba93eb86'; // evren@gghomessd.com (CTI users.id)
const REP_SF_USER_ID = '0055f000004OhNiAAK';
const ORG_ID = '03920326-b8c5-4aa4-b1d8-14f367e14ebc';
const TEST_OPP_IDS = ['006US00000gHuDhYAK', '006US00000gHqOdYAK', '006US00000gHmw7YAC'];

const c = new pg.Client({ connectionString: process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await c.connect();
try {
  if (process.env.MODE === 'trigger') {
    await c.query("delete from dialer_handoffs where salesforce_user_id=$1 and status='pending'", [REP_SF_USER_ID]);
    const r = await c.query(
      `insert into dialer_handoffs (org_id, salesforce_user_id, object_type, record_ids, status)
       values ($1,$2,'Opportunity',$3::jsonb,'pending') returning id, created_at`,
      [ORG_ID, REP_SF_USER_ID, JSON.stringify(TEST_OPP_IDS)]);
    console.log('QUEUED handoff', JSON.stringify(r.rows[0]), '— open/refresh the softphone so it claims it.');
  } else {
    const s = await c.query(
      "select id, status, created_at from dialer_sessions where user_id=$1 order by created_at desc limit 1", [REP_USER_ID]);
    if (!s.rows[0]) { console.log('no dialer sessions for this rep yet'); }
    else {
      console.log('LATEST RUN', JSON.stringify(s.rows[0]));
      const qi = await c.query(
        `select ordinal, status, outcome, record_id, to_number, from_number, call_id
         from dialer_queue_items where session_id=$1 order by ordinal`, [s.rows[0].id]);
      for (const it of qi.rows) console.log('  item', JSON.stringify(it));
    }
  }
} finally { await c.end(); }

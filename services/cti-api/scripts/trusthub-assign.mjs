// Trust Hub bundles this account is approved for (verified twilio-approved on 2026-08-23):
//   Primary Business Profile: BUfffd7ec178a44a108e81f2a1e03d0b2d
//   SHAKEN/STIR trust product: BU9aacbc2ad2856cd5a8167c8d556d3a16
//
// Assign every incoming phone number to the approved Primary Business Profile and the
// approved SHAKEN/STIR trust product. Idempotent: skips numbers already assigned.
const sid = process.env.TWILIO_ACCOUNT_SID, tok = process.env.TWILIO_AUTH_TOKEN, ksid = process.env.TWILIO_API_KEY_SID, ksec = process.env.TWILIO_API_KEY_SECRET;
const auth = 'Basic ' + Buffer.from(ksid && ksec ? `${ksid}:${ksec}` : `${sid}:${tok}`).toString('base64');
const PROFILE = 'BUfffd7ec178a44a108e81f2a1e03d0b2d';   // Primary Customer Profile (Femund LLC), twilio-approved
const SHAKEN  = 'BU9aacbc2ad2856cd5a8167c8d556d3a16';   // SHAKEN/STIR trust product (Femund LLC), twilio-approved
async function get(u){ const r=await fetch(u,{headers:{Authorization:auth}}); const j=await r.json(); if(!r.ok) throw new Error(`${r.status} ${u}: ${JSON.stringify(j).slice(0,200)}`); return j; }
async function all(u,k){ let out=[],n=u; while(n){ const j=await get(n); out=out.concat(j[k]??[]); n=j.meta?.next_page_url ?? (j.next_page_uri?'https://api.twilio.com'+j.next_page_uri:null);} return out; }
async function assign(kind, bu, pn){ const r=await fetch(`https://trusthub.twilio.com/v1/${kind}/${bu}/ChannelEndpointAssignments`,{method:'POST',headers:{Authorization:auth,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({ChannelEndpointType:'phone-number',ChannelEndpointSid:pn})}); const j=await r.json(); return [r.status, j.sid ?? j.message ?? JSON.stringify(j).slice(0,120)]; }
const nums = await all(`https://api.twilio.com/2010-04-01/Accounts/${sid}/IncomingPhoneNumbers.json?PageSize=100`,'incoming_phone_numbers');
let anyFailed = false;
for (const [kind,bu,label] of [['CustomerProfiles',PROFILE,'business profile'],['TrustProducts',SHAKEN,'SHAKEN/STIR']]) {
  const have = new Set((await all(`https://trusthub.twilio.com/v1/${kind}/${bu}/ChannelEndpointAssignments?PageSize=100`,'results')).map(a=>a.channel_endpoint_sid));
  let ok=0, skipped=0, failed=0;
  for (const n of nums) {
    if (have.has(n.sid)) { skipped++; continue; }
    const [st,msg] = await assign(kind,bu,n.sid);
    if (st===201) ok++; else { failed++; anyFailed = true; console.log(`  FAIL ${label} ${n.phone_number}: ${st} ${msg}`); }
  }
  const after = await all(`https://trusthub.twilio.com/v1/${kind}/${bu}/ChannelEndpointAssignments?PageSize=100`,'results');
  console.log(`${label}: assigned ${ok}, already ${skipped}, failed ${failed} → now ${after.length}/${nums.length}`);
}
if (anyFailed) process.exit(1);

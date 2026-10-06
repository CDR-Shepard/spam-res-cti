import { describe, expect, it, vi } from 'vitest';
import { SalesforceClient } from './client.js';
import {
  convertLead,
  convertLeadEnvelope,
  getUserInfo,
  parseConvertLeadResponse,
  xmlEscape,
  type ConvertLeadRequest,
} from './convert-lead.js';
import { SalesforceApiError, SalesforceAuthError } from './errors.js';
import { fakeFetch, type FakeScript } from './fake-fetch.js';

const INSTANCE = 'https://x.my.salesforce.com';
const LEAD = '00Q8X00000AbCdEUAV';
const OWNER = '0058X00000Fsx39QAB';

function client(script: FakeScript) {
  const http = fakeFetch(script);
  const tokens = {
    current: vi.fn(async () => ({ accessToken: 'tok-1', instanceUrl: INSTANCE })),
    refresh: vi.fn(async () => ({ accessToken: 'tok-2', instanceUrl: INSTANCE })),
  };
  return { sf: new SalesforceClient({ tokens, apiVersion: 'v62.0', fetchImpl: http.impl }), http, tokens };
}

const request: ConvertLeadRequest = {
  leadId: LEAD,
  convertedStatus: 'Qualified',
  ownerId: OWNER,
  opportunityName: 'Jane Seller',
  sendNotificationEmail: false,
};

const envelope = (body: string) =>
  `<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns="urn:partner.soap.sforce.com" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><soapenv:Header><LimitInfoHeader><limitInfo><current>12</current><limit>15000</limit><type>API REQUESTS</type></limitInfo></LimitInfoHeader></soapenv:Header><soapenv:Body>${body}</soapenv:Body></soapenv:Envelope>`;

const SUCCESS = envelope(
  `<convertLeadResponse><result><accountId>0018X00000Acct1QAA</accountId><contactId>0038X00000Cont1QAA</contactId><leadId>${LEAD}</leadId><opportunityId>0068X00000Oppt1QAA</opportunityId><success>true</success></result></convertLeadResponse>`,
);

const FAILURE = envelope(
  '<convertLeadResponse><result><accountId xsi:nil="true"/><contactId xsi:nil="true"/>' +
    '<errors><fields>LeadSource</fields><fields>Phone</fields><message>Lead Source &amp; Phone are required &lt;before&gt; converting</message><statusCode>FIELD_CUSTOM_VALIDATION_EXCEPTION</statusCode></errors>' +
    '<errors><message>Cannot update a converted lead</message><statusCode>CANNOT_UPDATE_CONVERTED_LEAD</statusCode></errors>' +
    '<leadId xsi:nil="true"/><opportunityId xsi:nil="true"/><success>false</success></result></convertLeadResponse>',
);

const fault = (code: string, text: string) =>
  envelope(
    `<soapenv:Fault><faultcode>sf:${code}</faultcode><faultstring>${text}</faultstring><detail><sf:UnexpectedErrorFault xmlns:sf="urn:fault.partner.soap.sforce.com" xsi:type="sf:UnexpectedErrorFault"><sf:exceptionCode>${code}</sf:exceptionCode><sf:exceptionMessage>${text}</sf:exceptionMessage></sf:UnexpectedErrorFault></detail></soapenv:Fault>`,
  );
const SESSION_FAULT = fault('INVALID_SESSION_ID', 'Invalid Session ID found in SessionHeader: Illegal Session');

const USER_INFO = envelope(
  '<getUserInfoResponse><result><accessibilityMode>false</accessibilityMode><currencySymbol>$</currencySymbol><organizationId>00D8X000000GgHmUAK</organizationId><organizationName>GG Homes</organizationName><userDefaultCurrencyIsoCode xsi:nil="true"/><userEmail>integration@gghomes.com</userEmail><userFullName>Integration User</userFullName><userId>0058X00000Integ1QAA</userId><userName>integration@gghomes.com</userName></result></getUserInfoResponse>',
);

const squash = (xml: string) => xml.replace(/>\s+</g, '><').trim();

describe('convertLeadEnvelope', () => {
  it('1: builds exactly the partner convertLead body', () => {
    expect(squash(convertLeadEnvelope(request))).toBe(
      squash(`<urn:convertLead xmlns:urn="urn:partner.soap.sforce.com">
  <urn:leadConverts>
    <urn:convertedStatus>Qualified</urn:convertedStatus>
    <urn:doNotCreateOpportunity>false</urn:doNotCreateOpportunity>
    <urn:leadId>${LEAD}</urn:leadId>
    <urn:opportunityName>Jane Seller</urn:opportunityName>
    <urn:overwriteLeadSource>false</urn:overwriteLeadSource>
    <urn:ownerId>${OWNER}</urn:ownerId>
    <urn:sendNotificationEmail>false</urn:sendNotificationEmail>
  </urn:leadConverts>
</urn:convertLead>`),
    );
  });

  it('1: escapes every value', () => {
    const xml = convertLeadEnvelope({ ...request, opportunityName: 'Tom & "Jo" <x>', convertedStatus: "It's <done>" });
    expect(xml).toContain('<urn:opportunityName>Tom &amp; &quot;Jo&quot; &lt;x&gt;</urn:opportunityName>');
    expect(xml).toContain('<urn:convertedStatus>It&apos;s &lt;done&gt;</urn:convertedStatus>');
    expect(xmlEscape(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&apos;');
  });

  it('a true sendNotificationEmail is sent as true', () => {
    expect(convertLeadEnvelope({ ...request, sendNotificationEmail: true })).toContain('<urn:sendNotificationEmail>true</urn:sendNotificationEmail>');
  });

  it.each([
    ['a lead id with a quote', { leadId: "00Q'; drop" }],
    ['a lead id that is not a Lead', { leadId: '0018X00000Acct1QAA' }],
    ['an owner id that is not a User', { ownerId: '00G8X00000Queue1QA' }],
    ['an empty converted status', { convertedStatus: ' ' }],
    ['an empty opportunity name', { opportunityName: '' }],
    ['a 121-character opportunity name', { opportunityName: 'x'.repeat(121) }],
  ])('9: %s throws RangeError', (_label, patch) => {
    expect(() => convertLeadEnvelope({ ...request, ...patch })).toThrow(RangeError);
  });
});

describe('parseConvertLeadResponse', () => {
  it('3: a success gives the four ids', () => {
    expect(parseConvertLeadResponse(SUCCESS)).toEqual({
      success: true,
      leadId: LEAD,
      accountId: '0018X00000Acct1QAA',
      contactId: '0038X00000Cont1QAA',
      opportunityId: '0068X00000Oppt1QAA',
    });
  });

  it('4: a refusal gives every error, its fields and its un-escaped message', () => {
    expect(parseConvertLeadResponse(FAILURE)).toEqual({
      success: false,
      errors: [
        { statusCode: 'FIELD_CUSTOM_VALIDATION_EXCEPTION', message: 'Lead Source & Phone are required <before> converting', fields: ['LeadSource', 'Phone'] },
        { statusCode: 'CANNOT_UPDATE_CONVERTED_LEAD', message: 'Cannot update a converted lead', fields: [] },
      ],
    });
  });

  it('7: a fault throws SalesforceApiError with the fault code, prefix stripped', () => {
    const xml = fault('INSUFFICIENT_ACCESS', 'insufficient access rights on cross-reference id');
    expect(() => parseConvertLeadResponse(xml)).toThrow(SalesforceApiError);
    try {
      parseConvertLeadResponse(xml);
    } catch (err) {
      expect((err as SalesforceApiError).code).toBe('INSUFFICIENT_ACCESS');
      expect((err as SalesforceApiError).message).toContain('insufficient access rights');
    }
  });

  it('D-5: an unreadable 2xx body is MALFORMED_RESPONSE (permanent); an unreadable 5xx body has no code (transient)', () => {
    expect(() => parseConvertLeadResponse(envelope('<convertLeadResponse/>'), 200)).toThrow(expect.objectContaining({ code: 'MALFORMED_RESPONSE' }));
    try {
      parseConvertLeadResponse('<html>Service Unavailable</html>', 503);
      expect.unreachable();
    } catch (err) {
      expect((err as SalesforceApiError).code).toBeUndefined();
      expect((err as SalesforceApiError).status).toBe(503);
    }
  });

  it('a body with no result, or a success without ids, is unusable', () => {
    expect(() => parseConvertLeadResponse('<html>Service Unavailable</html>')).toThrow(SalesforceApiError);
    const noIds = envelope('<convertLeadResponse><result><success>true</success></result></convertLeadResponse>');
    expect(() => parseConvertLeadResponse(noIds)).toThrow(SalesforceApiError);
  });
});

describe('SalesforceClient.soap and convertLead', () => {
  it('2: posts the envelope to /services/Soap/u/62.0 with the SOAP headers and the token in the SessionHeader', async () => {
    const { sf, http } = client([{ status: 200, text: SUCCESS }]);
    const result = await convertLead(sf, request);
    expect(result.success).toBe(true);
    const call = http.calls[0]!;
    expect(call.method).toBe('POST');
    expect(call.url).toBe(`${INSTANCE}/services/Soap/u/62.0`);
    expect(call.headers['content-type']).toBe('text/xml; charset=UTF-8');
    expect(call.headers.SOAPAction).toBe('""');
    expect(call.headers).not.toHaveProperty('authorization');
    const body = squash(call.body ?? '');
    expect(body).toContain('<urn:SessionHeader><urn:sessionId>tok-1</urn:sessionId></urn:SessionHeader>');
    expect(body).toContain(`<env:Body>${squash(convertLeadEnvelope(request))}</env:Body>`);
    expect(body.startsWith('<?xml version="1.0" encoding="UTF-8"?><env:Envelope xmlns:env="http://schemas.xmlsoap.org/soap/envelope/" xmlns:urn="urn:partner.soap.sforce.com">')).toBe(true);
  });

  it('4: a refusal comes back as success false, not a throw', async () => {
    const { sf } = client([{ status: 200, text: FAILURE }]);
    const result = await convertLead(sf, request);
    expect(result.success).toBe(false);
  });

  it('5: an INVALID_SESSION_ID fault refreshes the token once and the second send succeeds', async () => {
    const { sf, http, tokens } = client([
      { status: 500, text: SESSION_FAULT },
      { status: 200, text: SUCCESS },
    ]);
    expect((await convertLead(sf, request)).success).toBe(true);
    expect(tokens.refresh).toHaveBeenCalledTimes(1);
    expect(http.calls[1]!.body).toContain('<urn:sessionId>tok-2</urn:sessionId>');
  });

  it('an HTTP 401 also refreshes once', async () => {
    const { sf, tokens } = client([{ status: 401, text: '' }, { status: 200, text: SUCCESS }]);
    expect((await convertLead(sf, request)).success).toBe(true);
    expect(tokens.refresh).toHaveBeenCalledTimes(1);
  });

  it('6: two session faults throw SalesforceAuthError', async () => {
    const { sf, http } = client([
      { status: 500, text: SESSION_FAULT },
      { status: 500, text: SESSION_FAULT },
    ]);
    await expect(convertLead(sf, request)).rejects.toBeInstanceOf(SalesforceAuthError);
    expect(http.calls).toHaveLength(2);
  });

  it('7: an INSUFFICIENT_ACCESS fault throws SalesforceApiError with that code, without a refresh', async () => {
    const { sf, tokens } = client([{ status: 500, text: fault('INSUFFICIENT_ACCESS', 'no') }]);
    await expect(convertLead(sf, request)).rejects.toMatchObject({ name: 'SalesforceApiError', code: 'INSUFFICIENT_ACCESS' });
    expect(tokens.refresh).not.toHaveBeenCalled();
  });

  it('a network failure is a transient SalesforceApiError (status 0)', async () => {
    const { sf } = client(() => {
      throw new TypeError('fetch failed');
    });
    await expect(sf.soap('<urn:getUserInfo xmlns:urn="urn:partner.soap.sforce.com"/>')).rejects.toMatchObject({ name: 'SalesforceApiError', status: 0 });
  });

  it('D-5: a success for another Lead than the one asked is unusable (MALFORMED_RESPONSE), never trusted', async () => {
    const other = SUCCESS.replace(`<leadId>${LEAD}</leadId>`, '<leadId>00Q8X00000ZzZzZUAV</leadId>');
    const { sf } = client([{ status: 200, text: other }]);
    await expect(convertLead(sf, request)).rejects.toMatchObject({ name: 'SalesforceApiError', code: 'MALFORMED_RESPONSE' });
  });

  it('D-5: the 15-character core of the answered Lead id is enough', async () => {
    const { sf } = client([{ status: 200, text: SUCCESS.replace(`<leadId>${LEAD}</leadId>`, `<leadId>${LEAD.slice(0, 15)}</leadId>`) }]);
    expect((await convertLead(sf, request)).success).toBe(true);
  });

  it('9: a bad lead id never reaches Salesforce', async () => {
    const { sf, http } = client([]);
    await expect(convertLead(sf, { ...request, leadId: "00Q'; drop" })).rejects.toBeInstanceOf(RangeError);
    expect(http.calls).toHaveLength(0);
  });
});

describe('getUserInfo', () => {
  it('8: reads the user, login and org', async () => {
    const { sf, http } = client([{ status: 200, text: USER_INFO }]);
    expect(await getUserInfo(sf)).toEqual({ userId: '0058X00000Integ1QAA', userName: 'integration@gghomes.com', organizationId: '00D8X000000GgHmUAK' });
    expect(squash(http.calls[0]!.body ?? '')).toContain('<env:Body><urn:getUserInfo xmlns:urn="urn:partner.soap.sforce.com"/></env:Body>');
  });

  it('a fault or a missing user id throws SalesforceApiError', async () => {
    const { sf } = client([{ status: 500, text: fault('API_DISABLED_FOR_ORG', 'API is not enabled') }]);
    await expect(getUserInfo(sf)).rejects.toMatchObject({ code: 'API_DISABLED_FOR_ORG' });
    const { sf: sf2 } = client([{ status: 200, text: envelope('<getUserInfoResponse><result></result></getUserInfoResponse>') }]);
    await expect(getUserInfo(sf2)).rejects.toBeInstanceOf(SalesforceApiError);
  });
});

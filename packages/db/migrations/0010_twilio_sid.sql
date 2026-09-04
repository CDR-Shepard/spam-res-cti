-- Store each DID's Twilio IncomingPhoneNumber SID (PN…) so an admin can import
-- the org's owned numbers from Twilio in one click, and so inbound-webhook
-- registration can look up the SID without it being re-supplied by hand.
alter table outbound_numbers add column if not exists twilio_sid text;

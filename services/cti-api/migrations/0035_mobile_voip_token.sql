-- Callsign iPhone app: PushKit VoIP token per device (Twilio delivers the ring;
-- we keep the token for device management). Additive; apns_token stays for the
-- deferred silent-push feature.
alter table mobile_devices add column if not exists voip_token text;

-- =============================================================================
-- 0007_numberverifier.sql — NumberVerifier caller-ID reputation integration.
--
-- NumberVerifier (app.numberverifier.com) monitors each DID's "Spam Likely" /
-- "Scam Likely" status across AT&T / Verizon / T-Mobile and POSTs a webhook
-- whenever a number is checked. We ingest that webhook to drive DID health from
-- real carrier ground truth instead of behavioral proxies.
--
-- Adds outbound_numbers.health_source so a "clean" webhook only restores a DID
-- that NumberVerifier itself paused — never one paused by the behavioral worker
-- or a live-call analytics block.
-- =============================================================================

alter table outbound_numbers
  add column if not exists health_source text;

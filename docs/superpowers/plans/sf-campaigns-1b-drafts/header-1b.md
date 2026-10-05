# Salesforce Campaigns, Phase 1B (Live Calls and Write-Back) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Campaign call touches reach reps through the CTI power dialer's "Campaign calls" button, their outcomes flow back into the campaign, consent is captured into Salesforce through new consent fields, Salesforce writes go through a retrying outbox, and kill switches and automatic pauses guard everything; then it deploys.

**Architecture:** Builds on plan 1A (`2026-10-04-sf-campaigns-1a-dry-run.md`), which must be merged first. Salesforce metadata ships the consent fields and an `AI_Outreach` permission set. outreach-api adds the `sf.write` and `calls.reconcile` ticks, consent capture and backfill, and a global kill switch. cti-api gains two dialer routes that claim queued campaign touches and build a normal power-dial run; cti-web gains a Campaign calls picker. Every dialer gate is unchanged.

**Tech Stack:** as plan 1A, plus Salesforce DX metadata (`sf project deploy start`), the existing cti-api/cti-web stacks, and Railway Infrastructure as Code.

**Spec:** `docs/superpowers/specs/2026-10-04-outreach-salesforce-campaigns-design.md` (phase 1 of §3: §10.1, §11, §11.1, §12).


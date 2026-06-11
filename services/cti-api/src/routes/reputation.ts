/**
 * Per-DID reputation scoring — modeled on Hiya's public "Caller Reputation"
 * credit score (launched Sept 2025): Maturity / Connection / Engagement /
 * Sentiment. Each is a 0-100 sub-score; the composite is the min of the four
 * (Hiya weights heavily on the weakest axis, mirroring credit-score behavior).
 *
 * Sources are entirely from our own DB. As soon as we wire Hiya/First Orion/
 * TNS portal feeds in P1, we can swap individual axes for real provider data.
 */
import type { FastifyInstance } from 'fastify';
import { and, eq, gte, sql } from 'drizzle-orm';
import { resolveSession } from '../auth/session.js';
import { getDb, schema } from '../db/index.js';
import { warmupCapForAge } from '../firewall/index.js';

interface AxisScore {
  value: number;        // 0-100
  grade: 'A' | 'B' | 'C' | 'D' | 'F';
  detail: string;
}
interface NumberReputation {
  numberId: string;
  e164: string;
  label: string | null;
  health: string;
  shakenAttestationDistribution: Record<'A' | 'B' | 'C' | 'unknown', number>;
  daysSinceFirstUse: number | null;
  warmupTier: number;
  warmupCap: number;
  dialsToday: number;
  dialsLast7d: number;
  avgDurationLast7dSec: number | null;
  answerRate: number; // 0-1
  sub6sRate: number;  // 0-1
  attestationABRate: number; // 0-1 fraction of calls that came back A or B
  axes: {
    maturity: AxisScore;
    connection: AxisScore;
    engagement: AxisScore;
    sentiment: AxisScore;
  };
  composite: { value: number; grade: 'A' | 'B' | 'C' | 'D' | 'F' };
}

function gradeOf(v: number): 'A' | 'B' | 'C' | 'D' | 'F' {
  if (v >= 90) return 'A';
  if (v >= 75) return 'B';
  if (v >= 60) return 'C';
  if (v >= 40) return 'D';
  return 'F';
}

function clamp01(x: number): number { return Math.max(0, Math.min(1, x)); }

export async function registerReputationRoutes(app: FastifyInstance): Promise<void> {
  app.get('/reputation', async (req, reply) => {
    const session = await resolveSession(req.headers.authorization);
    if (!session) return reply.code(401).send({ error: 'Unauthorized' });
    const db = getDb();
    const numbers = await db
      .select()
      .from(schema.outboundNumbers)
      .where(eq(schema.outboundNumbers.orgId, session.orgId));

    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000);
    const results: NumberReputation[] = [];

    for (const n of numbers) {
      // Pull last 7d of calls placed from this DID
      const calls = await db
        .select()
        .from(schema.calls)
        .where(
          and(
            eq(schema.calls.orgId, session.orgId),
            eq(schema.calls.fromNumber, n.e164),
            gte(schema.calls.createdAt, sevenDaysAgo),
          ),
        );

      const total = calls.length;
      const answered = calls.filter((c) => c.answeredAt != null || (c.durationSeconds ?? 0) > 0).length;
      const connectedDurations = calls
        .map((c) => c.durationSeconds ?? 0)
        .filter((d) => d > 0);
      const avgDur = connectedDurations.length
        ? connectedDurations.reduce((a, b) => a + b, 0) / connectedDurations.length
        : null;
      const sub6 = connectedDurations.filter((d) => d > 0 && d < 6).length;

      // Attestation distribution
      const att: Record<'A' | 'B' | 'C' | 'unknown', number> = { A: 0, B: 0, C: 0, unknown: 0 };
      for (const c of calls) {
        const a = (c as { shakenAttestation?: string | null }).shakenAttestation;
        if (a === 'A' || a === 'B' || a === 'C') att[a]++;
        else att.unknown++;
      }
      const abRate = total > 0 ? (att.A + att.B) / total : 1;

      const daysSinceFirstUse = n.firstUsedAt
        ? Math.floor((Date.now() - n.firstUsedAt.getTime()) / 86_400_000)
        : null;
      const curve = warmupCapForAge(daysSinceFirstUse);

      // ---- Hiya 4-axis model ----
      // Maturity: caps at 100 once a DID has 4+ weeks of history. Penalized
      // heavily for fresh DIDs and (per Hiya docs) for "rotating" patterns.
      // Curve: day 0 = 15, day 7 = 45, day 14 = 70, day 21 = 88, day 28+ = 100
      const maturityRaw = daysSinceFirstUse === null
        ? 15
        : Math.min(100, 15 + daysSinceFirstUse * 3.1);
      const maturity: AxisScore = {
        value: Math.round(maturityRaw),
        grade: gradeOf(maturityRaw),
        detail: daysSinceFirstUse === null
          ? 'Brand new — no history yet'
          : `${daysSinceFirstUse} days in service · tier ${curve.tier}`,
      };

      // Connection: answer rate. Branded calling lifts ~5%→~30%.
      // Map: 0% → 0, 5% → 30, 15% → 60, 25%+ → 90, 35%+ → 100.
      const ar = total > 0 ? answered / total : 0;
      let connectionRaw = 0;
      if (ar >= 0.35) connectionRaw = 100;
      else if (ar >= 0.25) connectionRaw = 90 + (ar - 0.25) * 100;
      else if (ar >= 0.15) connectionRaw = 60 + (ar - 0.15) * 300;
      else if (ar >= 0.05) connectionRaw = 30 + (ar - 0.05) * 300;
      else connectionRaw = ar * 600;
      // Tiny sample = neutral 70 (don't punish a brand-new DID with 0 dials)
      if (total < 5) connectionRaw = 70;
      const connection: AxisScore = {
        value: Math.round(connectionRaw),
        grade: gradeOf(connectionRaw),
        detail: total > 0
          ? `${Math.round(ar * 100)}% answered (${answered}/${total} last 7d)`
          : 'No calls yet',
      };

      // Engagement: average duration. <6s = robocall fingerprint.
      // Map: 0s → 0, 6s → 30, 15s → 60, 30s → 80, 60s+ → 95, 120s+ → 100.
      const dur = avgDur ?? 0;
      let engagementRaw = 0;
      if (dur >= 120) engagementRaw = 100;
      else if (dur >= 60) engagementRaw = 95 + (dur - 60) / 12;
      else if (dur >= 30) engagementRaw = 80 + (dur - 30) / 2;
      else if (dur >= 15) engagementRaw = 60 + ((dur - 15) * 4) / 3;
      else if (dur >= 6) engagementRaw = 30 + ((dur - 6) * 10) / 3;
      else engagementRaw = dur * 5;
      if (connectedDurations.length < 3) engagementRaw = 70; // neutral on small samples
      const engagement: AxisScore = {
        value: Math.round(engagementRaw),
        grade: gradeOf(engagementRaw),
        detail: avgDur != null
          ? `${Math.round(avgDur)}s avg · ${Math.round((sub6 / Math.max(1, connectedDurations.length)) * 100)}% under 6s`
          : 'No connected calls yet',
      };

      // Sentiment: complaint/block proxy. We don't have real complaint feeds
      // yet, so use sub-6-second rate as the proxy (industry-standard signal
      // for "recipient hung up immediately = unwelcome"). 0% sub-6 = 100,
      // 20%+ = 0.
      const sub6Rate = connectedDurations.length > 0 ? sub6 / connectedDurations.length : 0;
      const unhealthyPenalty = n.health === 'spam_likely' ? 80 : n.health === 'degraded' ? 50 : 0;
      // Don't punish DIDs with <5 connected calls — sample too small to be reliable.
      const sentimentRaw = connectedDurations.length < 5
        ? Math.max(0, 75 - unhealthyPenalty)
        : Math.max(0, 100 - sub6Rate * 250 - unhealthyPenalty);
      const sentiment: AxisScore = {
        value: Math.round(sentimentRaw),
        grade: gradeOf(sentimentRaw),
        detail: n.health === 'spam_likely'
          ? 'Flagged Spam Likely — needs remediation'
          : n.health === 'degraded'
            ? 'Health degraded — monitor closely'
            : `${Math.round(sub6Rate * 100)}% short-hangup rate (proxy for complaint risk)`,
      };

      const compositeValue = Math.min(
        maturity.value,
        connection.value,
        engagement.value,
        sentiment.value,
      );

      results.push({
        numberId: n.id,
        e164: n.e164,
        label: n.label,
        health: n.health,
        shakenAttestationDistribution: att,
        daysSinceFirstUse,
        warmupTier: curve.tier,
        warmupCap: n.warmupOverrideCap ?? curve.cap,
        dialsToday: n.dialsTodayDate === new Date().toISOString().slice(0, 10) ? n.dialsToday : 0,
        dialsLast7d: total,
        avgDurationLast7dSec: avgDur,
        answerRate: ar,
        sub6sRate: sub6Rate,
        attestationABRate: abRate,
        axes: { maturity, connection, engagement, sentiment },
        composite: { value: compositeValue, grade: gradeOf(compositeValue) },
      });
    }

    // Org-level summary
    const totalDialsToday = results.reduce((a, b) => a + b.dialsToday, 0);
    const totalCapacityToday = results.reduce((a, b) => a + b.warmupCap, 0);
    const avgComposite = results.length > 0
      ? Math.round(results.reduce((a, b) => a + b.composite.value, 0) / results.length)
      : 0;
    const flaggedCount = results.filter((r) => r.health === 'spam_likely' || r.health === 'degraded').length;

    return {
      summary: {
        numberCount: results.length,
        flaggedCount,
        avgComposite,
        avgGrade: gradeOf(avgComposite),
        dialsTodayUsed: totalDialsToday,
        dialsTodayCapacity: totalCapacityToday,
        dialsTodayUtilization: totalCapacityToday > 0 ? totalDialsToday / totalCapacityToday : 0,
      },
      numbers: results,
    };
  });
}

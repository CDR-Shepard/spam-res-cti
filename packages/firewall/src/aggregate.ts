import type { CheckResult, Decision } from './types.js';

export function aggregate(
  checks: CheckResult[],
  requiredScriptId: string | null,
): {
  decision: Decision;
  reasons: string[];
  blockReason: string | null;
  requiredScriptId: string | null;
} {
  const firstBlock = checks.find((c) => !c.passed && c.severity === 'block');
  if (firstBlock) {
    return {
      decision: 'BLOCK',
      reasons: checks.map((c) => c.reasonCode),
      blockReason: firstBlock.detail ?? firstBlock.reasonCode,
      requiredScriptId: null,
    };
  }
  const hasReview = checks.some((c) => c.severity === 'review');
  if (hasReview) {
    return {
      decision: 'REQUIRE_REVIEW',
      reasons: checks.map((c) => c.reasonCode),
      blockReason: null,
      requiredScriptId,
    };
  }
  return {
    decision: 'ALLOW',
    reasons: checks.map((c) => c.reasonCode),
    blockReason: null,
    requiredScriptId,
  };
}

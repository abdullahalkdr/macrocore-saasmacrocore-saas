// Pure decision logic for EmailDeliverySection.tsx's retry button, factored
// out so it's directly unit-testable without rendering the component (no
// jsdom/React Testing Library needed for a single boolean decision).
//
// A 'requires_review' job was reclaimed after an apparent backend crash --
// see backend/src/utils/email.ts's reclaimStuckProcessingJobs(). Retrying it
// is NOT always safe the way retrying a plain temp_failed/permanently_failed
// job is: Resend's Idempotency-Key window (24h) may already have elapsed, in
// which case a blind retry could send a real duplicate email if the original
// attempt actually went through. So this status must never get the ordinary
// one-click retry button -- the admin has to see an explicit notice (check
// the Resend dashboard first) and confirm before the retry call fires.
export type RetryEligibleStatus = 'temp_failed' | 'permanently_failed' | 'requires_review';

export function needsExplicitReviewConfirmation(status: string): boolean {
  return status === 'requires_review';
}

import { describe, it, expect } from 'vitest';
import { needsExplicitReviewConfirmation } from '../emailRetryUx';

// Gap 4: requires_review must never present as an ordinary one-click retry.
// This is the pure decision EmailDeliverySection.tsx's retry button branches
// on -- when it's true, the component shows the bilingual "check the Resend
// dashboard first" notice and requires an explicit second click ("Retry
// anyway") before the retry API call fires; when it's false, the existing
// one-click retry behavior for temp_failed/permanently_failed is unchanged.
describe('needsExplicitReviewConfirmation', () => {
  it('requires explicit confirmation only for requires_review', () => {
    expect(needsExplicitReviewConfirmation('requires_review')).toBe(true);
  });

  it('does not gate the ordinary retryable statuses behind confirmation', () => {
    expect(needsExplicitReviewConfirmation('temp_failed')).toBe(false);
    expect(needsExplicitReviewConfirmation('permanently_failed')).toBe(false);
  });

  it('does not gate non-retryable statuses either (defensive -- the button never renders for these anyway)', () => {
    expect(needsExplicitReviewConfirmation('sent')).toBe(false);
    expect(needsExplicitReviewConfirmation('delivered')).toBe(false);
    expect(needsExplicitReviewConfirmation('queued')).toBe(false);
  });
});

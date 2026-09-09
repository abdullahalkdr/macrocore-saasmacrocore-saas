import { app } from './app';
import { env } from './config/env';
import { sweepEmailQueue } from './utils/email';
import { sweepApprovalSla } from './utils/approvalSla';

app.listen(env.PORT, () => {
  console.log(`macrocore backend listening on port ${env.PORT} [${env.NODE_ENV}]`);

  // SLA timezone incident (2026-09-09) — logged ONCE at startup, not once per
  // interval tick, so this is loud on boot without spamming the log every 60s.
  // See claude/sla-timezone-incident-2026-09-09.md (project doc).
  console.log(
    env.ENABLE_BACKGROUND_SWEEPS
      ? '[startup] Background sweeps (SLA reminder/breach + email queue) are ENABLED.'
      : '[startup] Background sweeps (SLA reminder/breach + email queue) are DISABLED — set ENABLE_BACKGROUND_SWEEPS=true to enable. This MUST be true on Railway. It must stay false/unset for any local process, especially one pointed at the production DATABASE_URL.'
  );

  // Background sweeps — email delivery (the crash-safety/multi-instance-safety
  // net for enqueueEmail()'s best-effort immediate send attempt) and Phase 4
  // (Chat 2)'s Financial Approval SLA reminder/breach sweep. Both are safe to
  // call concurrently from multiple processes (Postgres FOR UPDATE SKIP
  // LOCKED) and are exported standalone specifically so a future Railway Cron
  // hitting an internal endpoint could trigger either directly — this
  // setInterval is not the durability mechanism, it's just today's trigger
  // for it. Both functions now also self-guard on env.ENABLE_BACKGROUND_SWEEPS
  // (see their own headers) — that guard is the real safety net; this
  // setInterval firing on a disabled instance is a harmless no-op.
  //
  // BUGFIX (round 2, point 6) — ONE setInterval drives both, not two
  // independent timers. Each task keeps its own try/catch so a failure in
  // one never affects or delays the other (isolated failure handling), but
  // they now share a single scheduler tick instead of running as two
  // separately-drifting timers doing the same job.
  const runSweeps = (): void => {
    void sweepEmailQueue().catch((err) => console.error('[email] sweep failed', err));
    void sweepApprovalSla().catch((err) => console.error('[approvalSla] sweep failed', err));
  };
  runSweeps(); // once right away — picks up anything left over from before a restart
  setInterval(runSweeps, 60_000);
});

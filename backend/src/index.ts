import { app } from './app';
import { env } from './config/env';
import { sweepEmailQueue } from './utils/email';
import { sweepApprovalSla } from './utils/approvalSla';

app.listen(env.PORT, () => {
  console.log(`macrocore backend listening on port ${env.PORT} [${env.NODE_ENV}]`);

  // Background sweeps — email delivery (the crash-safety/multi-instance-safety
  // net for enqueueEmail()'s best-effort immediate send attempt) and Phase 4
  // (Chat 2)'s Financial Approval SLA reminder/breach sweep. Both are safe to
  // call concurrently from multiple processes (Postgres FOR UPDATE SKIP
  // LOCKED) and are exported standalone specifically so a future Railway Cron
  // hitting an internal endpoint could trigger either directly — this
  // setInterval is not the durability mechanism, it's just today's trigger
  // for it.
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

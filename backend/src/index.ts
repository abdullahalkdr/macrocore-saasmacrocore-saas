import { app } from './app';
import { env } from './config/env';
import { sweepEmailQueue } from './utils/email';

app.listen(env.PORT, () => {
  console.log(`macrocore backend listening on port ${env.PORT} [${env.NODE_ENV}]`);

  // Email delivery sweep — the crash-safety/multi-instance-safety net for
  // enqueueEmail()'s best-effort immediate send attempt (utils/email.ts). Runs
  // once right away (picks up anything left over from before a restart), then
  // every 60s for this single-instance deployment. sweepEmailQueue() is safe
  // to call concurrently from multiple processes (Postgres FOR UPDATE SKIP
  // LOCKED) and is exported standalone specifically so a future Railway Cron
  // hitting an internal endpoint can trigger the exact same function without
  // any change here — this setInterval is not the durability mechanism, it's
  // just today's trigger for it.
  void sweepEmailQueue().catch((err) => console.error('[email] startup sweep failed', err));
  setInterval(() => {
    void sweepEmailQueue().catch((err) => console.error('[email] periodic sweep failed', err));
  }, 60_000);
});

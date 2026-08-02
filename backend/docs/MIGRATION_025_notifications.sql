-- In-app notifications. This is the local groundwork for "external notifications" —
-- actually sending a WhatsApp/SMS/email requires the company's own Twilio/WhatsApp
-- Business API/SMTP credentials, which aren't available, so this delivers the in-app
-- layer only. One row per recipient user (not a broadcast+join-table design) — simplest
-- thing that works at kiosk scale, and each row has its own independent read_at.
CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type VARCHAR(50) NOT NULL,
  title VARCHAR(255) NOT NULL,
  body TEXT,
  link VARCHAR(255),
  read_at TIMESTAMP,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_user_unread ON notifications(user_id) WHERE read_at IS NULL;

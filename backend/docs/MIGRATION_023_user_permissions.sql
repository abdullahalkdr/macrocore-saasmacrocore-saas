-- Lightweight delegated permissions: lets an admin grant a specific non-manager
-- employee one narrow extra capability (e.g. "can approve leave requests")
-- without promoting them to the manager role, which would unlock everything.
-- Deliberately NOT a full RBAC rebuild — only a fixed, curated list of
-- permission_key values (enforced in code, see permissions.controller.ts)
-- is ever written here, and only a handful of existing routes check it.
CREATE TABLE IF NOT EXISTS user_permissions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id UUID NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission_key VARCHAR(50) NOT NULL,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE (user_id, permission_key)
);

CREATE INDEX IF NOT EXISTS idx_user_permissions_user ON user_permissions(user_id);
CREATE INDEX IF NOT EXISTS idx_user_permissions_company ON user_permissions(company_id);

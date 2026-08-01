import { Request, Response } from 'express';
import crypto from 'crypto';
import { pool } from '../db/pool';
import { asyncHandler } from '../utils/asyncHandler';
import { AppError } from '../middleware/errorHandler';
import { logAudit } from '../utils/audit';

export const list = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const result = await pool.query(
    `SELECT id, name, key_prefix, created_at, last_used_at, revoked_at
     FROM api_keys WHERE company_id = $1 ORDER BY created_at DESC`,
    [companyId]
  );
  res.status(200).json({ success: true, api_keys: result.rows });
});

// The full key is only ever shown once, right here in the create response —
// after this, only key_prefix (e.g. "mk_live_ab12") is retrievable, matching
// how Stripe/GitHub-style API keys work.
export const create = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { name } = req.body ?? {};
  if (typeof name !== 'string' || name.trim().length < 2) throw new AppError(400, 'name is required');

  const secret = crypto.randomBytes(24).toString('base64url');
  const fullKey = `mk_live_${secret}`;
  const keyPrefix = fullKey.slice(0, 16);
  const keyHash = crypto.createHash('sha256').update(fullKey).digest('hex');

  const result = await pool.query(
    `INSERT INTO api_keys (company_id, name, key_prefix, key_hash, created_by)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, name, key_prefix, created_at`,
    [companyId, name.trim(), keyPrefix, keyHash, req.auth!.userId]
  );
  const apiKey = result.rows[0];

  await logAudit({ companyId, userId: req.auth!.userId, action: 'api_key_created', entityType: 'api_keys', entityId: apiKey.id, req });

  res.status(201).json({
    success: true,
    api_key: apiKey,
    key: fullKey,
    message: 'Copy this key now — it will not be shown again.',
  });
});

export const revoke = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { id } = req.params;

  const result = await pool.query(
    `UPDATE api_keys SET revoked_at = NOW() WHERE id = $1 AND company_id = $2 AND revoked_at IS NULL
     RETURNING id, name, key_prefix, revoked_at`,
    [id, companyId]
  );
  const apiKey = result.rows[0];
  if (!apiKey) throw new AppError(404, 'API key not found or already revoked');

  await logAudit({ companyId, userId: req.auth!.userId, action: 'api_key_revoked', entityType: 'api_keys', entityId: apiKey.id, req });

  res.status(200).json({ success: true, api_key: apiKey });
});

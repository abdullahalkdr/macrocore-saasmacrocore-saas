import { Request, Response } from 'express';
import { pool } from '../db/pool';
import { asyncHandler } from '../utils/asyncHandler';
import { AppError } from '../middleware/errorHandler';

export const list = asyncHandler(async (req: Request, res: Response) => {
  const userId = req.auth!.userId;
  const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? '30'), 10) || 30));

  const result = await pool.query(
    `SELECT id, type, title, body, link, read_at, created_at FROM notifications
     WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [userId, limit]
  );
  const unread = await pool.query(`SELECT COUNT(*)::int AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL`, [userId]);

  res.status(200).json({ success: true, notifications: result.rows, unread_count: unread.rows[0].n });
});

export const markRead = asyncHandler(async (req: Request, res: Response) => {
  const userId = req.auth!.userId;
  const { id } = req.params;

  const result = await pool.query(
    `UPDATE notifications SET read_at = NOW() WHERE id = $1 AND user_id = $2 AND read_at IS NULL RETURNING id`,
    [id, userId]
  );
  if (!result.rows[0]) {
    const exists = await pool.query('SELECT id FROM notifications WHERE id = $1 AND user_id = $2', [id, userId]);
    if (!exists.rows[0]) throw new AppError(404, 'Notification not found');
  }
  res.status(200).json({ success: true });
});

export const markAllRead = asyncHandler(async (req: Request, res: Response) => {
  const userId = req.auth!.userId;
  await pool.query(`UPDATE notifications SET read_at = NOW() WHERE user_id = $1 AND read_at IS NULL`, [userId]);
  res.status(200).json({ success: true });
});

// MIGRATION_060 -- per-notification delete, so a user can dismiss one specific
// notification instead of only ever having "mark all as read" as a bulk action.
// Scoped to user_id same as markRead -- a user can only ever delete their own.
export const remove = asyncHandler(async (req: Request, res: Response) => {
  const userId = req.auth!.userId;
  const { id } = req.params;
  const result = await pool.query(`DELETE FROM notifications WHERE id = $1 AND user_id = $2 RETURNING id`, [id, userId]);
  if (!result.rows[0]) throw new AppError(404, 'Notification not found');
  res.status(200).json({ success: true });
});

// MIGRATION_060 -- toggles read_at either way (mark as unread is new: previously a
// notification could only ever move forward to read, never back), so the caller can
// select exactly which notifications to mark read/unread instead of only "read one
// by clicking through it" or "mark literally everything read" via markAllRead.
export const setRead = asyncHandler(async (req: Request, res: Response) => {
  const userId = req.auth!.userId;
  const { id } = req.params;
  const { read } = req.body ?? {};
  if (typeof read !== 'boolean') throw new AppError(400, 'read must be a boolean');

  const result = await pool.query(
    `UPDATE notifications SET read_at = $1 WHERE id = $2 AND user_id = $3 RETURNING id`,
    [read ? new Date() : null, id, userId]
  );
  if (!result.rows[0]) throw new AppError(404, 'Notification not found');
  res.status(200).json({ success: true });
});

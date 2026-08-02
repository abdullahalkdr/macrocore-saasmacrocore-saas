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

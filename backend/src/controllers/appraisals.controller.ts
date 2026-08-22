import { Request, Response } from 'express';
import { pool } from '../db/pool';
import { asyncHandler } from '../utils/asyncHandler';
import { AppError } from '../middleware/errorHandler';

const QUESTION_TYPES = ['rating', 'text', 'scale'];

const FORM_FIELDS = `id, name, name_en, description, is_active, created_by, created_at, updated_at`;
const QUESTION_FIELDS = `id, form_id, question_text, question_text_en, question_type, max_score, weight, sort_order, created_at`;

// Appraisal forms/questions are configuration, not personal data — admin/manager only
// at the route level (see routes/appraisals.routes.ts). No ownership filtering needed.

export const listForms = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const forms = await pool.query(`SELECT ${FORM_FIELDS} FROM appraisal_forms WHERE company_id = $1 ORDER BY created_at DESC`, [companyId]);
  res.status(200).json({ success: true, forms: forms.rows });
});

export const createForm = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { name, name_en, description } = req.body ?? {};
  if (typeof name !== 'string' || !name.trim()) throw new AppError(400, 'name is required');

  const result = await pool.query(
    `INSERT INTO appraisal_forms (company_id, name, name_en, description, created_by)
     VALUES ($1, $2, $3, $4, $5) RETURNING ${FORM_FIELDS}`,
    [companyId, name.trim(), name_en ?? null, description ?? null, req.auth!.userId]
  );
  res.status(201).json({ success: true, form: result.rows[0] });
});

export const updateForm = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { id } = req.params;
  const { name, name_en, description, is_active } = req.body ?? {};

  const sets: string[] = [];
  const values: unknown[] = [];
  let i = 1;

  if (name !== undefined) {
    if (typeof name !== 'string' || !name.trim()) throw new AppError(400, 'name must be a non-empty string');
    sets.push(`name = $${i++}`);
    values.push(name.trim());
  }
  if (name_en !== undefined) {
    sets.push(`name_en = $${i++}`);
    values.push(name_en);
  }
  if (description !== undefined) {
    sets.push(`description = $${i++}`);
    values.push(description);
  }
  if (is_active !== undefined) {
    if (typeof is_active !== 'boolean') throw new AppError(400, 'is_active must be a boolean');
    sets.push(`is_active = $${i++}`);
    values.push(is_active);
  }
  if (sets.length === 0) throw new AppError(400, 'No updatable fields provided');

  sets.push('updated_at = NOW()');
  values.push(id, companyId);

  const result = await pool.query(
    `UPDATE appraisal_forms SET ${sets.join(', ')} WHERE id = $${i++} AND company_id = $${i++} RETURNING ${FORM_FIELDS}`,
    values
  );
  if (!result.rows[0]) throw new AppError(404, 'Form not found');

  res.status(200).json({ success: true, form: result.rows[0] });
});

export const removeForm = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { id } = req.params;
  const result = await pool.query('DELETE FROM appraisal_forms WHERE id = $1 AND company_id = $2 RETURNING id', [id, companyId]);
  if (!result.rows[0]) throw new AppError(404, 'Form not found');
  res.status(200).json({ success: true });
});

export const listQuestions = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { formId } = req.params;
  const questions = await pool.query(
    `SELECT ${QUESTION_FIELDS} FROM appraisal_form_questions WHERE form_id = $1 AND company_id = $2 ORDER BY sort_order ASC, created_at ASC`,
    [formId, companyId]
  );
  res.status(200).json({ success: true, questions: questions.rows });
});

export const createQuestion = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { formId } = req.params;
  const { question_text, question_text_en, question_type, max_score, weight, sort_order } = req.body ?? {};

  if (typeof question_text !== 'string' || !question_text.trim()) throw new AppError(400, 'question_text is required');
  const finalType = typeof question_type === 'string' && QUESTION_TYPES.includes(question_type) ? question_type : 'rating';

  const form = await pool.query('SELECT id FROM appraisal_forms WHERE id = $1 AND company_id = $2', [formId, companyId]);
  if (!form.rows[0]) throw new AppError(404, 'Form not found');

  const result = await pool.query(
    `INSERT INTO appraisal_form_questions (company_id, form_id, question_text, question_text_en, question_type, max_score, weight, sort_order)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING ${QUESTION_FIELDS}`,
    [
      companyId,
      formId,
      question_text.trim(),
      question_text_en ?? null,
      finalType,
      typeof max_score === 'number' ? max_score : 5,
      typeof weight === 'number' ? weight : 1,
      typeof sort_order === 'number' ? sort_order : 0,
    ]
  );
  res.status(201).json({ success: true, question: result.rows[0] });
});

export const updateQuestion = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { id } = req.params;
  const { question_text, question_text_en, question_type, max_score, weight, sort_order } = req.body ?? {};

  const sets: string[] = [];
  const values: unknown[] = [];
  let i = 1;

  if (question_text !== undefined) {
    if (typeof question_text !== 'string' || !question_text.trim()) throw new AppError(400, 'question_text must be a non-empty string');
    sets.push(`question_text = $${i++}`);
    values.push(question_text.trim());
  }
  if (question_text_en !== undefined) {
    sets.push(`question_text_en = $${i++}`);
    values.push(question_text_en);
  }
  if (question_type !== undefined) {
    if (!QUESTION_TYPES.includes(question_type)) throw new AppError(400, `question_type must be one of ${QUESTION_TYPES.join(', ')}`);
    sets.push(`question_type = $${i++}`);
    values.push(question_type);
  }
  if (max_score !== undefined) {
    if (typeof max_score !== 'number' || max_score <= 0) throw new AppError(400, 'max_score must be a positive number');
    sets.push(`max_score = $${i++}`);
    values.push(max_score);
  }
  if (weight !== undefined) {
    if (typeof weight !== 'number' || weight < 0) throw new AppError(400, 'weight must be a non-negative number');
    sets.push(`weight = $${i++}`);
    values.push(weight);
  }
  if (sort_order !== undefined) {
    if (typeof sort_order !== 'number') throw new AppError(400, 'sort_order must be a number');
    sets.push(`sort_order = $${i++}`);
    values.push(sort_order);
  }
  if (sets.length === 0) throw new AppError(400, 'No updatable fields provided');

  values.push(id, companyId);

  const result = await pool.query(
    `UPDATE appraisal_form_questions SET ${sets.join(', ')} WHERE id = $${i++} AND company_id = $${i++} RETURNING ${QUESTION_FIELDS}`,
    values
  );
  if (!result.rows[0]) throw new AppError(404, 'Question not found');

  res.status(200).json({ success: true, question: result.rows[0] });
});

export const removeQuestion = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { id } = req.params;
  const result = await pool.query('DELETE FROM appraisal_form_questions WHERE id = $1 AND company_id = $2 RETURNING id', [id, companyId]);
  if (!result.rows[0]) throw new AppError(404, 'Question not found');
  res.status(200).json({ success: true });
});

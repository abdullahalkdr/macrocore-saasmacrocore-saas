import { AppError } from '../middleware/errorHandler';

// MIGRATION_059 introduced this shape/size validator for support_tickets/
// ticket_replies' `attachments` JSONB column; MIGRATION_062 reuses it verbatim for
// approval_steps_log's own `attachments` column (Return for Changes / Resubmit) —
// factored out here so both controllers share one implementation instead of two
// copies drifting apart.
//
// Each item is a plain {file_name, file_base64} object, file_base64 a full data:
// URL (same convention the frontend's readFileAsBase64() helper produces everywhere
// this app accepts a file — no S3/object storage in this project). Caps exist
// because this all lands inside one JSON request body — express.json() itself is
// capped at 10mb (app.ts), and multiple uncapped attachments could blow past that
// with a confusing "request too large" error instead of a clear one.
const MAX_ATTACHMENTS = 5;
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024; // 5MB decoded, per file

export interface Attachment {
  file_name: string;
  file_base64: string;
}

export function validateAttachments(input: unknown): Attachment[] {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) throw new AppError(400, 'attachments must be an array');
  if (input.length > MAX_ATTACHMENTS) throw new AppError(400, `You can attach at most ${MAX_ATTACHMENTS} files`);

  return input.map((item) => {
    if (!item || typeof item !== 'object') throw new AppError(400, 'Each attachment must be an object');
    const { file_name, file_base64 } = item as Record<string, unknown>;
    if (typeof file_name !== 'string' || file_name.trim().length < 1) {
      throw new AppError(400, 'Each attachment needs a file_name');
    }
    if (typeof file_base64 !== 'string' || !file_base64.startsWith('data:')) {
      throw new AppError(400, `${file_name} — file_base64 must be a data: URL`);
    }
    // Rough decoded-size estimate from the base64 payload length (after the
    // "data:<mime>;base64," prefix) — exact enough for a sanity cap, no need
    // to actually decode the buffer just to reject an oversized file.
    const commaIndex = file_base64.indexOf(',');
    const encodedLength = commaIndex >= 0 ? file_base64.length - commaIndex - 1 : file_base64.length;
    if (encodedLength * 0.75 > MAX_ATTACHMENT_BYTES) {
      throw new AppError(400, `${file_name} is too large — attachments are capped at 5MB each`);
    }
    return { file_name: file_name.trim(), file_base64 };
  });
}

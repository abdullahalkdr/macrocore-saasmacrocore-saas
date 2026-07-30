// Real Postgres always sets .code = '23503' for a foreign_key_violation. The message
// fallback exists because not every pg-compatible engine sets .code the same way
// (e.g. pg-mem, used in this project's own smoke tests, leaves it undefined).
export function isForeignKeyViolation(err: unknown): boolean {
  const e = err as { code?: string; message?: string };
  return e?.code === '23503' || /foreign key/i.test(e?.message ?? '');
}

// Real Postgres sets .code = '23505' for a unique_violation.
export function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; message?: string };
  return e?.code === '23505' || /duplicate key|unique constraint/i.test(e?.message ?? '');
}

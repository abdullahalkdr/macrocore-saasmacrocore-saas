import { Pool, types } from 'pg';
import { env } from '../config/env';

// node-postgres returns NUMERIC/DECIMAL columns as strings by default (it can't assume
// they fit in a JS float without precision loss). Every money/qty/percent field in this
// app (totals, discount_pct, amount_paid, ...) is well within float64 range, and the
// frontend does real arithmetic on them (.toFixed(), comparisons, discount math) —
// leaving them as strings breaks that (e.g. "12.500".toFixed is not a function). Fixing
// the parser here, once, is the real fix — not Number()-wrapping every call site.
types.setTypeParser(1700, (val) => parseFloat(val));

export const pool = new Pool({ connectionString: env.DATABASE_URL });

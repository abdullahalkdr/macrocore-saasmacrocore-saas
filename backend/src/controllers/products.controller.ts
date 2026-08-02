import { Request, Response } from 'express';
import { pool } from '../db/pool';
import { asyncHandler } from '../utils/asyncHandler';
import { AppError } from '../middleware/errorHandler';
import { logAudit } from '../utils/audit';
import { isForeignKeyViolation } from '../utils/dbErrors';
import { rawMaterialUsageCost, UNIT_TO_BASE } from '../utils/costing';
import { getCurrentPurchasePrice } from '../utils/inventory';

interface IngredientInput {
  raw_material_id: string;
  usage_qty: number;
  usage_unit?: string;
  is_packaging?: boolean;
}

interface SizeInput {
  name: string;
  name_en?: string;
  sell_price?: number;
  ingredients?: IngredientInput[];
}

function validateIngredients(ingredients: unknown): IngredientInput[] {
  const list: IngredientInput[] = Array.isArray(ingredients) ? ingredients : [];
  for (const ing of list) {
    if (typeof ing.raw_material_id !== 'string' || typeof ing.usage_qty !== 'number') {
      throw new AppError(400, 'each ingredient needs raw_material_id (string) and usage_qty (number)');
    }
    if (ing.is_packaging !== undefined && typeof ing.is_packaging !== 'boolean') {
      throw new AppError(400, 'is_packaging must be a boolean when provided');
    }
  }
  return list;
}

function validateSizes(sizes: unknown): SizeInput[] {
  if (!Array.isArray(sizes) || sizes.length === 0) {
    throw new AppError(400, 'has_sizes products need a non-empty sizes array');
  }
  return sizes.map((s: SizeInput) => {
    if (typeof s.name !== 'string' || s.name.trim().length < 1) throw new AppError(400, 'each size needs a name');
    if (s.sell_price !== undefined && (typeof s.sell_price !== 'number' || s.sell_price < 0)) {
      throw new AppError(400, 'each size sell_price must be a non-negative number');
    }
    return { ...s, ingredients: validateIngredients(s.ingredients) };
  });
}

export const list = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const result = await pool.query(
    `SELECT id, name, name_en, category, sell_price, status, has_sizes, created_at
     FROM products WHERE company_id = $1 ORDER BY created_at DESC`,
    [companyId]
  );
  res.status(200).json({ success: true, products: result.rows });
});

export const getOne = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { id } = req.params;

  const product = await pool.query(
    `SELECT id, name, name_en, category, sell_price, status, has_sizes, created_at FROM products WHERE id = $1 AND company_id = $2`,
    [id, companyId]
  );
  if (!product.rows[0]) throw new AppError(404, 'Product not found');

  if (product.rows[0].has_sizes) {
    const sizes = await pool.query(
      `SELECT id, name, name_en, sell_price, sort_order, status FROM product_sizes
       WHERE product_id = $1 ORDER BY sort_order ASC, created_at ASC`,
      [id]
    );
    const sizeIds: string[] = sizes.rows.map((s) => s.id);
    const sizeIngredients =
      sizeIds.length === 0
        ? { rows: [] as { product_size_id: string }[] }
        : await pool.query(
            `SELECT psi.product_size_id, psi.raw_material_id, psi.usage_qty, psi.usage_unit, psi.is_packaging,
                    rm.name AS raw_material_name, rm.name_en AS raw_material_name_en, rm.category AS raw_material_category
             FROM product_size_ingredients psi
             JOIN raw_materials rm ON rm.id = psi.raw_material_id
             WHERE psi.product_size_id IN (${sizeIds.map((_, i) => `$${i + 1}`).join(', ')})`,
            sizeIds
          );
    const sizesWithIngredients = sizes.rows.map((s) => ({
      ...s,
      ingredients: sizeIngredients.rows.filter((i) => i.product_size_id === s.id),
    }));
    res.status(200).json({ success: true, product: product.rows[0], sizes: sizesWithIngredients });
    return;
  }

  const ingredients = await pool.query(
    `SELECT pi.raw_material_id, pi.usage_qty, pi.usage_unit, pi.is_packaging,
            rm.name AS raw_material_name, rm.name_en AS raw_material_name_en, rm.category AS raw_material_category
     FROM product_ingredients pi
     JOIN raw_materials rm ON rm.id = pi.raw_material_id
     WHERE pi.product_id = $1`,
    [id]
  );

  res.status(200).json({ success: true, product: product.rows[0], ingredients: ingredients.rows });
});

export const create = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { name, name_en, category, sell_price, ingredients, has_sizes, sizes } = req.body ?? {};

  if (typeof name !== 'string' || name.trim().length < 1) throw new AppError(400, 'name is required');
  if (sell_price !== undefined && (typeof sell_price !== 'number' || sell_price < 0)) {
    throw new AppError(400, 'sell_price must be a non-negative number');
  }

  const hasSizes = has_sizes === true;
  const ingredientList = hasSizes ? [] : validateIngredients(ingredients);
  const sizeList = hasSizes ? validateSizes(sizes) : [];

  const client = await pool.connect();
  let product;
  try {
    await client.query('BEGIN');

    const productResult = await client.query(
      `INSERT INTO products (company_id, name, name_en, category, sell_price, has_sizes)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, name, name_en, category, sell_price, status, has_sizes, created_at`,
      [companyId, name.trim(), name_en?.trim() || null, category ?? null, hasSizes ? null : sell_price ?? null, hasSizes]
    );
    product = productResult.rows[0];

    for (const ing of ingredientList) {
      await client.query(
        `INSERT INTO product_ingredients (product_id, raw_material_id, usage_qty, usage_unit, is_packaging)
         VALUES ($1, $2, $3, $4, $5)`,
        [product.id, ing.raw_material_id, ing.usage_qty, ing.usage_unit ?? null, ing.is_packaging === true]
      );
    }

    for (let i = 0; i < sizeList.length; i++) {
      const size = sizeList[i];
      const sizeResult = await client.query(
        `INSERT INTO product_sizes (company_id, product_id, name, name_en, sell_price, sort_order)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [companyId, product.id, size.name.trim(), size.name_en?.trim() || null, size.sell_price ?? null, i]
      );
      const sizeId = sizeResult.rows[0].id;
      for (const ing of size.ingredients ?? []) {
        await client.query(
          `INSERT INTO product_size_ingredients (product_size_id, raw_material_id, usage_qty, usage_unit, is_packaging)
           VALUES ($1, $2, $3, $4, $5)`,
          [sizeId, ing.raw_material_id, ing.usage_qty, ing.usage_unit ?? null, ing.is_packaging === true]
        );
      }
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    // FK violation -> the raw_material_id doesn't exist for this company yet
    if (isForeignKeyViolation(err)) {
      throw new AppError(400, 'One of the ingredients references a raw_material_id that does not exist');
    }
    throw err;
  } finally {
    client.release();
  }

  await logAudit({ companyId, userId: req.auth!.userId, action: 'product_created', entityType: 'products', entityId: product.id, req });

  res.status(201).json({ success: true, product });
});

// Admin/manager only (see routes). Scalar fields (name/category/price/status) update
// in place; sending `ingredients` (non-sized) or `sizes` (sized) fully replaces the
// existing recipe/size list, same shape as create() — simplest correct option since
// recipes are small and there's no meaningful "diff" UI on the frontend.
export const update = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { id } = req.params;
  const { name, name_en, category, sell_price, status, has_sizes, ingredients, sizes } = req.body ?? {};

  const existing = await pool.query('SELECT id, has_sizes FROM products WHERE id = $1 AND company_id = $2', [id, companyId]);
  if (!existing.rows[0]) throw new AppError(404, 'Product not found');
  const currentHasSizes: boolean = existing.rows[0].has_sizes;

  if (name !== undefined && (typeof name !== 'string' || name.trim().length < 1)) throw new AppError(400, 'name must be a non-empty string');
  if (sell_price !== undefined && sell_price !== null && (typeof sell_price !== 'number' || sell_price < 0)) {
    throw new AppError(400, 'sell_price must be a non-negative number');
  }
  if (status !== undefined && !['active', 'inactive'].includes(status)) throw new AppError(400, 'status must be active or inactive');

  const nextHasSizes = has_sizes !== undefined ? has_sizes === true : currentHasSizes;
  const replaceIngredients = has_sizes !== undefined || ingredients !== undefined;
  const replaceSizes = has_sizes !== undefined || sizes !== undefined;
  const ingredientList = replaceIngredients ? (nextHasSizes ? [] : validateIngredients(ingredients)) : null;
  const sizeList = replaceSizes ? (nextHasSizes ? validateSizes(sizes) : []) : null;

  const sets: string[] = [];
  const values: unknown[] = [];
  let i = 1;
  if (name !== undefined) {
    sets.push(`name = $${i++}`);
    values.push(name.trim());
  }
  if (name_en !== undefined) {
    sets.push(`name_en = $${i++}`);
    values.push(typeof name_en === 'string' && name_en.trim() ? name_en.trim() : null);
  }
  if (category !== undefined) {
    sets.push(`category = $${i++}`);
    values.push(category);
  }
  if (sell_price !== undefined) {
    sets.push(`sell_price = $${i++}`);
    values.push(nextHasSizes ? null : sell_price);
  }
  if (status !== undefined) {
    sets.push(`status = $${i++}`);
    values.push(status);
  }
  if (has_sizes !== undefined) {
    sets.push(`has_sizes = $${i++}`);
    values.push(nextHasSizes);
  }

  const client = await pool.connect();
  let product;
  try {
    await client.query('BEGIN');

    if (sets.length > 0) {
      sets.push(`updated_at = NOW()`);
      values.push(id, companyId);
      const result = await client.query(
        `UPDATE products SET ${sets.join(', ')} WHERE id = $${i++} AND company_id = $${i++}
         RETURNING id, name, name_en, category, sell_price, status, has_sizes, created_at`,
        values
      );
      product = result.rows[0];
    } else {
      const result = await client.query(
        `SELECT id, name, name_en, category, sell_price, status, has_sizes, created_at FROM products WHERE id = $1 AND company_id = $2`,
        [id, companyId]
      );
      product = result.rows[0];
    }

    if (ingredientList !== null) {
      await client.query(`DELETE FROM product_ingredients WHERE product_id = $1`, [id]);
      for (const ing of ingredientList) {
        await client.query(
          `INSERT INTO product_ingredients (product_id, raw_material_id, usage_qty, usage_unit, is_packaging) VALUES ($1, $2, $3, $4, $5)`,
          [id, ing.raw_material_id, ing.usage_qty, ing.usage_unit ?? null, ing.is_packaging === true]
        );
      }
    }
    if (sizeList !== null) {
      await client.query(`DELETE FROM product_sizes WHERE product_id = $1`, [id]); // cascades product_size_ingredients
      for (let idx = 0; idx < sizeList.length; idx++) {
        const size = sizeList[idx];
        const sizeResult = await client.query(
          `INSERT INTO product_sizes (company_id, product_id, name, name_en, sell_price, sort_order)
           VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
          [companyId, id, size.name.trim(), size.name_en?.trim() || null, size.sell_price ?? null, idx]
        );
        const sizeId = sizeResult.rows[0].id;
        for (const ing of size.ingredients ?? []) {
          await client.query(
            `INSERT INTO product_size_ingredients (product_size_id, raw_material_id, usage_qty, usage_unit, is_packaging) VALUES ($1, $2, $3, $4, $5)`,
            [sizeId, ing.raw_material_id, ing.usage_qty, ing.usage_unit ?? null, ing.is_packaging === true]
          );
        }
      }
    }

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    if (isForeignKeyViolation(err)) {
      throw new AppError(400, 'One of the ingredients references a raw_material_id that does not exist');
    }
    throw err;
  } finally {
    client.release();
  }

  if (!product) throw new AppError(404, 'Product not found');

  await logAudit({ companyId, userId: req.auth!.userId, action: 'product_updated', entityType: 'products', entityId: id as string, req });

  res.status(200).json({ success: true, product });
});

// Admin/manager only. Blocked by a foreign key violation (friendly-messaged below) if
// the product has any sales/shift-assignment/waste history — that's intentional, we
// never want a delete to silently wipe historical revenue/cost numbers. Use `status:
// 'inactive'` via update() instead to retire a product that already has history.
export const remove = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { id } = req.params;

  try {
    const result = await pool.query('DELETE FROM products WHERE id = $1 AND company_id = $2 RETURNING id', [id, companyId]);
    if (result.rows.length === 0) throw new AppError(404, 'Product not found');
  } catch (err) {
    if (isForeignKeyViolation(err)) {
      throw new AppError(409, 'This product has sales/waste history and cannot be deleted — set it to inactive instead');
    }
    throw err;
  }

  await logAudit({ companyId, userId: req.auth!.userId, action: 'product_deleted', entityType: 'products', entityId: id as string, req });

  res.status(200).json({ success: true });
});

// Shared cost math: raw ingredient cost for a set of {package_qty, package_unit,
// purchase_price, usage_qty, usage_unit} rows.
function sumRawCost(rows: { usage_qty: number; usage_unit: string | null; package_qty: number | null; package_unit: string | null; purchase_price: number | null }[]) {
  return rows.reduce(
    (sum, row) => sum + rawMaterialUsageCost({ package_qty: row.package_qty, package_unit: row.package_unit, purchase_price: row.purchase_price }, Number(row.usage_qty), row.usage_unit),
    0
  );
}

// Calculate raw cost using current purchase prices from batches (FIFO).
// If no batches exist, falls back to raw_materials.purchase_price.
async function sumRawCostWithCurrentPrices(
  client: any,
  companyId: string,
  rows: { raw_material_id: string; usage_qty: number; usage_unit: string | null; package_qty: number | null; package_unit: string | null }[]
): Promise<number> {
  let totalCost = 0;
  for (const row of rows) {
    const currentPrice = await getCurrentPurchasePrice(client, companyId, row.raw_material_id);
    const cost = rawMaterialUsageCost(
      { package_qty: row.package_qty, package_unit: row.package_unit, purchase_price: currentPrice },
      Number(row.usage_qty),
      row.usage_unit
    );
    totalCost += cost;
  }
  return totalCost;
}

async function getOverheadPerOrder(companyId: string): Promise<{ totalFixedMonthly: number; estimatedOrders: number; overheadPerOrder: number }> {
  const company = await pool.query(
    `SELECT fixed_cost_items, estimated_orders_mode, estimated_orders_manual FROM companies WHERE id = $1`,
    [companyId]
  );
  const fixedCostItems: { amount: number }[] = company.rows[0]?.fixed_cost_items ?? [];
  const fixedItemsTotal = fixedCostItems.reduce((sum, item) => sum + (Number(item.amount) || 0), 0);

  const salaries = await pool.query(
    `SELECT COALESCE(SUM(salary_monthly), 0)::float AS total FROM employees WHERE company_id = $1 AND status = 'active'`,
    [companyId]
  );
  const totalFixedMonthly = fixedItemsTotal + salaries.rows[0].total;

  const mode = company.rows[0]?.estimated_orders_mode ?? 'auto';
  let estimatedOrders: number;
  if (mode === 'manual') {
    estimatedOrders = company.rows[0]?.estimated_orders_manual || 1;
  } else {
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const recent = await pool.query(`SELECT COUNT(*)::int AS n FROM sales WHERE company_id = $1 AND created_at >= $2`, [companyId, since]);
    estimatedOrders = Math.max(1, recent.rows[0].n);
  }

  return { totalFixedMonthly, estimatedOrders, overheadPerOrder: totalFixedMonthly / estimatedOrders };
}

// GET /products/:id/cost — raw ingredient cost + this product's share of fixed
// monthly overhead (rent, salaries, ...) spread across estimated monthly orders.
// For has_sizes products, returns one breakdown per size instead of a single one —
// overhead per order is the same regardless of size (it's a per-order cost, not
// per-unit), only raw cost and sell price vary by size.
// See docs/MIGRATION_002_priority1.sql, docs/MIGRATION_003_product_sizes.sql.
export const getCost = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { id } = req.params;

  const product = await pool.query(`SELECT id, sell_price, has_sizes FROM products WHERE id = $1 AND company_id = $2`, [id, companyId]);
  if (!product.rows[0]) throw new AppError(404, 'Product not found');

  const { totalFixedMonthly, estimatedOrders, overheadPerOrder } = await getOverheadPerOrder(companyId);

  const client = await pool.connect();
  try {
    if (product.rows[0].has_sizes) {
      const sizes = await pool.query(`SELECT id, name, sell_price FROM product_sizes WHERE product_id = $1 ORDER BY sort_order ASC`, [id]);
      const results = [];
      for (const size of sizes.rows) {
        const ingredients = await pool.query(
          `SELECT psi.raw_material_id, psi.usage_qty, psi.usage_unit, rm.package_qty, rm.package_unit
           FROM product_size_ingredients psi
           JOIN raw_materials rm ON rm.id = psi.raw_material_id
           WHERE psi.product_size_id = $1`,
          [size.id]
        );
        const rawCost = await sumRawCostWithCurrentPrices(client, companyId, ingredients.rows);
        const fullCost = rawCost + overheadPerOrder;
        const sellPrice: number | null = size.sell_price;
        const profit = sellPrice !== null ? sellPrice - fullCost : null;
        const marginPct = sellPrice !== null && sellPrice > 0 ? (profit! / sellPrice) * 100 : null;
        results.push({ id: size.id, name: size.name, raw_cost: rawCost, full_cost: fullCost, sell_price: sellPrice, profit, margin_pct: marginPct });
      }
      res.status(200).json({
        success: true,
        has_sizes: true,
        total_fixed_monthly: totalFixedMonthly,
        estimated_orders: estimatedOrders,
        overhead_per_order: overheadPerOrder,
        sizes: results,
      });
      return;
    }

    const ingredients = await pool.query(
      `SELECT pi.raw_material_id, pi.usage_qty, pi.usage_unit, rm.package_qty, rm.package_unit
       FROM product_ingredients pi
       JOIN raw_materials rm ON rm.id = pi.raw_material_id
       WHERE pi.product_id = $1`,
      [id]
    );
    const rawCost = await sumRawCostWithCurrentPrices(client, companyId, ingredients.rows);
    const fullCost = rawCost + overheadPerOrder;
    const sellPrice: number | null = product.rows[0].sell_price;
    const profit = sellPrice !== null ? sellPrice - fullCost : null;
    const marginPct = sellPrice !== null && sellPrice > 0 ? (profit! / sellPrice) * 100 : null;

    res.status(200).json({
      success: true,
      has_sizes: false,
      raw_cost: rawCost,
      total_fixed_monthly: totalFixedMonthly,
      estimated_orders: estimatedOrders,
      overhead_per_order: overheadPerOrder,
      full_cost: fullCost,
      sell_price: sellPrice,
      profit,
      margin_pct: marginPct,
    });
  } finally {
    client.release();
  }
});

// POST /products/cost-preview — same cost math as GET /:id/cost, but works on an
// in-progress (possibly unsaved) ingredient list instead of a stored product, so the
// add/edit modal can show live margin/profit stats as the user types — matching the
// CornLab reference where the stat cards update immediately, before "Save" is pressed.
export const costPreview = asyncHandler(async (req: Request, res: Response) => {
  const companyId = req.auth!.companyId;
  const { ingredients, sell_price } = req.body ?? {};

  if (sell_price !== undefined && sell_price !== null && (typeof sell_price !== 'number' || sell_price < 0)) {
    throw new AppError(400, 'sell_price must be a non-negative number');
  }
  const ingredientList = validateIngredients(ingredients);

  const { totalFixedMonthly, estimatedOrders, overheadPerOrder } = await getOverheadPerOrder(companyId);

  const client = await pool.connect();
  try {
    let rawCost = 0;
    if (ingredientList.length > 0) {
      const ids = ingredientList.map((ing) => ing.raw_material_id);
      const materials = await pool.query(
        `SELECT id, package_qty, package_unit FROM raw_materials WHERE company_id = $1 AND id = ANY($2::uuid[])`,
        [companyId, ids]
      );
      const materialsById = new Map(materials.rows.map((m) => [m.id, m]));
      const rows = ingredientList
        .filter((ing) => materialsById.has(ing.raw_material_id))
        .map((ing) => ({
          raw_material_id: ing.raw_material_id,
          usage_qty: ing.usage_qty,
          usage_unit: ing.usage_unit ?? null,
          package_qty: materialsById.get(ing.raw_material_id)!.package_qty,
          package_unit: materialsById.get(ing.raw_material_id)!.package_unit,
        }));
      rawCost = await sumRawCostWithCurrentPrices(client, companyId, rows);
    }

    const fullCost = rawCost + overheadPerOrder;
    const sellPrice: number | null = typeof sell_price === 'number' ? sell_price : null;
    const profit = sellPrice !== null ? sellPrice - fullCost : null;
    const marginPct = sellPrice !== null && sellPrice > 0 ? (profit! / sellPrice) * 100 : null;

    res.status(200).json({
      success: true,
      raw_cost: rawCost,
      total_fixed_monthly: totalFixedMonthly,
      estimated_orders: estimatedOrders,
      overhead_per_order: overheadPerOrder,
      full_cost: fullCost,
      sell_price: sellPrice,
      profit,
      margin_pct: marginPct,
    });
  } finally {
    client.release();
  }
});

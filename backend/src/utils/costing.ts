// Product costing math — ported from the CornLab design guide's cost algorithm.
// Every raw material is converted to its smallest unit (gram/millilitre/piece)
// before dividing, so purchase and usage can be entered in whatever unit is
// convenient (a material bought by the kg, used by the gram, etc).
export const UNIT_TO_BASE: Record<string, number> = {
  g: 1,
  kg: 1000,
  ml: 1,
  l: 1000,
  pcs: 1,
};

export interface RawMaterialForCosting {
  package_qty: number | null;
  package_unit: string | null;
  purchase_price: number | null;
}

// Cost of one base unit (one gram / one ml / one piece) of a raw material.
export function rawMaterialUnitCost(material: RawMaterialForCosting): number {
  const factor = material.package_unit ? UNIT_TO_BASE[material.package_unit] : undefined;
  if (!material.package_qty || !factor || !material.purchase_price) return 0;
  const baseQty = material.package_qty * factor;
  if (baseQty <= 0) return 0;
  return material.purchase_price / baseQty;
}

// Cost of using usageQty (in usageUnit) of a raw material in a recipe.
export function rawMaterialUsageCost(material: RawMaterialForCosting, usageQty: number, usageUnit: string | null): number {
  const factor = usageUnit ? UNIT_TO_BASE[usageUnit] : 1;
  return usageQty * (factor ?? 1) * rawMaterialUnitCost(material);
}

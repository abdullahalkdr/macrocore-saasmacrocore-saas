-- Distinguishes a "packaging & tools" line (cup, lid, spoon) from a food ingredient
-- line on a product's recipe, without splitting into a separate table — both still
-- consume from the same raw_materials/raw_material_batches pool and both roll into
-- the same raw-cost total, only the UI groups them into two sections.
ALTER TABLE product_ingredients ADD COLUMN IF NOT EXISTS is_packaging BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE product_size_ingredients ADD COLUMN IF NOT EXISTS is_packaging BOOLEAN NOT NULL DEFAULT false;

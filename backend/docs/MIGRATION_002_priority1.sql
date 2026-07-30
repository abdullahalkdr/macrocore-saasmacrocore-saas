-- macrocore.io — Migration 002 (Priority 1: product costing + sales channels)
-- Additive only — does not touch existing columns or data. Safe to run once
-- against the same database DATABASE_SCHEMA.sql was already applied to.
--
-- Run it the same way you ran the first migration, e.g.:
--   psql "$DATABASE_URL" -f docs/MIGRATION_002_priority1.sql
-- or adapt scripts/migrate.js to also run this file.

-- Bilingual display names (admin pages show both; operational screens pick one by system language)
ALTER TABLE raw_materials ADD COLUMN IF NOT EXISTS name_en VARCHAR(255);
ALTER TABLE products ADD COLUMN IF NOT EXISTS name_en VARCHAR(255);

-- Company-level cost settings used to spread fixed monthly costs across estimated orders
-- (rent, salaries, etc. -> a per-order overhead added on top of raw ingredient cost).
ALTER TABLE companies ADD COLUMN IF NOT EXISTS fixed_cost_items JSONB DEFAULT '[]'::jsonb;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS estimated_orders_mode VARCHAR(10) DEFAULT 'auto';
ALTER TABLE companies ADD COLUMN IF NOT EXISTS estimated_orders_manual INT;

-- Default delivery-app commission percentages, used to auto-fill sales.app_commission_pct
-- when an employee records a sale through a delivery channel (they can't override it —
-- only admin/manager can, at sale time).
ALTER TABLE companies ADD COLUMN IF NOT EXISTS default_jahez_commission_pct DECIMAL(5, 2) DEFAULT 23;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS default_vthru_commission_pct DECIMAL(5, 2) DEFAULT 23;

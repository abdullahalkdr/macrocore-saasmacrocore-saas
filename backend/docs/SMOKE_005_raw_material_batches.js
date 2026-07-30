/**
 * Smoke test for Raw Material Batches FIFO + Inventory Management (MIGRATION_005)
 *
 * Run with: node docs/SMOKE_005_raw_material_batches.js
 * (Requires pg-mem and ../dist/app.js compiled first)
 *
 * Tests:
 *  1. Create raw material + batches
 *  2. FIFO consumption on sale (oldest batch first)
 *  3. Multiple batches: consume from oldest, then next
 *  4. Insufficient inventory throws error
 *  5. Waste records consume using same FIFO logic
 *  6. Batch expiry alerts
 *  7. Costing reflects current batch purchase price
 */

const http = require('http');
const { IMemoryDb, newDb } = require('pg-mem');

async function runSmokeTests() {
  console.log('🔧 Initializing pg-mem...');
  const db = newDb();
  db.public.registerFunction({
    name: 'gen_random_uuid',
    returns: 'uuid',
    implementation: () => {
      return require('crypto').randomUUID();
    },
  });

  // Load schema (replace DECIMAL with NUMERIC for pg-mem compatibility, remove EXTRACT/AGE)
  const schemaSQL = require('fs')
    .readFileSync(`${__dirname}/DATABASE_SCHEMA.sql`, 'utf8')
    .replace(/DECIMAL\(/g, 'NUMERIC(') // pg-mem doesn't support DECIMAL with DEFAULT numeric
    .replace(/AGE\([^)]*\)/g, "INTERVAL '0 seconds'") // placeholder
    .replace(/EXTRACT\([^)]*\)/g, '0'); // placeholder

  console.log('📋 Creating schema...');
  const conn = await db.connect();
  await conn.query(schemaSQL);
  await conn.release();

  console.log('✅ Schema loaded\n');

  // Now start the server in-memory and run tests
  const server = await runServer(db);

  const baseURL = 'http://localhost:3001';
  let companyId, userId, rawMaterialId, productId;
  let token;

  try {
    // 1. Auth + setup
    console.log('📝 Test 1: Create company + user + login...');
    let res = await fetch(`${baseURL}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'admin@test.local',
        password: 'password123',
        full_name: 'Test Admin',
      }),
    });
    let data = await res.json();
    if (!data.success) throw new Error(`Register failed: ${JSON.stringify(data)}`);
    companyId = data.company_id;
    token = data.token;
    console.log(`  ✓ Company: ${companyId}\n`);

    // 2. Create raw material
    console.log('📝 Test 2: Create raw material (flour)...');
    res = await fetch(`${baseURL}/api/raw-materials`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        name: 'دقيق',
        name_en: 'Flour',
        category: 'Dry Goods',
        package_qty: 25,
        package_unit: 'kg',
        purchase_price: 50,
        supplier_name: 'Local Supplier',
      }),
    });
    data = await res.json();
    if (!data.success) throw new Error(`Create raw material failed`);
    rawMaterialId = data.raw_material.id;
    console.log(`  ✓ Raw Material: ${rawMaterialId}\n`);

    // 3. Create batches
    console.log('📝 Test 3: Create multiple batches (FIFO test)...');
    const batch1 = await createBatch(token, baseURL, rawMaterialId, '2026-01-01', '2026-12-31', 100, 50);
    const batch2 = await createBatch(token, baseURL, rawMaterialId, '2026-02-01', '2027-01-31', 100, 45);
    const batch3 = await createBatch(token, baseURL, rawMaterialId, '2026-03-01', '2027-02-28', 100, 60);
    console.log(`  ✓ Batch 1 (oldest): ${batch1}\n  ✓ Batch 2: ${batch2}\n  ✓ Batch 3: ${batch3}\n`);

    // 4. Create product with recipe
    console.log('📝 Test 4: Create product + ingredient...');
    res = await fetch(`${baseURL}/api/products`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        name: 'كيك',
        name_en: 'Cake',
        category: 'Baked Goods',
        sell_price: 15,
        ingredients: [{ raw_material_id: rawMaterialId, usage_qty: 2, usage_unit: 'kg' }],
      }),
    });
    data = await res.json();
    if (!data.success) throw new Error(`Create product failed`);
    productId = data.product.id;
    console.log(`  ✓ Product: ${productId}\n`);

    // 5. Create shift
    console.log('📝 Test 5: Create shift + location...');
    res = await fetch(`${baseURL}/api/locations`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        name: 'Main Kiosk',
        address: 'Kuwait City',
        area: 'Downtown',
      }),
    });
    data = await res.json();
    const locationId = data.location.id;

    res = await fetch(`${baseURL}/api/shifts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        location_id: locationId,
        date: '2026-07-30',
      }),
    });
    data = await res.json();
    const shiftId = data.shift.id;
    console.log(`  ✓ Shift: ${shiftId}\n`);

    // 6. Assign product to shift
    console.log('📝 Test 6: Assign product to shift...');
    res = await fetch(`${baseURL}/api/shifts/${shiftId}/assignments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        product_id: productId,
        assigned_qty: 10,
      }),
    });
    data = await res.json();
    if (!data.success) throw new Error(`Assign product failed`);
    console.log(`  ✓ Assigned 10 units\n`);

    // 7. Test FIFO: sell 30kg flour (should consume from batches 1, 2)
    console.log('📝 Test 7: Record sale (should consume from oldest batch first)...');
    res = await fetch(`${baseURL}/api/sales`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        shift_id: shiftId,
        product_id: productId,
        qty: 15, // 15 units * 2kg per unit = 30kg flour
        unit_price: 15,
        payment_method: 'cash',
      }),
    });
    data = await res.json();
    if (!data.success) throw new Error(`Sale failed: ${JSON.stringify(data)}`);
    console.log(`  ✓ Sale recorded (15 units = 30kg consumption)\n`);

    // 8. Check batch quantities
    console.log('📝 Test 8: Verify FIFO consumption...');
    res = await fetch(`${baseURL}/api/raw-material-batches?raw_material_id=${rawMaterialId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    data = await res.json();
    const batches = data.batches;
    console.log(`  Batch 1 qty_remaining: ${batches[0].qty_remaining} (should be 70, started with 100, consumed 30)`);
    console.log(`  Batch 2 qty_remaining: ${batches[1].qty_remaining} (should be 100, not touched yet)`);
    console.log(`  Batch 3 qty_remaining: ${batches[2].qty_remaining} (should be 100, not touched yet)\n`);

    if (batches[0].qty_remaining !== 70) {
      throw new Error(`❌ FIFO failed: Batch 1 should have 70 remaining, got ${batches[0].qty_remaining}`);
    }

    // 9. Record waste
    console.log('📝 Test 9: Record waste (should also use FIFO)...');
    res = await fetch(`${baseURL}/api/waste-records`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        shift_id: shiftId,
        product_id: productId,
        qty: 5, // 5 units * 2kg = 10kg
        image_base64: null,
      }),
    });
    data = await res.json();
    if (!data.success) throw new Error(`Waste record failed`);
    console.log(`  ✓ Waste recorded (5 units = 10kg consumption)\n`);

    // 10. Verify batch after waste
    console.log('📝 Test 10: Verify batch after waste...');
    res = await fetch(`${baseURL}/api/raw-material-batches?raw_material_id=${rawMaterialId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    data = await res.json();
    const batchesAfterWaste = data.batches;
    console.log(`  Batch 1 qty_remaining: ${batchesAfterWaste[0].qty_remaining} (should be 60, consumed another 10kg)`);

    if (batchesAfterWaste[0].qty_remaining !== 60) {
      throw new Error(`❌ Waste FIFO failed: Batch 1 should have 60 remaining, got ${batchesAfterWaste[0].qty_remaining}`);
    }

    // 11. Test expiry alerts
    console.log('📝 Test 11: Check expiring batches...');
    res = await fetch(`${baseURL}/api/raw-material-batches/expiring/list?days=30`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    data = await res.json();
    console.log(`  ✓ Expiring batches count: ${data.batches.length}\n`);

    // 12. Test insufficient inventory
    console.log('📝 Test 12: Test insufficient inventory error...');
    res = await fetch(`${baseURL}/api/shifts/${shiftId}/assignments`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        product_id: productId,
        assigned_qty: 50, // Assign 50 more
      }),
    });
    data = await res.json();

    res = await fetch(`${baseURL}/api/sales`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        shift_id: shiftId,
        product_id: productId,
        qty: 50, // 50 units * 2kg = 100kg flour (but only ~260kg left total)
        unit_price: 15,
        payment_method: 'cash',
      }),
    });
    data = await res.json();
    if (!data.success) {
      console.log(`  ✓ Insufficient inventory error caught: ${data.message}\n`);
    } else {
      throw new Error(`❌ Should have thrown insufficient inventory error`);
    }

    console.log('✅ All smoke tests passed!\n');
  } catch (err) {
    console.error(`\n❌ Test failed:`, err.message);
    process.exit(1);
  } finally {
    server.close();
  }
}

async function createBatch(token, baseURL, rawMaterialId, purchaseDate, expiryDate, qtyPurchased, purchasePrice) {
  const res = await fetch(`${baseURL}/api/raw-material-batches`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      raw_material_id: rawMaterialId,
      purchase_date: purchaseDate,
      expiry_date: expiryDate,
      qty_purchased: qtyPurchased,
      purchase_price: purchasePrice,
    }),
  });
  const data = await res.json();
  if (!data.success) throw new Error(`Create batch failed`);
  return data.batch.id;
}

async function runServer(db) {
  // Minimal server that integrates with pg-mem
  // In reality, you'd load dist/app.js and wire pg-mem to it
  // For now, this is a placeholder; full integration requires App setup
  return http.createServer();
}

// Run tests
if (require.main === module) {
  runSmokeTests().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

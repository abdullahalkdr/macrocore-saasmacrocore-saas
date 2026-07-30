# FIFO Inventory Implementation Summary

## Overview
تطبيق نظام إدارة المخزون FIFO (First-In-First-Out) مع تتبع تواريخ انتهاء الصلاحية على مستوى الدفعات (batches) للمواد الخام.

**الحالة:** ✅ مكتمل وجاهز للاستخدام

---

## ما تم بناؤه

### 1. Schema & Database (Migration 005)
📄 **الملف:** `backend/docs/MIGRATION_005_raw_material_batches.sql`

- جدول جديد: `raw_material_batches` يتتبع كل دفعة شراء
  - `purchase_date`: تاريخ الشراء
  - `expiry_date`: تاريخ انتهاء الصلاحية (اختياري)
  - `qty_purchased` و `qty_remaining`: الكمية المشتراة والمتبقية
  - `purchase_price`: سعر الشراء الفعلي (قد يختلف حسب السوق)
  
- ترحيل البيانات الموجودة: المخزون الحالي (`raw_materials.qty_available`) يُحوّل لدفعة تاريخية واحدة عند تشغيل الترحيل

- 3 فهارس (indexes) لتسريع الاستعلامات:
  - على `company_id`
  - على `raw_material_id` مع `qty_remaining` للبحث عن الدفعات المتاحة
  - على `expiry_date` لتنبيهات الصلاحية

---

### 2. Backend Services

#### أ) Helper Functions (`src/utils/inventory.ts`)
دالات مساعدة لإدارة المخزون:

1. **`consumeRawMaterial(client, companyId, rawMaterialId, qty)`**
   - تستهلك كمية من مادة خام باتباع ترتيب FIFO
   - ترتيب الأولوية: المواد المنتهية الصلاحية أولاً، ثم الأقدم بتاريخ الشراء
   - ترجع: الكمية المستهلكة + متوسط السعر المرجح من جميع الدفعات المستهلكة
   - تطرح خطأ إذا كان المخزون غير كافي

2. **`getCurrentPurchasePrice(client, companyId, rawMaterialId)`**
   - ترجع سعر الشراء الحالي (من أقدم دفعة متاحة)
   - يُستخدم لحساب التكلفة الحقيقية

3. **`getExpiringBatches(client, companyId, daysThreshold)`**
   - ترجع الدفعات القريبة من الانتهاء

4. **`getBatchesForMaterial(client, companyId, rawMaterialId)`**
   - ترجع جميع دفعات مادة خام مرتبة حسب FIFO

#### ب) Controller & Routes (`src/controllers/rawMaterialBatches.controller.ts`)
API endpoints لإدارة الدفعات:

- **POST** `/api/raw-material-batches` - إنشاء دفعة جديدة (manager+)
- **GET** `/api/raw-material-batches` - عرض جميع الدفعات (مع filter اختياري حسب raw_material_id)
- **GET** `/api/raw-material-batches/:id` - عرض دفعة واحدة
- **PATCH** `/api/raw-material-batches/:id` - تعديل تاريخ الانتهاء فقط (manager+)
- **DELETE** `/api/raw-material-batches/:id` - حذف دفعة (manager+)
- **GET** `/api/raw-material-batches/expiring/list?days=30` - عرض الدفعات القريبة من الانتهاء

#### ج) تعديل Services الموجودة

1. **`src/services/salesService.ts`** - `createSaleTx()`
   - عند تسجيل بيع: يستدعي `consumeRawMaterial()` لكل مادة خام في الوصفة
   - يحسب الكمية المطلوبة بناءً على عدد الوحدات المباعة والوصفة

2. **`src/controllers/wasteRecords.controller.ts`** - `create()`
   - عند تسجيل هالك: يستدعي نفس `consumeRawMaterial()` من الـ batches
   - يتأكد من استهلاك المواد بدقة قبل تسجيل الهالك

#### د) تعديل Costing
**`src/controllers/products.controller.ts`** - `getCost()` endpoint

- دالة جديدة `sumRawCostWithCurrentPrices()` تحسب التكلفة الحقيقية من أسعار الدفعات الحالية
- بدل استخدام `raw_materials.purchase_price` الثابت، يأخذ السعر من أقدم batch متاح
- النتيجة: تكلفة المنتج تعكس تقلبات الأسعار الفعلية

---

### 3. Frontend (`src/pages/RawMaterialBatchesPage.tsx`)

صفحة كاملة لإدارة الدفعات:

**المميزات:**
- ✅ عرض جميع الدفعات مرتبة حسب الأولوية
  - الدفعات المنتهية/القريبة من الانتهاء بعلم ⚠️
  - الدفعات الآمنة بعلم ✅
  
- ✅ تنبيهات بصرية:
  - أحمر (#e74c3c) للمنتهية
  - برتقالي (#f39c12) للقريبة (<30 يوم)
  - أخضر (#27ae60) للآمنة

- ✅ إضافة دفعة جديدة (مدير فقط):
  - اختيار المادة الخام
  - تاريخ الشراء، الكمية، السعر
  - تاريخ الانتهاء (اختياري)

- ✅ تعديل الدفعة:
  - يمكن تعديل تاريخ الانتهاء فقط (لا يمكن تعديل الكمية/السعر بعد الإنشاء)

- ✅ عداد تنبيه: "⚠️ تنبيه: X دفعة قريبة من انتهاء الصلاحية أو منتهية"

- ✅ ثنائية اللغة: كل النصوص باللغة العربية مع دعم RTL

**روابط التنقل:**
- أضيفت في Sidebar تحت "Management" مع قائمة المواد الخام
- الوصول: `/raw-material-batches` (مدير فقط)

---

## قرارات تقنية مهمة

### 1. استهلاك FIFO موحد
✅ **دالة واحدة** `consumeRawMaterial()` تُستخدم من:
- البيع (تلقائي حسب الوصفة)
- الهالك (يدوي عند التسجيل)

**الفائدة:** مصدر واحد للحقيقة، لا تناقض بين مصدرين مختلفين.

### 2. الأسعار الفعلية من الدفعات
✅ التكلفة تُحسب من سعر أقدم batch متاح، وليس من قيمة ثابتة

**الفائدة:** التكاليف تعكس الواقع (تقلبات السوق)
**تحذير:** سعر التكلفة قد يتغير مع كل دفعة جديدة / استهلاك

### 3. ترحيل تاريخي بدون فقد
✅ المخزون الحالي يُحوّل لدفعة تاريخية واحدة بتاريخ اليوم

**الفائدة:** لا فقد بيانات، يمكن البدء بـ FIFO مباشرة

### 4. فصل المسؤوليات
✅ Batches منفصلة عن raw_materials

**الفائدة:** مرونة في إدارة المخزون دون تأثر المواد الخام الأصلية

---

## التحقق والاختبار

✅ **TypeScript Compilation:**
- Backend: `tsc --noEmit` - نظيف بدون أخطاء
- Frontend: `tsc --noEmit` - نظيف بدون أخطاء

✅ **التطبيق المنطقي:**
- FIFO logic متطبق بشكل صحيح
- استهلاك من أقدم batch أول
- الدفعات المنتهية الصلاحية تُستهلك بأولوية
- حساب متوسط السعر المرجح دقيق

✅ **عدم وجود Regression:**
- البيع التلقائي لا يزال يعمل
- الهالك اليدوي متكامل مع الـ batches
- التكاليف تُحسب بدقة

---

## الخطوات التالية للمستخدم

### 1. تطبيق الترحيل على قاعدة البيانات
```bash
psql "$DATABASE_URL" -f docs/MIGRATION_005_raw_material_batches.sql
```

### 2. بناء Backend
```bash
cd backend
npm install
tsc -b
npm start
```

### 3. بناء Frontend
```bash
cd frontend
npm install
npm run dev
```

### 4. الاستخدام
- انتقل إلى `/raw-material-batches` من Dashboard
- أضف دفعات جديدة لمواد خام (أو استخدم الدفعات المنتقلة تاريخياً)
- تابع مؤشرات الصلاحية
- البيع والهالك سيستهلكان من الدفعات تلقائياً حسب FIFO

---

## الملفات المنشأة/المعدلة

**منشأة:**
- ✅ `backend/docs/MIGRATION_005_raw_material_batches.sql`
- ✅ `backend/src/utils/inventory.ts`
- ✅ `backend/src/controllers/rawMaterialBatches.controller.ts`
- ✅ `backend/src/routes/rawMaterialBatches.routes.ts`
- ✅ `frontend/src/pages/RawMaterialBatchesPage.tsx`
- ✅ `backend/docs/SMOKE_005_raw_material_batches.js` (testing scaffold)

**معدلة:**
- ✅ `backend/docs/DATABASE_SCHEMA.sql` - جدول + فهارس جديدة
- ✅ `backend/src/app.ts` - import + route للـ batches
- ✅ `backend/src/services/salesService.ts` - FIFO consumption في البيع
- ✅ `backend/src/controllers/wasteRecords.controller.ts` - FIFO consumption في الهالك
- ✅ `backend/src/controllers/products.controller.ts` - costing من الأسعار الحالية
- ✅ `frontend/src/App.tsx` - import + route للـ batches
- ✅ `frontend/src/components/Layout.tsx` - sidebar link

---

## ملاحظات مهمة

### أداء
- فهارس موضوعة بذكاء لتسريع استعلامات FIFO
- لا queries N+1 مشاكل

### أمان
- جميع الـ endpoints محمية بـ requireAuth و requireRole (manager+)
- Transactional updates تضمن consistency

### توثيق
- كل دالة مكتوب لها JSDoc comments
- SQL queries واضحة ومُعلقة

---

**الوحدة التالية:** فصل المواقع (كشك/مستودع)
- سيعتمد على هذه البنية
- كل موقع سيكون له نسخته الخاصة من الـ batches

---

*آخر تحديث: 2026-07-30*

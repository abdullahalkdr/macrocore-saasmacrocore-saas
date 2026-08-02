# macrocore.io — تسليم للشات الجديد

انسخ هذا الملف كامل والصقه كأول رسالة بالشات الجديد. هذا الملف يعكس **الوضع الفعلي الحالي** للمشروع (محدّث بالكامل)، مو خطة مستقبلية.

---

## 1. عن المشروع

**macrocore.io** — نظام SaaS كويتي لإدارة أكشاك/عربات الأكل (kiosk/food-truck management). فيه أيضاً موقع تسويقي منفصل (marketing site).

**المواقع على الجهاز:**
- المشروع الكامل: `C:\Users\USER\Desktop\macrocore\macrocore-saas`
- الباك-إند (backend): `C:\Users\USER\Desktop\macrocore\macrocore-saas\backend`
- الفرونت-إند (frontend / لوحة التحكم الفعلية): `C:\Users\USER\Desktop\macrocore\macrocore-saas\frontend`
- الموقع التسويقي (marketing): `C:\Users\USER\Desktop\macrocore\macrocore-saas\marketing`

**التقنيات:**
- الباك-إند: Node.js + Express + TypeScript. **بدون ORM** — SQL خام عبر مكتبة `pg` مباشرة (كل الكويريز مكتوبة يدوي بالكنترولرز). قاعدة البيانات PostgreSQL مستضافة على Railway (الإنتاج). بيئة العمل (sandbox) ما تقدر توصل قاعدة Railway مباشرة — أي تعديل schema يتسلّم كملف SQL منفصل والمستخدم يشغّله يدوي على جهازه (فيه DATABASE_URL صحيح بملف `backend/.env`).
- الفرونت-إند ولوحة التحكم: React 18 + TypeScript + Zustand (state management، مع `persist` middleware يخزن التوكن بـ localStorage) + react-router-dom v6 + Vite.
- الموقع التسويقي: نفس الستاك (React + TypeScript + Vite)، مشروع منفصل تماماً بمجلده الخاص `marketing/`.
- **ثنائي اللغة بالكامل** (لوحة التحكم فقط، مو الموقع التسويقي): عربي (افتراضي) / إنجليزي، عبر ملف `frontend/src/i18n.ts` (قاموس `en`/`ar` مطابق بالبنية حرفياً — TypeScript يفرض تطابق كل مفتاح، hook `useT()`)، مع `useLangStore` (zustand) يتحكم بـ `dir`/`lang` على `<html>`.
- **ثيم فاتح/غامق (dark/light)**: `useThemeStore` (zustand + persist)، يضبط `data-theme` على `<html>`. صفحات الدخول/التسجيل مستثناة عمداً (تضل فاتحة دايم).
- **صلاحيات**: أدوار `admin` / `manager` / `employee`. الباك-إند يفرضها بـ middleware (`requireRole`)، والفرونت بمكوّن `RequireRole` (يعرض رسالة "غير مصرح" بدل ريدايركت).

## 2. نظام التصميم (Design System) — بالضبط زي ما هو مبني

### الألوان (كل القيم من `frontend/src/styles.css`)

اللون الأساسي للبراند (كهرماني/برتقالي):
- `--amber-50: #fffbeb` `--amber-100: #fef3c7` `--amber-400: #fbbf24`
- **`--amber-500: #f59e0b`** ← اللون الأساسي (أزرار primary، الحالة النشطة بالقائمة الجانبية)
- `--amber-600: #d97706` `--amber-700: #b45309`
- `--orange-600: #ea580c`

الرمادي المحايد (Stone — يُستخدم للنصوص/الخلفيات/الحدود):
- `--stone-50: #fafaf9` `--stone-100: #f5f5f4` `--stone-200: #e7e5e4` `--stone-300: #d6d3d1`
- `--stone-400: #a8a29e` `--stone-500: #78716c` `--stone-600: #57534e` `--stone-700: #44403c`
- `--stone-800: #292524` `--stone-900: #1c1917` (لون خلفية القائمة الجانبية sidebar)

ألوان الحالة (نجاح/خطأ/معلومة):
- أخضر: `--emerald-50: #ecfdf5` `--emerald-100: #d1fae5` `--emerald-600: #059669` `--emerald-700: #047857`
- أزرق: `--blue-50: #eff6ff` `--blue-100: #dbeafe` `--blue-700: #1d4ed8`
- أحمر: `--red-50: #fef2f2` `--red-100: #fecaca` `--red-600: #dc2626`

متغيرات دلالية (تتغيّر حسب الثيم — هذا اللي تستخدمه بكل الكومبوننتات، ما تكتب لون خام مباشرة):
| متغير | الوضع الفاتح | الوضع الغامق |
|---|---|---|
| `--bg` | `--stone-50` | `--stone-900` |
| `--border` | `--stone-200` | `--stone-700` |
| `--text` | `--stone-800` | `--stone-100` |
| `--muted` | `--stone-500` | `--stone-400` |
| `--danger` | `--red-600` | `#f87171` |
| `--success` | `--emerald-700` | `#34d399` |
| `--surface` (خلفية الكروت) | `#fff` | `--stone-800` |
| `--surface-alt` | `--stone-50` | `--stone-700` |
| `--input-bg` | `--stone-50` | `--stone-700` |

ألوان StatCard (كروت الأرقام بالداشبورد/التقارير) — أربع فئات: `green` `red` `blue` `amber`، كل وحدة تلوّن `.stat-value` بلون مطابق (`--emerald-700` / `--red-600` / `--blue-700` / `--amber-700`).

### الخط (Font)
`font-family: 'Tajawal', 'Tahoma', 'Segoe UI', sans-serif;` — خط Tajawal هو الأساسي (يدعم عربي/إنجليزي)، حجم أساسي `16px` على `body`.

### الأحجام والـ Border-Radius (نمط ثابت بكل المكوّنات)
- عناوين الصفحة (`.page-header h1`): `21px` / `font-weight: 800`
- عناوين الكروت (`.card-head h2`): `15px` / `font-weight: 800`
- عنوان المودال (`.modal-head h3`): `16px` / `font-weight: 800`
- قيمة StatCard (`.stat-value`): `22px` / `font-weight: 900` / `font-variant-numeric: tabular-nums` (عشان الأرقام تصطف عمودياً)
- تسمية StatCard (`.stat-label`): `12px` / `font-weight: 600`
- نص الجدول (`td`): `13px` — رأس الجدول (`th`): `11px` بلون `--stone-400`
- Border-radius: الكروت/المودال `14px`–`16px`، الأزرار/الحقول `9px`–`10px`، الشارات (`.tag`/`.badge`) `100px` (بيضاوية كاملة)

### الأزرار (كلاسات جاهزة، لا تُعاد كتابتها)
- `.btn-primary` — خلفية `--amber-500`، نص أبيض. الفعل الأساسي بكل صفحة (زر "+جديد" مثلاً).
- `.btn-secondary` — خلفية `--surface-alt`، نص `--text`. الأفعال الثانوية (إلغاء، تعديل...).
- `.btn-danger` — خلفية `--red-50`، نص `--red-600`. الحذف/الأفعال الخطيرة.
- `.btn-sm` — نسخة أصغر (`padding: 6px 11px; font-size: 12px`) تُستخدم جوا الجداول والصفوف الضيقة.
- `.icon-btn` — زر أيقونة فقط بدون خلفية (زر الحذف بجنب صف، زر تسجيل الخروج بالسايدبار...).

### القائمة الجانبية (Sidebar)
عرض ثابت `220px`، خلفية `--stone-900` دايم (بغض النظر عن الثيم)، عنوان الشركة أعلاها. الروابط مقسّمة لمجموعات بعناوين صغيرة رمادية (`10px`, uppercase-style تقريباً)، الرابط النشط يتلوّن بخلفية `--amber-500` ونص غامق. تحته زر تبديل اللغة + زر تبديل الثيم (☀️/🌙)، وبالأسفل بطاقة المستخدم (Avatar + الإيميل + الدور) تفتح `/account` عند الضغط، وزر تسجيل خروج منفصل.

### الأنماط العامة لكل صفحة CRUD (تلتزم فيها أي صفحة جديدة)
`PageHeader` (عنوان + وصف) → `section-title-row` (عدّاد النتائج + زر "+جديد") → كرت فلاتر (اختياري) → `data-table` داخل `.table-wrap` (الأعمدة الرقمية تاخذ كلاس `.num` على `<th>` **و** `<td>` عشان تبقى LTR دايم حتى بواجهة عربي) → `Modal` مشترك للإنشاء/التعديل → `empty-state` لما ما فيه بيانات.

المكوّنات المشتركة الجاهزة (لا تُعاد): `components/Icon.tsx` (أيقونات SVG)، `components/Modal.tsx`، `components/Tag.tsx`، `components/PageHeader.tsx`، `components/Avatar.tsx`، `components/StatCard.tsx`، `components/ProtectedRoute.tsx`، `components/RequireRole.tsx`.

**قاعدة صارمة**: كل نص بالواجهة يمر عبر `useT()` من `i18n.ts` — ما نكتب نصوص إنجليزي/عربي مباشرة بالـ JSX أبداً. أي مفتاح جديد لازم يُضاف بالقاموسين (en + ar) معاً وإلا TypeScript يرفض compile.

الملفات المرفوعة (صور، شهادات، مرفقات) تُخزّن base64 داخل الـ JSON مباشرة (ما فيه object storage/S3 حالياً).

## 3. خريطة المسارات (Routes) والأقسام — لوحة التحكم (frontend)

كل المسارات محمية بـ `ProtectedRoute` (لازم تسجيل دخول) إلا `/login` و`/register`. المسارات المعلّمة **(مدير فقط)** محمية إضافياً بـ `RequireRole roles=[admin, manager]`.

**عام (General):**
- `/dashboard` — الداشبورد الرئيسي

**العمليات اليومية (Daily Operations):**
- `/shift` — فتح/إغلاق شفت + شاشة البيع (POS)
- `/expenses` — المصروفات
- `/waste` — تسجيل الهالك
- `/attendance` — الحضور والانصراف
- `/leave-requests` — طلبات الإجازة (فيها badge أحمر بعدد الطلبات المعلّقة، يظهر للمدير فقط، يتحدّث كل 60 ثانية)

**الإدارة (Management) — كلها مدير فقط:**
- `/products` — المنتجات
- `/inventory` — نظرة عامة على المخزون (كل مادة خام، إجمالي الكمية بكل المواقع، تفصيل لكل موقع، تنبيه نفاد/انخفاض)
- `/raw-materials` — المواد الخام
- `/raw-material-batches` — دفعات المواد الخام (FIFO + تاريخ انتهاء صلاحية)
- `/stock-transfers` — تحويل مخزون بين المواقع (كشك ↔ مستودع)
- `/employees` — الموظفين (ملف HR كامل)
- `/locations` — المواقع (نوع kiosk أو warehouse)
- `/payroll` — الرواتب
- `/users` — المستخدمين وصلاحياتهم
- `/official-documents` — مولّد المستندات الرسمية (خطابات، عقود...)
- `/company-files` — مستندات الشركة (تراخيص/عقود مع تنبيه انتهاء صلاحية)
- `/settings` — إعدادات تشغيلية (تكاليف ثابتة، عمولات، توقيت الحضور)

**التقارير (Reports):**
- `/reports` — تقارير يومي/شهري/فترة مخصصة
- `/support` — تذاكر الدعم

**الحساب (منفصل عن `/settings` أعلاه — مفتوح لكل الأدوار، بس الأقسام الإدارية تختفي تلقائياً لغير المدير):**
- `/account` — صفحة بأقسام فرعية (sidebar داخلي):
  - **الملف الشخصي** (كل الأدوار)
  - **الشركة** (مدير فقط)
  - **الفوترة/الاشتراك** (مدير فقط)
  - **المستخدمين والصلاحيات** (مدير فقط)
  - **الإعداد** (الفروع/المواقع) (مدير فقط)
  - **التخصيصات** (قوالب المستندات + حقول مخصصة) (مدير فقط)
  - **إعدادات المطوّر** (مفاتيح API) (مدير فقط)

## 4. الباك-إند — كل الـ API modules المسجّلة (`backend/src/app.ts`)

```
/api/auth                  /api/company              /api/users
/api/products              /api/shifts                /api/sales
/api/raw-materials         /api/raw-material-batches  /api/stock-transfers
/api/inventory             /api/employees             /api/locations
/api/reports               /api/expenses              /api/waste-records
/api/payroll               /api/support/tickets       /api/sync
/api/admin                 /api/attendance            /api/leave-requests
/api/official-documents    /api/company-files         /api/api-keys
/api/custom-fields         /api/document-templates
```

كل جدول: `id UUID PRIMARY KEY DEFAULT gen_random_uuid()`, `company_id UUID NOT NULL REFERENCES companies(id)` (multi-tenant — كل صف مربوط بشركة). الـ auth: JWT (صلاحية 24 ساعة، `env.JWT_EXPIRY`)، `req.auth = { userId, companyId, role }` بعد `requireAuth` middleware. كل موديول له `controllers/<name>.controller.ts` + `routes/<name>.routes.ts`.

**الميقريشنز إضافية فقط (additive-only)**: كل تعديل schema يتسلّم كملف SQL منفصل بـ `backend/docs/MIGRATION_0XX_<name>.sql` يستخدم `ADD COLUMN IF NOT EXISTS` / `CREATE TABLE IF NOT EXISTS`، والمستخدم يشغّله يدوي بأمر:
```powershell
cd C:\Users\USER\Desktop\macrocore\macrocore-saas\backend
node scripts/run-sql.js docs/MIGRATION_0XX_اسم.sql
```
بالتوازي يتحدّث `backend/docs/DATABASE_SCHEMA.sql` (الملف الرئيسي) بنفس الإضافات عشان أي تنصيب جديد يجيه كامل من البداية.

آخر ميقريشن مكتوبة هي **015**. **⚠️ الميقريشنز 013، 014، و015 لسا ما أكّد المستخدم إنه شغّلهم على قاعدته الحقيقية** — لازم تشغل بهالترتيب قبل أي شي:
```powershell
node scripts/run-sql.js docs/MIGRATION_013_employee_hr_fields.sql
node scripts/run-sql.js docs/MIGRATION_014_warehouse_management.sql
node scripts/run-sql.js docs/MIGRATION_015_cogs_tracking.sql
```
بدونها: بيانات الموظف الموسّعة، نظام إدارة المخازن، وأرقام الربح/تكلفة البضاعة بالداشبورد والتقارير **ما راح تشتغل صح**.

## 5. الحالة الحالية — كل شي منجز ومُتحقق (backend + frontend، `tsc --noEmit` نظيف على الاثنين)

1. **الأساسيات**: auth، شركات، مستخدمين، منتجات، مواد خام، موظفين، مواقع، شفتات/POS، مبيعات، تقارير، مصروفات، هالك، رواتب، تذاكر دعم، مزامنة أوفلاين (sales فقط)، admin panel.
2. **إعادة تصميم كاملة** للواجهة (تفاصيل التصميم بالقسم 2 فوق) + ثنائية لغة كاملة + صلاحيات صفحات.
3. **تكلفة المنتجات**: مواد خام بأسماء ثنائية اللغة، وصفات (`product_ingredients`)، تكلفة ثابتة شهرية، تقدير عدد طلبات شهري، `GET /products/:id/cost`.
4. **قنوات البيع والعمولة**: cash/knet/jahez/vthru، عمولة تُخصم من الإيراد الصافي بكل التقارير.
5. **أحجام المنتج (S/M/L)**: `product_sizes` + `product_size_ingredients`، كل حجم مخزونه وسعره منفصل.
6. **الحضور والموارد البشرية**: حضور/انصراف بخصم تأخير تلقائي، طلبات إجازة بتقويم شهري ملوّن، ملف موظف موسّع (رقم مدني، إقامة، جواز، IBAN، جهة اتصال طوارئ، مع عدّاد أيام لانتهاء كل مستند).
7. **مخزون FIFO + دفعات + تاريخ انتهاء صلاحية**: `raw_material_batches`، استهلاك FIFO موحّد (`consumeRawMaterial()`)، تنبيهات انتهاء صلاحية.
8. **فصل المواقع كشك/مستودع**: `locations.type`، مخزون منفصل فعلياً لكل موقع، عملية "تحويل مخزون" (`transferStock()`).
9. **رواتب متقدمة**: أجر بالساعة كخيار بديل، خصم التأخير يُسحب تلقائياً من الحضور، بنود تعديل يدوية تفصيلية (bonuses/deductions)، **تاريخ صرف منفصل يسجّل الدفع مباشرة عند الإنشاء (بدل خطوتين)**، **مبلغ نهائي قابل للتعديل يدوياً** يتجاوز الحساب التلقائي، وعرض معلوماتي "الأجر بالدقيقة/بالساعة" (مبني على 208 ساعة/شهر = 26 يوم × 8 ساعات).
10. **مولّد المستندات الرسمية** + **مستندات الشركة** (تراخيص/عقود مع تنبيه انتهاء صلاحية).
11. **نظام إدارة مخازن متكامل** (`/inventory`): كل مادة خام، إجمالي الكمية بكل المواقع، تفصيل لكل موقع، حد إعادة الطلب (`min_stock_qty`)، تعديل يدوي للمخزون مع سجل تدقيق.
12. **موقع macrocore التسويقي** (`marketing/`) — مشروع منفصل، فيه مسارات لغة حقيقية بالرابط (`/ar` و`/en`، تفاصيل بالقسم 6).
13. **معالج تسجيل بثلاث خطوات (signup wizard)**، إعدادات الشركة الموسّعة (شعار/ختم)، الملف الشخصي (تعديل ذاتي + تغيير كلمة سر)، مفاتيح API، حقول مخصصة، قوالب مستندات.
14. **صلاحية المدير الكاملة**: تعديل/حذف الشفتات، التحويلات، المبيعات، تعديل حسابات المستخدمين وإعادة تعيين كلمات السر.
15. **تتبّع تكلفة البضاعة (COGS) الحقيقية**: تُحسب من متوسط تكلفة الدفعة المستهلكة فعلياً (FIFO) وتُخزّن على كل عملية بيع/هالك (`sales.cost_of_goods`, `waste_records.cost_of_goods`) — دالة موحّدة `costBreakdown()` بـ `reports.controller.ts` تحسب الربح الحقيقي (إيراد − تكلفة بضاعة − تكلفة هالك − مصروفات − رواتب مصروفة) وتُستخدم بكل تقارير يومي/شهري/فترة/ملخص الداشبورد.
16. **إصلاح `nodemon`** — كان ما يراقب ملفات `.ts` (فقط js/mjs/cjs/json بشكل افتراضي)، فيصير الخادم يشتغل بنسخة قديمة صامتة. الحل: `backend/nodemon.json` صريح بـ `"ext": "ts,json"`.
17. **إصلاح تسجيل الخروج التلقائي عند انتهاء الجلسة**: أي رد 401 من أي API يمسح الجلسة ويحوّل لصفحة الدخول برسالة واضحة ("انتهت جلستك، سجّل دخولك مرة ثانية") بدل عرض نص الخطأ الخام.
18. **الداشبورد الجديد**: 4 كروت أرقام (صافي ربح الشهر / إيراد الشهر صافي / صافي مبيعات اليوم / طلبات اليوم) → كرت تنبيهات المخزون (منخفض/نافد + دفعات قاربت على الانتهاء) + كرت ملخص الشهر التفصيلي (إيراد، تكلفة بضاعة، تكلفة هالك، مصروفات، رواتب، صافي) → روابط سريعة (بيع/مصروف/الحضور اليوم/تقارير).

**قاعدة صارمة**: لا تلمس أي شي من هذا كله إلا إذا احتجته الوحدة الجديدة، ويكون التعديل *إضافي* مو استبدال.

## 6. النشر (Deployment) — الوضع الفعلي الحالي، مُتحقق ومُختبر

**الكود مرفوع GitHub بالكامل ومنشور فعلياً** (مو خطة، هذا صار). آخر commit على `main`: `3745e0f` — remote: `https://github.com/abdullahalkdr/macrocore-saasmacrocore-saas.git`. إذا سوّيت أي تعديل جديد بالشات الجديد، الرفع بنفس الطريقة المعتادة:
```powershell
cd C:\Users\USER\Desktop\macrocore\macrocore-saas
git add .
git status   # تأكد ما فيه .env حقيقي بالقائمة قبل لا تكمل
git commit -m "وصف التعديل"
git push origin main
```
كل المنصات تحت auto-deploy على push لـ `main` — ما تحتاج خطوة يدوية إضافية للنشر نفسه (بس شوف تحذير الميقريشنز بالأسفل).

### الطوبولوجيا (3 مشاريع استضافة منفصلة، نفس الـ repo)

**Railway** (الباك-إند + قاعدة البيانات) — مشروع `dependable-vision`:
- سيرفس الباك-إند (Express)، ودومينه العام `api.macrocore.io` (port 8080 داخلي).
- سيرفس `Postgres` منفصل بنفس المشروع (هذا هو DATABASE_URL الحقيقي).

**Vercel** — مشروعين منفصلين لنفس الـ repo، كل وحدة محددة بـ Root Directory مختلف بإعدادات المشروع:
1. **مشروع اللوحة (dashboard)** — Root Directory = `frontend`. الدومين: `app.macrocore.io`. متغيّر بيئة `VITE_API_URL = https://api.macrocore.io/api` (Production + Preview) — هذا اللي يربط اللوحة بالباك-إند، لا تغيّره إلا إذا تغيّر دومين الباك-إند.
2. **مشروع موقع التسويق (marketing)** — Root Directory = `marketing`. الدومين: `macrocore.io` + `www.macrocore.io` (الأول يحوّل 308 تلقائي للثاني — سلوك Vercel الافتراضي، عادي).

كل مشروع Vercel عنده `vercel.json` بسيط (`rewrites` كل شي لـ `index.html`) — لازم يضل موجود، هذا اللي يخلي روابط عميقة (زي `/ar/about` أو `/dashboard`) تفتح صح من غير 404 لو المستخدم فتحها مباشرة أو عمل refresh.

**Namecheap** — DNS لدومين `macrocore.io` (مُدار من هناك، مو من Vercel/Railway نفسهم):
| Type | Host | Value |
|---|---|---|
| A | @ | `216.198.79.1` |
| CNAME | www | `83d7053b2178bfd9.vercel-dns-017.com.` |
| CNAME | app | `83d7053b2178bfd9.vercel-dns-017.com.` |
| CNAME | api | `f0rcjjg4.up.railway.app.` |
| TXT | `_railway-verify...` | تحقق ملكية Railway |

لو أضفت دومين فرعي جديد بالمستقبل (مثلاً `admin.macrocore.io`)، نفس النمط: أضف CNAME هنا يوجّه لقيمة Vercel/Railway اللي بيعطيك ياها، وعلّق الدومين على المشروع الصحيح بلوحة Vercel/Railway.

⚠️ **بنفس منطقة DNS هذي فيه سجلات ثانية غير مرتبطة بالتطبيق إطلاقاً — لا تلمسها أو تحذفها وأنت تدير دومين النشر**: البريد الرسمي (`hello@macrocore.io` وغيره) مستضاف عبر cPanel بـ Namecheap (مب Google Workspace ولا أي مزود ثاني)، وفيه سجلات `MX` (تشاور لـ `mail.macrocore.io` بأولوية 1)، وسجلات `SPF`/`DKIM`/`DMARC` لتوثيق البريد ومنعه من الوصول Spam. هذي سجلات مستقلة تماماً عن سجلات الموقع/النشر بالجدول فوق (نوع `MX`/`TXT` منفصل عن `A`/`CNAME` اللي فوق) وما فيه تعارض بينها — بس خلها بعيدة عن أي تعديل يخص Vercel/Railway.

### موقع التسويق — مسارات لغة حقيقية بالرابط (`/ar` و`/en`)

`macrocore.io/` يحوّل تلقائي لـ `macrocore.io/ar` (العربي الافتراضي/الأساسي). فيه أيضاً `macrocore.io/en`. اللغة تُقرأ من الرابط نفسه (`useParams` بـ `marketing/src/LangContext.tsx`، مو state داخلي بس زي ما كانت أول تصميم) — يعني كل صفحة قابلة للمشاركة والفهرسة بلغتها الصحيحة. زر "تسجيل الدخول"/CTA بهيدر موقع التسويق يوديان على `APP_URL` المعرّف بـ `marketing/src/content.ts` = `https://app.macrocore.io`. أي صفحة جديدة تُضاف لموقع التسويق لازم تستخدم `useLang().path('/xxx')` بدل `to="/xxx"` مباشرة عشان تحافظ على اللغة بالرابط (نفس نمط `Header.tsx`/`Footer.tsx` الحاليين).

### ⚠️ باقي عليك (مو مؤكد إنه صار)

الميقريشنز 013/014/015 (القسم 4 فوق) — **ما تأكد لي إنك شغّلتهم على قاعدة Railway الحقيقية**. لو ما شغّلتهم، صفحات المخزون/بيانات الموظف الموسّعة/أرقام الربح بالداشبورد ما تشتغل صح حتى إنه الموقع منشور صح بالكامل. شغّلهم أول شي بالشات الجديد لو ما أكّدت لي.

## 7. تشغيل محلي (4 نوافذ منفصلة)

```powershell
# تنظيف أول (نافذة وحدة، قبل أي شي، يحل مشكلة EADDRINUSE)
taskkill /F /IM node.exe
```

```powershell
# نافذة 1 — migrations (مرة وحدة، تسكرها بعدها)
cd C:\Users\USER\Desktop\macrocore\macrocore-saas\backend
node scripts/run-sql.js docs/MIGRATION_013_employee_hr_fields.sql
node scripts/run-sql.js docs/MIGRATION_014_warehouse_management.sql
node scripts/run-sql.js docs/MIGRATION_015_cogs_tracking.sql
```

```powershell
# نافذة 2 — backend (تخليها شغالة)
cd C:\Users\USER\Desktop\macrocore\macrocore-saas\backend
npm run dev
```

```powershell
# نافذة 3 — frontend (تخليها شغالة)
cd C:\Users\USER\Desktop\macrocore\macrocore-saas\frontend
npm run dev
```

```powershell
# نافذة 4 — marketing (تخليها شغالة)
cd C:\Users\USER\Desktop\macrocore\macrocore-saas\marketing
npm run dev
```

لا تسكر نوافذ 2/3/4 بزر X — دايماً `Ctrl+C` جوا النافذة نفسها، وإلا يرجع نفس مشكلة `EADDRINUSE`.

## 8. أسلوب العمل المتوقع بالشات الجديد

- اسأل بس إذا كان القرار يحتاج توجيه المستخدم فعلاً (شكل schema، أولوية بين الوحدات). القرارات التقنية الصغيرة سوّها وبلّغ بس.
- كل ميزة جديدة: schema إضافي (ميقريشن جديدة برقم تسلسلي، additive-only) → باك-إند (controller/routes) → `tsc --noEmit` نظيف → فرونت-إند (يمر بـ `useT()` بالكامل) → `tsc --noEmit` نظيف على الاثنين → تقرير مختصر للمستخدم بالكويتي، يوضح شنو انبنى، وشنو محتاج ميقريشن يدوي.
- خلك مباشر وعملي، بدون فذلكة.

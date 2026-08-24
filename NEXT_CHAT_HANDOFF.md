# macrocore.io — تسليم للشات الجديد

انسخ هذا الملف كامل والصقه كأول رسالة بالشات الجديد. هذا الملف يعكس **الوضع الفعلي الحالي** للمشروع (محدّث بالكامل بعد جلسة عمل طويلة جداً)، مو خطة مستقبلية.

⚠️ **قاعدة مهمة قبل لا تبدأ أي شي**: هذا الملف تلخيص، مو مصدر الحقيقة المطلق. المشروع كبير ويتغيّر بسرعة — لو تحتاج تعرف "شنو آخر route/endpoint/عمود بالجدول الفلاني بالضبط"، اقرأ الملف الحقيقي (`app.ts`، `App.tsx`، آخر ميقريشن) بدل ما تثق بالتعداد هنا حرفياً. هذا بالضبط اللي صار بالنسخة القديمة من هذا الملف — صارت قديمة وتقول إن آخر ميقريشن هي 015 بينما المشروع وصل لـ 057 فعلياً.

---

## 1. عن المشروع

**macrocore.io** — نظام SaaS كويتي لإدارة أكشاك/عربات الأكل (kiosk/food-truck management)، تطوّر بمرور الوقت لنظام ERP/HRMS مؤسسي متكامل (صلاحيات، سير موافقات، ITSM helpdesk، مبيعات B2B، إلخ). فيه أيضاً موقع تسويقي منفصل.

**المواقع على الجهاز:**
- المشروع الكامل: `C:\Users\USER\Desktop\macrocore\macrocore-saas`
- الباك-إند: `C:\Users\USER\Desktop\macrocore\macrocore-saas\backend`
- الفرونت-إند (لوحة التحكم): `C:\Users\USER\Desktop\macrocore\macrocore-saas\frontend`
- الموقع التسويقي: `C:\Users\USER\Desktop\macrocore\macrocore-saas\marketing`

**التقنيات:**
- الباك-إند: Node.js + Express + TypeScript. **بدون ORM** — SQL خام عبر `pg` مباشرة، كل كويري مكتوب يدوي بالكنترولر. PostgreSQL مستضافة على Railway (الإنتاج). الـ sandbox ما يوصل قاعدة Railway مباشرة — أي تعديل schema يتسلّم كملف SQL منفصل بـ `backend/docs/MIGRATION_0XX_...sql` والمستخدم يشغّله يدوي.
- الفرونت-إند: React 18 + TypeScript + Zustand (مع `persist` middleware للتوكن) + react-router-dom v6 + Vite.
- الموقع التسويقي: نفس الستاك، مشروع منفصل بمجلده `marketing/`.
- ثنائي اللغة بالكامل (لوحة التحكم فقط): عربي (افتراضي)/إنجليزي عبر `frontend/src/i18n.ts` (قاموس `en`/`ar` مطابق بالبنية حرفياً، TypeScript يفرض تطابق كل مفتاح، hook `useT()`). **قاعدة صارمة: كل نص بالواجهة يمر عبر `useT()`، ما نكتب نصوص مباشرة بالـ JSX.**
- ثيم فاتح/غامق: `useThemeStore`. صفحات الدخول/التسجيل مستثناة (تضل فاتحة دايم).
- **الصلاحيات نظامان متراكبان الحين**:
  1. أدوار أساسية: `admin` / `manager` / `employee` — يفرضها الباك-إند بـ middleware (`requireRole`/`requireAuth`)، والفرونت بـ `RequireRole`.
  2. طبقة صلاحيات دقيقة فوقها (MIGRATION_054): `job_role_permissions` (صلاحية افتراضية حسب المسمى الوظيفي) + `user_permissions` (استثناء فردي لموظف معين)، تتّحد عبر `hasPermission()`/`effectivePermissions()` بـ `backend/src/utils/permissions.ts`. تُدار من `/permissions` (صفحة Cascading Department → Job Role، وتاب "بالموظف" بـ autocomplete مجمّع حسب القسم).
- **باقات اشتراك SaaS حقيقية**: `Bronze` / `Silver` / `Gold` / `Enterprise`، مُنفّذة عبر `requirePlanLevel(minLevel, label)` middleware + `planLevelOf()` بـ `backend/src/config/planFeatures.ts`. الفرونت: أي رد 403 بكود `PLAN_UPGRADE_REQUIRED` يفتح مودال ترقية تلقائي (`api/client.ts` + `useUpgradeModalStore`). عناصر القائمة الجانبية المقفلة تظهر بصري لكن مقفلة (نمط Wafeq) بدل ما تختفي بالكامل.

## 2. نظام التصميم (Design System) — لم يتغيّر، ما زال دقيق

### الألوان (من `frontend/src/styles.css`)
اللون الأساسي (كهرماني): `--amber-500: #f59e0b` (أزرار primary، الحالة النشطة بالسايدبار)، `--amber-600: #d97706`.
الرمادي المحايد (Stone): `--stone-50` إلى `--stone-900` (النص/الخلفيات/الحدود، سايدبار خلفيته `--stone-900` دايم بغض النظر عن الثيم).
حالات: أخضر `--emerald-*`، أزرق `--blue-*`، أحمر `--red-*`.
متغيّرات دلالية تتغيّر بالثيم (استخدمها دايم، لا تكتب لون خام): `--bg` `--border` `--text` `--muted` `--danger` `--success` `--surface` `--surface-alt` `--input-bg`.

### الخط
`Tajawal` أساسي (عربي/إنجليزي)، `16px` على body.

### الأزرار الجاهزة (لا تُعاد كتابتها)
`.btn-primary` (كهرماني) / `.btn-secondary` (رمادي) / `.btn-danger` (أحمر فاتح) / `.btn-sm` (نسخة صغيرة بالجداول) / `.icon-btn` (أيقونة بدون خلفية).

### القائمة الجانبية (Sidebar)
عرض ثابت `220px`، خلفية `--stone-900` دايم. المجموعات الكبيرة (المخازن، الموارد البشرية، التقارير والمستندات، الإعدادات والدعم، تقنية المعلومات والدعم، المبيعات) صارت **قوائم منسدلة قابلة للطي (accordion/flyout)** بنفس نمط "المبيعات" الأصلي — `Layout.tsx` فيه آلية عامة (`expandedGroupKey`, `toggleFlyout(key)`) تدعم عدة مجموعات، مع سهم (chevron) يدور عند الفتح. **قاعدة مهمة**: لو كل عناصر مجموعة مخفية بسبب الصلاحيات/الباقة، عنوان المجموعة نفسه يختفي تلقائياً (ما يبين عنوان فاضي).

### الأنماط العامة لأي صفحة CRUD جديدة
`PageHeader` → `section-title-row` (عدّاد + زر "+جديد") → كرت فلاتر (اختياري) → `data-table` داخل `.table-wrap` (الأعمدة الرقمية `.num` على `th` و`td`) → `Modal` مشترك → `empty-state`.

المكوّنات المشتركة: `Icon.tsx` `Modal.tsx` `Tag.tsx` `PageHeader.tsx` `Avatar.tsx` `StatCard.tsx` `ProtectedRoute.tsx` `RequireRole.tsx`.

## 3. المسارات والـ API — لا تثق بأي تعداد هنا، تحقق من الكود مباشرة

القائمة تحت كبيرة جداً الحين (عشرات الصفحات: مبيعات B2B كاملة، HRMS/أداء/سياسات، ITSM helpdesk، موافقات، صلاحيات، إدارات...). **بدل ما أعدّد كل route هنا وأخاطر إني أطلع ناقص/قديم، اقرأ مباشرة**:
- كل مسارات الفرونت: `frontend/src/App.tsx` (كل `<Route path=... element=.../>`)
- كل مسارات الباك-إند المسجّلة: `backend/src/app.ts` (كل `app.use('/api/...', ...)`)
- عناصر القائمة الجانبية وبواباتها (صلاحية/باقة): `frontend/src/components/Layout.tsx`

نمط ثابت بكل route محمي: `[requireAuth, requireActiveSubscription, requirePlanLevel(N, 'اسم الميزة')]` (اختصارات `guarded`/`silver()`/`gold()` معرّفة بـ `app.ts`). التوكن JWT شكله `{ userId, companyId, role }`، متاح كـ `req.auth` بعد `requireAuth`.

## 4. الباك-إند — الميقريشنز

كل جدول: `id UUID PRIMARY KEY DEFAULT gen_random_uuid()`, `company_id UUID NOT NULL REFERENCES companies(id)` (عزل multi-tenant صارم على كل استعلام تقريباً). كل ميقريشن **إضافية فقط** (`ADD COLUMN IF NOT EXISTS` / `CREATE TABLE IF NOT EXISTS`)، بملف منفصل `backend/docs/MIGRATION_0XX_<name>.sql`، يشغّلها المستخدم يدوي:

```powershell
cd C:\Users\USER\Desktop\macrocore\macrocore-saas\backend
node scripts/run-sql.js docs/MIGRATION_0XX_اسم.sql
```

**آخر ميقريشن مكتوبة: `MIGRATION_057_ticket_smart_numbering.sql`.** ⚠️ **لازم تتأكد من المستخدم إنه شغّلها فعلاً على قاعدة Railway الحقيقية قبل أي شي يعتمد على `departments.code` / `document_sequences` / `support_tickets.ticket_number`** — إذا ما شغّلها، ترقيم التذاكر الذكي وميزات الأقسام الجديدة ما تشتغل.

أهم الميقريشنز من 040 لين 057 (مرجع سريع، مو تفصيل كامل — التفاصيل بتعليقات كل ملف نفسه):
- **040/041** — ربط `users.employee_id` بـ `employees`.
- **042** — طلبات إجازة/استئذان (`leave_requests`).
- **043** — HRMS: أداء (OKR)، تقييم 360، SLA.
- **044/045** — وحدة السياسات (Policies) وتوسيعها.
- **046/047** — تحوّل قسم الدعم لنظام ITSM/Service Desk حقيقي (فئات خدمة، أنواع طلبات، حقول مخصصة ديناميكية، ملاحظات داخلية).
- **048/049** — إدارات الشركة (Corporate Departments) ديناميكية لكل شركة، مع تسلسل هرمي (parent/child)، مدير لكل إدارة، ومسميات وظيفية (`job_roles`) منقولة من كتالوج ثابت بالفرونت إلى الداتابيس.
- **050/051/052/053** — مواقع مؤسسية، مراكز تكلفة، مشاريع، إقفال فترات محاسبية.
- **054** — نظام الصلاحيات الدقيقة (`job_role_permissions` + `user_permissions`).
- **055** — محرّك الموافقات (Maker-Checker) الأساسي: `approval_requests` + `approval_steps_log`، خطوة وحدة (رواتب/أوامر شراء/مصاريف).
- **056** — ترقية محرّك الموافقات لسلسلة متعددة الخطوات (`approval_workflow_steps`)، مطبّقة على تذاكر ITSM (مدير القسم → وكيل تقنية المعلومات → مدير تقنية المعلومات).
- **057** — ترقيم ذكي للتذاكر (`DEPT-YYMM-XXXX`) + `departments.code` + جدول `document_sequences` عام قابل لإعادة الاستخدام لأي مستند مستقبلي.

## 5. الأنظمة الكبيرة المبنية (ملخص الجلسة الأخيرة الضخمة)

### أ) نظام الصلاحيات الدقيقة (RBAC)
صفحة `/permissions`: تاب "حسب المسمى الوظيفي" (اختيار متسلسل قسم → مسمى → شبكة checkboxes قابلة لإعادة الاستخدام)، وتاب "حسب الموظف" (autocomplete مجمّع حسب القسم، يبيّن الصلاحيات الموروثة من المسمى الوظيفي بشكل مميّز/معطّل + badge).

### ب) باقات SaaS + بوابة الترقية
`requirePlanLevel` على كل route حساس، مودال ترقية تلقائي عند 403 بكود `PLAN_UPGRADE_REQUIRED`، عناصر القائمة الجانبية تظهر مقفلة بدل الاختفاء.

### ج) وحدة المبيعات B2B كاملة (Silver+)
عروض أسعار، فواتير مبيعات، فواتير نقدية، سندات قبض، فواتير متكررة، إشعارات دائنة — كل وحدة عندها controller/routes/صفحة خاصة، مع مكوّن `DocumentPreview` مشترك وطباعة موحّدة.

### د) محرّك سير الموافقات (Approval Workflow Engine) — Maker-Checker
- **خطوة وحدة**: رواتب/أوامر شراء/مصاريف — أي `admin`/`manager` أو حامل صلاحية `MODULE_APPROVER_PERMISSION` المطابقة يقدر يعتمد/يرفض فوراً.
- **متعدد الخطوات**: تذاكر ITSM فقط حالياً — 3 خطوات (مدير القسم المباشر → الوكيل المُسند له التذكرة → مدير تقنية المعلومات)، كل خطوة تُحل "حي" وقت الفعل (`resolveItsmStepEligibility` بـ `backend/src/utils/itsmApprovals.ts`) — مو مجمّدة وقت إنشاء الطلب. لكل خطوة "صمام أمان": لو ما انحل معتمد محدد، أي `admin`/`manager` يقدر يتصرف بدل ما يعلق الطلب للأبد.
- Maker-checker صارم: مقدّم الطلب ما يقدر يعتمد/يرفض طلبه هو نفسه، حتى لو كان admin.
- صفحة `/approvals` (Inbox) — فيها "View Details" (رابط/أيقونة عين) يوديك للمستند الحقيقي قبل لا تقرر (رفعنا هالميزة لأنه كانت "موافقات عمياء" — تعتمد بدون ما تشوف محتوى الطلب).
- **ملاحظة مهمة لأي شات جديد**: صفحة تفاصيل التذكرة (`SupportTicketsPage.tsx`) ما فيها route مستقل لكل تذكرة (`/support/tickets/:id` غير موجود) — التفاصيل تفتح بحالة داخلية بالمكوّن (`openId`/`detail`). الرابط الشغّال هو query param: `/support?ticket=<id>` تقرأه الصفحة بـ `useSearchParams` عند التحميل وتفتح التذكرة تلقائي.
- محرّك الموافقات موصول بنظام الإشعارات الموجود مسبقاً (`notifications` table) — أي خطوة توصل "دورها" تولّد إشعار داخل التطبيق للمعتمد المطلوب (جرس الإشعارات بأعلى القائمة الجانبية).
- **مو موصول (بالتصميم، مو نسيان)**: إنشاء/دفع الرواتب وأوامر الشراء الفعلية ما تمر إجبارياً على محرّك الموافقات — المحرّك موجود ومستقل، بس ما رُبط بعد بتلك الشاشات نفسها. لو المستخدم يبيها مربوطة فعلياً، هذا شغل جديد لازم تسأل عنه.

### هـ) وحدة ITSM/Helpdesk
كتالوج خدمة (فئات، أنواع طلبات، حقول مخصصة ديناميكية)، تذاكر بحقول ديناميكية حسب النوع، SLA (استجابة/حل حسب الأولوية + تصعيد تلقائي)، عزل تذاكر HR الحساسة (`view_hr_tickets` permission منفصل حتى عن admin/manager الافتراضيين).

**آخر إصلاحات بهذي الوحدة (نهاية الجلسة، جديدة جداً):**
1. وصف التذكرة الأصلي كان يترندر بس بدون أي تمييز بصري تحت كارد الموافقات — انحل: صار بكارد مستقل بارز بأعلى بانل التفاصيل، فوق كارد سير الموافقات، مع word-wrap صحيح ورسالة "ما فيه وصف مُدخل" لو التذكرة فاضية.
2. **صلاحية تغيير حالة التذكرة كانت مفتوحة لأي موظف عادي (حتى صاحب الطلب نفسه)** — انحل: صارت مقصورة على `admin`/`manager`/موظف بإدارة اسمها "IT" (`canManageTicketStatus()` بالباك-إند، `can_manage_status` بالـ response، تاغ للقراءة فقط بدل dropdown لغير المصرّح).
3. **ترقيم ذكي للتذاكر**: كل تذكرة جديدة تاخذ رقم `DEPT-YYMM-XXXX` (مثال: `IT-2608-0001`) حسب إدارة مقدّم الطلب، بعدّاد آمن من التعارض (`SELECT ... FOR UPDATE` بمعاملة حقيقية بـ `backend/src/utils/sequences.ts`)، يتصفّر تلقائياً كل شهر لكل إدارة (الشهر مدمج بالـ prefix نفسه). صفحة `/departments` فيها الحين حقل "رمز القسم" (code) لكل إدارة.
4. **ملاحظة معلّقة، مو مؤكدة**: لما تكتمل كل خطوات الموافقة على تذكرة، حالة التذكرة نفسها (`status`) ما تتغيّر تلقائياً — تبقى "مفتوحة" لين موظف IT يسويها `resolved`/`closed` يدوياً. هذا **مقصود بالتصميم** (الاعتماد = تصريح، مو تنفيذ فعلي)، بس المستخدم استغرب منه بالجلسة الأخيرة — لو طلب تحويل تلقائي لما يخلص الاعتماد، هذا قرار تصميم لازم تأكيده معه صراحة قبل التنفيذ.

## 6. النشر (Deployment)

**آخر commit على `main`: `7790b51`**. الكود مرفوع GitHub ومنشور فعلياً. remote: `https://github.com/abdullahalkdr/macrocore-saasmacrocore-saas.git`.

```powershell
cd C:\Users\USER\Desktop\macrocore\macrocore-saas
git add .
git status   # تأكد ما فيه .env حقيقي قبل لا تكمل
git commit -m "وصف التعديل"
git push origin main
```

كل المنصات auto-deploy على push لـ `main`.

**⚠️ ملاحظة sandbox مهمة**: بيئة العمل بالشات (sandbox) عندها قيود صلاحيات على مجلد `.git` — أوامر `git commit`/`git add` تطلع تحذيرات `unable to unlink ... Operation not permitted` بس تكمل تنجح عادةً. لو `git commit` يفشل فعلاً بسبب `index.lock`/`HEAD.lock` موجودين، الحل: `mv .git/index.lock .git/index.lock.bakN` (رقم متزايد) و`mv .git/HEAD.lock .git/HEAD.lock.bakN` قبل إعادة المحاولة — `rm` العادي يفشل بـ "Operation not permitted" بس `mv` ينجح. **`git push` ما يشتغل من الـ sandbox إطلاقاً (ما فيه GitHub credentials) — المستخدم دايماً يسوي push بنفسه من PowerShell على جهازه.**

### الطوبولوجيا (3 استضافات منفصلة، نفس الـ repo)
- **Railway** — الباك-إند (`api.macrocore.io`) + Postgres، مشروع `dependable-vision`.
- **Vercel** — مشروعين منفصلين لنفس الـ repo: اللوحة (Root Directory = `frontend`, دومين `app.macrocore.io`, `VITE_API_URL=https://api.macrocore.io/api`) والموقع التسويقي (Root Directory = `marketing`, دومين `macrocore.io`/`www.macrocore.io`).
- **Namecheap** — DNS فقط. **لا تلمس سجلات `MX`/`SPF`/`DKIM`/`DMARC`** — هذي خاصة بالبريد الرسمي (مستضاف عبر cPanel، منفصل تماماً عن Vercel/Railway) وما إلها علاقة بالنشر.

### موقع التسويق
مسارات لغة حقيقية بالرابط (`/ar` و`/en`)، تُقرأ عبر `useParams` بـ `marketing/src/LangContext.tsx`. أي صفحة جديدة تستخدم `useLang().path('/xxx')` مو `to="/xxx"` مباشرة.

## 7. تشغيل محلي

```powershell
taskkill /F /IM node.exe   # تنظيف أول، يحل EADDRINUSE
```

```powershell
# نافذة 1 — backend
cd C:\Users\USER\Desktop\macrocore\macrocore-saas\backend
npm run dev
```
```powershell
# نافذة 2 — frontend
cd C:\Users\USER\Desktop\macrocore\macrocore-saas\frontend
npm run dev
```
```powershell
# نافذة 3 — marketing (لو محتاجه)
cd C:\Users\USER\Desktop\macrocore\macrocore-saas\marketing
npm run dev
```

لا تسكر النوافذ بزر X — دايماً `Ctrl+C` جوا النافذة نفسها. قبل أي شغل محلي جديد، اسأل المستخدم عن آخر ميقريشن شغّلها فعلاً (القسم 4 فوق) بدل ما تفترض.

## 8. أسلوب العمل المتوقع

- تكلّم بالكويتي، مباشر وعملي بدون فذلكة.
- **قاعدة تنسيق ثابتة لازم تُطبّق بكل رد**: النص العربي يكتب من اليمين لليسار (RTL)، وأي كلمة أو عبارة إنجليزية تنحط بين قوسين بسطر منفصل لحالها عشان ما ينكسر اتجاه النص العربي.
- اسأل بس لو القرار يحتاج توجيه المستخدم فعلاً (شكل schema، أولوية بين وحدات، تغيير سلوك موجود). القرارات التقنية الصغيرة سوّها وبلّغ بس.
- كل ميزة جديدة: schema إضافي (ميقريشن جديدة برقم تسلسلي، additive-only، بتعليقات تشرح القرارات زي كل الميقريشنز السابقة) → باك-إند → `tsc --noEmit` نظيف → فرونت-إند (كل نص عبر `useT()`) → `tsc --noEmit` نظيف على الاثنين → commit برسالة توضح "شنو" و"ليش" → تقرير مختصر بالكويتي يوضح شنو انبنى وشنو محتاج ميقريشن يدوي من عندك.
- قبل ما تفترض أي عمود/جدول موجود، تأكد من آخر ميقريشن أو اقرأ الكنترولر الفعلي — صار خطأ إنتاج حقيقي بالجلسة السابقة بسبب افتراض عمود `employees.full_name` كان موجود وما كان (الصح `employees.name`).

## 9. أشياء مذكورة بس ما انبنت بعد (لو المستخدم رجع يطلبها)
- ربط محرّك الموافقات فعلياً بشاشات إنشاء/دفع الرواتب وأوامر الشراء (المحرّك جاهز ومستقل، بس مو مربوط قسرياً بتلك الشاشات — قرار متعمّد بالجلسة اللي بنته).
- بوابة دفع MyFatoorah (اتذكرت بجلسة قديمة، ما انبنت).
- تحويل حالة التذكرة تلقائياً لما يخلص سير الموافقات بالكامل (نقطة نقاش مفتوحة، شوف القسم 5-هـ نقطة 4 فوق).

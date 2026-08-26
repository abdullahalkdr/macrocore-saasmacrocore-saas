import { PoolClient } from 'pg';

// MIGRATION_069 — "IT Department Template": a ready-made, research-backed IT
// organizational structure (8 divisions -> internal sections -> job titles),
// applied on demand (see applyItDepartmentTemplate below) instead of the old
// single flat "IT" department + 5 job_roles MIGRATION_049 used to seed.
//
// Source: claude/it-department-structure-context-handoff.md section 5 (the
// full Arabic reference, researched/verified/expanded from Abdullah's
// original draft — sources listed in that doc's section 6). Design decisions
// locked in with Abdullah via AskUserQuestion before this file was written
// (same doc, section 4):
//   1. Applies to new companies automatically (auth.controller.ts calls this
//      at signup) AND to existing companies as an admin-triggered action
//      that REPLACES whatever "IT"-named department tree already exists for
//      that company (POST /api/departments/template/IT/apply — generalized
//      2026-08-26 to all 6 default department templates, see
//      departmentTemplates.ts).
//   2. Full 3-tier hierarchy: division (root department) -> section (child
//      department, parent_department_id = division) -> job title (job_roles
//      row on the division OR its most relevant section). The source
//      document itself lists job titles per DIVISION, not per section, so
//      roles that clearly map onto one specific section were placed there
//      (e.g. "Network Engineer" -> Networking & Telecom); roles that lead
//      the whole division or cut across every section (the division
//      manager, a cross-cutting analyst) were kept at the division level.
//      That mapping is an interpretive judgment call, not sourced 1:1 —
//      flagged here rather than silently.
//   3. "responsibilities" (MIGRATION_069) is reference/descriptive text
//      only, not a pile of new enforced permission keys. It holds the
//      relevant division's real-world authorities text from the source doc
//      (same text for every role in that division, since the source only
//      breaks authorities down at division granularity). A handful of
//      senior/security-facing roles ALSO get real job_role_permissions rows
//      against the EXISTING PERMISSION_KEYS catalog (permissions.controller.ts)
//      wherever one genuinely applies — never a newly-invented key.
//   4. One-off, IT-specific seed (not a generic reusable "department
//      template library") — revisit that abstraction later if/when the same
//      is wanted for Finance/HR/Sales.

// the 2026-08-26 multi-department template rebuild (code-only, no schema change) — these three interfaces + applyDepartmentTemplate() below were
// generalized out of this file (originally IT-only) so the same "division ->
// section -> job title" engine could be reused for the other 5 default
// departments (HR/Finance/Marketing/Legal/Operations — see
// utils/departmentTemplates.ts) without duplicating the apply logic 5 more
// times. IT_DEPARTMENT_TEMPLATE and applyItDepartmentTemplate() below are
// unchanged in behavior — kept as the IT-specific data + a thin wrapper so
// every existing caller (auth.controller.ts, departments.controller.ts)
// keeps working without modification.
export interface TemplateRole {
  name: string;
  name_en: string;
  responsibilities: string;
  /** Local section code (see TemplateSection.code) this role nests under. Omit to attach directly to the division. */
  section?: string;
  /** Existing PERMISSION_KEYS (permissions.controller.ts) to grant this role via job_role_permissions. Omit for none. */
  permission_keys?: string[];
}

export interface TemplateSection {
  /** Local key used only to link roles -> section within this file, not persisted. */
  code: string;
  name: string;
  name_en: string;
}

export interface TemplateDivision {
  code: string; // departments.code
  name: string;
  name_en: string;
  sections: TemplateSection[];
  roles: TemplateRole[];
}

const DIV1_AUTHORITIES =
  'إدارية/مالية: اعتماد الميزانيات السنوية للمشاريع، توقيع عقود الموردين (Vendors) والبرمجيات، والموافقة على التعيينات والهيكل التنظيمي.\n' +
  'تقنية: الصلاحية العليا لاعتماد المعايير التقنية (Architecture Standards) والسياسات الأمنية للشركة.';

const DIV2_AUTHORITIES =
  '- التحكم الكامل (Full Access) في الخوادم الرئيسية (Domain Controllers)، المحولات (Switches)، وأجهزة التوجيه (Routers).\n' +
  '- صلاحية ربط أو قطع شبكة أي فرع أو كشك جديد في الكويت (VPN / MPLS).\n' +
  '- إدارة النسخ الاحتياطي (Backups) لبيانات الشركة بالكامل واستعادتها عند الطوارئ.\n' +
  '- تتبع جرد الأجهزة وتراخيص البرامج، والتأكد من الالتزام بشروط الترخيص (License Compliance).';

const DIV3_AUTHORITIES =
  '- صلاحية تعديل وتحديث برامج الكاشير (POS) وأنظمة المبيعات والمخازن في الفروع.\n' +
  '- الوصول إلى قواعد البيانات (Database Read/Write Access) لاستخراج التقارير المالية والبيعية أو تعديل الأخطاء البرمجية.\n' +
  '- صلاحية إصدار التحديثات (Deployments) لتطبيقات التوصيل والمواقع الإلكترونية للشركة.\n' +
  '- صلاحية رفض أي تحديث ما يجتاز اختبارات الجودة قبل نزوله على الفروع الحية.';

const DIV4_AUTHORITIES =
  '- صلاحية المنع والحظر: إغلاق أي ثغرة، حظر مواقع معينة، أو فصل أي جهاز أو مستخدم يُشتبه في تعرضه للاختراق.\n' +
  '- صلاحية التدقيق والمراقبة (Auditing Logs): مراقبة كافة تحركات الموظفين على الأنظمة والإنترنت في الفروع والمكاتب.\n' +
  '- إلزام إدارات الـ IT الأخرى بتطبيق معايير أمنية صارمة قبل إطلاق أي نظام جديد.';

const DIV5_AUTHORITIES =
  '- صلاحية الدخول عن بعد (Remote Desktop/AnyDesk) على أجهزة الكاشير والكمبيوتر بالفروع لحل المشاكل.\n' +
  '- صلاحية إعادة تعيين كلمات المرور (Password Reset) وإنشاء حسابات البريد الإلكتروني للموظفين الجدد.\n' +
  '- صلاحية استبدال وصرف الأجهزة التالفة وإرسالها للصيانة.';

const DIV6_AUTHORITIES =
  '- مراقبة الجداول الزمنية لتنفيذ المشاريع التقنية والربط مع الشركات الخارجية.\n' +
  '- تقييم أداء الشركات الموردة للإنترنت أو أجهزة الدفع في الكويت ومحاسبتهم بناءً على اتفاقية مستوى الخدمة (SLA).';

const DIV7_AUTHORITIES =
  '- الوصول إلى قواعد البيانات والمستودعات (Data Warehouse) لبناء لوحات المؤشرات (Dashboards) والتقارير الموحدة بين كل الفروع.\n' +
  '- اعتماد معايير جودة البيانات وتوحيد تعريف المؤشرات بين الإدارات.\n' +
  '- تحديد من يقدر يوصل لأي بيانات حساسة بالتنسيق مع إدارة الأمن السيبراني.';

const DIV8_AUTHORITIES =
  '- اقتراح واعتماد مبادرات الأتمتة الجديدة بالتنسيق مع إدارة التطبيقات لتنفيذها.\n' +
  '- قيادة تجارب تقنية محدودة (Pilot Projects) بفرع أو معرض واحد قبل التعميم على كل الشركة.\n' +
  '- التنسيق مع الموارد البشرية لتدريب الموظفين على أي نظام أو أداة جديدة قبل إطلاقها.';

export const IT_DEPARTMENT_TEMPLATE: TemplateDivision[] = [
  {
    code: 'IT-EXEC',
    name: 'الإدارة العليا لتقنية المعلومات',
    name_en: 'IT Executive Management',
    sections: [],
    roles: [
      { name: 'رئيس قطاع تكنولوجيا المعلومات / العمليات التقنية', name_en: 'Chief Information Officer (CIO) / CTO', responsibilities: DIV1_AUTHORITIES, permission_keys: ['manage_system_settings', 'view_audit_log', 'export_sensitive_reports'] },
      { name: 'مدير عام إدارة تكنولوجيا المعلومات', name_en: 'IT Director / General Manager', responsibilities: DIV1_AUTHORITIES, permission_keys: ['manage_system_settings', 'view_audit_log'] },
      { name: 'مستشار تقني', name_en: 'IT Consultant', responsibilities: DIV1_AUTHORITIES },
    ],
  },
  {
    code: 'IT-INFRA',
    name: 'إدارة البنية التحتية والشبكات',
    name_en: 'IT Infrastructure & Networks',
    sections: [
      { code: 'NET', name: 'قسم الشبكات والاتصالات', name_en: 'Networking & Telecom' },
      { code: 'SDC', name: 'قسم الخوادم ومراكز البيانات', name_en: 'Systems & Data Centers' },
      { code: 'CLD', name: 'قسم الحوسبة السحابية', name_en: 'Cloud Infrastructure' },
      { code: 'AST', name: 'قسم إدارة الأصول والتراخيص', name_en: 'IT Asset & License Management' },
    ],
    roles: [
      { name: 'مدير إدارة البنية التحتية', name_en: 'Infrastructure Manager', responsibilities: DIV2_AUTHORITIES, permission_keys: ['manage_system_settings'] },
      { name: 'مهندس شبكات (أول / مبتدئ)', name_en: 'Network Engineer (Senior / Junior)', responsibilities: DIV2_AUTHORITIES, section: 'NET' },
      { name: 'مسؤول أنظمة وخوادم', name_en: 'System Administrator', responsibilities: DIV2_AUTHORITIES, section: 'SDC', permission_keys: ['manage_system_settings'] },
      { name: 'مهندس حلول سحابية', name_en: 'Cloud Engineer', responsibilities: DIV2_AUTHORITIES, section: 'CLD' },
      { name: 'مسؤول أصول تقنية', name_en: 'IT Asset Manager', responsibilities: DIV2_AUTHORITIES, section: 'AST' },
    ],
  },
  {
    code: 'IT-APPS',
    name: 'إدارة التطبيقات والبرمجيات',
    name_en: 'Applications & Software Development',
    sections: [
      { code: 'ERP', name: 'قسم أنظمة تخطيط الموارد', name_en: 'ERP Systems' },
      { code: 'POS', name: 'قسم تطبيقات البيع والمطاعم', name_en: 'POS & Retail Systems' },
      { code: 'DIG', name: 'قسم القنوات الرقمية', name_en: 'Digital Channels' },
      { code: 'DBA', name: 'قسم إدارة قواعد البيانات', name_en: 'Database Administration' },
      { code: 'QA', name: 'قسم ضمان الجودة والاختبار', name_en: 'Quality Assurance' },
    ],
    roles: [
      { name: 'مدير إدارة التطبيقات', name_en: 'Applications Manager', responsibilities: DIV3_AUTHORITIES },
      { name: 'مستشار أنظمة', name_en: 'ERP Consultant', responsibilities: DIV3_AUTHORITIES, section: 'ERP' },
      { name: 'مطور برمجيات / تطبيقات', name_en: 'Software / Mobile Developer', responsibilities: DIV3_AUTHORITIES, section: 'DIG' },
      { name: 'مسؤول قواعد بيانات', name_en: 'Database Administrator (DBA)', responsibilities: DIV3_AUTHORITIES, section: 'DBA', permission_keys: ['export_sensitive_reports'] },
      { name: 'محلل نظم', name_en: 'Business Analyst', responsibilities: DIV3_AUTHORITIES },
      { name: 'مهندس ضمان جودة', name_en: 'QA Engineer', responsibilities: DIV3_AUTHORITIES, section: 'QA' },
    ],
  },
  {
    code: 'IT-SEC',
    name: 'إدارة الأمن السيبراني وأمن المعلومات',
    name_en: 'Cybersecurity & Information Security',
    sections: [
      { code: 'GRC', name: 'قسم الحوكمة والالتزام والمخاطر', name_en: 'Governance, Risk & Compliance (GRC)' },
      { code: 'SOC', name: 'مركز العمليات الأمنية', name_en: 'Security Operations Center (SOC)' },
      { code: 'IR', name: 'قسم الاستجابة للحوادث والتهديدات', name_en: 'Incident Response' },
    ],
    roles: [
      { name: 'مدير إدارة الأمن السيبراني', name_en: 'CISO / Cybersecurity Manager', responsibilities: DIV4_AUTHORITIES, permission_keys: ['view_audit_log', 'manage_system_settings'] },
      { name: 'محلل أمن معلومات', name_en: 'Security Analyst', responsibilities: DIV4_AUTHORITIES, section: 'SOC', permission_keys: ['view_audit_log'] },
      { name: 'مهندس حماية شبكات', name_en: 'Security Engineer', responsibilities: DIV4_AUTHORITIES, section: 'GRC' },
      { name: 'مختبر اختراق', name_en: 'Penetration Tester / Ethical Hacker', responsibilities: DIV4_AUTHORITIES, section: 'IR' },
    ],
  },
  {
    code: 'IT-SD',
    name: 'إدارة الدعم الفني والخدمات التقنية',
    name_en: 'IT Service Desk & Support',
    sections: [
      { code: 'T1', name: 'قسم مكتب الخدمة / الاتصال', name_en: 'IT Service Desk (Tier 1)' },
      { code: 'T2', name: 'قسم الدعم الميداني للفروع', name_en: 'Field Support (Tier 2)' },
    ],
    roles: [
      { name: 'مدير إدارة الدعم الفني', name_en: 'IT Support / Service Desk Manager', responsibilities: DIV5_AUTHORITIES },
      { name: 'مشرف الدعم الفني', name_en: 'Support Supervisor', responsibilities: DIV5_AUTHORITIES, section: 'T1' },
      { name: 'فني دعم تكنولوجيا معلومات', name_en: 'IT Support Technician', responsibilities: DIV5_AUTHORITIES, section: 'T1' },
      { name: 'مهندس دعم ميداني', name_en: 'Field Support Engineer', responsibilities: DIV5_AUTHORITIES, section: 'T2' },
    ],
  },
  {
    code: 'IT-PMO',
    name: 'إدارة المشاريع والحوكمة التقنية',
    name_en: 'IT PMO & Governance',
    sections: [
      { code: 'PMO', name: 'مكتب إدارة مشاريع الـ IT', name_en: 'IT PMO' },
      { code: 'VSM', name: 'قسم إدارة عقود الموردين', name_en: 'Vendor & SLA Management' },
    ],
    roles: [
      { name: 'مدير مكتب مشاريع الـ IT', name_en: 'IT PMO Manager', responsibilities: DIV6_AUTHORITIES },
      { name: 'مدير مشروع تقني', name_en: 'IT Project Manager', responsibilities: DIV6_AUTHORITIES, section: 'PMO' },
      { name: 'مسؤول حوكمة وعقود', name_en: 'IT Governance Officer', responsibilities: DIV6_AUTHORITIES, section: 'VSM', permission_keys: ['view_audit_log'] },
    ],
  },
  {
    code: 'IT-DATA',
    name: 'إدارة البيانات والتحليلات',
    name_en: 'Data & Analytics',
    sections: [
      { code: 'ENG', name: 'قسم هندسة البيانات', name_en: 'Data Engineering' },
      { code: 'BI', name: 'قسم ذكاء الأعمال والتقارير', name_en: 'Business Intelligence (BI)' },
      { code: 'GOV', name: 'قسم حوكمة البيانات', name_en: 'Data Governance' },
    ],
    roles: [
      { name: 'مدير إدارة البيانات', name_en: 'Chief Data Officer (CDO) / Data & Analytics Manager', responsibilities: DIV7_AUTHORITIES, permission_keys: ['export_sensitive_reports'] },
      { name: 'مهندس بيانات', name_en: 'Data Engineer', responsibilities: DIV7_AUTHORITIES, section: 'ENG' },
      { name: 'مطوّر ذكاء أعمال', name_en: 'BI Developer', responsibilities: DIV7_AUTHORITIES, section: 'BI' },
      { name: 'محلل بيانات', name_en: 'Data Analyst', responsibilities: DIV7_AUTHORITIES, section: 'BI' },
      { name: 'مسؤول حوكمة بيانات', name_en: 'Data Governance Officer', responsibilities: DIV7_AUTHORITIES, section: 'GOV', permission_keys: ['export_sensitive_reports', 'view_audit_log'] },
    ],
  },
  {
    code: 'IT-DX',
    name: 'إدارة التحول الرقمي والابتكار',
    name_en: 'Digital Transformation & Innovation',
    sections: [
      { code: 'AI', name: 'قسم الأتمتة والذكاء الاصطناعي', name_en: 'Automation & AI' },
      { code: 'CX', name: 'قسم تجربة العميل الرقمية', name_en: 'Digital Customer Experience' },
      { code: 'CM', name: 'قسم إدارة التغيير', name_en: 'Change Management' },
    ],
    roles: [
      { name: 'مدير التحول الرقمي', name_en: 'Chief Digital Officer (CDxO) / Digital Transformation Manager', responsibilities: DIV8_AUTHORITIES },
      { name: 'مهندس أتمتة العمليات', name_en: 'RPA / Automation Engineer', responsibilities: DIV8_AUTHORITIES, section: 'AI' },
      { name: 'محلل عمليات وتحسين', name_en: 'Business Process Analyst', responsibilities: DIV8_AUTHORITIES, section: 'CX' },
      { name: 'مسؤول إدارة التغيير', name_en: 'Change Management Lead', responsibilities: DIV8_AUTHORITIES, section: 'CM' },
    ],
  },
];

export interface ApplyDepartmentTemplateResult {
  divisionsCreated: number;
  sectionsCreated: number;
  rolesCreated: number;
  permissionsGranted: number;
  employeesAffected: number;
}
// Back-compat alias — existing callers (auth.controller.ts, departments.controller.ts)
// were written against this name before the 2026-08-26 multi-department template rebuild (code-only, no schema change) generalized the engine.
export type ApplyItTemplateResult = ApplyDepartmentTemplateResult;

// the 2026-08-26 multi-department template rebuild (code-only, no schema change) — generic version of the engine originally written IT-only. Every
// name_en a template has ever used, plus whatever legacy department name(s) it
// replaces, is the full "replace set" for one company — computed fresh from the
// template array each call so it always reflects the current data.
function allTemplateNames(template: TemplateDivision[], legacyNames: string[]): string[] {
  const names = new Set<string>(legacyNames);
  for (const division of template) {
    names.add(division.name_en);
    for (const section of division.sections) names.add(section.name_en);
  }
  return [...names];
}

// Replaces whatever template-named (or legacy flat) department tree already exists
// for this company with a fresh build of the given template. Runs inside the
// caller's transaction (auth.controller.ts's signup transaction, or
// departments.controller.ts's applyTemplate endpoint) — a single client, no
// BEGIN/COMMIT here.
//
// Deleting a division's row does NOT cascade-delete its section children
// (departments.parent_department_id is ON DELETE SET NULL, MIGRATION_049
// decision 1) — so both divisions and sections are deleted together in one
// statement below, which Postgres handles cleanly (no orphaned root-level
// sections left behind). job_roles rows ARE cascade-deleted with their
// department (department_id is ON DELETE CASCADE), so no separate cleanup
// is needed there; job_role_permissions cascade-deletes with its job_role
// the same way.
export async function applyDepartmentTemplate(
  client: PoolClient,
  companyId: string,
  template: TemplateDivision[],
  legacyNames: string[]
): Promise<ApplyDepartmentTemplateResult> {
  const names = allTemplateNames(template, legacyNames);

  const affectedResult = await client.query(
    `SELECT COUNT(DISTINCT e.id)::int AS count
     FROM employees e
     JOIN departments d ON d.id = e.department_id
     WHERE d.company_id = $1 AND d.name_en = ANY($2::text[])`,
    [companyId, names]
  );
  const employeesAffected = affectedResult.rows[0]?.count ?? 0;

  await client.query(`DELETE FROM departments WHERE company_id = $1 AND name_en = ANY($2::text[])`, [companyId, names]);

  let divisionsCreated = 0;
  let sectionsCreated = 0;
  let rolesCreated = 0;
  let permissionsGranted = 0;

  for (const division of template) {
    const divisionResult = await client.query(
      `INSERT INTO departments (company_id, name, name_en, code, status) VALUES ($1, $2, $3, $4, 'active') RETURNING id`,
      [companyId, division.name, division.name_en, division.code]
    );
    const divisionId = divisionResult.rows[0].id as string;
    divisionsCreated++;

    const sectionIds: Record<string, string> = {};
    for (const section of division.sections) {
      // BUGFIX (found live, 2026-08-26, originally IT-only) — sections originally got
      // no `code` at all, which silently degraded MIGRATION_057's ticket smart-
      // numbering: an employee placed at the more natural, specific section level
      // (not the division level) fell back to the generic 'GEN-...' prefix instead
      // of a department-specific one, because generateTicketNumber() resolves
      // strictly from the REQUESTER'S OWN department row's `code` column
      // (supportTickets.controller.ts), not from any ancestor. Sections now inherit
      // their division's code, so ticket numbering is prefixed correctly no matter
      // which level of the tree an employee actually sits at — applies to every
      // template through this shared engine, not just IT.
      const sectionResult = await client.query(
        `INSERT INTO departments (company_id, name, name_en, code, parent_department_id, status) VALUES ($1, $2, $3, $4, $5, 'active') RETURNING id`,
        [companyId, section.name, section.name_en, division.code, divisionId]
      );
      sectionIds[section.code] = sectionResult.rows[0].id as string;
      sectionsCreated++;
    }

    for (const role of division.roles) {
      const departmentId = role.section ? sectionIds[role.section] : divisionId;
      const roleResult = await client.query(
        `INSERT INTO job_roles (company_id, department_id, name, name_en, responsibilities) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [companyId, departmentId, role.name, role.name_en, role.responsibilities]
      );
      rolesCreated++;
      const jobRoleId = roleResult.rows[0].id as string;

      for (const key of role.permission_keys ?? []) {
        await client.query(
          `INSERT INTO job_role_permissions (company_id, job_role_id, permission_key) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
          [companyId, jobRoleId, key]
        );
        permissionsGranted++;
      }
    }
  }

  return { divisionsCreated, sectionsCreated, rolesCreated, permissionsGranted, employeesAffected };
}

// Thin, behavior-preserving wrapper — every existing caller keeps working exactly
// as before the 2026-08-26 multi-department template rebuild (code-only, no schema change)'s generalization.
export async function applyItDepartmentTemplate(client: PoolClient, companyId: string): Promise<ApplyItTemplateResult> {
  return applyDepartmentTemplate(client, companyId, IT_DEPARTMENT_TEMPLATE, ['IT']);
}

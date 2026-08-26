import type { PoolClient } from 'pg';
import { TemplateDivision, applyDepartmentTemplate, ApplyDepartmentTemplateResult, IT_DEPARTMENT_TEMPLATE } from './itDepartmentTemplate';

// the 2026-08-26 multi-department template rebuild (code-only, no schema change) — the other 5 default corporate departments (HR/Finance/Marketing/
// Legal/Operations, MIGRATION_048's flat seed) get the same treatment IT got in
// MIGRATION_069: a research-backed division -> section -> job title structure
// instead of one flat department row. Built on Abdullah's explicit request to apply
// "same style as IT" to the rest of the org chart — decisions locked via
// AskUserQuestion (recorded in claude/it-department-structure-context-handoff.md
// §10): (1) exactly these 5 defaults, no extra departments invented; (2) same
// replace-for-all behavior as IT — new companies get every template automatically
// at signup, existing companies get an admin-triggered per-department "Load
// Template" action that replaces that department's current flat row.
//
// Depth is deliberately smaller per department than IT's 8 divisions/22 sections —
// IT was asked for maximum detail; these five are sized to what's realistic for a
// mid-size multi-branch retail/F&B company (research sources at the bottom of this
// file), not padded to match IT's count artificially.
//
// Shares applyDepartmentTemplate() (extracted from itDepartmentTemplate.ts) instead
// of duplicating the apply engine — see that file's own header for why.

// ============================== HR ==============================

const HR_EXEC_AUTH =
  'اعتماد استراتيجية الموارد البشرية والموازنة السنوية للتوظيف والتدريب، واعتماد الهيكل التنظيمي الكلي للشركة بالتنسيق مع الإدارة العليا.\n' +
  'صلاحية الاطلاع الكامل على بيانات جميع الموظفين وملفاتهم، واعتماد القرارات الحساسة (إنهاء الخدمة، الترقيات الكبرى).';

const HR_TA_AUTH =
  '- صلاحية نشر الوظائف الشاغرة وإدارة قنوات التوظيف (مواقع التوظيف، شركات التوظيف الخارجية).\n' +
  '- إجراء المقابلات وتقييم المرشحين واتخاذ قرار الترشيح النهائي لمدير القسم المعني.\n' +
  '- إدارة قاعدة بيانات المتقدمين والتواصل معهم.';

const HR_CB_AUTH =
  '- اعتماد هيكل الرواتب والعلاوات ومراجعته دوريًا لضمان التنافسية والعدالة الداخلية.\n' +
  '- إدارة برامج المزايا (تأمين صحي، بدلات، مكافآت) والتفاوض مع مزودي الخدمة.\n' +
  '- الوصول إلى بيانات الرواتب لتحليل تكلفة القوى العاملة وإعداد التقارير للإدارة المالية.';

const HR_LD_AUTH =
  '- تحديد الاحتياجات التدريبية بالتنسيق مع مديري الأقسام وتصميم خطط التطوير السنوية.\n' +
  '- اعتماد الميزانية التدريبية واختيار الجهات والمدربين الخارجيين.\n' +
  '- متابعة أثر التدريب على الأداء وتحديث مسارات التطور الوظيفي.';

const HR_ER_AUTH =
  '- التعامل المباشر مع الشكاوى والنزاعات بين الموظفين أو بينهم وبين إدارتهم، وفتح تحقيقات داخلية عند الحاجة.\n' +
  '- التأكد من تطبيق سياسات الشركة ولوائح العمل الكويتية على جميع الموظفين.\n' +
  '- تقديم التوصيات للإدارة العليا بخصوص الإجراءات التأديبية.';

const HR_HSW_AUTH =
  '- وضع ومتابعة سياسات السلامة المهنية في الفروع والمكاتب والمخازن.\n' +
  '- التحقيق في حوادث العمل واتخاذ إجراءات الوقاية.\n' +
  '- تنظيم برامج التوعية الصحية والرفاهية للموظفين.';

const HR_OPS_AUTH =
  '- إدارة أنظمة معلومات الموارد البشرية (HRIS) وضمان دقة بيانات الحضور والإجازات والعقود.\n' +
  '- إصدار التقارير الدورية عن القوى العاملة (معدل الدوران، الحضور، التركيبة الوظيفية) للإدارة العليا.\n' +
  '- دعم الموظفين والمدراء بالأمور الإجرائية اليومية (عقود، شهادات، طلبات).';

export const HR_DEPARTMENT_TEMPLATE: TemplateDivision[] = [
  {
    code: 'HR-EXEC',
    name: 'الإدارة العليا للموارد البشرية',
    name_en: 'HR Executive Management',
    sections: [],
    roles: [
      { name: 'مدير الموارد البشرية', name_en: 'HR Director / Chief Human Resources Officer (CHRO)', responsibilities: HR_EXEC_AUTH, permission_keys: ['approve_leave', 'view_all_employees', 'view_hr_tickets', 'edit_sensitive_data'] },
      { name: 'مستشار موارد بشرية', name_en: 'HR Business Partner', responsibilities: HR_EXEC_AUTH },
    ],
  },
  {
    code: 'HR-TA',
    name: 'إدارة التوظيف واستقطاب المواهب',
    name_en: 'Recruitment & Talent Acquisition',
    sections: [],
    roles: [
      { name: 'مدير التوظيف', name_en: 'Recruitment Manager', responsibilities: HR_TA_AUTH },
      { name: 'أخصائي توظيف', name_en: 'Recruiter', responsibilities: HR_TA_AUTH },
      { name: 'منسق مقابلات', name_en: 'Interview Coordinator', responsibilities: HR_TA_AUTH },
    ],
  },
  {
    code: 'HR-CB',
    name: 'إدارة التعويضات والمزايا',
    name_en: 'Compensation & Benefits',
    sections: [],
    roles: [
      { name: 'مدير التعويضات والمزايا', name_en: 'Compensation & Benefits Manager', responsibilities: HR_CB_AUTH, permission_keys: ['manage_payroll'] },
      { name: 'أخصائي رواتب ومزايا', name_en: 'Compensation & Benefits Specialist', responsibilities: HR_CB_AUTH },
      { name: 'محلل بيانات الموارد البشرية', name_en: 'People Data Analyst', responsibilities: HR_CB_AUTH },
    ],
  },
  {
    code: 'HR-LD',
    name: 'إدارة التدريب والتطوير',
    name_en: 'Learning & Development',
    sections: [],
    roles: [
      { name: 'مدير التدريب والتطوير', name_en: 'Learning & Development Manager', responsibilities: HR_LD_AUTH },
      { name: 'أخصائي تدريب', name_en: 'L&D Specialist', responsibilities: HR_LD_AUTH },
      { name: 'منسق برامج تدريبية', name_en: 'Training Programs Coordinator', responsibilities: HR_LD_AUTH },
    ],
  },
  {
    code: 'HR-ER',
    name: 'إدارة علاقات الموظفين',
    name_en: 'Employee Relations',
    sections: [],
    roles: [
      { name: 'مدير علاقات الموظفين', name_en: 'Employee Relations Manager', responsibilities: HR_ER_AUTH, permission_keys: ['view_hr_tickets', 'approve_leave'] },
      { name: 'أخصائي علاقات موظفين', name_en: 'Employee Relations Specialist', responsibilities: HR_ER_AUTH },
      { name: 'مسؤول شكاوى وتظلمات', name_en: 'Grievance Officer', responsibilities: HR_ER_AUTH },
    ],
  },
  {
    code: 'HR-HSW',
    name: 'إدارة الصحة والسلامة المهنية',
    name_en: 'Health, Safety & Wellbeing',
    sections: [],
    roles: [
      { name: 'مسؤول الصحة والسلامة المهنية', name_en: 'Health & Safety Officer', responsibilities: HR_HSW_AUTH },
      { name: 'أخصائي رفاهية الموظفين', name_en: 'Employee Wellbeing Specialist', responsibilities: HR_HSW_AUTH },
    ],
  },
  {
    code: 'HR-OPS',
    name: 'إدارة عمليات الموارد البشرية ونظم المعلومات',
    name_en: 'HR Operations & HRIS',
    sections: [],
    roles: [
      { name: 'مدير عمليات الموارد البشرية', name_en: 'HR Operations Manager', responsibilities: HR_OPS_AUTH, permission_keys: ['manual_attendance'] },
      { name: 'أخصائي نظم معلومات الموارد البشرية', name_en: 'HRIS Specialist', responsibilities: HR_OPS_AUTH },
      { name: 'أخصائي موارد بشرية عام', name_en: 'HR Generalist', responsibilities: HR_OPS_AUTH },
    ],
  },
];

// ============================== Finance ==============================

const FIN_EXEC_AUTH =
  'اعتماد الموازنة العامة للشركة والخطط المالية طويلة المدى، والتوقيع على الالتزامات المالية الكبرى والقروض والاستثمارات.\n' +
  'صلاحية الاطلاع الكامل على كل البيانات المالية والتقارير الحساسة (هوامش الربح، التدفقات النقدية) وتمثيل الشركة أمام البنوك والجهات الرقابية.';

const FIN_ACC_AUTH =
  '- اعتماد القيود المحاسبية الختامية وإصدار القوائم المالية الشهرية والسنوية.\n' +
  '- ضمان التزام السجلات المحاسبية بالمعايير المحاسبية الدولية (IFRS) ومتطلبات الجهات الرقابية بالكويت.\n' +
  '- مراجعة التسويات البنكية وحسابات الأصول الثابتة.';

const FIN_APAR_AUTH =
  '- صلاحية اعتماد وصرف مدفوعات الموردين ومتابعة تحصيل مستحقات العملاء.\n' +
  '- إدارة سقوف الائتمان الممنوحة للعملاء ومتابعة الذمم المتأخرة.\n' +
  '- التنسيق مع الفروع والمخازن لمطابقة الفواتير مع أوامر الشراء والاستلام.';

const FIN_TREAS_AUTH =
  '- إدارة السيولة النقدية اليومية للشركة وحساباتها البنكية المتعددة.\n' +
  '- التفاوض على التسهيلات البنكية وإدارة مخاطر أسعار الصرف والفائدة.\n' +
  '- اعتماد التحويلات المالية الكبرى بين حسابات الشركة.';

const FIN_FPA_AUTH =
  '- إعداد الموازنات التقديرية السنوية لكل الإدارات ومتابعة الانحرافات الفعلية عنها.\n' +
  '- تحليل الربحية لكل فرع/منتج وتقديم توصيات لتحسين الأداء المالي.\n' +
  '- دعم القرارات الاستثمارية بدراسات جدوى مالية.';

const FIN_PAY_AUTH =
  '- احتساب واعتماد رواتب ومستحقات جميع الموظفين شهريًا بالتنسيق مع الموارد البشرية.\n' +
  '- ضمان الالتزام بقانون العمل الكويتي وأنظمة التأمينات الاجتماعية.\n' +
  '- إصدار تقارير تكلفة القوى العاملة للإدارة المالية.';

const FIN_TAX_AUTH =
  '- ضمان التزام الشركة بجميع المتطلبات الضريبية والزكوية المحلية والدولية.\n' +
  '- إعداد وتقديم الإقرارات الضريبية بالمواعيد النظامية.\n' +
  '- متابعة أي تحديثات تشريعية ضريبية وتقييم أثرها على الشركة.';

const FIN_AUD_AUTH =
  '- تدقيق العمليات المالية والتشغيلية بشكل دوري ومستقل عن باقي إدارات المالية.\n' +
  '- رفع تقارير مباشرة للإدارة العليا/لجنة التدقيق عن أي مخالفات أو نقاط ضعف بالرقابة الداخلية.\n' +
  '- متابعة تنفيذ التوصيات التصحيحية عبر جميع الإدارات.';

export const FINANCE_DEPARTMENT_TEMPLATE: TemplateDivision[] = [
  {
    code: 'FIN-EXEC',
    name: 'الإدارة العليا المالية',
    name_en: 'Finance Executive Management',
    sections: [],
    roles: [
      { name: 'المدير المالي', name_en: 'Chief Financial Officer (CFO)', responsibilities: FIN_EXEC_AUTH, permission_keys: ['view_financials', 'manage_cost_centers', 'view_profit_margins', 'export_sensitive_reports', 'edit_sensitive_data'] },
      { name: 'نائب المدير المالي', name_en: 'Deputy CFO / Finance Director', responsibilities: FIN_EXEC_AUTH, permission_keys: ['view_financials', 'manage_cost_centers'] },
    ],
  },
  {
    code: 'FIN-ACC',
    name: 'إدارة المحاسبة العامة والتقارير المالية',
    name_en: 'Accounting & Financial Reporting',
    sections: [],
    roles: [
      { name: 'مدير الحسابات العامة', name_en: 'Financial Controller', responsibilities: FIN_ACC_AUTH, permission_keys: ['view_financials'] },
      { name: 'محاسب أول', name_en: 'Senior Accountant', responsibilities: FIN_ACC_AUTH },
      { name: 'محاسب', name_en: 'Accountant', responsibilities: FIN_ACC_AUTH },
      { name: 'محلل محاسبي', name_en: 'Accounting Analyst', responsibilities: FIN_ACC_AUTH },
    ],
  },
  {
    code: 'FIN-APAR',
    name: 'إدارة الذمم الدائنة والمدينة',
    name_en: 'Accounts Payable & Receivable',
    sections: [
      { code: 'AP', name: 'قسم الذمم الدائنة', name_en: 'Accounts Payable' },
      { code: 'AR', name: 'قسم الذمم المدينة', name_en: 'Accounts Receivable' },
    ],
    roles: [
      { name: 'مسؤول الذمم الدائنة', name_en: 'Accounts Payable Specialist', responsibilities: FIN_APAR_AUTH, section: 'AP', permission_keys: ['edit_expenses'] },
      { name: 'مسؤول الذمم المدينة', name_en: 'Accounts Receivable / Billing Specialist', responsibilities: FIN_APAR_AUTH, section: 'AR' },
      { name: 'محلل ذمم', name_en: 'AP/AR Analyst', responsibilities: FIN_APAR_AUTH },
    ],
  },
  {
    code: 'FIN-TREAS',
    name: 'إدارة الخزينة',
    name_en: 'Treasury',
    sections: [],
    roles: [
      { name: 'أمين الخزينة', name_en: 'Treasurer', responsibilities: FIN_TREAS_AUTH, permission_keys: ['view_financials', 'override_credit_limit'] },
      { name: 'محلل خزينة', name_en: 'Treasury Analyst', responsibilities: FIN_TREAS_AUTH },
    ],
  },
  {
    code: 'FIN-FPA',
    name: 'إدارة التخطيط المالي والميزانيات',
    name_en: 'Budgeting & Financial Planning (FP&A)',
    sections: [],
    roles: [
      { name: 'مدير التخطيط المالي', name_en: 'FP&A Manager', responsibilities: FIN_FPA_AUTH, permission_keys: ['view_financials', 'manage_cost_centers'] },
      { name: 'محلل ميزانيات', name_en: 'Budget Analyst', responsibilities: FIN_FPA_AUTH },
    ],
  },
  {
    code: 'FIN-PAY',
    name: 'إدارة الرواتب',
    name_en: 'Payroll',
    sections: [],
    roles: [
      { name: 'مدير الرواتب', name_en: 'Payroll Manager', responsibilities: FIN_PAY_AUTH, permission_keys: ['manage_payroll'] },
      { name: 'مسؤول رواتب', name_en: 'Payroll Specialist', responsibilities: FIN_PAY_AUTH, permission_keys: ['manage_payroll'] },
    ],
  },
  {
    code: 'FIN-TAX',
    name: 'إدارة الضرائب والالتزام الضريبي',
    name_en: 'Tax & Compliance',
    sections: [],
    roles: [
      { name: 'محاسب ضرائب', name_en: 'Tax Accountant', responsibilities: FIN_TAX_AUTH },
      { name: 'محلل التزام ضريبي', name_en: 'Tax Compliance Analyst', responsibilities: FIN_TAX_AUTH },
    ],
  },
  {
    code: 'FIN-AUD',
    name: 'إدارة التدقيق الداخلي',
    name_en: 'Internal Audit',
    sections: [],
    roles: [
      { name: 'مدقق داخلي', name_en: 'Internal Auditor', responsibilities: FIN_AUD_AUTH, permission_keys: ['view_audit_log', 'export_sensitive_reports'] },
      { name: 'محلل مطابقة', name_en: 'Compliance Analyst', responsibilities: FIN_AUD_AUTH, permission_keys: ['view_audit_log'] },
    ],
  },
];

// ============================== Marketing ==============================

const MKT_EXEC_AUTH =
  'اعتماد الاستراتيجية التسويقية السنوية والموازنة الإعلانية الكلية، والموافقة على الهوية البصرية والحملات الكبرى قبل إطلاقها.\n' +
  'صلاحية اعتماد الخصومات والعروض الترويجية الاستثنائية بالتنسيق مع الإدارة المالية.';

const MKT_BRAND_AUTH =
  '- اعتماد دليل الهوية البصرية للعلامة التجارية وضمان الالتزام به عبر كل القنوات والفروع.\n' +
  '- وضع استراتيجية تموضع العلامة التجارية بالسوق ومراقبة صورتها لدى الجمهور.';

const MKT_DIGITAL_AUTH =
  '- إدارة الحسابات الإعلانية المدفوعة (Google/Meta/TikTok) والموازنات المخصصة لها.\n' +
  '- إدارة حسابات التواصل الاجتماعي الرسمية للشركة والرد على تفاعل الجمهور.\n' +
  '- تحسين ظهور موقع الشركة وتطبيقاتها بمحركات البحث.';

const MKT_CONTENT_AUTH =
  '- إنتاج المحتوى الإبداعي (نصوص، تصاميم، فيديو) لكل الحملات والقنوات.\n' +
  '- الحفاظ على نبرة الصوت (Tone of Voice) الموحدة للعلامة التجارية بكل المخرجات.';

const MKT_RESEARCH_AUTH =
  '- إجراء أبحاث السوق ودراسات سلوك المستهلك لدعم القرارات التسويقية.\n' +
  '- تحليل أداء الحملات (ROI) وتقديم تقارير دورية للإدارة العليا.';

const MKT_CAMP_AUTH =
  '- تخطيط وتنفيذ الحملات التسويقية عبر القنوات المختلفة والتنسيق بين الفرق المعنية.\n' +
  '- صلاحية اعتماد عروض وخصومات ترويجية محدودة ضمن سقف الحملة المعتمد.';

const MKT_PR_AUTH =
  '- إدارة العلاقة مع وسائل الإعلام والمؤثرين والجهات الخارجية.\n' +
  '- إعداد البيانات الصحفية وإدارة الأزمات الإعلامية إن وجدت.';

export const MARKETING_DEPARTMENT_TEMPLATE: TemplateDivision[] = [
  {
    code: 'MKT-EXEC',
    name: 'الإدارة العليا للتسويق',
    name_en: 'Marketing Executive Management',
    sections: [],
    roles: [
      { name: 'مدير التسويق', name_en: 'Chief Marketing Officer (CMO) / Marketing Director', responsibilities: MKT_EXEC_AUTH, permission_keys: ['apply_custom_discount', 'export_sensitive_reports'] },
    ],
  },
  {
    code: 'MKT-BRAND',
    name: 'إدارة العلامة التجارية والاستراتيجية',
    name_en: 'Brand & Strategy',
    sections: [],
    roles: [
      { name: 'مدير العلامة التجارية', name_en: 'Brand Manager', responsibilities: MKT_BRAND_AUTH },
      { name: 'استراتيجي علامة تجارية', name_en: 'Brand Strategist', responsibilities: MKT_BRAND_AUTH },
    ],
  },
  {
    code: 'MKT-DIG',
    name: 'إدارة التسويق الرقمي',
    name_en: 'Digital Marketing',
    sections: [],
    roles: [
      { name: 'مدير التسويق الرقمي', name_en: 'Digital Marketing Manager', responsibilities: MKT_DIGITAL_AUTH },
      { name: 'أخصائي وسائل تواصل اجتماعي', name_en: 'Social Media Specialist', responsibilities: MKT_DIGITAL_AUTH },
      { name: 'أخصائي إعلانات مدفوعة', name_en: 'Paid Media Specialist', responsibilities: MKT_DIGITAL_AUTH },
      { name: 'أخصائي تحسين محركات البحث', name_en: 'SEO Specialist', responsibilities: MKT_DIGITAL_AUTH },
    ],
  },
  {
    code: 'MKT-CONT',
    name: 'إدارة المحتوى والإبداع',
    name_en: 'Content & Creative',
    sections: [],
    roles: [
      { name: 'مدير المحتوى', name_en: 'Content Manager', responsibilities: MKT_CONTENT_AUTH },
      { name: 'كاتب محتوى تسويقي', name_en: 'Marketing Copywriter', responsibilities: MKT_CONTENT_AUTH },
      { name: 'مصمم جرافيك', name_en: 'Graphic Designer', responsibilities: MKT_CONTENT_AUTH },
    ],
  },
  {
    code: 'MKT-RSCH',
    name: 'إدارة أبحاث السوق والتحليلات',
    name_en: 'Market Research & Analytics',
    sections: [],
    roles: [
      { name: 'محلل أبحاث سوق', name_en: 'Market Research Analyst', responsibilities: MKT_RESEARCH_AUTH },
      { name: 'محلل تسويق', name_en: 'Marketing Analyst', responsibilities: MKT_RESEARCH_AUTH },
    ],
  },
  {
    code: 'MKT-CAMP',
    name: 'إدارة الحملات والبرامج التسويقية',
    name_en: 'Campaigns & Programs',
    sections: [],
    roles: [
      { name: 'مدير حملات تسويقية', name_en: 'Campaign Manager', responsibilities: MKT_CAMP_AUTH, permission_keys: ['apply_custom_discount'] },
      { name: 'منسق حملات', name_en: 'Campaign Coordinator', responsibilities: MKT_CAMP_AUTH },
    ],
  },
  {
    code: 'MKT-PR',
    name: 'إدارة العلاقات العامة',
    name_en: 'Public Relations',
    sections: [],
    roles: [
      { name: 'مسؤول علاقات عامة', name_en: 'PR Specialist', responsibilities: MKT_PR_AUTH },
    ],
  },
];

// ============================== Legal ==============================

const LGL_EXEC_AUTH =
  'تمثيل الشركة قانونيًا أمام الجهات القضائية والحكومية، واعتماد جميع العقود والاتفاقيات الجوهرية قبل التوقيع.\n' +
  'صلاحية الاطلاع على كل الملفات القانونية الحساسة وتقديم المشورة الملزمة للإدارة العليا بشأن المخاطر القانونية.';

const LGL_GOV_AUTH =
  '- وضع السياسات الداخلية لضمان التزام الشركة بالأنظمة واللوائح المحلية والدولية.\n' +
  '- إجراء مراجعات دورية للتأكد من الامتثال ورفع تقارير للإدارة العليا.';

const LGL_CONTR_AUTH =
  '- صياغة ومراجعة واعتماد كل العقود مع الموردين والعملاء والشركاء قبل التوقيع.\n' +
  '- إدارة أرشيف العقود ومتابعة تواريخ التجديد والانتهاء.';

const LGL_IP_AUTH =
  '- تسجيل وحماية العلامات التجارية وبراءات الاختراع الخاصة بالشركة.\n' +
  '- متابعة أي تعدٍ على الملكية الفكرية للشركة واتخاذ الإجراءات القانونية اللازمة.';

const LGL_LIT_AUTH =
  '- إدارة أي نزاعات أو دعاوى قضائية تخص الشركة والتنسيق مع المحامين الخارجيين عند الحاجة.\n' +
  '- تقييم المخاطر القانونية للقرارات التجارية الكبرى قبل اتخاذها.';

const LGL_GA_AUTH =
  '- إدارة العلاقة مع الجهات الحكومية (وزارة التجارة، البلدية، إلخ) ومتابعة التراخيص التجارية للفروع.\n' +
  '- متابعة أي تغييرات تشريعية تؤثر على نشاط الشركة.';

const LGL_ADMIN_AUTH =
  '- إدارة نظام حفظ وأرشفة المستندات القانونية للشركة.\n' +
  '- تقديم الدعم الإداري لكل فرق الإدارة القانونية.';

export const LEGAL_DEPARTMENT_TEMPLATE: TemplateDivision[] = [
  {
    code: 'LGL-EXEC',
    name: 'الإدارة العليا للشؤون القانونية',
    name_en: 'Legal Executive Office',
    sections: [],
    roles: [
      { name: 'المستشار القانوني العام', name_en: 'General Counsel / Chief Legal Officer (CLO)', responsibilities: LGL_EXEC_AUTH, permission_keys: ['view_audit_log', 'edit_sensitive_data', 'export_sensitive_reports'] },
    ],
  },
  {
    code: 'LGL-GOV',
    name: 'إدارة الحوكمة المؤسسية والامتثال',
    name_en: 'Corporate Governance & Compliance',
    sections: [],
    roles: [
      { name: 'مسؤول الحوكمة والامتثال', name_en: 'Governance & Compliance Officer', responsibilities: LGL_GOV_AUTH, permission_keys: ['view_audit_log'] },
      { name: 'مساعد قانوني', name_en: 'Paralegal', responsibilities: LGL_GOV_AUTH },
    ],
  },
  {
    code: 'LGL-CONTR',
    name: 'إدارة العقود',
    name_en: 'Contract Management',
    sections: [],
    roles: [
      { name: 'مدير إدارة العقود', name_en: 'Contracts Manager', responsibilities: LGL_CONTR_AUTH },
      { name: 'محلل عقود', name_en: 'Contracts Analyst', responsibilities: LGL_CONTR_AUTH },
    ],
  },
  {
    code: 'LGL-IP',
    name: 'إدارة الملكية الفكرية',
    name_en: 'Intellectual Property',
    sections: [],
    roles: [
      { name: 'مستشار ملكية فكرية', name_en: 'IP Counsel', responsibilities: LGL_IP_AUTH },
      { name: 'أخصائي تراخيص', name_en: 'Licensing Specialist', responsibilities: LGL_IP_AUTH },
    ],
  },
  {
    code: 'LGL-LIT',
    name: 'إدارة التقاضي والمنازعات',
    name_en: 'Litigation & Disputes',
    sections: [],
    roles: [
      { name: 'محامي شركة', name_en: 'Corporate Attorney', responsibilities: LGL_LIT_AUTH },
      { name: 'محلل دعاوى', name_en: 'Litigation Analyst', responsibilities: LGL_LIT_AUTH },
    ],
  },
  {
    code: 'LGL-GA',
    name: 'إدارة الشؤون الحكومية والتراخيص',
    name_en: 'Government Affairs & Licensing',
    sections: [],
    roles: [
      { name: 'مسؤول علاقات حكومية', name_en: 'Government Relations Officer', responsibilities: LGL_GA_AUTH },
    ],
  },
  {
    code: 'LGL-ADMIN',
    name: 'إدارة الدعم الإداري القانوني',
    name_en: 'Legal Administrative Support',
    sections: [],
    roles: [
      { name: 'مدير مستندات قانونية', name_en: 'Document Manager', responsibilities: LGL_ADMIN_AUTH },
      { name: 'مساعد قانوني إداري', name_en: 'Legal Administrative Assistant', responsibilities: LGL_ADMIN_AUTH },
    ],
  },
];

// ============================== Operations ==============================
// Scoped to a multi-branch retail/F&B/service company — the same customer profile
// the IT template's own Infrastructure division already assumed ("الفروع والمعارض
// والمطاعم", see itDepartmentTemplate.ts DIV2_AUTHORITIES).

const OPS_EXEC_AUTH =
  'اعتماد الخطط التشغيلية السنوية لكل الفروع والمستودعات، واعتماد أوامر الشراء والعقود التشغيلية الكبرى.\n' +
  'صلاحية الاطلاع على هوامش الربح التشغيلية ومراكز التكلفة لكل فرع/قسم واتخاذ قرارات تحسين الكفاءة.';

const OPS_BRANCH_AUTH =
  '- الإشراف اليومي على تشغيل الفروع (المعارض، المطاعم، الكشكات) وضمان الالتزام بمعايير الشركة.\n' +
  '- اعتماد جداول دوام الموظفين بالفروع ومتابعة الحضور والانصراف.\n' +
  '- صلاحية اعتماد إتلاف/هدر البضاعة التالفة وتقديم عروض وخصومات محدودة بالفرع.';

const OPS_PROC_AUTH =
  '- اعتماد أوامر الشراء من الموردين وفق السقوف المالية المحددة لكل مستوى إداري.\n' +
  '- التفاوض على أسعار وشروط التوريد ومتابعة أداء الموردين.\n' +
  '- التخطيط لاحتياجات التوريد بناءً على مبيعات وتوقعات الفروع.';

const OPS_WH_AUTH =
  '- إدارة استلام وتخزين وصرف البضائع من وإلى المستودعات المركزية والفروع.\n' +
  '- إجراء الجرد الدوري ومطابقته مع سجلات النظام، ومعالجة فروقات المخزون.';

const OPS_LOG_AUTH =
  '- تخطيط وتنفيذ عمليات نقل وتوزيع البضائع بين المستودعات والفروع بأقل تكلفة وأسرع وقت.\n' +
  '- التنسيق مع شركات التوصيل الخارجية ومتابعة أداء التسليم للعملاء.';

const OPS_FAC_AUTH =
  '- صيانة معدات وأجهزة الفروع والمكاتب (تكييف، كهرباء، معدات مطابخ) والتأكد من جاهزيتها.\n' +
  '- إدارة عقود الصيانة الخارجية ومتابعة ميزانية الصيانة والمرافق.';

const OPS_QC_AUTH =
  '- وضع معايير الجودة والسلامة الغذائية/التشغيلية ومراقبة التزام الفروع بها.\n' +
  '- إجراء زيارات تفتيشية دورية ورفع تقارير مخالفات للإدارة.';

export const OPERATIONS_DEPARTMENT_TEMPLATE: TemplateDivision[] = [
  {
    code: 'OPS-EXEC',
    name: 'الإدارة العليا للعمليات',
    name_en: 'Operations Executive Management',
    sections: [],
    roles: [
      { name: 'مدير العمليات', name_en: 'Chief Operating Officer (COO) / Operations Director', responsibilities: OPS_EXEC_AUTH, permission_keys: ['view_profit_margins', 'manage_cost_centers', 'approve_purchase_orders'] },
    ],
  },
  {
    code: 'OPS-BRANCH',
    name: 'إدارة عمليات الفروع',
    name_en: 'Branch / Store Operations',
    sections: [],
    roles: [
      { name: 'مدير مناطق', name_en: 'Area / District Manager', responsibilities: OPS_BRANCH_AUTH, permission_keys: ['manual_attendance', 'edit_waste'] },
      { name: 'مشرف فرع', name_en: 'Branch Supervisor', responsibilities: OPS_BRANCH_AUTH },
      { name: 'مدير فرع', name_en: 'Branch Manager', responsibilities: OPS_BRANCH_AUTH, permission_keys: ['apply_custom_discount'] },
    ],
  },
  {
    code: 'OPS-PROC',
    name: 'إدارة سلسلة الإمداد والمشتريات',
    name_en: 'Supply Chain & Procurement',
    sections: [],
    roles: [
      { name: 'مدير سلسلة الإمداد', name_en: 'Supply Chain Manager', responsibilities: OPS_PROC_AUTH, permission_keys: ['approve_purchase_orders'] },
      { name: 'مسؤول مشتريات', name_en: 'Procurement Specialist', responsibilities: OPS_PROC_AUTH, permission_keys: ['approve_purchase_orders'] },
      { name: 'محلل سلسلة إمداد', name_en: 'Supply Chain Analyst', responsibilities: OPS_PROC_AUTH },
    ],
  },
  {
    code: 'OPS-WH',
    name: 'إدارة المخازن والمستودعات',
    name_en: 'Warehousing & Inventory',
    sections: [],
    roles: [
      { name: 'مدير المستودعات', name_en: 'Warehouse Manager', responsibilities: OPS_WH_AUTH, permission_keys: ['edit_waste'] },
      { name: 'مسؤول جرد ومخزون', name_en: 'Inventory Controller', responsibilities: OPS_WH_AUTH },
    ],
  },
  {
    code: 'OPS-LOG',
    name: 'إدارة اللوجستيات والتوزيع',
    name_en: 'Logistics & Distribution',
    sections: [],
    roles: [
      { name: 'مدير لوجستيات', name_en: 'Logistics Manager', responsibilities: OPS_LOG_AUTH },
      { name: 'منسق توصيل', name_en: 'Delivery Coordinator', responsibilities: OPS_LOG_AUTH },
    ],
  },
  {
    code: 'OPS-FAC',
    name: 'إدارة الصيانة والمرافق',
    name_en: 'Facilities & Maintenance',
    sections: [],
    roles: [
      { name: 'مدير الصيانة والمرافق', name_en: 'Facilities Manager', responsibilities: OPS_FAC_AUTH, permission_keys: ['manage_cost_centers'] },
      { name: 'فني صيانة', name_en: 'Maintenance Technician', responsibilities: OPS_FAC_AUTH },
    ],
  },
  {
    code: 'OPS-QC',
    name: 'إدارة الجودة والامتثال التشغيلي',
    name_en: 'Quality & Operational Compliance',
    sections: [],
    roles: [
      { name: 'مسؤول ضمان الجودة', name_en: 'QA / Compliance Officer', responsibilities: OPS_QC_AUTH },
      { name: 'مسؤول السلامة المهنية', name_en: 'Operational Safety Officer', responsibilities: OPS_QC_AUTH },
    ],
  },
];

// ============================== Registry ==============================

export type DepartmentTemplateKey = 'IT' | 'HR' | 'FINANCE' | 'MARKETING' | 'LEGAL' | 'OPERATIONS';

export interface DepartmentTemplateEntry {
  template: TemplateDivision[];
  // The legacy department name_en(s) this template replaces when applied — the flat
  // MIGRATION_048 seed name for the 5 non-IT keys, or the pre-MIGRATION_069 flat
  // "IT" row for IT.
  legacyNames: string[];
  labelAr: string;
  labelEn: string;
}

export const DEPARTMENT_TEMPLATES: Record<DepartmentTemplateKey, DepartmentTemplateEntry> = {
  IT: { template: IT_DEPARTMENT_TEMPLATE, legacyNames: ['IT'], labelAr: 'تقنية المعلومات', labelEn: 'IT' },
  HR: { template: HR_DEPARTMENT_TEMPLATE, legacyNames: ['Human Resources'], labelAr: 'الموارد البشرية', labelEn: 'Human Resources' },
  FINANCE: { template: FINANCE_DEPARTMENT_TEMPLATE, legacyNames: ['Finance'], labelAr: 'المالية', labelEn: 'Finance' },
  MARKETING: { template: MARKETING_DEPARTMENT_TEMPLATE, legacyNames: ['Marketing'], labelAr: 'التسويق', labelEn: 'Marketing' },
  LEGAL: { template: LEGAL_DEPARTMENT_TEMPLATE, legacyNames: ['Legal'], labelAr: 'الشؤون القانونية', labelEn: 'Legal' },
  OPERATIONS: { template: OPERATIONS_DEPARTMENT_TEMPLATE, legacyNames: ['Operations'], labelAr: 'العمليات', labelEn: 'Operations' },
};

export function isDepartmentTemplateKey(value: unknown): value is DepartmentTemplateKey {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(DEPARTMENT_TEMPLATES, value);
}

// Applies any registered template by key — thin dispatcher over
// applyDepartmentTemplate() (itDepartmentTemplate.ts) so every caller (signup,
// the admin "Load Template" endpoint) goes through one place regardless of which
// of the 6 departments is being applied.
export async function applyDepartmentTemplateByKey(
  client: PoolClient,
  companyId: string,
  key: DepartmentTemplateKey
): Promise<ApplyDepartmentTemplateResult> {
  const entry = DEPARTMENT_TEMPLATES[key];
  return applyDepartmentTemplate(client, companyId, entry.template, entry.legacyNames);
}

// Sources consulted (2026-08-26) to verify sub-department/role breakdowns before
// writing the Arabic reference text above — same "research first, then translate
// into the app's data model" approach as IT's own template
// (claude/it-department-structure-context-handoff.md §6):
// - HR: https://www.hibob.com/blog/hr-department-structure/
// - Finance: https://opsdog.com/categories/organization-charts/finance
// - Marketing: https://opsdog.com/categories/organization-charts/marketing
// - Legal: https://opsdog.com/categories/organization-charts/legal
// - Operations (retail/F&B): https://www.clickpost.ai/blog/retail-operations-manager

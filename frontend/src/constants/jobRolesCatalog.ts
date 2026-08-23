// Enterprise Job Role Catalog — a hierarchical, department-aware replacement for
// the old flat kiosk-only job role list in EmployeesPage.tsx.
//
// Design: this file only defines STRUCTURE (which role keys exist, which group
// they belong to, and which department(s) should auto-filter to that group).
// The actual bilingual LABEL TEXT for every role/group lives in i18n.ts under
// t.employees.jobRole<Key> / t.employees.jobRoleGroup<Key> — same convention the
// original 8-role list already used (EmployeesPage.tsx's JOB_ROLE_LABELS reads
// from useT()), so every label still switches with the current UI language and
// nothing bilingual is duplicated/hardcoded here.
//
// job_role itself is still stored on the employee as plain resolved label text
// (legacy design, unchanged) — an employee whose stored text doesn't match any
// current key/label just falls back to "Other" with the raw text preserved and
// editable (see EmployeesPage.tsx's resolveJobRoleSelect), so replacing the old
// flat kiosk list with this catalog is safe for existing employee records.

export type JobRoleKey =
  // Legal & Compliance
  | 'legalDirector'
  | 'generalCounsel'
  | 'seniorLegalCounsel'
  | 'legalCounsel'
  | 'corporateLawyer'
  | 'legalResearcher'
  | 'paralegal'
  | 'complianceOfficer'
  | 'boardSecretary'
  // Operations - F&B
  | 'restaurantManager'
  | 'assistantRestaurantManager'
  | 'shiftSupervisor'
  | 'headChef'
  | 'commisChef'
  | 'barista'
  | 'juiceMaker'
  | 'cashier'
  | 'waiter'
  | 'sandwichMaker'
  | 'kitchenSteward'
  | 'deliveryRider'
  // Operations - Retail
  | 'storeManager'
  | 'assistantStoreManager'
  | 'departmentSupervisor'
  | 'salesAssociate'
  | 'retailCashier'
  | 'receptionist'
  | 'visualMerchandiser'
  | 'storeKeeper'
  | 'customerServiceAgent'
  // Operations - Kiosk
  | 'kioskSupervisor'
  | 'kioskOperator'
  // Compliance & Quality / Field Control & Support
  | 'qualityAuditor'
  | 'mysteryShopper'
  | 'securityOfficer'
  // HR (generic)
  | 'hrManager'
  | 'hrOfficer'
  | 'recruitmentSpecialist'
  | 'payrollSpecialist'
  | 'trainingDevelopmentOfficer'
  // Finance (generic)
  | 'financeManager'
  | 'accountant'
  | 'accountsPayableOfficer'
  | 'treasuryOfficer'
  | 'internalAuditor'
  // IT (generic)
  | 'itManager'
  | 'softwareDeveloper'
  | 'itSupportSpecialist'
  | 'systemsAdministrator'
  | 'networkEngineer'
  // Marketing (generic)
  | 'marketingManager'
  | 'marketingSpecialist'
  | 'socialMediaCoordinator'
  | 'graphicDesigner'
  | 'contentCreator';

export type JobRoleGroupKey =
  | 'legal'
  | 'fnb'
  | 'retail'
  | 'kiosk'
  | 'fieldControl'
  | 'hr'
  | 'finance'
  | 'it'
  | 'marketing';

export interface JobRoleGroup {
  key: JobRoleGroupKey;
  roles: JobRoleKey[];
  // Lowercased EN/AR fragments checked against the selected employee's department
  // (both department.name and department.name_en, since either can be renamed
  // per-company). A department matching one of these keywords auto-filters the
  // Job Role dropdown down to this group. Empty array = never auto-selected by a
  // department match — 'fieldControl' only shows in the "no department chosen"
  // (show-everything) state, per the exact scope given for this feature
  // ("Operations department -> F&B/Retail/Kiosk only").
  departmentKeywords: string[];
}

export const JOB_ROLE_GROUPS: JobRoleGroup[] = [
  {
    key: 'legal',
    departmentKeywords: ['legal', 'الشؤون القانونية', 'قانون'],
    roles: [
      'legalDirector',
      'generalCounsel',
      'seniorLegalCounsel',
      'legalCounsel',
      'corporateLawyer',
      'legalResearcher',
      'paralegal',
      'complianceOfficer',
      'boardSecretary',
    ],
  },
  {
    key: 'fnb',
    departmentKeywords: ['operations', 'العمليات'],
    roles: [
      'restaurantManager',
      'assistantRestaurantManager',
      'shiftSupervisor',
      'headChef',
      'commisChef',
      'barista',
      'juiceMaker',
      'cashier',
      'waiter',
      'sandwichMaker',
      'kitchenSteward',
      'deliveryRider',
    ],
  },
  {
    key: 'retail',
    departmentKeywords: ['operations', 'العمليات'],
    roles: [
      'storeManager',
      'assistantStoreManager',
      'departmentSupervisor',
      'salesAssociate',
      'retailCashier',
      'receptionist',
      'visualMerchandiser',
      'storeKeeper',
      'customerServiceAgent',
    ],
  },
  {
    key: 'kiosk',
    departmentKeywords: ['operations', 'العمليات'],
    roles: ['kioskSupervisor', 'kioskOperator'],
  },
  {
    key: 'fieldControl',
    departmentKeywords: [],
    roles: ['qualityAuditor', 'mysteryShopper', 'securityOfficer'],
  },
  {
    key: 'hr',
    departmentKeywords: ['human resources', 'hr', 'الموارد البشرية'],
    roles: ['hrManager', 'hrOfficer', 'recruitmentSpecialist', 'payrollSpecialist', 'trainingDevelopmentOfficer'],
  },
  {
    key: 'finance',
    departmentKeywords: ['finance', 'المالية'],
    roles: ['financeManager', 'accountant', 'accountsPayableOfficer', 'treasuryOfficer', 'internalAuditor'],
  },
  {
    key: 'it',
    departmentKeywords: ['information technology', ' it', 'تقنية المعلومات'],
    roles: ['itManager', 'softwareDeveloper', 'itSupportSpecialist', 'systemsAdministrator', 'networkEngineer'],
  },
  {
    key: 'marketing',
    departmentKeywords: ['marketing', 'التسويق'],
    roles: ['marketingManager', 'marketingSpecialist', 'socialMediaCoordinator', 'graphicDesigner', 'contentCreator'],
  },
];

// Returns the groups to render as <optgroup>s given the employee's currently
// selected department (or null/undefined when none is selected yet). Falls back
// to showing every group whenever nothing matches, so a custom-renamed
// department can never leave the picker empty.
export function getVisibleJobRoleGroups(department: { name: string; name_en: string } | null | undefined): JobRoleGroup[] {
  if (!department) return JOB_ROLE_GROUPS;
  const haystack = `${department.name} ${department.name_en}`.toLowerCase();
  const matched = JOB_ROLE_GROUPS.filter(
    (g) => g.departmentKeywords.length > 0 && g.departmentKeywords.some((kw) => haystack.includes(kw.toLowerCase()))
  );
  return matched.length > 0 ? matched : JOB_ROLE_GROUPS;
}

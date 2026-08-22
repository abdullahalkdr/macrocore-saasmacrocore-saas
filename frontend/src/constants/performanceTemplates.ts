// Hardcoded "starting point" templates for the OKR and Appraisal Form creation
// modals — product ask: a blank form/goal is intimidating, so offer a
// standard-industry default the admin can tweak instead of typing from scratch.
// Pure data, no backend/schema changes — selecting one just mutates the modal's
// local React state (see PerformancePage.tsx's OkrTab/AppraisalsTab).
//
// Every user-facing bit of DATA here (form name, question text, KR titles) is
// bilingual by default since it lands in real bilingual DB columns
// (name/name_en, question_text/question_text_en, title/title_en) regardless of
// which language the admin is using right now. Dropdown LABELS are not defined
// here — those go through useT() like every other string in this app (see
// i18n.ts's performance.template*/category* keys) so the picker itself still
// switches with the UI language.

export type AppraisalTemplateKey = 'annual360' | 'quarterly' | 'probationary';

export interface AppraisalTemplateQuestion {
  question_text: string;
  question_text_en: string;
  question_type: 'rating' | 'text' | 'scale';
  max_score: number;
  weight: number;
}

export interface AppraisalTemplate {
  name: string;
  name_en: string;
  // appraisal_forms.description is a single (non-bilingual) column — pick the
  // matching string for the admin's current UI language at selection time
  // (see AppraisalsTab.handleTemplateChange), rather than picking one language
  // and sticking with it regardless of who's filling the form out.
  description_ar: string;
  description_en: string;
  questions: AppraisalTemplateQuestion[];
}

export const APPRAISAL_TEMPLATES: Record<AppraisalTemplateKey, AppraisalTemplate> = {
  annual360: {
    name: 'تقييم 360 السنوي',
    name_en: 'Annual 360 Review',
    description_ar: 'تقييم شامل سنوي يغطي العمل الجماعي، القيادة، التواصل، وحل المشاكل.',
    description_en: 'A comprehensive annual review covering teamwork, leadership, communication, and problem-solving.',
    questions: [
      {
        question_text: 'كيف يتعاون الموظف بفعالية مع أعضاء الفريق؟',
        question_text_en: 'How effectively does this employee collaborate with team members?',
        question_type: 'rating',
        max_score: 5,
        weight: 1,
      },
      {
        question_text: 'إلى أي مدى يُظهر الموظف صفات القيادة؟',
        question_text_en: 'How well does this employee demonstrate leadership qualities?',
        question_type: 'rating',
        max_score: 5,
        weight: 1,
      },
      {
        question_text: 'ما مدى وضوح وفعالية تواصل الموظف؟',
        question_text_en: "How clear and effective is this employee's communication?",
        question_type: 'rating',
        max_score: 5,
        weight: 1,
      },
      {
        question_text: 'كيف يتعامل الموظف مع حل المشاكل تحت الضغط؟',
        question_text_en: 'How effectively does this employee solve problems under pressure?',
        question_type: 'rating',
        max_score: 5,
        weight: 1,
      },
      {
        question_text: 'قيّم مساهمة الموظف العامة للفريق هالسنة.',
        question_text_en: "Rate the employee's overall contribution to the team this year.",
        question_type: 'rating',
        max_score: 5,
        weight: 1.5,
      },
    ],
  },
  quarterly: {
    name: 'الأداء الربع سنوي',
    name_en: 'Quarterly Performance',
    description_ar: 'مراجعة ربع سنوية مختصرة تركّز على تحقيق الأهداف وجودة العمل.',
    description_en: 'A short quarterly check-in focused on goal achievement and work quality.',
    questions: [
      {
        question_text: 'إلى أي مدى حقق الموظف أهدافه لهذا الربع؟',
        question_text_en: 'To what extent did the employee achieve their goals this quarter?',
        question_type: 'rating',
        max_score: 5,
        weight: 1.5,
      },
      {
        question_text: 'قيّم جودة العمل المُنجز هالربع.',
        question_text_en: "Rate the quality of the employee's work this quarter.",
        question_type: 'rating',
        max_score: 5,
        weight: 1,
      },
      {
        question_text: 'قيّم التزام الموظف بالمواعيد والانضباط.',
        question_text_en: "Rate the employee's punctuality and reliability.",
        question_type: 'rating',
        max_score: 5,
        weight: 1,
      },
      {
        question_text: 'وش أهم مجالات التحسين للربع الجاي؟',
        question_text_en: 'What are the top areas for improvement next quarter?',
        question_type: 'text',
        max_score: 5,
        weight: 1,
      },
    ],
  },
  probationary: {
    name: 'تقييم فترة التجربة',
    name_en: 'Probationary Review',
    description_ar: 'تقييم نهاية فترة التجربة لتحديد مدى ملاءمة الموظف للاستمرار.',
    description_en: "An end-of-probation review to assess the employee's fit going forward.",
    questions: [
      {
        question_text: 'ما مستوى معرفة الموظف بمهام وظيفته حتى الآن؟',
        question_text_en: "How would you rate the employee's job knowledge so far?",
        question_type: 'rating',
        max_score: 5,
        weight: 1,
      },
      {
        question_text: 'كيف كان تأقلم الموظف مع الفريق وثقافة العمل؟',
        question_text_en: "How well has the employee adapted to the team and workplace culture?",
        question_type: 'rating',
        max_score: 5,
        weight: 1,
      },
      {
        question_text: 'هل حقق الموظف التوقعات المطلوبة منه لين الحين؟',
        question_text_en: 'Has the employee met expectations so far?',
        question_type: 'rating',
        max_score: 5,
        weight: 1.5,
      },
      {
        question_text: 'التوصية: استمرار، تمديد فترة التجربة، أو إنهاء؟',
        question_text_en: 'Recommendation: continue, extend probation, or terminate?',
        question_type: 'text',
        max_score: 5,
        weight: 1,
      },
    ],
  },
};

export type OkrCategoryKey = 'sales' | 'customerSuccess' | 'operational';

export interface OkrTemplateKeyResult {
  title: string;
  title_en: string;
  metric_type: 'number' | 'percentage' | 'currency' | 'boolean';
  unit: string;
  // Baseline the KR starts from — distinct from target_value, since progress
  // can't be measured correctly by assuming every metric starts at 0 (e.g.
  // raising CSAT from 75% to 90%). Templates default to 0; the admin edits
  // it to the company's real current baseline after picking a category.
  start_value: number;
}

export interface OkrCategoryTemplate {
  title: string;
  title_en: string;
  keyResults: OkrTemplateKeyResult[];
}

// KR titles use a literal [X] placeholder where a company-specific number belongs
// (e.g. "Achieve KD [X] in MRR") — deliberately not a guessed real number; the
// admin fills target_value in with their own target after picking the category.
export const OKR_CATEGORY_TEMPLATES: Record<OkrCategoryKey, OkrCategoryTemplate> = {
  sales: {
    title: 'زيادة الإيرادات وتحقيق أهداف المبيعات',
    title_en: 'Grow Revenue & Hit Sales Targets',
    keyResults: [
      {
        title: 'تحقيق [X] د.ك من الإيراد الشهري المتكرر',
        title_en: 'Achieve KD [X] in Monthly Recurring Revenue',
        metric_type: 'currency',
        unit: 'KD',
        start_value: 0,
      },
      {
        title: 'استقطاب [X] عميل جديد',
        title_en: 'Acquire [X] new customers',
        metric_type: 'number',
        unit: '',
        start_value: 0,
      },
      {
        title: 'رفع معدل تجديد العملاء إلى [X]%',
        title_en: 'Improve customer renewal rate to [X]%',
        metric_type: 'percentage',
        unit: '%',
        start_value: 0,
      },
    ],
  },
  customerSuccess: {
    title: 'رفع رضا العملاء وتقليل التسرب',
    title_en: 'Improve Customer Satisfaction & Reduce Churn',
    keyResults: [
      {
        title: 'رفع درجة رضا العملاء (CSAT) إلى [X]%',
        title_en: 'Improve CSAT score to [X]%',
        metric_type: 'percentage',
        unit: '%',
        start_value: 0,
      },
      {
        title: 'تقليل معدل تسرب العملاء إلى [X]%',
        title_en: 'Reduce customer churn rate to [X]%',
        metric_type: 'percentage',
        unit: '%',
        start_value: 0,
      },
      {
        title: 'تقليل متوسط زمن الرد على تذاكر الدعم إلى [X] دقيقة',
        title_en: 'Reduce average support ticket response time to [X] minutes',
        metric_type: 'number',
        unit: 'min',
        start_value: 0,
      },
    ],
  },
  operational: {
    title: 'تحسين الكفاءة التشغيلية',
    title_en: 'Improve Operational Efficiency',
    keyResults: [
      {
        title: 'تقليل زمن دورة العملية الرئيسية إلى [X]',
        title_en: 'Reduce core process cycle time to [X]',
        metric_type: 'number',
        unit: '',
        start_value: 0,
      },
      {
        title: 'رفع نسبة الالتزام بمعايير الجودة إلى [X]%',
        title_en: 'Increase quality-standard compliance rate to [X]%',
        metric_type: 'percentage',
        unit: '%',
        start_value: 0,
      },
      {
        title: 'تقليل التكاليف التشغيلية بمقدار [X] د.ك',
        title_en: 'Reduce operational costs by KD [X]',
        metric_type: 'currency',
        unit: 'KD',
        start_value: 0,
      },
    ],
  },
};

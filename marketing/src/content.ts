export type Lang = 'ar' | 'en';

// Where "Login" / "Start free" buttons send visitors. Update this once the app
// moves to app.macrocore.io (see NEXT_CHAT_HANDOFF notes) — for now it points at
// the same domain the product currently lives on.
export const APP_URL = 'https://macrocore.io';

interface Feature {
  title: string;
  desc: string;
}

interface Vertical {
  title: string;
  desc: string;
}

interface Step {
  title: string;
  desc: string;
}

interface Stat {
  value: string;
  label: string;
}

export type MockupKind = 'inventory' | 'payroll' | 'reports';

interface DeepDive {
  eyebrow: string;
  title: string;
  desc: string;
  bullets: string[];
  mockup: MockupKind;
}

interface PricingTier {
  name: string;
  priceMonthlyUsd: string;
  priceAnnualUsd: string;
  priceMonthlyKwd: string;
  priceAnnualKwd: string;
  desc: string;
  highlighted?: boolean;
  cta: string;
  contactOnly?: boolean;
}

export type FeatureValue = boolean | string;

interface FeatureRow {
  label: string;
  values: FeatureValue[]; // one entry per tier, same order as pricingTiers
}

export interface FeatureCategory {
  name: string;
  rows: FeatureRow[];
}

interface SupportCard {
  title: string;
  desc: string;
  button: string;
}

interface AddOn {
  name: string;
  desc: string;
  priceMonthlyUsd: string;
  priceAnnualUsd: string;
  priceMonthlyKwd: string;
  priceAnnualKwd: string;
}

interface Content {
  nav: { features: string; verticals: string; how: string; pricing: string; login: string; cta: string };
  hero: { title: string; subtitle: string; ctaPrimary: string; ctaSecondary: string; trust: string };
  statsTitle: string;
  stats: Stat[];
  featuresTitle: string;
  featuresSubtitle: string;
  features: Feature[];
  deepDives: DeepDive[];
  verticalsTitle: string;
  verticalsSubtitle: string;
  verticals: Vertical[];
  howTitle: string;
  howSubtitle: string;
  steps: Step[];
  pricingTitle: string;
  pricingSubtitle: string;
  billingMonthly: string;
  billingAnnual: string;
  billingSave: string;
  annualCallout: string;
  mostPopular: string;
  perMonth: string;
  contactSales: string;
  pricingTiers: PricingTier[];
  featureMatrixTitle: string;
  featureViewSummaryLabel: string;
  featureViewDetailLabel: string;
  summaryPlusTemplate: string;
  featureMatrix: FeatureCategory[];
  pricingNote: string;
  addOnsTitle: string;
  addOnsSubtitle: string;
  addOnBilledMonthly: string;
  addOnBilledAnnual: string;
  addOns: AddOn[];
  supportTitle: string;
  supportSubtitle: string;
  supportCards: SupportCard[];
  ctaBanner: { title: string; subtitle: string; button: string };
  footer: {
    tagline: string;
    product: string;
    resources: string;
    company: string;
    productLinks: string[];
    resourceLinks: string[];
    companyLinks: string[];
    rights: string;
  };
}

export const content: Record<Lang, Content> = {
  ar: {
    nav: {
      features: 'المميزات',
      verticals: 'القطاعات',
      how: 'كيف يعمل',
      pricing: 'الأسعار',
      login: 'تسجيل الدخول',
      cta: 'ابدأ الآن',
    },
    hero: {
      title: 'نظام تشغيل متكامل لعملك — من الكشك للمتجر',
      subtitle: 'مبيعات، مخزون، رواتب، وتقارير — كله بمكان واحد. مصمم خصيصًا لأصحاب الكشكات والمطاعم والمحلات بالخليج.',
      ctaPrimary: 'ابدأ تجربتك المجانية',
      ctaSecondary: 'شوف كيف يشتغل',
      trust: 'مبني من صاحب مشروع، لأصحاب المشاريع — مو برنامج عام معرّب.',
    },
    statsTitle: 'ليش macrocore',
    stats: [
      { value: '٦', label: 'وحدات متكاملة بنظام واحد' },
      { value: '٢', label: 'لغة كاملة — عربي وإنجليزي' },
      { value: 'FIFO', label: 'تتبع مخزون دقيق لحظة بلحظة' },
      { value: '١٤', label: 'يوم تجربة مجانية بدون بطاقة' },
    ],
    featuresTitle: 'كل اللي تحتاجه، بمكان واحد',
    featuresSubtitle: 'ما تحتاج جدول إكسل ولا خمس برامج متفرقة — macrocore يجمعها كلها.',
    features: [
      { title: 'نقطة بيع وشفتات', desc: 'افتح شفت، سجل مبيعات، وتابع كل كشك أو فرع لحاله بلحظته.' },
      { title: 'مخزون FIFO وتواريخ صلاحية', desc: 'تعرف بالضبط أي دفعة تنباع أول، وتتنبه قبل ما مادتك الخام تنتهي.' },
      { title: 'رواتب وحضور', desc: 'راتب شهري أو بالساعة، خصم تأخير تلقائي، وبنود إضافية مفصّلة لكل موظف.' },
      { title: 'مستندات وتراخيص', desc: 'ولّد خطابات وشهادات رسمية، واحفظ تراخيصك وعقودك مع تنبيه قبل الانتهاء.' },
      { title: 'تقارير مالية يومية وشهرية', desc: 'أرباح، تكاليف، ومصروفات — كل شي واضح بلمحة وحدة.' },
      { title: 'تعدد الفروع', desc: 'كشك، مستودع، أكثر من موقع؟ كل واحد له مخزونه ومبيعاته لحاله.' },
    ],
    deepDives: [
      {
        eyebrow: 'المخزون',
        title: 'اعرف بالضبط وش عندك، وقبل لا ينتهي',
        desc: 'كل دفعة مواد خام لها تاريخ شراء وتاريخ صلاحية. النظام يستهلك الأقدم أول (FIFO) تلقائيًا، وينبهك قبل ما أي دفعة تنتهي — بكل موقع لحاله.',
        bullets: ['استهلاك FIFO تلقائي مع كل عملية بيع', 'تنبيهات قبل انتهاء الصلاحية', 'تحويل مخزون بين الكشك والمستودع بضغطة'],
        mockup: 'inventory',
      },
      {
        eyebrow: 'الرواتب',
        title: 'رواتب موظفينك تحسب لحالها',
        desc: 'راتب شهري أو بالساعة، خصم التأخير يُحسب تلقائيًا بالدقيقة من وقت الحضور الفعلي، وأي بدل أو خصم إضافي تسجله بند بند.',
        bullets: ['حساب تلقائي للخصومات من الحضور', 'أجر بالساعة أو شهري لكل موظف', 'بنود إضافية مفصّلة (بدلات، مكافآت، غياب)'],
        mockup: 'payroll',
      },
      {
        eyebrow: 'التقارير',
        title: 'أرباحك الحقيقية، كل يوم',
        desc: 'صافي الربح، تكلفة البضاعة المباعة، التالف، المصروفات، والرواتب — كلها محسوبة تلقائيًا ومعروضة يوميًا وشهريًا بدون ما تجمعها يدويًا.',
        bullets: ['تقرير يومي وشهري وسنوي جاهز', 'تكلفة كل منتج محسوبة من وصفته', 'حالة المخزون والتنبيهات بنفس الشاشة'],
        mockup: 'reports',
      },
    ],
    verticalsTitle: 'مصمم لعملك، أيًا كان نوعه',
    verticalsSubtitle: 'من كشك لقمة الطريق إلى سلسلة فروع — نفس النظام يكبر معك.',
    verticals: [
      { title: 'كشكات الطعام', desc: 'تتبع مبيعاتك اليومية ومخزون موادك الخام لحظة بلحظة.' },
      { title: 'مطاعم ومقاهي', desc: 'شفتات، وصفات، وتكلفة كل طبق محسوبة تلقائيًا.' },
      { title: 'محلات وبوتيكات', desc: 'مخزون منتجات، مقاسات، وتقارير مبيعات فورية.' },
      { title: 'مشاريع منزلية', desc: 'ابدأ بسيط وكبّر نظامك مع نمو مشروعك.' },
    ],
    howTitle: 'تبدأ بثلاث خطوات',
    howSubtitle: 'بدون تعقيد، بدون خبرة تقنية مطلوبة.',
    steps: [
      { title: 'سجّل شركتك', desc: 'دقائق وأنت جاهز — ما يحتاج فريق تقني.' },
      { title: 'أضف موظفينك ومخزونك', desc: 'واجهة بسيطة بالعربي والإنجليزي، خطوة بخطوة.' },
      { title: 'شغّل وتابع', desc: 'كل بياناتك بمكان واحد، أي وقت وأي مكان.' },
    ],
    pricingTitle: 'أسعار واضحة، بدون مفاجآت',
    pricingSubtitle: 'اختر الباقة اللي تناسب حجم مشروعك — وابدأ تجربة مجانية ١٤ يوم على أي باقة.',
    billingMonthly: 'شهري',
    billingAnnual: 'سنوي (شهرين مجانًا)',
    billingSave: 'وفّر مع الاشتراك السنوي',
    annualCallout: 'اشتراك ١٢ شهر بسعر ١٠ شهور فقط',
    mostPopular: 'الأكثر طلبًا',
    perMonth: 'شهر',
    contactSales: 'تواصل مع المبيعات',
    pricingTiers: [
      {
        name: 'Bronze',
        priceMonthlyUsd: '32',
        priceAnnualUsd: '26',
        priceMonthlyKwd: '9.900',
        priceAnnualKwd: '8.000',
        desc: 'لكشك أو فرع واحد يبدأ.',
        cta: 'ابدأ تجربتك المجانية',
      },
      {
        name: 'Silver',
        priceMonthlyUsd: '39',
        priceAnnualUsd: '32',
        priceMonthlyKwd: '12.000',
        priceAnnualKwd: '9.900',
        desc: 'لفريق أكبر ومخزون متعدد المواقع.',
        highlighted: true,
        cta: 'ابدأ تجربتك المجانية',
      },
      {
        name: 'Gold',
        priceMonthlyUsd: '67',
        priceAnnualUsd: '55',
        priceMonthlyKwd: '20.750',
        priceAnnualKwd: '17.000',
        desc: 'للمنشآت اللي تحتاج نظام تشغيل متكامل.',
        cta: 'ابدأ تجربتك المجانية',
      },
      {
        name: 'Enterprise',
        priceMonthlyUsd: '',
        priceAnnualUsd: '',
        priceMonthlyKwd: '',
        priceAnnualKwd: '',
        desc: 'لسلاسل الفروع الكبيرة والاحتياجات الخاصة.',
        contactOnly: true,
        cta: 'تواصل مع المبيعات',
      },
    ],
    featureMatrixTitle: 'قارن بين الباقات',
    featureViewSummaryLabel: 'ملخص الميزات',
    featureViewDetailLabel: 'الميزات بالتفصيل',
    summaryPlusTemplate: 'كل ميزات {tier} بالإضافة إلى:',
    featureMatrix: [
      {
        name: 'نقطة البيع والشفتات',
        rows: [
          { label: 'فتح وإغلاق شفتات', values: [true, true, true, true] },
          { label: 'عدد المواقع (كشك/مستودع)', values: ['موقع واحد', 'حتى 3 مواقع', 'حتى 10 مواقع', 'غير محدود'] },
          { label: 'طرق دفع متعددة (نقد، كي نت، تطبيقات توصيل)', values: [true, true, true, true] },
          { label: 'سجل مبيعات وتقارير الشفت', values: [true, true, true, true] },
        ],
      },
      {
        name: 'المخزون',
        rows: [
          { label: 'تتبع FIFO وتواريخ الصلاحية', values: [true, true, true, true] },
          { label: 'تحويل مخزون بين المواقع', values: [false, true, true, true] },
          { label: 'تنبيهات الحد الأدنى للمخزون', values: [false, true, true, true] },
          { label: 'إدارة مخازن متعددة متقدمة', values: [false, false, true, true] },
        ],
      },
      {
        name: 'الموظفون والرواتب',
        rows: [
          { label: 'عدد الموظفين', values: ['حتى 5', 'حتى 20', 'حتى 50', 'غير محدود'] },
          { label: 'رواتب شهرية أو بالساعة', values: [true, true, true, true] },
          { label: 'خصومات تأخير تلقائية', values: [true, true, true, true] },
          { label: 'طلبات إجازة واستئذان', values: [false, true, true, true] },
        ],
      },
      {
        name: 'المستندات والتراخيص',
        rows: [
          { label: 'مولّد المستندات الرسمية', values: [false, true, true, true] },
          { label: 'حفظ تراخيص وعقود الشركة', values: [false, false, true, true] },
        ],
      },
      {
        name: 'التقارير',
        rows: [
          { label: 'تقارير يومية وشهرية', values: [true, true, true, true] },
          { label: 'تصدير التقارير', values: [false, true, true, true] },
          { label: 'تقارير مخصصة', values: [false, false, false, true] },
        ],
      },
      {
        name: 'الحسابات والدعم',
        rows: [
          { label: 'عدد حسابات الدخول', values: ['حسابين', '5 حسابات', '15 حساب', 'غير محدود'] },
          { label: 'الدعم الفني', values: ['عبر البريد', 'واتساب', 'واتساب مخصص', 'مدير حساب مخصص'] },
        ],
      },
      {
        name: 'حلول الأعمال الكبيرة',
        rows: [
          { label: 'واجهة API للتكامل مع أنظمة أخرى', values: [false, false, false, true] },
          { label: 'تخصيصات حسب طلبك', values: [false, false, false, true] },
        ],
      },
    ],
    pricingNote: 'الأسعار تقريبية بالدينار الكويتي (بحسب سعر الصرف)، والفوترة الفعلية تكون بالدولار الأمريكي.',
    addOnsTitle: 'إضافات لمنشأتك',
    addOnsSubtitle: 'فروع، وقوالب متقدّمة، والمزيد.',
    addOnBilledMonthly: 'شهر',
    addOnBilledAnnual: 'سنة — تُدفع سنويًا',
    addOns: [
      {
        name: 'فرع إضافي',
        desc: 'أضِف فروعاً جديدة لشركتك فوق المتاح في باقتك الحالية.',
        priceMonthlyUsd: '9',
        priceAnnualUsd: '90',
        priceMonthlyKwd: '2.790',
        priceAnnualKwd: '27.900',
      },
      {
        name: 'تخصيصات متقدّمة',
        desc: 'خصّص فواتيرك ومستنداتك باستخدام مصمم القوالب المتقدم.',
        priceMonthlyUsd: '29',
        priceAnnualUsd: '290',
        priceMonthlyKwd: '8.980',
        priceAnnualKwd: '89.800',
      },
      {
        name: 'الاعتراف بالإيرادات',
        desc: 'أنشئ جداول الاعتراف بالإيرادات للإيرادات المؤجلة والدخل.',
        priceMonthlyUsd: '39',
        priceAnnualUsd: '390',
        priceMonthlyKwd: '12.080',
        priceAnnualKwd: '120.800',
      },
    ],
    supportTitle: 'ما وحدك — دعم محلي حقيقي',
    supportSubtitle: 'كلمنا وقت ما تحتاج، بالعربي أو الإنجليزي.',
    supportCards: [
      { title: 'تأهيل مجاني', desc: 'نساعدك تضيف كشكك أو فرعك الأول وتبدأ خلال يوم.', button: 'اطلب تأهيل' },
      { title: 'دعم واتساب', desc: 'راسلنا مباشرة لأي استفسار أو مشكلة تواجهك.', button: 'تواصل واتساب' },
      { title: 'مركز مساعدة', desc: 'أدلة خطوة بخطوة لكل قسم بالنظام.', button: 'تصفح الأدلة' },
    ],
    ctaBanner: {
      title: 'جاهز تبسّط عمليات عملك؟',
      subtitle: 'ابدأ تجربتك المجانية اليوم — بدون بطاقة ائتمان.',
      button: 'ابدأ الآن مجانًا',
    },
    footer: {
      tagline: 'نظام تشغيل متكامل للكشكات والمطاعم والمحلات، مبني خصيصًا للسوق الخليجي.',
      product: 'المنتج',
      resources: 'موارد',
      company: 'الشركة',
      productLinks: ['المميزات', 'القطاعات', 'الأسعار', 'تسجيل الدخول'],
      resourceLinks: ['مركز المساعدة', 'كيف يعمل', 'الأسئلة الشائعة'],
      companyLinks: ['من نحن', 'تواصل معنا', 'الشروط والأحكام', 'سياسة الخصوصية'],
      rights: 'جميع الحقوق محفوظة.',
    },
  },
  en: {
    nav: {
      features: 'Features',
      verticals: 'Industries',
      how: 'How it works',
      pricing: 'Pricing',
      login: 'Log in',
      cta: 'Start free',
    },
    hero: {
      title: 'The all-in-one operating system for your business — from kiosks to storefronts',
      subtitle:
        'Sales, inventory, payroll, and reports — all in one place. Built specifically for kiosk, restaurant, and shop owners in the Gulf.',
      ctaPrimary: 'Start your free trial',
      ctaSecondary: 'See how it works',
      trust: 'Built by an operator, for operators — not a generic app with a translated menu.',
    },
    statsTitle: 'Why macrocore',
    stats: [
      { value: '6', label: 'integrated modules in one system' },
      { value: '2', label: 'full languages — Arabic & English' },
      { value: 'FIFO', label: 'precise, real-time inventory tracking' },
      { value: '14', label: 'day free trial, no card required' },
    ],
    featuresTitle: 'Everything you need, in one place',
    featuresSubtitle: "No spreadsheets, no five different apps — macrocore brings it all together.",
    features: [
      { title: 'POS & shifts', desc: 'Open a shift, record sales, and track every kiosk or branch on its own in real time.' },
      { title: 'FIFO inventory & expiry', desc: 'Know exactly which batch sells first, and get alerted before raw materials expire.' },
      { title: 'Payroll & attendance', desc: 'Monthly or hourly wages, automatic lateness deductions, and itemized adjustments per employee.' },
      { title: 'Documents & licenses', desc: 'Generate official letters and certificates, and store your licenses and contracts with expiry alerts.' },
      { title: 'Daily & monthly reports', desc: 'Profit, cost, and expenses — everything clear at a glance.' },
      { title: 'Multi-location', desc: 'Kiosk, warehouse, more than one site? Each one tracks its own stock and sales.' },
    ],
    deepDives: [
      {
        eyebrow: 'Inventory',
        title: 'Know exactly what you have, before it runs out',
        desc: 'Every raw material batch has a purchase date and an expiry date. The system consumes the oldest batch first (FIFO) automatically, and warns you before anything expires — per location.',
        bullets: ['Automatic FIFO consumption on every sale', 'Alerts before batches expire', 'One-click stock transfer between kiosk and warehouse'],
        mockup: 'inventory',
      },
      {
        eyebrow: 'Payroll',
        title: "Your team's payroll, calculated for you",
        desc: 'Monthly or hourly wages, lateness deductions computed automatically to the minute from real attendance, and any bonus or deduction logged line by line.',
        bullets: ['Automatic deductions from attendance', 'Hourly or monthly wage per employee', 'Itemized adjustments (bonuses, absences, overtime)'],
        mockup: 'payroll',
      },
      {
        eyebrow: 'Reports',
        title: 'Your real profit, every day',
        desc: 'Net profit, cost of goods sold, waste, expenses, and payroll — all calculated automatically and shown daily and monthly, no manual spreadsheets.',
        bullets: ['Daily, monthly, and yearly reports ready instantly', 'Per-product cost calculated from its recipe', 'Stock status and alerts on the same screen'],
        mockup: 'reports',
      },
    ],
    verticalsTitle: 'Built for your business, whatever it is',
    verticalsSubtitle: 'From a single food cart to a chain of branches — the same system grows with you.',
    verticals: [
      { title: 'Food kiosks', desc: 'Track daily sales and raw material stock in real time.' },
      { title: 'Restaurants & cafes', desc: 'Shifts, recipes, and per-dish cost calculated automatically.' },
      { title: 'Retail & boutiques', desc: 'Product inventory, sizes, and instant sales reports.' },
      { title: 'Home businesses', desc: 'Start simple and scale up as your business grows.' },
    ],
    howTitle: 'Get started in three steps',
    howSubtitle: 'No complexity, no technical experience required.',
    steps: [
      { title: 'Register your company', desc: "Minutes and you're ready — no IT team needed." },
      { title: 'Add your team and inventory', desc: 'A simple interface in Arabic and English, step by step.' },
      { title: 'Run and track', desc: 'All your data in one place, anytime, anywhere.' },
    ],
    pricingTitle: 'Clear pricing, no surprises',
    pricingSubtitle: 'Pick the plan that fits your size — every plan starts with a 14-day free trial.',
    billingMonthly: 'Monthly',
    billingAnnual: 'Annual (2 months free)',
    billingSave: 'Save with annual billing',
    annualCallout: 'Pay for 12 months, priced at just 10',
    mostPopular: 'Most popular',
    perMonth: 'month',
    contactSales: 'Contact sales',
    pricingTiers: [
      {
        name: 'Bronze',
        priceMonthlyUsd: '32',
        priceAnnualUsd: '26',
        priceMonthlyKwd: '9.900',
        priceAnnualKwd: '8.000',
        desc: 'For a single kiosk or branch getting started.',
        cta: 'Start your free trial',
      },
      {
        name: 'Silver',
        priceMonthlyUsd: '39',
        priceAnnualUsd: '32',
        priceMonthlyKwd: '12.000',
        priceAnnualKwd: '9.900',
        desc: 'For a bigger team and multi-location inventory.',
        highlighted: true,
        cta: 'Start your free trial',
      },
      {
        name: 'Gold',
        priceMonthlyUsd: '67',
        priceAnnualUsd: '55',
        priceMonthlyKwd: '20.750',
        priceAnnualKwd: '17.000',
        desc: 'For businesses that need a fully integrated operating system.',
        cta: 'Start your free trial',
      },
      {
        name: 'Enterprise',
        priceMonthlyUsd: '',
        priceAnnualUsd: '',
        priceMonthlyKwd: '',
        priceAnnualKwd: '',
        desc: 'For large branch chains and custom needs.',
        contactOnly: true,
        cta: 'Contact sales',
      },
    ],
    featureMatrixTitle: 'Compare plans',
    featureViewSummaryLabel: 'Feature summary',
    featureViewDetailLabel: 'Features in detail',
    summaryPlusTemplate: 'Everything in {tier}, plus:',
    featureMatrix: [
      {
        name: 'POS & shifts',
        rows: [
          { label: 'Open and close shifts', values: [true, true, true, true] },
          { label: 'Number of locations (kiosk/warehouse)', values: ['1 location', 'Up to 3', 'Up to 10', 'Unlimited'] },
          { label: 'Multiple payment methods (cash, KNET, delivery apps)', values: [true, true, true, true] },
          { label: 'Sales log & shift reports', values: [true, true, true, true] },
        ],
      },
      {
        name: 'Inventory',
        rows: [
          { label: 'FIFO tracking & expiry dates', values: [true, true, true, true] },
          { label: 'Stock transfers between locations', values: [false, true, true, true] },
          { label: 'Low-stock alerts', values: [false, true, true, true] },
          { label: 'Advanced multi-warehouse management', values: [false, false, true, true] },
        ],
      },
      {
        name: 'Employees & payroll',
        rows: [
          { label: 'Number of employees', values: ['Up to 5', 'Up to 20', 'Up to 50', 'Unlimited'] },
          { label: 'Monthly or hourly wages', values: [true, true, true, true] },
          { label: 'Automatic lateness deductions', values: [true, true, true, true] },
          { label: 'Leave & permission requests', values: [false, true, true, true] },
        ],
      },
      {
        name: 'Documents & licenses',
        rows: [
          { label: 'Official document generator', values: [false, true, true, true] },
          { label: 'Company license & contract storage', values: [false, false, true, true] },
        ],
      },
      {
        name: 'Reports',
        rows: [
          { label: 'Daily & monthly reports', values: [true, true, true, true] },
          { label: 'Report export', values: [false, true, true, true] },
          { label: 'Custom reports', values: [false, false, false, true] },
        ],
      },
      {
        name: 'Accounts & support',
        rows: [
          { label: 'Login accounts', values: ['2 accounts', '5 accounts', '15 accounts', 'Unlimited'] },
          { label: 'Support', values: ['Email', 'WhatsApp', 'Dedicated WhatsApp', 'Dedicated account manager'] },
        ],
      },
      {
        name: 'Enterprise solutions',
        rows: [
          { label: 'API for integrating with other systems', values: [false, false, false, true] },
          { label: 'Custom requirements', values: [false, false, false, true] },
        ],
      },
    ],
    pricingNote: 'KWD prices are approximate (based on exchange rate) — actual billing is in US Dollars.',
    addOnsTitle: 'Add-ons for your business',
    addOnsSubtitle: 'Branches, advanced templates, and more.',
    addOnBilledMonthly: 'month',
    addOnBilledAnnual: 'year — billed annually',
    addOns: [
      {
        name: 'Extra branch',
        desc: 'Add new branches for your company beyond what your current plan includes.',
        priceMonthlyUsd: '9',
        priceAnnualUsd: '90',
        priceMonthlyKwd: '2.790',
        priceAnnualKwd: '27.900',
      },
      {
        name: 'Advanced customization',
        desc: 'Customize your invoices and documents with the advanced template designer.',
        priceMonthlyUsd: '29',
        priceAnnualUsd: '290',
        priceMonthlyKwd: '8.980',
        priceAnnualKwd: '89.800',
      },
      {
        name: 'Revenue recognition',
        desc: 'Build revenue recognition schedules for deferred revenue and income.',
        priceMonthlyUsd: '39',
        priceAnnualUsd: '390',
        priceMonthlyKwd: '12.080',
        priceAnnualKwd: '120.800',
      },
    ],
    supportTitle: "You're not alone — real local support",
    supportSubtitle: 'Reach us whenever you need to, in Arabic or English.',
    supportCards: [
      { title: 'Free onboarding', desc: "We'll help you set up your first kiosk or branch within a day.", button: 'Request onboarding' },
      { title: 'WhatsApp support', desc: 'Message us directly for any question or issue.', button: 'Chat on WhatsApp' },
      { title: 'Help center', desc: 'Step-by-step guides for every part of the system.', button: 'Browse guides' },
    ],
    ctaBanner: {
      title: 'Ready to simplify your operations?',
      subtitle: 'Start your free trial today — no credit card required.',
      button: 'Start free now',
    },
    footer: {
      tagline: 'The all-in-one operating system for kiosks, restaurants, and shops — built for the Gulf market.',
      product: 'Product',
      resources: 'Resources',
      company: 'Company',
      productLinks: ['Features', 'Industries', 'Pricing', 'Log in'],
      resourceLinks: ['Help center', 'How it works', 'FAQ'],
      companyLinks: ['About us', 'Contact us', 'Terms of service', 'Privacy policy'],
      rights: 'All rights reserved.',
    },
  },
};

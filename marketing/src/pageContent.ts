import type { Lang } from './content';

interface AboutContent {
  title: string;
  intro: string;
  paragraphs: string[];
  missionTitle: string;
  mission: string;
}

interface ContactContent {
  title: string;
  subtitle: string;
  emailLabel: string;
  nameLabel: string;
  messageLabel: string;
  send: string;
  directTitle: string;
  directDesc: string;
}

interface LegalSection {
  heading: string;
  body: string;
  list?: string[];
}

interface LegalContent {
  title: string;
  updated: string;
  disclaimerTitle: string;
  disclaimerBody: string;
  intro: string;
  sections: LegalSection[];
}

interface HelpArticle {
  title: string;
  desc: string;
}

interface HelpContent {
  title: string;
  subtitle: string;
  articles: HelpArticle[];
}

interface FaqItem {
  q: string;
  a: string;
}

interface FaqContent {
  title: string;
  subtitle: string;
  items: FaqItem[];
}

interface PageContent {
  about: AboutContent;
  contact: ContactContent;
  terms: LegalContent;
  privacy: LegalContent;
  help: HelpContent;
  faq: FaqContent;
  backHome: string;
}

export const pageContent: Record<Lang, PageContent> = {
  ar: {
    about: {
      title: 'من نحن',
      intro: 'macrocore نظام تشغيل بناه صاحب مشروع، لأصحاب المشاريع.',
      paragraphs: [
        'بدأت macrocore كحل داخلي لإدارة كشك بيع بالكويت — احتجنا نتابع المبيعات والمخزون والرواتب بمكان واحد، وما لقينا نظام يناسب حجمنا وطريقة شغلنا الفعلية، فبنيناه بأنفسنا.',
        'بعد ما اشتغل النظام معنا وأثبت نفسه بالتشغيل اليومي، قررنا نفتحه لأصحاب المشاريع الثانية اللي يواجهون نفس التحدي: كشكات، مطاعم صغيرة، محلات، ومشاريع منزلية تكبر بسرعة أكثر من قدرة صاحبها على متابعتها يدويًا.',
        'ما إحنا شركة برمجيات كبيرة نبيع نظام عام مترجم — إحنا فريق صغير مبني من عمليات حقيقية، ونطور النظام حسب اللي نشوفه يحتاجه أصحاب المشاريع بالخليج فعليًا.',
      ],
      missionTitle: 'رسالتنا',
      mission: 'نبسّط عمليات المشاريع الصغيرة والمتوسطة بالخليج، بنظام واحد يفهم طريقة شغلهم الحقيقية — مو نسخة معربة من برنامج أجنبي.',
    },
    contact: {
      title: 'تواصل معنا',
      subtitle: 'عندك سؤال أو تبي تجرب النظام؟ راسلنا وبنرد عليك بأسرع وقت.',
      emailLabel: 'البريد الإلكتروني',
      nameLabel: 'الاسم',
      messageLabel: 'رسالتك',
      send: 'إرسال',
      directTitle: 'تواصل مباشر',
      directDesc: 'تقدر تراسلنا مباشرة على:',
    },
    terms: {
      title: 'الشروط والأحكام',
      updated: 'آخر تحديث: ٣١ يوليو ٢٠٢٦',
      disclaimerTitle: 'ملاحظة قانونية مهمة',
      disclaimerBody:
        'هذه الشروط صياغة عامة تغطي أهم جوانب استخدام macrocore، وهي نقطة انطلاق وليست بديلاً عن مراجعة محامٍ مرخّص بدولة الكويت قبل اعتمادها رسميًا أو نشرها للجمهور.',
      intro:
        'يرجى قراءة هذه الشروط والأحكام ("الاتفاقية") بعناية، فهي تشكّل عقدًا بينك أو بين المنشأة التي تمثّلها ("العميل" أو "أنت") وبين macrocore ("نحن")، وتحكم استخدامك لموقع macrocore.io والتطبيقات والخدمات المرتبطة به (يُشار إليها مجتمعة بـ"الخدمات"). بتسجيلك أو اشتراكك أو استخدامك للخدمات بأي شكل، فإنك تقر بأنك قرأت هذه الاتفاقية وفهمتها ووافقت على الالتزام بها. إذا كنت تستخدم الخدمات نيابة عن منشأة أو شركة، فإنك تقر بأن لديك الصلاحية لإلزامها بهذه الشروط.',
      sections: [
        {
          heading: '١. التعريفات',
          body: '"الخدمات" تعني موقع macrocore.io وأي تطبيقات أو واجهات مرتبطة به تُستخدم لتقديم نظام macrocore لإدارة المبيعات والمخزون والرواتب والمستندات. "العميل" يعني الشخص أو المنشأة المسجّلة لاستخدام الخدمات. "بيانات العميل" تعني أي بيانات يُدخلها العميل أو موظفوه في النظام، بما يشمل بيانات المبيعات والمخزون والموظفين والمستندات. "المستخدم المخوّل" يعني أي موظف أو ممثل يمنحه العميل صلاحية الوصول لحسابه.',
        },
        {
          heading: '٢. الأهلية والتسجيل',
          body: 'لاستخدام الخدمات يجب أن يكون عمرك 18 عامًا على الأقل وأن تملك الصلاحية القانونية للتعاقد. بتسجيلك، تقر بأن جميع المعلومات المقدمة صحيحة ومحدّثة. لا يجوز تسجيل أكثر من حساب واحد لنفس المنشأة دون تنسيق معنا، ونحتفظ بالحق في تعليق أي حساب نشك بشكل معقول في مخالفته لهذه الشروط.',
        },
        {
          heading: '٣. نطاق الترخيص',
          body: 'نمنحك، طوال فترة اشتراكك ومقابل التزامك بهذه الشروط وسداد الرسوم المستحقة، ترخيصًا شخصيًا محدودًا غير حصري وغير قابل للتحويل للوصول إلى الخدمات واستخدامها ضمن العمليات الداخلية لمنشأتك فقط. يجوز لك منح موظفيك حسابات فرعية ضمن حسابك، وأنت مسؤول عن كل استخدام يصدر منهم.',
        },
        {
          heading: '٤. حسابات المستخدمين ومسؤوليتك عنها',
          body: 'أنت مسؤول عن الحفاظ على سرية بيانات الدخول الخاصة بحسابك وحسابات موظفيك، وعن كل نشاط يحدث تحت هذه الحسابات. عليك إبلاغنا فورًا عبر hello@macrocore.io عند الاشتباه بأي استخدام غير مصرح به.',
        },
        {
          heading: '٥. الاستخدامات المحظورة',
          body: 'أثناء استخدامك للخدمات، توافق على عدم القيام بأي مما يلي:',
          list: [
            'مشاركة بيانات دخول حسابك مع أطراف خارج منشأتك، أو السماح لغير المخوّلين بالوصول للخدمة',
            'محاولة عكس هندسة النظام أو نسخ شيفرته المصدرية أو استخراج خوارزمياته',
            'إعادة بيع أو ترخيص أو تأجير الوصول للخدمات لطرف ثالث دون إذن كتابي منا',
            'استخدام أي أداة آلية (روبوتات، سكربتات) لاستخراج بيانات من النظام خارج الواجهات المتاحة رسميًا',
            'رفع أي محتوى غير قانوني، أو محاولة تعطيل عمل الخدمة أو خوادمها',
            'انتحال هوية أي جهة أو تقديم معلومات تسجيل غير صحيحة',
          ],
        },
        {
          heading: '٦. بيانات العميل وملكيتها',
          body: 'كل البيانات التي تُدخلها أنت أو موظفوك في النظام (مبيعات، مخزون، موظفين، مستندات، وغيرها) تبقى ملكًا كاملاً لك. نستخدمها فقط لتشغيل الخدمة لصالحك، ولن نبيعها أو نستخدمها لأي غرض تجاري خارج ذلك. يجوز لنا استخدام بيانات مجمّعة وغير معرّفة الهوية (لا يمكن ربطها بمنشأة محددة) لتحسين النظام وتحليل الأداء العام.',
        },
        {
          heading: '٧. الملكية الفكرية لـmacrocore',
          body: 'النظام والشيفرة البرمجية والتصميم والعلامة التجارية "macrocore" وكل ما يتعلق بها من حقوق ملكية فكرية هي ملك حصري لنا أو للجهات المرخِّصة لنا. هذه الاتفاقية لا تمنحك أي حق ملكية في النظام نفسه، فقط حق الاستخدام المحدود الموصوف أعلاه.',
        },
        {
          heading: '٨. الرسوم والدفع',
          body: 'تُعرض أسعار الباقات على موقعنا وتُحتسب بالدولار الأمريكي (USD)، مع عرض ما يعادلها تقريبًا بالدينار الكويتي (KWD) للتوضيح فقط — الفوترة الفعلية والخصم من وسيلة الدفع يتمّان بالدولار الأمريكي. بالاشتراك في باقة مدفوعة، فإنك تخوّلنا بخصم الرسوم تلقائيًا من وسيلة الدفع التي تسجّلها بشكل دوري (شهري أو سنوي حسب اختيارك) حتى تُلغي اشتراكك. عدم سداد المستحقات في موعدها قد يؤدي إلى تعليق وصولك للخدمة بعد إشعار مسبق.',
          list: ['الفوترة الأساسية: بالدولار الأمريكي (USD)', 'القيمة المعروضة بالدينار الكويتي (KWD) تقريبية للاطلاع فقط وتتبع سعر الصرف'],
        },
        {
          heading: '٩. التجربة المجانية والاسترجاع',
          body: 'نوفر تجربة مجانية مدتها 14 يومًا لا تتطلب إدخال بطاقة دفع ولا يُخصم خلالها أي مبلغ. عند انتهاء التجربة، يبدأ الاشتراك المدفوع فقط بعد موافقتك الصريحة وإدخال وسيلة دفع. الرسوم المدفوعة غير قابلة للاسترجاع بشكل عام؛ إلغاء الاشتراك يوقف الفوترة المستقبلية فقط ولا يترتب عليه استرجاع رسوم الفترة الحالية، إلا إذا نص القانون الكويتي المعمول به على خلاف ذلك أو قررنا استثناءً خلاف ذلك وفق تقديرنا.',
        },
        {
          heading: '١٠. الدعم الفني وتوفر الخدمة',
          body: 'نبذل جهودًا معقولة تجاريًا لإتاحة الخدمة وتقديم الدعم الفني عبر البريد الإلكتروني أو واتساب حسب باقتك. قد نجري صيانة مجدولة تؤدي لتوقف مؤقت للخدمة، وسنحاول إشعارك مسبقًا كلما أمكن. لا نضمن أن تعمل الخدمة دون انقطاع أو أخطاء بنسبة 100%.',
        },
        {
          heading: '١١. النسخ الاحتياطي للبيانات',
          body: 'نحتفظ بنسخ احتياطية دورية من قاعدة بيانات النظام كجزء من ممارساتنا التشغيلية، إلا أن هذا لا يغني عن مسؤوليتك في تصدير ومراجعة بياناتك المهمة بشكل دوري من داخل حسابك. لا نتحمل مسؤولية فقدان بيانات ناتج عن أسباب خارجة عن إرادتنا المعقولة.',
        },
        {
          heading: '١٢. السرية',
          body: 'يلتزم كل طرف بالحفاظ على سرية أي معلومات غير علنية يحصل عليها من الطرف الآخر أثناء تنفيذ هذه الاتفاقية، وعدم استخدامها إلا لغرض تنفيذ الخدمة أو الالتزامات المتفق عليها.',
        },
        {
          heading: '١٣. إخلاء الضمانات',
          body: 'تُقدَّم الخدمات "كما هي" و"كما هي متاحة" دون أي ضمانات صريحة أو ضمنية من أي نوع، بما يشمل (دون حصر) ضمانات الملاءمة لغرض معين أو الخلو من الأخطاء. نبذل جهدنا لضمان دقة النظام، لكننا لا نضمن خلوّه التام من الأعطال أو الانقطاعات.',
        },
        {
          heading: '١٤. حدود المسؤولية',
          body: 'إلى أقصى حد يسمح به القانون، لا تتجاوز مسؤوليتنا تجاهك عن أي مطالبة متعلقة بهذه الاتفاقية إجمالي الرسوم التي دفعتها لنا خلال الأشهر الثلاثة السابقة للمطالبة، ولسنا مسؤولين عن أي أضرار غير مباشرة أو تبعية أو خسارة أرباح أو بيانات ناتجة عن استخدام الخدمة أو تعذّر استخدامها.',
        },
        {
          heading: '١٥. التعويض',
          body: 'توافق على تعويضنا وحمايتنا من أي مطالبات أو خسائر أو تكاليف معقولة (بما فيها أتعاب محاماة) ناتجة عن مخالفتك لهذه الشروط، أو استخدامك غير القانوني للخدمة، أو البيانات التي تُدخلها في النظام.',
        },
        {
          heading: '١٦. المدة والإنهاء',
          body: 'تسري هذه الاتفاقية من تاريخ تسجيلك وتستمر تلقائيًا وفق دورة الفوترة المختارة (شهرية أو سنوية) ما دمت ملتزمًا بسداد الرسوم. يجوز لأي طرف إنهاء الاشتراك في أي وقت مع إشعار مسبق قبل نهاية الدورة الحالية. يجوز لنا تعليق أو إنهاء حسابك فورًا في حال مخالفة جوهرية لهذه الشروط أو عدم السداد بعد إشعار.',
        },
        {
          heading: '١٧. الإشعارات',
          body: 'الإشعارات الموجّهة لك تُرسل إلى بريدك الإلكتروني المسجّل بالحساب. الإشعارات الموجّهة لنا تُرسل إلى hello@macrocore.io',
        },
        {
          heading: '١٨. القانون الحاكم وتسوية النزاعات',
          body: 'تخضع هذه الاتفاقية وتُفسَّر وفقًا لقوانين دولة الكويت، وتختص محاكم دولة الكويت وحدها بالفصل في أي نزاع ينشأ عنها أو يتعلق بها.',
        },
        {
          heading: '١٩. أحكام عامة',
          body: 'إذا تبيّن أن أحد بنود هذه الاتفاقية غير قابل للتنفيذ، يبقى باقي الاتفاقية ساريًا. عدم ممارستنا لأي حق لا يعني تنازلنا عنه. لا يجوز لك التنازل عن هذه الاتفاقية لطرف آخر دون موافقتنا الكتابية. نحتفظ بالحق في تعديل هذه الشروط من وقت لآخر، وسننشر أي تعديل جوهري على هذه الصفحة؛ استمرارك باستخدام الخدمة بعد التعديل يُعد موافقة عليه.',
        },
        {
          heading: '٢٠. التواصل',
          body: 'لأي استفسار حول هذه الشروط، راسلنا على hello@macrocore.io',
        },
      ],
    },
    privacy: {
      title: 'سياسة الخصوصية',
      updated: 'آخر تحديث: ٣١ يوليو ٢٠٢٦',
      disclaimerTitle: 'ملاحظة قانونية مهمة',
      disclaimerBody:
        'هذه السياسة صياغة عامة تشرح ممارساتنا الفعلية في التعامل مع البيانات، وهي نقطة انطلاق وليست بديلاً عن مراجعة محامٍ مرخّص بدولة الكويت قبل اعتمادها رسميًا، خصوصًا فيما يخص البيانات الحساسة للموظفين (كالرقم المدني) التي يُدخلها العميل بالنظام.',
      intro:
        'نأخذ خصوصية بياناتك وبيانات موظفيك على محمل الجد. توضح هذه السياسة نوع البيانات التي نجمعها عند استخدامك لخدمات macrocore، وكيف نستخدمها ونحميها، ومتى قد نشاركها مع أطراف أخرى. باستخدامك للخدمات فإنك توافق على هذه السياسة.',
      sections: [
        {
          heading: '١. البيانات التي نجمعها',
          body: 'نجمع نوعين رئيسيين من البيانات:',
          list: [
            'بيانات الحساب: اسمك، بريدك الإلكتروني، رقم هاتفك، واسم منشأتك عند التسجيل',
            'بيانات التشغيل التي تُدخلها في النظام: المبيعات، المخزون، بيانات موظفيك (قد تشمل الاسم، الرقم المدني، تاريخ الميلاد، الراتب، والصور الشخصية إذا رفعتها)، والمستندات الرسمية التي تُنشئها',
            'بيانات تقنية أساسية: نوع المتصفح، عنوان IP، وسجلات الاستخدام، لأغراض الأمان وتحسين الخدمة',
          ],
        },
        {
          heading: '٢. لماذا نجمع بياناتك',
          body: 'نستخدم البيانات للأغراض التالية:',
          list: [
            'تشغيل النظام وتقديم الخدمات المشترك بها',
            'التحقق من هويتك وحماية حسابك من الاستخدام غير المصرح به',
            'تحصيل الرسوم المستحقة',
            'تقديم الدعم الفني والرد على استفساراتك',
            'إرسال تنبيهات تشغيلية مهمة (مثل انتهاء صلاحية مخزون أو ترخيص)',
            'تحسين النظام وتحليل الأداء العام باستخدام بيانات مجمّعة غير معرّفة الهوية',
            'الامتثال لأي التزام قانوني معمول به في دولة الكويت',
          ],
        },
        {
          heading: '٣. بيانات موظفيك (بيانات حسّاسة)',
          body: 'إذا اخترت إدخال بيانات موظفين حسّاسة في النظام (كالرقم المدني أو الراتب)، فأنت تتحمل مسؤولية الحصول على موافقتهم اللازمة لإدخال بياناتهم. نتعامل مع هذه البيانات كوسيط تقني يخزّنها لصالحك فقط، ولا نستخدمها لأي غرض آخر خارج تشغيل الخدمة.',
        },
        {
          heading: '٤. مشاركة البيانات مع أطراف ثالثة',
          body: 'لا نبيع بياناتك لأي جهة. قد نشارك بيانات محدودة مع:',
          list: [
            'مزودي استضافة وبنية تحتية سحابية موثوقين، لتشغيل النظام فقط',
            'مزودي خدمات الدفع، لمعالجة الاشتراكات (لا نخزّن بيانات بطاقتك بأنفسنا)',
            'الجهات الحكومية أو القضائية، فقط إذا كان الإفصاح مطلوبًا قانونًا',
          ],
        },
        {
          heading: '٥. أمن البيانات',
          body: 'نستخدم تشفير الاتصال (HTTPS) لكل عمليات النقل، وعزل بيانات كل منشأة عن غيرها داخل النظام، وضوابط وصول محدودة لفريقنا الداخلي. مع ذلك، لا يوجد نظام آمن بنسبة 100%، ونطلب منك أيضًا الحفاظ على سرية بيانات دخولك.',
        },
        {
          heading: '٦. الاحتفاظ بالبيانات وحذف الحساب',
          body: 'نحتفظ ببياناتك طوال فترة اشتراكك. عند طلبك حذف حسابك، نحذف بياناتك من أنظمتنا التشغيلية خلال مدة معقولة، باستثناء ما قد نحتفظ به للامتثال لالتزام قانوني أو لتسوية نزاع قائم.',
        },
        {
          heading: '٧. حقوقك',
          body: 'يحق لك، بالتواصل معنا على hello@macrocore.io، طلب نسخة من بياناتك، أو تصحيحها، أو حذفها، ضمن الحدود التي يسمح بها القانون المعمول به.',
        },
        {
          heading: '٨. ملفات تعريف الارتباط (Cookies)',
          body: 'نستخدم ملفات تعريف ارتباط أساسية فقط للحفاظ على جلسة تسجيل دخولك وتفضيلاتك (كاللغة)، ولا نستخدم أدوات إعلانات تتبعية.',
        },
        {
          heading: '٩. استخدام الخدمة من قبل القاصرين',
          body: 'خدماتنا مخصصة لأصحاب المنشآت التجارية وموظفيهم البالغين (18 عامًا فأكثر)، وليست موجّهة للاستخدام من قبل الأطفال. إذا علمنا أن حسابًا تم إنشاؤه من قبل قاصر، سنتخذ خطوات معقولة لإغلاقه.',
        },
        {
          heading: '١٠. التغييرات على هذه السياسة',
          body: 'قد نحدّث هذه السياسة من وقت لآخر لتعكس تغييرات في ممارساتنا. سننشر أي تعديل جوهري على هذه الصفحة، ونشجعك على مراجعتها دوريًا.',
        },
        {
          heading: '١١. التواصل',
          body: 'لأي استفسار حول هذه السياسة أو بياناتك، راسلنا على hello@macrocore.io',
        },
      ],
    },
    help: {
      title: 'مركز المساعدة',
      subtitle: 'أدلة سريعة لكل قسم بالنظام — تفاصيل أكثر تتوفر داخل حسابك.',
      articles: [
        { title: 'البدء مع macrocore', desc: 'إعداد شركتك، إضافة أول موقع وموظف، وفتح أول شفت.' },
        { title: 'نقطة البيع والشفتات', desc: 'فتح وإغلاق الشفتات، تسجيل المبيعات، وتخصيص المنتجات لكل شفت.' },
        { title: 'إدارة المخزون FIFO', desc: 'إضافة دفعات مواد خام، فهم آلية الاستهلاك، وتنبيهات الصلاحية.' },
        { title: 'الرواتب والحضور', desc: 'إعداد نوع الأجر لكل موظف، وفهم حسبة خصم التأخير.' },
        { title: 'التقارير المالية', desc: 'قراءة التقرير اليومي والشهري، وفهم كل رقم فيه.' },
        { title: 'المستندات والتراخيص', desc: 'توليد خطابات رسمية، ورفع تراخيص الشركة مع تنبيهات الانتهاء.' },
      ],
    },
    faq: {
      title: 'الأسئلة الشائعة',
      subtitle: 'ما لقيت جوابك؟ راسلنا على hello@macrocore.io',
      items: [
        { q: 'هل أحتاج خبرة تقنية عشان أستخدم macrocore؟', a: 'لا، النظام مصمم يكون بسيط لأي صاحب مشروع أو موظف، بدون حاجة لفريق تقني.' },
        { q: 'هل النظام يدعم أكثر من فرع أو كشك؟', a: 'إي، تقدر تضيف عدد غير محدود من المواقع (كشكات ومستودعات) وكل واحد يتابع مخزونه ومبيعاته لحاله.' },
        { q: 'وش يصير لبياناتي لو سويت تجربة مجانية وما كملت؟', a: 'بياناتك تبقى محفوظة بحسابك، وتقدر تكمل أو تمسحها بأي وقت.' },
        { q: 'هل تقدرون تساعدوني أنقل بياناتي من نظام ثاني؟', a: 'إي، تواصل معنا وبنساعدك تنقل بياناتك (مواد خام، منتجات، موظفين) لـmacrocore.' },
        { q: 'هل النظام يشتغل بالعربي والإنجليزي؟', a: 'إي، النظام كامل بلغتين وتقدر تبدّل بينهم بأي وقت.' },
      ],
    },
    backHome: 'رجوع للرئيسية',
  },
  en: {
    about: {
      title: 'About us',
      intro: 'macrocore is an operating system built by an operator, for operators.',
      paragraphs: [
        "macrocore started as an in-house solution to manage a food kiosk in Kuwait — we needed to track sales, inventory, and payroll in one place, and couldn't find a system that fit our size and the way we actually worked, so we built it ourselves.",
        'After it proved itself running our own daily operations, we decided to open it up to other business owners facing the same challenge: kiosks, small restaurants, shops, and home businesses growing faster than their owner can track by hand.',
        "We're not a large software company selling a generic translated app — we're a small team built out of real operations, shaping the product around what business owners in the Gulf actually need.",
      ],
      missionTitle: 'Our mission',
      mission: 'To simplify operations for small and medium businesses in the Gulf, with one system that understands how they actually work — not a translated copy of a foreign app.',
    },
    contact: {
      title: 'Contact us',
      subtitle: "Have a question or want to try the system? Send us a message and we'll get back to you quickly.",
      emailLabel: 'Email',
      nameLabel: 'Name',
      messageLabel: 'Your message',
      send: 'Send',
      directTitle: 'Reach us directly',
      directDesc: 'You can also email us at:',
    },
    terms: {
      title: 'Terms of Service',
      updated: 'Last updated: July 31, 2026',
      disclaimerTitle: 'Important legal note',
      disclaimerBody:
        'These terms are a general-purpose draft covering the main aspects of using macrocore. They are a starting point, not a substitute for review by a lawyer licensed in Kuwait before formal adoption or public use.',
      intro:
        'Please read these Terms of Service ("Agreement") carefully — they form a contract between you or the business you represent ("Customer" or "you") and macrocore ("we"), and govern your use of macrocore.io and any related apps and services (collectively, the "Services"). By registering, subscribing, or otherwise using the Services, you acknowledge that you have read, understood, and agree to be bound by this Agreement. If you are using the Services on behalf of a business, you represent that you have the authority to bind that business to these terms.',
      sections: [
        {
          heading: '1. Definitions',
          body: '"Services" means macrocore.io and any related apps or interfaces used to deliver the macrocore system for managing sales, inventory, payroll, and documents. "Customer" means the person or business registered to use the Services. "Customer Data" means any data the Customer or its employees enter into the system, including sales, inventory, employee, and document data. "Authorized User" means any employee or representative the Customer grants access to its account.',
        },
        {
          heading: '2. Eligibility & registration',
          body: 'To use the Services you must be at least 18 years old and have the legal capacity to contract. By registering, you represent that all information provided is accurate and up to date. You may not register more than one account for the same business without coordinating with us, and we reserve the right to suspend any account we reasonably suspect of violating these terms.',
        },
        {
          heading: '3. Scope of license',
          body: 'For the duration of your subscription, and subject to your compliance with these terms and payment of applicable fees, we grant you a limited, personal, non-exclusive, non-transferable license to access and use the Services solely for your business’s internal operations. You may grant your employees sub-accounts under your account, and you remain responsible for all use by them.',
        },
        {
          heading: '4. User accounts & your responsibility',
          body: 'You are responsible for keeping your login credentials and those of your employees confidential, and for all activity under those accounts. Notify us immediately at hello@macrocore.io if you suspect any unauthorized use.',
        },
        {
          heading: '5. Prohibited uses',
          body: 'While using the Services, you agree not to:',
          list: [
            'Share your account credentials with anyone outside your business, or allow unauthorized parties to access the Service',
            'Attempt to reverse-engineer the system, copy its source code, or extract its algorithms',
            'Resell, sublicense, or rent access to the Services to a third party without our written permission',
            'Use any automated tool (bots, scripts) to extract data from the system outside the officially available interfaces',
            'Upload unlawful content, or attempt to disrupt the Service or its servers',
            'Impersonate any person or entity, or provide false registration information',
          ],
        },
        {
          heading: '6. Customer data & ownership',
          body: 'All data you or your employees enter into the system (sales, inventory, employees, documents, and more) remains entirely your property. We use it only to operate the Service on your behalf, and will not sell it or use it for any other commercial purpose. We may use aggregated, de-identified data (which cannot be tied to a specific business) to improve the system and analyze overall performance.',
        },
        {
          heading: '7. macrocore’s intellectual property',
          body: 'The system, its source code, design, and the "macrocore" brand, along with all related intellectual property rights, are exclusively owned by us or our licensors. This Agreement grants you no ownership right in the system itself — only the limited right of use described above.',
        },
        {
          heading: '8. Fees & payment',
          body: 'Plan prices are published on our site and calculated in US Dollars (USD), with an approximate Kuwaiti Dinar (KWD) equivalent shown for reference only — actual billing and charges to your payment method are in US Dollars. By subscribing to a paid plan, you authorize us to automatically charge fees to your registered payment method on a recurring basis (monthly or annual, as you choose) until you cancel. Non-payment may result in suspended access after prior notice.',
          list: ['Primary billing: US Dollars (USD)', 'The KWD figure shown is an approximate reference and follows the exchange rate'],
        },
        {
          heading: '9. Free trial & refunds',
          body: 'We offer a 14-day free trial that requires no payment card and incurs no charge. Paid billing only begins after the trial ends and after your explicit consent and entry of a payment method. Fees paid are generally non-refundable; cancelling your subscription stops future billing only and does not entitle you to a refund for the current billing period, unless otherwise required by applicable Kuwaiti law or unless we decide otherwise at our discretion.',
        },
        {
          heading: '10. Support & service availability',
          body: 'We make commercially reasonable efforts to keep the Service available and to provide technical support by email or WhatsApp depending on your plan. We may schedule maintenance that temporarily interrupts the Service and will try to notify you in advance when possible. We do not guarantee the Service will be 100% uninterrupted or error-free.',
        },
        {
          heading: '11. Data backups',
          body: 'We maintain periodic backups of the system database as part of our operational practices, but this does not replace your own responsibility to export and review your important data periodically from within your account. We are not liable for data loss resulting from causes reasonably beyond our control.',
        },
        {
          heading: '12. Confidentiality',
          body: 'Each party agrees to keep confidential any non-public information it receives from the other party in the course of this Agreement, and to use it only to perform the Service or the obligations agreed upon.',
        },
        {
          heading: '13. Disclaimer of warranties',
          body: 'The Services are provided "as is" and "as available" without any express or implied warranties of any kind, including (without limitation) fitness for a particular purpose or error-free operation. We work to keep the system accurate, but we do not warrant it will be entirely free of faults or interruptions.',
        },
        {
          heading: '14. Limitation of liability',
          body: 'To the maximum extent permitted by law, our liability to you for any claim relating to this Agreement will not exceed the total fees you paid us in the three months preceding the claim, and we are not liable for any indirect or consequential damages or loss of profit or data resulting from use of, or inability to use, the Service.',
        },
        {
          heading: '15. Indemnification',
          body: 'You agree to defend, indemnify, and hold us harmless from any claims, losses, or reasonable costs (including legal fees) arising from your breach of these terms, your unlawful use of the Service, or the data you enter into the system.',
        },
        {
          heading: '16. Term & termination',
          body: 'This Agreement takes effect from your registration date and automatically continues on your chosen billing cycle (monthly or annual) as long as you keep paying applicable fees. Either party may cancel the subscription at any time with notice before the end of the current cycle. We may suspend or terminate your account immediately for a material breach of these terms or non-payment after notice.',
        },
        {
          heading: '17. Notices',
          body: 'Notices to you will be sent to the email address registered on your account. Notices to us should be sent to hello@macrocore.io',
        },
        {
          heading: '18. Governing law & dispute resolution',
          body: 'This Agreement is governed by and construed in accordance with the laws of the State of Kuwait, and the courts of Kuwait shall have exclusive jurisdiction over any dispute arising from or relating to it.',
        },
        {
          heading: '19. General provisions',
          body: 'If any provision of this Agreement is found unenforceable, the rest of the Agreement remains in effect. Our failure to exercise any right does not waive it. You may not assign this Agreement to another party without our written consent. We reserve the right to amend these terms from time to time, and will post any material change on this page; your continued use of the Service after a change constitutes acceptance of it.',
        },
        {
          heading: '20. Contact',
          body: 'For any question about these terms, email us at hello@macrocore.io',
        },
      ],
    },
    privacy: {
      title: 'Privacy Policy',
      updated: 'Last updated: July 31, 2026',
      disclaimerTitle: 'Important legal note',
      disclaimerBody:
        'This policy is a general-purpose draft describing our actual data practices. It is a starting point, not a substitute for review by a lawyer licensed in Kuwait before formal adoption — especially regarding sensitive employee data (such as Civil ID numbers) that a Customer enters into the system.',
      intro:
        'We take the privacy of your data and your employees’ data seriously. This policy explains what data we collect when you use macrocore’s Services, how we use and protect it, and when we may share it with others. By using the Services, you agree to this policy.',
      sections: [
        {
          heading: '1. Data we collect',
          body: 'We collect two main types of data:',
          list: [
            'Account data: your name, email, phone number, and business name at registration',
            'Operational data you enter into the system: sales, inventory, employee data (which may include names, Civil ID numbers, dates of birth, wages, and photos if uploaded), and the official documents you generate',
            'Basic technical data: browser type, IP address, and usage logs, for security and service improvement',
          ],
        },
        {
          heading: '2. Why we collect your data',
          body: 'We use this data for the following purposes:',
          list: [
            'Operating the system and delivering the Services you subscribe to',
            'Verifying your identity and protecting your account from unauthorized use',
            'Collecting fees owed',
            'Providing technical support and responding to your questions',
            'Sending important operational alerts (such as expiring stock or an expiring license)',
            'Improving the system and analyzing overall performance using aggregated, de-identified data',
            'Complying with any applicable legal obligation in the State of Kuwait',
          ],
        },
        {
          heading: '3. Your employees’ data (sensitive data)',
          body: 'If you choose to enter sensitive employee data into the system (such as Civil ID numbers or wages), you are responsible for obtaining any necessary consent from them to enter their data. We treat this data as a technical intermediary that stores it solely on your behalf, and we do not use it for any purpose beyond operating the Service.',
        },
        {
          heading: '4. Sharing data with third parties',
          body: 'We do not sell your data to anyone. We may share limited data with:',
          list: [
            'Trusted cloud hosting and infrastructure providers, solely to operate the system',
            'Payment service providers, to process subscriptions (we do not store your card details ourselves)',
            'Government or judicial authorities, only when disclosure is legally required',
          ],
        },
        {
          heading: '5. Data security',
          body: 'We use encrypted connections (HTTPS) for all data in transit, isolate each business’s data from others within the system, and apply limited access controls for our internal team. That said, no system is 100% secure, and we also ask you to keep your login credentials confidential.',
        },
        {
          heading: '6. Data retention & account deletion',
          body: 'We retain your data for the duration of your subscription. When you request account deletion, we delete your data from our operational systems within a reasonable period, except for data we may retain to comply with a legal obligation or resolve an ongoing dispute.',
        },
        {
          heading: '7. Your rights',
          body: 'You may contact us at hello@macrocore.io to request a copy of your data, its correction, or its deletion, within the limits permitted by applicable law.',
        },
        {
          heading: '8. Cookies',
          body: 'We use only essential cookies to maintain your login session and preferences (such as language), and do not use tracking advertisements.',
        },
        {
          heading: '9. Use of the Service by minors',
          body: 'Our Services are intended for business owners and their adult employees (18 and older), and are not directed at children. If we learn that an account was created by a minor, we will take reasonable steps to close it.',
        },
        {
          heading: '10. Changes to this policy',
          body: 'We may update this policy from time to time to reflect changes in our practices. We will post any material change on this page, and encourage you to review it periodically.',
        },
        {
          heading: '11. Contact',
          body: 'For any question about this policy or your data, email us at hello@macrocore.io',
        },
      ],
    },
    help: {
      title: 'Help Center',
      subtitle: 'Quick guides for every part of the system — more detail is available inside your account.',
      articles: [
        { title: 'Getting started with macrocore', desc: 'Set up your company, add your first location and employee, and open your first shift.' },
        { title: 'POS & shifts', desc: 'Opening and closing shifts, recording sales, and assigning products per shift.' },
        { title: 'FIFO inventory management', desc: 'Adding raw material batches, how consumption works, and expiry alerts.' },
        { title: 'Payroll & attendance', desc: "Setting each employee's wage type, and understanding the lateness deduction calculation." },
        { title: 'Financial reports', desc: 'Reading daily and monthly reports, and understanding every number in them.' },
        { title: 'Documents & licenses', desc: 'Generating official letters, and uploading company licenses with expiry alerts.' },
      ],
    },
    faq: {
      title: 'Frequently Asked Questions',
      subtitle: "Didn't find your answer? Email us at hello@macrocore.io",
      items: [
        { q: 'Do I need technical experience to use macrocore?', a: 'No, the system is designed to be simple for any business owner or employee, no IT team required.' },
        { q: 'Does the system support more than one branch or kiosk?', a: 'Yes, you can add an unlimited number of locations (kiosks and warehouses), each tracking its own stock and sales.' },
        { q: "What happens to my data if I start a free trial and don't continue?", a: 'Your data stays saved in your account, and you can continue or delete it anytime.' },
        { q: 'Can you help me migrate my data from another system?', a: 'Yes, contact us and we’ll help you migrate your data (raw materials, products, employees) to macrocore.' },
        { q: 'Does the system work in Arabic and English?', a: 'Yes, the system is fully bilingual and you can switch anytime.' },
      ],
    },
    backHome: 'Back to home',
  },
};

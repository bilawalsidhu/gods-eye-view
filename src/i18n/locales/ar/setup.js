// Arabic (ar, Modern Standard Arabic) catalog — setup namespace.
// Same keys and order as en/setup.js; values only are translated.
export const NAMESPACE = 'setup';

export default {
  'firstRun.kicker': 'مركز التحكم · أول تشغيل',
  'firstRun.title': 'اختر عرضك الأول',
  'firstRun.choice.contacts': 'الأهداف الحية',
  'firstRun.suppress': 'لا تعرض هذا مرة أخرى',
  'keySetup.chip': 'تشغيل',
  'keySetup.kicker': 'المحطة الأرضية · إعدادات المزوّدين',
  'keySetup.title': 'شغّل الكرة الأرضية',
  'keySetup.apply': 'حفظ المفاتيح',
  'keySetup.status.saving': 'جارٍ الحفظ…',

  'firstRun.description':
    'يبدو الأمر كقمرة قيادة محظورة—ثم تدرك أن المصادر عامة والبيانات حقيقية.',
  'firstRun.choice.contactsSub': 'طائرات وسفن ومعلومات استخباراتية قريبة',
  'firstRun.choice.spaceMissions': 'المهام الفضائية',
  'firstRun.choice.spaceMissionsSub': 'عمليات إطلاق ومركبات وسياق مداري',
  'firstRun.choice.explore': 'استكشاف يدوي',
  'firstRun.choice.exploreSub': 'ابدأ بكرة أرضية نظيفة',
  'firstRun.dismissHint': 'اضغط ESC للإغلاق',
  'firstRun.note':
    'نصيحة: زر GEV MIC في الشريط السفلي يتيح لك التحدث إلى الخريطة.',

  'keySetup.closeAriaLabel': 'إغلاق إعداد المفاتيح',
  'keySetup.description':
    'تعمل الكرة الأرضية بلا مفاتيح أصلًا. كل مفتاح أدناه يفعّل مصدرًا حقيقيًا إضافيًا: الصق مفتاحًا فيُحفظ في إعدادات هذا التطبيق المحلية، ثم يعيد الخادم تشغيل نفسه. تبقى مفاتيح الخادم على هذا الجهاز، أما Google Maps وCesium ion فتعملان في المتصفح ويجب تقييدهما بحسب المزوّد. المفاتيح التي أعددتها في مكان آخر تظهر دون أن تُمَسّ.',
  'keySetup.hint': 'اضغط ESC للإغلاق',
  'keySetup.note':
    'مفتاح Google Maps يمنحك الكوكب الواقعي، وكل ما سواه يُضاف فوقه.',

  'scenes.panelTitle': 'المشاهد',
  'scenes.collapseTitle': 'طي اللوحة',
  'scenes.recipeAriaLabel': 'قالب المشهد',
  'scenes.new': 'جديد',
  'scenes.delete': 'حذف',
  'scenes.capture': 'التقاط لقطة',
  'scenes.updateShot': 'تحديث اللقطة',
  'scenes.start': 'بدء',
  'scenes.stop': 'إيقاف',
  'scenes.next': 'التالي',
  'scenes.exportPresets': 'تصدير الإعدادات المسبقة',
  'scenes.import': 'استيراد',
  'scenes.runLog': 'سجل التشغيل',
  'scenes.statusReady': 'جاهز',

  'firstRun.busy.contacts': 'جارٍ تشغيل الأهداف الحية…',
  'firstRun.busy.spaceMissions': 'جارٍ فتح المهام الفضائية…',
  'firstRun.busy.environmental': 'جارٍ مسح الأحداث النشطة…',
  'firstRun.busy.working': 'جارٍ العمل…',
  'firstRun.status.failed':
    'تعذّر فتح تلك المهمة{detail}. أعد المحاولة أو استكشف يدويًا.',
  'firstRun.status.storageBlocked':
    'هذا المتصفح يحظر التخزين، لذا تعذّر الحفظ.',
  'firstRun.choice.environmentalSub': 'زلازل وحرائق نشطة حية، من USGS وNASA',
  'firstRun.environmentalTitle.environmental': 'البيئة',
  'firstRun.environmentalTitle.earthWatch': 'مراقبة الأرض',
  'firstRun.environmentalTitle.activeEvents': 'الأحداث النشطة',

  'keySetup.chipWaiting': {
    zero: 'تشغيل · لا مفاتيح في الانتظار ({count})',
    one: 'تشغيل · مفتاح واحد في الانتظار ({count})',
    two: 'تشغيل · مفتاحان في الانتظار ({count})',
    few: 'تشغيل · {count} مفاتيح في الانتظار',
    many: 'تشغيل · {count} مفتاحًا في الانتظار',
    other: 'تشغيل · {count} مفتاح في الانتظار',
  },
  'keySetup.chipReady': 'تم التشغيل',
  'keySetup.status.saveFailed': 'فشل الحفظ ({status}).',
  'keySetup.status.saveFailedDetail': 'فشل الحفظ: {detail}',
  'keySetup.status.pasteFirst': 'الصق مفتاحًا واحدًا على الأقل أولًا.',
  'keySetup.status.saved':
    'تم الحفظ في {store}. جارٍ إعادة التشغيل — ستُحمَّل هذه الصفحة من جديد تلقائيًا.',
  'keySetup.status.removed':
    'تمت الإزالة من {store}. جارٍ إعادة التشغيل — ستُحمَّل هذه الصفحة من جديد تلقائيًا.',
  'keySetup.store.pinokio': 'إعدادات التطبيق لديك',
  'keySetup.store.env': 'ملف .env المحلي لديك',
  'keySetup.confirm.remove': 'إزالة هذا المفتاح من إعداداتك المحفوظة؟',

  'mapStack.fallbackName': 'حزمة الخرائط هذه',
  'mapStack.unavailableReason': '{label} غير متاحة',
  'mapStack.unavailableAriaLabel': '{label} غير متاحة: {hint}',

  'scenes.recipe.flightsRadar': 'رادار الرحلات العالمي',
  'scenes.recipe.orbitalWatch': 'المراقبة المدارية',
  'scenes.recipe.thermalThreats': 'لوحة التهديدات الحرارية',
  'scenes.recipe.cityOverload': 'ازدحام المدينة',
  'scenes.recipe.omnisciencePullback': 'الإطلالة الشاملة',

  'voice.status.idle': 'متوقف',
  'voice.status.connecting': 'جارٍ الاتصال',
  'voice.status.listening': 'جارٍ الاستماع',
  'voice.status.executing': 'جارٍ التنفيذ',
  'voice.status.error': 'خطأ',
  'voice.status.sessionCostCap': 'انتهت الجلسة — بلغت حد التكلفة {cost}',
  'voice.detail.standby': 'الصوت في وضع الاستعداد',
  'voice.detail.active': 'الصوت نشط',
  'voice.detail.unavailable': 'الصوت غير متاح',
  'voice.detail.microphoneUnavailable': 'دعم ميكروفون WebRTC غير متاح',
  'voice.detail.requestingMicrophone': 'جارٍ طلب الميكروفون',
  'voice.detail.holdSpaceTalk': 'اضغط مطولًا على Space للتحدث',
  'voice.detail.releaseSpaceSend': 'حرّر Space للإرسال',
  'voice.detail.askOrCommand': 'اسأل أو أصدر أمرًا',
  'voice.detail.voiceOff': 'الصوت متوقف',
  'voice.detail.runningCommand': 'جارٍ تنفيذ الأمر',
  'voice.detail.radioDidNotStart': 'لم يبدأ الراديو',
  'voice.hint.default':
    'اضغط مطولًا على Space للتحدث · اضغط Space مرة واحدة لتفعيل العنصر المحدد',
  'voice.error.sessionStart': 'تعذّر بدء الجلسة الصوتية.',
  'voice.error.trayTitle': 'خطأ في النظام الصوتي',
  'voice.error.dismiss': 'تجاهل',
  'voice.error.hint':
    'تحقق من إذن الميكروفون والاتصال بالشبكة، ثم أعد المحاولة.',
  'voice.kicker.agent': 'وكيل ذكاء اصطناعي',
  'voice.kicker.control': 'التحكم الصوتي',
  'voice.tier.appliesNextSession': '{tier} يسري في الجلسة التالية',
  'voice.tier.buttonTitle': 'فئة النموذج الصوتي — تسري في الجلسة التالية',
  'voice.cost.buttonTitle': 'التكلفة التقديرية للجلسة',
  'voice.button.ariaLabel':
    'التحكم الصوتي — فعّله لتشغيل الصوت أو إيقافه، واضغط مطولًا على Space للتحدث',

  'scenes.status.captureCameraNotReady':
    'تعذّر التقاط اللقطة: الكاميرا غير جاهزة',
  'scenes.status.shotTitleDefault': 'لقطة {n}',
  'scenes.status.captured': 'تم الالتقاط: {scene} / {shot}',
  'scenes.status.selectShotFirst': 'اختر لقطة أولًا',
  'scenes.status.updated': 'تم التحديث: {scene} / {shot}',
  'scenes.status.deleteShotConfirm': 'حذف اللقطة "{shot}"؟',
  'scenes.status.loaded': 'تم التحميل: {scene} / {shot}',
  'scenes.status.cameraUnavailable':
    'الكاميرا غير متاحة — اخرج من قمرة القيادة أولًا',
  'scenes.status.noShotsToRun': 'لا توجد لقطات للتشغيل',
  'scenes.status.runningShot': 'جارٍ التشغيل {index}/{total}: {scene} / {shot}',
  'scenes.status.runComplete': 'اكتمل تشغيل المشهد',
  'scenes.status.runError': 'خطأ: {message}',
  'scenes.status.contextExitFailed':
    'تعذّر الخروج من {mode} — قد تُرفض طبقات المشهد',

  'keySetup.row.remove': 'إزالة',
  'keySetup.row.removeTitle': 'إزالة {title} من مفاتيح هذا التطبيق المحفوظة',
  'keySetup.requirement': 'يحتاج إلى {envVars} — أضفه في إعدادات المزوّدين',
  'keySetup.unlocks.google-maps':
    'الكوكب ثلاثي الأبعاد الواقعي + البحث عن الأماكن',
  'keySetup.unlocks.google-maps-server':
    'سياق الأماكن + بديل Street View؛ مفتاح منفصل اختياري',
  'keySetup.unlocks.openai': 'التحكم الصوتي — تحدّث إلى الكوكب',
  'keySetup.unlocks.aisstream': 'السفن الحية حول العالم',
  'keySetup.unlocks.firms': 'رصد الحرائق النشطة مباشرة',
  'keySetup.unlocks.tomtom': 'حركة مرور حية حقيقية (بدون مفتاح تُعرض محاكاة)',
  'keySetup.unlocks.cesium-ion': 'حزم خرائط صور Bing + تضاريس العالم',
  'keySetup.unlocks.opensky':
    'رصيد أكبر لاستعلام الرحلات (يعمل دونه بصفة مجهولة)',
  'keySetup.unlocks.launch-library': 'حد أعلى لطلبات المهام الفضائية',

  'scenes.status.actionFailed': 'فشل إجراء المشهد',

  'scenes.status.projectExported': 'تم تصدير المشروع',

  'voice.tierNextSession':
    'الجلسة التالية: {pendingId} — تبقى هذه الجلسة على {modelId}',
  'voice.tierSwitchHint':
    'النموذج الصوتي: {pendingId} — انقر للتبديل إلى {target}؛ يسري في الجلسة التالية',
  'voice.costTooltip':
    'التكلفة التقديرية للجلسة على {modelId} — عدد الاستجابات: {responses}. تنبيه عند {warn}، وتنتهي الجلسة عند {cap}.',
};

// What Team asks before a recorded Routine can become a card (ADR-0101), in every interface language. An answer sent in
// any language closes the question, so the chat matches it in each and keeps every language's words loaded.
export const routineQuestionMessages = {
  en: {
    schedule: {
      question: 'How often should this Routine run?',
      answers: ['Every 30 seconds', 'Every hour', 'Every day at 09:00'],
    },
    output: {
      question: 'What should this Routine do with each run\'s result?',
      answers: ['Show every run', 'Show only when it changes', 'Don\'t show'],
    },
    overBudget: {
      question: 'This Team\'s daily Action budget fits this Routine at most every {seconds} seconds. How often should it run?',
      answer: 'Every {seconds} seconds',
    },
    ambiguous: {
      question: 'More than one item matches. Which one should this Routine use?',
      option: '{label} ({value})',
    },
    rerun: {
      question: 'To become a Routine, this work must run again. Should the assistant run it again?',
      answers: ['Run it again'],
    },
  },
  pt: {
    schedule: {
      question: 'Com que frequência esta rotina deve rodar?',
      answers: ['A cada 30 segundos', 'A cada hora', 'Todo dia às 09:00'],
    },
    output: {
      question: 'O que esta rotina deve fazer com o resultado de cada execução?',
      answers: [
        'Mostrar em todas as execuções',
        'Mostrar somente quando mudar',
        'Não mostrar',
      ],
    },
    overBudget: {
      question: 'O orçamento diário de Actions desta equipe comporta esta rotina no máximo a cada {seconds} segundos. Com que frequência ela deve rodar?',
      answer: 'A cada {seconds} segundos',
    },
    ambiguous: {
      question: 'Mais de um item corresponde. Qual deles esta rotina deve usar?',
      option: '{label} ({value})',
    },
    rerun: {
      question: 'Para virar uma rotina, este trabalho precisa rodar de novo. O assistente deve executá-lo de novo?',
      answers: ['Executar de novo'],
    },
  },
  es: {
    schedule: {
      question: '¿Con qué frecuencia debe ejecutarse esta rutina?',
      answers: ['Cada 30 segundos', 'Cada hora', 'Todos los días a las 09:00'],
    },
    output: {
      question: '¿Qué debe hacer esta rutina con el resultado de cada ejecución?',
      answers: ['Mostrar en cada ejecución', 'Mostrar solo cuando cambie', 'No mostrar'],
    },
    overBudget: {
      question: 'El presupuesto diario de Actions de este equipo admite esta rutina como máximo cada {seconds} segundos. ¿Con qué frecuencia debe ejecutarse?',
      answer: 'Cada {seconds} segundos',
    },
    ambiguous: {
      question: 'Coincide más de un elemento. ¿Cuál debe usar esta rutina?',
      option: '{label} ({value})',
    },
    rerun: {
      question: 'Para convertirse en una rutina, este trabajo debe ejecutarse de nuevo. ¿Debe el asistente ejecutarlo de nuevo?',
      answers: ['Ejecutar de nuevo'],
    },
  },
  zh: {
    schedule: {
      question: '这个例行任务应多久运行一次？',
      answers: ['每 30 秒', '每小时', '每天 09:00'],
    },
    output: {
      question: '这个例行任务每次运行的结果应如何处理？',
      answers: ['每次运行都显示', '仅在变化时显示', '不显示'],
    },
    overBudget: {
      question: '该团队每日的 Action 预算最多允许这个例行任务每 {seconds} 秒运行一次。它应多久运行一次？',
      answer: '每 {seconds} 秒',
    },
    ambiguous: {
      question: '有多个项目匹配。这个例行任务应使用哪一个？',
      option: '{label}（{value}）',
    },
    rerun: {
      question: '要成为例行任务，这项工作需要重新运行。要让助手重新运行它吗？',
      answers: ['重新运行'],
    },
  },
  fr: {
    schedule: {
      question: 'À quelle fréquence cette routine doit-elle s’exécuter ?',
      answers: ['Toutes les 30 secondes', 'Toutes les heures', 'Tous les jours à 09:00'],
    },
    output: {
      question: 'Que doit faire cette routine du résultat de chaque exécution ?',
      answers: [
        'Afficher à chaque exécution',
        'Afficher seulement en cas de changement',
        'Ne pas afficher',
      ],
    },
    overBudget: {
      question: 'Le budget quotidien d’Actions de cette équipe permet cette routine au plus toutes les {seconds} secondes. À quelle fréquence doit-elle s’exécuter ?',
      answer: 'Toutes les {seconds} secondes',
    },
    ambiguous: {
      question: 'Plusieurs éléments correspondent. Lequel cette routine doit-elle utiliser ?',
      option: '{label} ({value})',
    },
    rerun: {
      question: 'Pour devenir une routine, ce travail doit être exécuté de nouveau. L’assistant doit-il l’exécuter de nouveau ?',
      answers: ['Exécuter de nouveau'],
    },
  },
  de: {
    schedule: {
      question: 'Wie oft soll diese Routine laufen?',
      answers: ['Alle 30 Sekunden', 'Jede Stunde', 'Jeden Tag um 09:00'],
    },
    output: {
      question: 'Was soll diese Routine mit dem Ergebnis jedes Laufs tun?',
      answers: [
        'Bei jedem Lauf anzeigen',
        'Nur bei Änderung anzeigen',
        'Nicht anzeigen',
      ],
    },
    overBudget: {
      question: 'Das tägliche Action-Budget dieses Teams erlaubt diese Routine höchstens alle {seconds} Sekunden. Wie oft soll sie laufen?',
      answer: 'Alle {seconds} Sekunden',
    },
    ambiguous: {
      question: 'Mehr als ein Element passt. Welches soll diese Routine verwenden?',
      option: '{label} ({value})',
    },
    rerun: {
      question: 'Damit daraus eine Routine wird, muss diese Arbeit erneut laufen. Soll der Assistent sie erneut ausführen?',
      answers: ['Erneut ausführen'],
    },
  },
  ja: {
    schedule: {
      question: 'このルーチンはどのくらいの頻度で実行しますか？',
      answers: ['30 秒ごと', '1 時間ごと', '毎日 09:00'],
    },
    output: {
      question: 'このルーチンは各実行の結果をどう扱いますか？',
      answers: ['毎回表示する', '変更時のみ表示する', '表示しない'],
    },
    overBudget: {
      question: 'このチームの 1 日の Action 予算では、このルーチンは最短で {seconds} 秒ごとにしか実行できません。どのくらいの頻度で実行しますか？',
      answer: '{seconds} 秒ごと',
    },
    ambiguous: {
      question: '複数の項目が一致します。このルーチンはどれを使いますか？',
      option: '{label}（{value}）',
    },
    rerun: {
      question: 'ルーティンにするには、この作業をもう一度実行する必要があります。アシスタントにもう一度実行させますか？',
      answers: ['もう一度実行する'],
    },
  },
  ar: {
    schedule: {
      question: 'كم مرة يجب أن يعمل هذا الروتين؟',
      answers: ['كل 30 ثانية', 'كل ساعة', 'كل يوم الساعة 09:00'],
    },
    output: {
      question: 'ماذا يجب أن يفعل هذا الروتين بنتيجة كل تشغيل؟',
      answers: ['اعرض في كل تشغيل', 'اعرض فقط عند التغيير', 'لا تعرض'],
    },
    overBudget: {
      question: 'تسمح ميزانية Actions اليومية لهذا الفريق بتشغيل هذا الروتين مرة كل {seconds} ثانية على الأكثر. كم مرة يجب أن يعمل؟',
      answer: 'كل {seconds} ثانية',
    },
    ambiguous: {
      question: 'يطابق أكثر من عنصر. أيها يجب أن يستخدم هذا الروتين؟',
      option: '{label} ({value})',
    },
    rerun: {
      question: 'ليصبح هذا العمل روتينًا، يجب تشغيله مجددًا. هل يشغّله المساعد مجددًا؟',
      answers: ['التشغيل مجددًا'],
    },
  },
};

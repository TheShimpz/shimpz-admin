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
      answers: ['Show every run', 'Show only when it changes', 'Don\'t show', 'Use it in other Actions'],
    },
    overBudget: {
      question: 'This Team\'s daily Action budget fits this Routine at most every {seconds} seconds. How often should it run?',
      answer: 'Every {seconds} seconds',
    },
    ambiguous: {
      question: 'More than one item matches. Which one should this Routine use?',
      option: '{label} ({value})',
    },
    unsourced: {
      question: 'The assistant used a value it did not look up in this conversation. Should it look it up again?',
      answers: ['Look it up again'],
    },
    split: {
      question: 'The work was split across several messages. Should the assistant run all of it again in one message?',
      answers: ['Run it all again'],
    },
    rerun: {
      question: 'The chosen item differs from what the work used. Should the assistant run the work again with it?',
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
        'Usar em outras ações',
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
    unsourced: {
      question: 'O assistente usou um valor que não consultou nesta conversa. Ele deve consultá-lo de novo?',
      answers: ['Consultar de novo'],
    },
    split: {
      question: 'O trabalho ficou dividido em várias mensagens. O assistente deve executá-lo todo de novo em uma mensagem?',
      answers: ['Executar tudo de novo'],
    },
    rerun: {
      question: 'O item escolhido é diferente do que o trabalho usou. O assistente deve executar o trabalho de novo com ele?',
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
      answers: ['Mostrar en cada ejecución', 'Mostrar solo cuando cambie', 'No mostrar', 'Usar en otras acciones'],
    },
    overBudget: {
      question: 'El presupuesto diario de Actions de este equipo admite esta rutina como máximo cada {seconds} segundos. ¿Con qué frecuencia debe ejecutarse?',
      answer: 'Cada {seconds} segundos',
    },
    ambiguous: {
      question: 'Coincide más de un elemento. ¿Cuál debe usar esta rutina?',
      option: '{label} ({value})',
    },
    unsourced: {
      question: 'El asistente usó un valor que no consultó en esta conversación. ¿Debe consultarlo de nuevo?',
      answers: ['Consultar de nuevo'],
    },
    split: {
      question: 'El trabajo quedó dividido en varios mensajes. ¿Debe el asistente ejecutarlo todo de nuevo en un mensaje?',
      answers: ['Ejecutar todo de nuevo'],
    },
    rerun: {
      question: 'El elemento elegido es distinto del que usó el trabajo. ¿Debe el asistente ejecutar el trabajo de nuevo con él?',
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
      answers: ['每次运行都显示', '仅在变化时显示', '不显示', '用于其他操作'],
    },
    overBudget: {
      question: '该团队每日的 Action 预算最多允许这个例行任务每 {seconds} 秒运行一次。它应多久运行一次？',
      answer: '每 {seconds} 秒',
    },
    ambiguous: {
      question: '有多个项目匹配。这个例行任务应使用哪一个？',
      option: '{label}（{value}）',
    },
    unsourced: {
      question: '助手使用了一个未在本次对话中查询的值。要让它重新查询吗？',
      answers: ['重新查询'],
    },
    split: {
      question: '这项工作分散在多条消息中。要让助手在一条消息中重新运行全部工作吗？',
      answers: ['全部重新运行'],
    },
    rerun: {
      question: '所选项目与工作使用的不同。要让助手用它重新运行这项工作吗？',
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
        'Utiliser dans d\'autres actions',
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
    unsourced: {
      question: 'L’assistant a utilisé une valeur qu’il n’a pas consultée dans cette conversation. Doit-il la consulter de nouveau ?',
      answers: ['La consulter de nouveau'],
    },
    split: {
      question: 'Le travail a été réparti sur plusieurs messages. L’assistant doit-il tout exécuter de nouveau en un seul message ?',
      answers: ['Tout exécuter de nouveau'],
    },
    rerun: {
      question: 'L’élément choisi diffère de celui utilisé par le travail. L’assistant doit-il exécuter le travail de nouveau avec lui ?',
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
        'In anderen Aktionen verwenden',
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
    unsourced: {
      question: 'Der Assistent hat einen Wert verwendet, den er in diesem Gespräch nicht abgefragt hat. Soll er ihn erneut abfragen?',
      answers: ['Erneut abfragen'],
    },
    split: {
      question: 'Die Arbeit war auf mehrere Nachrichten verteilt. Soll der Assistent alles erneut in einer Nachricht ausführen?',
      answers: ['Alles erneut ausführen'],
    },
    rerun: {
      question: 'Das gewählte Element unterscheidet sich von dem, das die Arbeit verwendet hat. Soll der Assistent die Arbeit damit erneut ausführen?',
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
      answers: ['毎回表示する', '変更時のみ表示する', '表示しない', '他のアクションで使う'],
    },
    overBudget: {
      question: 'このチームの 1 日の Action 予算では、このルーチンは最短で {seconds} 秒ごとにしか実行できません。どのくらいの頻度で実行しますか？',
      answer: '{seconds} 秒ごと',
    },
    ambiguous: {
      question: '複数の項目が一致します。このルーチンはどれを使いますか？',
      option: '{label}（{value}）',
    },
    unsourced: {
      question: 'アシスタントはこの会話で調べていない値を使いました。もう一度調べますか？',
      answers: ['もう一度調べる'],
    },
    split: {
      question: '作業が複数のメッセージに分かれています。アシスタントに 1 つのメッセージですべてもう一度実行させますか？',
      answers: ['すべてもう一度実行する'],
    },
    rerun: {
      question: '選んだ項目は作業で使われたものと異なります。アシスタントにそれで作業をもう一度実行させますか？',
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
      answers: ['اعرض في كل تشغيل', 'اعرض فقط عند التغيير', 'لا تعرض', 'استخدمه في إجراءات أخرى'],
    },
    overBudget: {
      question: 'تسمح ميزانية Actions اليومية لهذا الفريق بتشغيل هذا الروتين مرة كل {seconds} ثانية على الأكثر. كم مرة يجب أن يعمل؟',
      answer: 'كل {seconds} ثانية',
    },
    ambiguous: {
      question: 'يطابق أكثر من عنصر. أيها يجب أن يستخدم هذا الروتين؟',
      option: '{label} ({value})',
    },
    unsourced: {
      question: 'استخدم المساعد قيمة لم يبحث عنها في هذه المحادثة. هل يبحث عنها مجددًا؟',
      answers: ['البحث مجددًا'],
    },
    split: {
      question: 'انقسم العمل على عدة رسائل. هل يشغّل المساعد العمل كله مجددًا في رسالة واحدة؟',
      answers: ['تشغيل الكل مجددًا'],
    },
    rerun: {
      question: 'العنصر المختار يختلف عما استخدمه العمل. هل يشغّل المساعد العمل مجددًا به؟',
      answers: ['التشغيل مجددًا'],
    },
  },
};

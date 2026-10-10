// The Supervisor's own sign-in security (ADR-0051): refused second-factor attempts reported after sign-in.

export const securityMessages = {
  en: {
    alertTitle: 'Failed sign-in attempts',
    alertMessage: 'Second-factor codes refused since your previous sign-in: {count}. If you didn’t enter them, someone may know your Supervisor password.',
    acknowledge: 'Acknowledge',
    acknowledging: 'Saving…',
    acknowledgeFailed: 'The acknowledgment couldn’t be saved. Try again.',
  },
  pt: {
    alertTitle: 'Tentativas de entrada com falha',
    alertMessage: 'Códigos do segundo fator recusados desde a sua entrada anterior: {count}. Se não foi você, alguém pode saber a sua senha do Supervisor.',
    acknowledge: 'Estou ciente',
    acknowledging: 'Salvando…',
    acknowledgeFailed: 'Não foi possível salvar a confirmação. Tente novamente.',
  },
  es: {
    alertTitle: 'Intentos de inicio de sesión fallidos',
    alertMessage: 'Códigos del segundo factor rechazados desde tu inicio de sesión anterior: {count}. Si no fuiste tú, alguien podría conocer tu contraseña de Supervisor.',
    acknowledge: 'Entendido',
    acknowledging: 'Guardando…',
    acknowledgeFailed: 'No se pudo guardar la confirmación. Inténtalo de nuevo.',
  },
  zh: {
    alertTitle: '登录失败尝试',
    alertMessage: '自上次登录以来被拒绝的第二因素验证码：{count}。如果不是你输入的，可能有人知道你的 Supervisor 密码。',
    acknowledge: '我已知晓',
    acknowledging: '正在保存…',
    acknowledgeFailed: '无法保存确认。请重试。',
  },
  fr: {
    alertTitle: 'Tentatives de connexion échouées',
    alertMessage: 'Codes du second facteur refusés depuis votre connexion précédente : {count}. Si ce n’était pas vous, quelqu’un connaît peut-être votre mot de passe de Supervisor.',
    acknowledge: 'J’ai compris',
    acknowledging: 'Enregistrement…',
    acknowledgeFailed: 'Impossible d’enregistrer la confirmation. Réessayez.',
  },
  de: {
    alertTitle: 'Fehlgeschlagene Anmeldeversuche',
    alertMessage: 'Seit deiner vorherigen Anmeldung abgelehnte Codes des zweiten Faktors: {count}. Wenn du sie nicht eingegeben hast, kennt jemand vielleicht dein Supervisor-Passwort.',
    acknowledge: 'Zur Kenntnis genommen',
    acknowledging: 'Wird gespeichert…',
    acknowledgeFailed: 'Die Bestätigung konnte nicht gespeichert werden. Versuche es erneut.',
  },
  ja: {
    alertTitle: 'サインインの失敗',
    alertMessage: '前回のサインイン以降に拒否された 2 要素目のコード: {count}。入力した覚えがない場合は、誰かが Supervisor のパスワードを知っている可能性があります。',
    acknowledge: '確認しました',
    acknowledging: '保存中…',
    acknowledgeFailed: '確認を保存できませんでした。もう一度お試しください。',
  },
  ar: {
    alertTitle: 'محاولات تسجيل دخول فاشلة',
    alertMessage: 'رموز العامل الثاني المرفوضة منذ تسجيل دخولك السابق: {count}. إذا لم تُدخلها أنت، فقد يعرف شخص ما كلمة مرور Supervisor الخاصة بك.',
    acknowledge: 'تم الاطلاع',
    acknowledging: 'جارٍ الحفظ…',
    acknowledgeFailed: 'تعذّر حفظ التأكيد. حاول مرة أخرى.',
  },
};

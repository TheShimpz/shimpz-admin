//! Platform guidance in every interface language: attachments never install or remove an Assistant, a missing
//! capability is installed only from an attachment-free request (ADR-0093), and an Assistant whose binding the current
//! contract refuses has no card to confirm, so the chat never removes it and never proposes another in its place.

/// Each platform guidance code and its reply per interface language.
const PLATFORM_GUIDANCE: [(&str, [(&str, &str); 8]); 3] = [
    (
        "assistant-lifecycle-attachments",
        [
            (
                "ar",
                "لا يمكن استخدام المرفقات لتثبيت المساعدين أو إزالتهم. أرسل هذا الطلب مرة أخرى بدون مرفقات.",
            ),
            (
                "de",
                "Anhänge können nicht zum Installieren oder Entfernen von Assistenten verwendet werden. Sende diese Anfrage erneut ohne Anhänge.",
            ),
            (
                "en",
                "Attachments can't be used to install or remove Assistants. Send that request again without attachments.",
            ),
            (
                "es",
                "Los adjuntos no pueden usarse para instalar o quitar Asistentes. Envía esa solicitud de nuevo sin adjuntos.",
            ),
            (
                "fr",
                "Les pièces jointes ne peuvent pas servir à installer ou retirer des Assistants. Renvoyez cette demande sans pièces jointes.",
            ),
            (
                "ja",
                "添付ファイルを使ってアシスタントをインストールまたは削除することはできません。添付ファイルなしでもう一度送信してください。",
            ),
            (
                "pt",
                "Anexos não podem ser usados para instalar ou remover Assistentes. Envie esse pedido de novo sem anexos.",
            ),
            (
                "zh",
                "附件不能用于安装或移除助手。请不带附件重新发送该请求。",
            ),
        ],
    ),
    (
        "assistant-capability-attachments",
        [
            (
                "ar",
                "تحتاج هذه المهمة إلى مساعد لم يُثبَّت بعد. لتثبيته، أرسل الطلب مرة أخرى بدون مرفقات.",
            ),
            (
                "de",
                "Für diese Aufgabe wird ein Assistent benötigt, der noch nicht installiert ist. Sende die Anfrage zum Installieren erneut ohne Anhänge.",
            ),
            (
                "en",
                "This task needs an Assistant that isn't installed yet. To install it, send the request again without attachments.",
            ),
            (
                "es",
                "Esta tarea necesita un Asistente que aún no está instalado. Para instalarlo, envía la solicitud de nuevo sin adjuntos.",
            ),
            (
                "fr",
                "Cette tâche nécessite un Assistant qui n'est pas encore installé. Pour l'installer, renvoyez la demande sans pièces jointes.",
            ),
            (
                "ja",
                "このタスクには、まだインストールされていないアシスタントが必要です。インストールするには、添付ファイルなしでもう一度送信してください。",
            ),
            (
                "pt",
                "Esta tarefa precisa de um Assistente que ainda não está instalado. Para instalá-lo, envie o pedido de novo sem anexos.",
            ),
            (
                "zh",
                "此任务需要一个尚未安装的助手。如需安装，请不带附件重新发送该请求。",
            ),
        ],
    ),
    (
        "assistant-uninstall-replacement",
        [
            (
                "ar",
                "يحتاج هذا المساعد إلى الاستبدال، لذا لا يمكن إزالته من المحادثة. ألغِ تثبيته من صفحته في المتجر.",
            ),
            (
                "de",
                "Dieser Assistent muss ersetzt werden und kann daher nicht im Chat entfernt werden. Deinstalliere ihn auf seiner Seite im Store.",
            ),
            (
                "en",
                "This Assistant needs to be replaced, so it can't be removed from the chat. Uninstall it from its Store page.",
            ),
            (
                "es",
                "Este Asistente necesita reemplazarse, así que no puede quitarse desde el chat. Desinstálalo desde su página en la Tienda.",
            ),
            (
                "fr",
                "Cet Assistant doit être remplacé, il ne peut donc pas être retiré depuis la conversation. Désinstallez-le depuis sa page dans la Boutique.",
            ),
            (
                "ja",
                "このアシスタントは置き換えが必要なため、チャットからは削除できません。ストアのページからアンインストールしてください。",
            ),
            (
                "pt",
                "Este Assistente precisa ser substituído, então não pode ser removido pela conversa. Desinstale-o na página dele na Loja.",
            ),
            (
                "zh",
                "此助手需要替换，因此无法在对话中移除。请在商店中的助手页面将其卸载。",
            ),
        ],
    ),
];

/// One guidance reply the turn ends with.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Guidance {
    /// Its closed code.
    pub code: &'static str,
    /// Its reply.
    pub reply: String,
}

/// The platform guidance `code` in `locale`.
#[must_use]
pub fn platform(code: &'static str, locale: &str) -> Option<Guidance> {
    let (_, replies) = PLATFORM_GUIDANCE.iter().find(|(known, _)| *known == code)?;
    let (_, reply) = replies.iter().find(|(language, _)| *language == locale)?;
    Some(Guidance {
        code,
        reply: (*reply).to_owned(),
    })
}

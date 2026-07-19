<script>
  import { goto } from '$app/navigation';
  import { page } from '$app/state';

  import AssistantIcon from '$lib/AssistantIcon.svelte';
  import { locale } from '$lib/i18n.js';
  import { modelContext, selectTeamBrain } from '$lib/modelContext.js';
  import {
    createTeam,
    deleteTeam,
    MAX_SELECTED_ASSISTANTS,
    selectAllTeamAssistants,
    selectOnlyTeamAssistant,
    teamContext,
    toggleTeamAssistant,
    unselectAllTeamAssistants,
  } from '$lib/teamContext.js';

  let { disabled = false } = $props();

  const COPY = {
    en: {
      contextAria: 'Chat context',
      team: 'Team', noTeam: 'Create Team', teamTitle: 'Choose a Team', teamLead: 'Change the private workspace for this conversation.',
      teamKicker: 'Team // context', addTeam: 'Add Team', createKicker: 'Team // initialize', createTitle: 'Create a Team', createLead: 'Give this isolated local workspace a clear name.',
      teamName: 'Team name', teamPlaceholder: 'Marketing', create: 'Create Team', creating: 'Creating…', createFailed: 'The Team could not be created.',
      deleteTeam: 'Delete', deleteTeamNamed: 'Delete {name}', deleteKicker: 'Team // delete', deleteTitle: 'Delete Team', deleteLead: 'This permanently deletes {name} and its local data. Type the exact Team name and enter your current Admin password.', deleteName: 'Confirm Team name', deleteNamePlaceholder: 'Type {name}', adminPassword: 'Admin password', passwordPlaceholder: 'Enter your current password', deleteAction: 'Delete Team', deleting: 'Deleting…', deleteFailed: 'The Team could not be deleted.',
      brain: 'Brain', brainKicker: 'Brain // context', brainTitle: 'Choose a Brain', brainLead: 'Select the model that coordinates this Team.', modelLoading: 'Loading model settings…', modelFailed: 'Brain settings could not be updated.',
      assistants: 'Assistants', assistantTitle: 'Choose Assistants', assistantLead: 'Only selected Assistants can lend Powers to the next turns.',
      assistantKicker: 'Assistants // context', assistantEmpty: 'No running Assistants are available in this Team.', selectAll: 'Select all', selectMaximum: 'Select first {limit}', unselectAll: 'Unselect all', onlyThis: 'Only this', onlyThisNamed: 'Use only {name}',
      selectionLimit: 'This chat can use up to {limit} Assistants at once.', selected: '{selected} of {total}', selectedLimited: '{selected} of {total} · max {limit}', current: 'Current', close: 'Close', cancel: 'Cancel',
    },
    pt: {
      contextAria: 'Contexto do chat',
      team: 'Time', noTeam: 'Criar Time', teamTitle: 'Escolha um Time', teamLead: 'Troque o ambiente privado desta conversa.',
      teamKicker: 'Time // contexto', addTeam: 'Adicionar Time', createKicker: 'Time // inicializar', createTitle: 'Criar um Time', createLead: 'Dê um nome claro para este ambiente local isolado.',
      teamName: 'Nome do Time', teamPlaceholder: 'Marketing', create: 'Criar Time', creating: 'Criando…', createFailed: 'Não foi possível criar o Time.',
      deleteTeam: 'Excluir', deleteTeamNamed: 'Excluir {name}', deleteKicker: 'Time // excluir', deleteTitle: 'Excluir Time', deleteLead: 'Isso exclui permanentemente {name} e seus dados locais. Digite o nome exato do Time e informe a senha atual do Admin.', deleteName: 'Confirme o nome do Time', deleteNamePlaceholder: 'Digite {name}', adminPassword: 'Senha do Admin', passwordPlaceholder: 'Digite sua senha atual', deleteAction: 'Excluir Time', deleting: 'Excluindo…', deleteFailed: 'Não foi possível excluir o Time.',
      brain: 'Brain', brainKicker: 'Brain // contexto', brainTitle: 'Escolha um Brain', brainLead: 'Selecione o modelo que coordena este Time.', modelLoading: 'Carregando modelos…', modelFailed: 'Não foi possível atualizar o Brain.',
      assistants: 'Assistants', assistantTitle: 'Escolha os Assistants', assistantLead: 'Somente os Assistants selecionados podem fornecer Powers nos próximos turnos.',
      assistantKicker: 'Assistants // contexto', assistantEmpty: 'Nenhum Assistant em execução está disponível neste Time.', selectAll: 'Selecionar todos', selectMaximum: 'Selecionar os primeiros {limit}', unselectAll: 'Desmarcar todos', onlyThis: 'Somente este', onlyThisNamed: 'Usar somente {name}',
      selectionLimit: 'Este chat pode usar até {limit} Assistants por vez.', selected: '{selected} de {total}', selectedLimited: '{selected} de {total} · máximo {limit}', current: 'Atual', close: 'Fechar', cancel: 'Cancelar',
    },
    es: {
      contextAria: 'Contexto del chat', team: 'Equipo', noTeam: 'Crear Equipo', teamKicker: 'Equipo // contexto', teamTitle: 'Elige un Equipo', teamLead: 'Cambia el espacio privado de esta conversación.',
      addTeam: 'Añadir Equipo', createKicker: 'Equipo // iniciar', createTitle: 'Crear un Equipo', createLead: 'Ponle un nombre claro a este espacio local aislado.', teamName: 'Nombre del Equipo', teamPlaceholder: 'Marketing', create: 'Crear Equipo', creating: 'Creando…', createFailed: 'No se pudo crear el Equipo.',
      deleteTeam: 'Eliminar', deleteTeamNamed: 'Eliminar {name}', deleteKicker: 'Equipo // eliminar', deleteTitle: 'Eliminar Equipo', deleteLead: 'Esto elimina permanentemente {name} y sus datos locales. Escribe el nombre exacto del Equipo e introduce la contraseña actual del Admin.', deleteName: 'Confirma el nombre del Equipo', deleteNamePlaceholder: 'Escribe {name}', adminPassword: 'Contraseña del Admin', passwordPlaceholder: 'Introduce tu contraseña actual', deleteAction: 'Eliminar Equipo', deleting: 'Eliminando…', deleteFailed: 'No se pudo eliminar el Equipo.',
      brain: 'Brain', brainKicker: 'Brain // contexto', brainTitle: 'Elige un Brain', brainLead: 'Selecciona el modelo que coordina este Equipo.', modelLoading: 'Cargando modelos…', modelFailed: 'No se pudo actualizar el Brain.',
      assistants: 'Assistants', assistantKicker: 'Assistants // contexto', assistantTitle: 'Elige Assistants', assistantLead: 'Solo los Assistants seleccionados pueden aportar Powers en los próximos turnos.', assistantEmpty: 'No hay Assistants en ejecución en este Equipo.', selectAll: 'Seleccionar todos', selectMaximum: 'Seleccionar los primeros {limit}', unselectAll: 'Deseleccionar todos', onlyThis: 'Solo este', onlyThisNamed: 'Usar solo {name}', selectionLimit: 'Este chat puede usar hasta {limit} Assistants a la vez.', selected: '{selected} de {total}', selectedLimited: '{selected} de {total} · máximo {limit}', current: 'Actual', close: 'Cerrar', cancel: 'Cancelar',
    },
    zh: {
      contextAria: '聊天上下文', team: '团队', noTeam: '创建团队', teamKicker: '团队 // 上下文', teamTitle: '选择团队', teamLead: '切换此对话的私有工作区。',
      addTeam: '添加团队', createKicker: '团队 // 初始化', createTitle: '创建团队', createLead: '为这个隔离的本地工作区起一个清晰的名称。', teamName: '团队名称', teamPlaceholder: '营销', create: '创建团队', creating: '正在创建…', createFailed: '无法创建团队。',
      deleteTeam: '删除', deleteTeamNamed: '删除 {name}', deleteKicker: '团队 // 删除', deleteTitle: '删除团队', deleteLead: '这会永久删除 {name} 及其本地数据。请输入完全一致的团队名称和当前管理员密码。', deleteName: '确认团队名称', deleteNamePlaceholder: '输入 {name}', adminPassword: '管理员密码', passwordPlaceholder: '输入当前密码', deleteAction: '删除团队', deleting: '正在删除…', deleteFailed: '无法删除团队。',
      brain: 'Brain', brainKicker: 'Brain // 上下文', brainTitle: '选择 Brain', brainLead: '选择协调此团队的模型。', modelLoading: '正在加载模型…', modelFailed: '无法更新 Brain 设置。',
      assistants: 'Assistants', assistantKicker: 'Assistants // 上下文', assistantTitle: '选择 Assistants', assistantLead: '只有选中的 Assistants 能在后续对话中提供 Powers。', assistantEmpty: '此团队没有正在运行的 Assistant。', selectAll: '全选', selectMaximum: '选择前 {limit} 个', unselectAll: '全部取消', onlyThis: '仅此项', onlyThisNamed: '仅使用 {name}', selectionLimit: '此聊天一次最多可使用 {limit} 个 Assistants。', selected: '已选 {selected}/{total}', selectedLimited: '已选 {selected}/{total} · 上限 {limit}', current: '当前', close: '关闭', cancel: '取消',
    },
    fr: {
      contextAria: 'Contexte du chat', team: 'Équipe', noTeam: 'Créer une Équipe', teamKicker: 'Équipe // contexte', teamTitle: 'Choisir une Équipe', teamLead: 'Changez l’espace privé de cette conversation.',
      addTeam: 'Ajouter une Équipe', createKicker: 'Équipe // initialiser', createTitle: 'Créer une Équipe', createLead: 'Donnez un nom clair à cet espace local isolé.', teamName: 'Nom de l’Équipe', teamPlaceholder: 'Marketing', create: 'Créer l’Équipe', creating: 'Création…', createFailed: 'Impossible de créer l’Équipe.',
      deleteTeam: 'Supprimer', deleteTeamNamed: 'Supprimer {name}', deleteKicker: 'Équipe // supprimer', deleteTitle: 'Supprimer l’Équipe', deleteLead: 'Cette action supprime définitivement {name} et ses données locales. Saisissez le nom exact de l’Équipe et le mot de passe Admin actuel.', deleteName: 'Confirmer le nom de l’Équipe', deleteNamePlaceholder: 'Saisissez {name}', adminPassword: 'Mot de passe Admin', passwordPlaceholder: 'Saisissez votre mot de passe actuel', deleteAction: 'Supprimer l’Équipe', deleting: 'Suppression…', deleteFailed: 'Impossible de supprimer l’Équipe.',
      brain: 'Brain', brainKicker: 'Brain // contexte', brainTitle: 'Choisir un Brain', brainLead: 'Sélectionnez le modèle qui coordonne cette Équipe.', modelLoading: 'Chargement des modèles…', modelFailed: 'Impossible de mettre à jour le Brain.',
      assistants: 'Assistants', assistantKicker: 'Assistants // contexte', assistantTitle: 'Choisir les Assistants', assistantLead: 'Seuls les Assistants sélectionnés peuvent fournir des Powers aux prochains tours.', assistantEmpty: 'Aucun Assistant en cours d’exécution dans cette Équipe.', selectAll: 'Tout sélectionner', selectMaximum: 'Sélectionner les {limit} premiers', unselectAll: 'Tout désélectionner', onlyThis: 'Seulement celui-ci', onlyThisNamed: 'Utiliser uniquement {name}', selectionLimit: 'Ce chat peut utiliser jusqu’à {limit} Assistants à la fois.', selected: '{selected} sur {total}', selectedLimited: '{selected} sur {total} · maximum {limit}', current: 'Actuel', close: 'Fermer', cancel: 'Annuler',
    },
    de: {
      contextAria: 'Chat-Kontext', team: 'Team', noTeam: 'Team erstellen', teamKicker: 'Team // Kontext', teamTitle: 'Team auswählen', teamLead: 'Wechsle den privaten Arbeitsbereich für dieses Gespräch.',
      addTeam: 'Team hinzufügen', createKicker: 'Team // initialisieren', createTitle: 'Team erstellen', createLead: 'Gib diesem isolierten lokalen Arbeitsbereich einen eindeutigen Namen.', teamName: 'Teamname', teamPlaceholder: 'Marketing', create: 'Team erstellen', creating: 'Wird erstellt…', createFailed: 'Das Team konnte nicht erstellt werden.',
      deleteTeam: 'Löschen', deleteTeamNamed: '{name} löschen', deleteKicker: 'Team // löschen', deleteTitle: 'Team löschen', deleteLead: 'Dadurch werden {name} und seine lokalen Daten dauerhaft gelöscht. Gib den exakten Teamnamen und dein aktuelles Admin-Passwort ein.', deleteName: 'Teamnamen bestätigen', deleteNamePlaceholder: '{name} eingeben', adminPassword: 'Admin-Passwort', passwordPlaceholder: 'Aktuelles Passwort eingeben', deleteAction: 'Team löschen', deleting: 'Wird gelöscht…', deleteFailed: 'Das Team konnte nicht gelöscht werden.',
      brain: 'Brain', brainKicker: 'Brain // Kontext', brainTitle: 'Brain auswählen', brainLead: 'Wähle das Modell, das dieses Team koordiniert.', modelLoading: 'Modelle werden geladen…', modelFailed: 'Das Brain konnte nicht aktualisiert werden.',
      assistants: 'Assistants', assistantKicker: 'Assistants // Kontext', assistantTitle: 'Assistants auswählen', assistantLead: 'Nur ausgewählte Assistants können in den nächsten Runden Powers bereitstellen.', assistantEmpty: 'In diesem Team sind keine Assistants aktiv.', selectAll: 'Alle auswählen', selectMaximum: 'Die ersten {limit} auswählen', unselectAll: 'Alle abwählen', onlyThis: 'Nur diesen', onlyThisNamed: 'Nur {name} verwenden', selectionLimit: 'Dieser Chat kann höchstens {limit} Assistants gleichzeitig verwenden.', selected: '{selected} von {total}', selectedLimited: '{selected} von {total} · maximal {limit}', current: 'Aktuell', close: 'Schließen', cancel: 'Abbrechen',
    },
    ja: {
      contextAria: 'チャットのコンテキスト', team: 'チーム', noTeam: 'チームを作成', teamKicker: 'チーム // コンテキスト', teamTitle: 'チームを選択', teamLead: 'この会話のプライベートワークスペースを切り替えます。',
      addTeam: 'チームを追加', createKicker: 'チーム // 初期化', createTitle: 'チームを作成', createLead: 'この分離されたローカルワークスペースに分かりやすい名前を付けます。', teamName: 'チーム名', teamPlaceholder: 'マーケティング', create: 'チームを作成', creating: '作成中…', createFailed: 'チームを作成できませんでした。',
      deleteTeam: '削除', deleteTeamNamed: '{name} を削除', deleteKicker: 'チーム // 削除', deleteTitle: 'チームを削除', deleteLead: '{name} とローカルデータを完全に削除します。正確なチーム名と現在の管理者パスワードを入力してください。', deleteName: 'チーム名を確認', deleteNamePlaceholder: '{name} と入力', adminPassword: '管理者パスワード', passwordPlaceholder: '現在のパスワードを入力', deleteAction: 'チームを削除', deleting: '削除中…', deleteFailed: 'チームを削除できませんでした。',
      brain: 'Brain', brainKicker: 'Brain // コンテキスト', brainTitle: 'Brain を選択', brainLead: 'このチームを調整するモデルを選択します。', modelLoading: 'モデルを読み込み中…', modelFailed: 'Brain を更新できませんでした。',
      assistants: 'Assistants', assistantKicker: 'Assistants // コンテキスト', assistantTitle: 'Assistants を選択', assistantLead: '選択した Assistants だけが次のターンで Powers を提供できます。', assistantEmpty: 'このチームで実行中の Assistant はありません。', selectAll: 'すべて選択', selectMaximum: '先頭の {limit} 件を選択', unselectAll: 'すべて解除', onlyThis: 'これだけ', onlyThisNamed: '{name} のみ使用', selectionLimit: 'このチャットでは一度に最大 {limit} 個の Assistants を使用できます。', selected: '{total} 件中 {selected} 件', selectedLimited: '{total} 件中 {selected} 件 · 上限 {limit}', current: '現在', close: '閉じる', cancel: 'キャンセル',
    },
    ar: {
      contextAria: 'سياق المحادثة', team: 'الفريق', noTeam: 'إنشاء فريق', teamKicker: 'الفريق // السياق', teamTitle: 'اختر فريقًا', teamLead: 'غيّر مساحة العمل الخاصة بهذه المحادثة.',
      addTeam: 'إضافة فريق', createKicker: 'الفريق // التهيئة', createTitle: 'إنشاء فريق', createLead: 'امنح مساحة العمل المحلية المعزولة اسمًا واضحًا.', teamName: 'اسم الفريق', teamPlaceholder: 'التسويق', create: 'إنشاء الفريق', creating: 'جارٍ الإنشاء…', createFailed: 'تعذر إنشاء الفريق.',
      deleteTeam: 'حذف', deleteTeamNamed: 'حذف {name}', deleteKicker: 'الفريق // حذف', deleteTitle: 'حذف الفريق', deleteLead: 'سيؤدي هذا إلى حذف {name} وبياناته المحلية نهائيًا. أدخل اسم الفريق مطابقًا وكلمة مرور Admin الحالية.', deleteName: 'تأكيد اسم الفريق', deleteNamePlaceholder: 'اكتب {name}', adminPassword: 'كلمة مرور Admin', passwordPlaceholder: 'أدخل كلمة المرور الحالية', deleteAction: 'حذف الفريق', deleting: 'جارٍ الحذف…', deleteFailed: 'تعذر حذف الفريق.',
      brain: 'Brain', brainKicker: 'Brain // السياق', brainTitle: 'اختر Brain', brainLead: 'اختر النموذج الذي ينسّق هذا الفريق.', modelLoading: 'جارٍ تحميل النماذج…', modelFailed: 'تعذر تحديث Brain.',
      assistants: 'Assistants', assistantKicker: 'Assistants // السياق', assistantTitle: 'اختر Assistants', assistantLead: 'يمكن فقط لـ Assistants المحددين توفير Powers في الأدوار التالية.', assistantEmpty: 'لا يوجد Assistant قيد التشغيل في هذا الفريق.', selectAll: 'تحديد الكل', selectMaximum: 'تحديد أول {limit}', unselectAll: 'إلغاء تحديد الكل', onlyThis: 'هذا فقط', onlyThisNamed: 'استخدم {name} فقط', selectionLimit: 'يمكن لهذه المحادثة استخدام ما يصل إلى {limit} من Assistants في الوقت نفسه.', selected: '{selected} من {total}', selectedLimited: '{selected} من {total} · الحد {limit}', current: 'الحالي', close: 'إغلاق', cancel: 'إلغاء',
    },
  };

  let teamDialog = $state();
  let brainDialog = $state();
  let assistantDialog = $state();
  let createDialog = $state();
  let deleteDialog = $state();
  let teamTrigger = $state();
  let brainTrigger = $state();
  let assistantTrigger = $state();
  let teamName = $state('');
  let creating = $state(false);
  let dialogError = $state('');
  let deletingTeam = $state();
  let deleteName = $state('');
  let adminPassword = $state('');
  let deleting = $state(false);
  let deleteError = $state('');

  let copy = $derived(COPY[$locale] ?? COPY.en);
  let activeTeam = $derived(
    $teamContext.teams.find((entry) => entry.id === $teamContext.selectedTeamId) ?? null,
  );
  let brainOptions = $derived(
    $modelContext.providers.flatMap((provider) => provider.models.map((model) => ({
      value: `${provider.id}:${model.id}`,
      provider: provider.id,
      providerTitle: provider.title,
      model: model.id,
      title: model.title,
    }))),
  );
  let selectedBrain = $derived(
    brainOptions.find((entry) => (
      entry.provider === $modelContext.provider && entry.model === $modelContext.model
    )) ?? null,
  );
  let runningAssistants = $derived.by(() => {
    const catalog = new Map($teamContext.catalog.map((entry) => [entry.id, entry.name]));
    return $teamContext.installedAssistants
      .filter((entry) => entry.status === 'running')
      .map((entry) => ({
        id: entry.assistant,
        name: catalog.get(entry.assistant) ?? entry.assistant,
      }));
  });
  let selectedCount = $derived($teamContext.selectedAssistantIds.length);
  let assistantLimitApplies = $derived(runningAssistants.length > MAX_SELECTED_ASSISTANTS);
  let assistantCount = $derived(
    format(assistantLimitApplies ? copy.selectedLimited : copy.selected, {
      selected: selectedCount,
      total: runningAssistants.length,
      limit: MAX_SELECTED_ASSISTANTS,
    }),
  );
  let controlsDisabled = $derived(disabled || $teamContext.phase === 'loading');

  function format(template, values) {
    return Object.entries(values).reduce(
      (result, [key, value]) => result.replaceAll(`{${key}}`, String(value)),
      template,
    );
  }

  function open(dialog) {
    if (!dialog?.open) dialog?.showModal();
  }

  function close(dialog, trigger) {
    dialog?.close();
    queueMicrotask(() => trigger?.focus());
  }

  function cancelDialog(event, dialog, trigger) {
    event.preventDefault();
    close(dialog, trigger);
  }

  async function chooseTeam(id) {
    if (controlsDisabled || !id || id === $teamContext.selectedTeamId) {
      close(teamDialog, teamTrigger);
      return;
    }
    const next = new URL(page.url);
    next.searchParams.set('team', id);
    await goto(next, { replaceState: true, keepFocus: true, noScroll: true });
    close(teamDialog, teamTrigger);
  }

  function openCreate() {
    teamDialog?.close();
    teamName = '';
    dialogError = '';
    queueMicrotask(() => open(createDialog));
  }

  function closeCreate() {
    if (!creating) close(createDialog, teamTrigger);
  }

  function cancelCreate(event) {
    event.preventDefault();
    closeCreate();
  }

  async function submitCreate(event) {
    event.preventDefault();
    if (creating || !teamName.trim()) return;
    creating = true;
    dialogError = '';
    try {
      const created = await createTeam(fetch, teamName);
      createDialog?.close();
      window.location.assign(`/assistants/?team=${encodeURIComponent(created.id)}`);
    } catch {
      dialogError = copy.createFailed;
    } finally {
      creating = false;
    }
  }

  function resetDeleteForm() {
    deleteName = '';
    adminPassword = '';
  }

  function openDelete(team) {
    teamDialog?.close();
    deletingTeam = team;
    deleteError = '';
    resetDeleteForm();
    queueMicrotask(() => open(deleteDialog));
  }

  function closeDelete() {
    if (deleting) return;
    deleteDialog?.close();
    deletingTeam = undefined;
    deleteError = '';
    resetDeleteForm();
    queueMicrotask(() => teamTrigger?.focus());
  }

  function cancelDelete(event) {
    event.preventDefault();
    closeDelete();
  }

  async function submitDelete(event) {
    event.preventDefault();
    const target = deletingTeam;
    if (deleting || !target || deleteName !== target.name || !adminPassword) return;
    deleting = true;
    deleteError = '';
    let deleted = false;
    try {
      await deleteTeam(fetch, target.id, deleteName, adminPassword);
      deleted = true;
    } catch {
      deleteError = copy.deleteFailed;
    } finally {
      deleting = false;
      resetDeleteForm();
    }
    if (!deleted) return;

    deleteDialog?.close();
    deletingTeam = undefined;
    const next = new URL(page.url);
    if ($teamContext.selectedTeamId) next.searchParams.set('team', $teamContext.selectedTeamId);
    else next.searchParams.delete('team');
    await goto(next, { replaceState: true, keepFocus: true, noScroll: true });
    queueMicrotask(() => teamTrigger?.focus());
  }

  async function chooseBrain(brain) {
    const teamId = $teamContext.selectedTeamId;
    if (!teamId || controlsDisabled || $modelContext.phase === 'saving') return;
    if (brain.provider === $modelContext.provider && brain.model === $modelContext.model) {
      close(brainDialog, brainTrigger);
      return;
    }
    try {
      await selectTeamBrain(fetch, teamId, brain.provider, brain.model);
      close(brainDialog, brainTrigger);
    } catch {
      // The shared model context owns the bounded visible error.
    }
  }

</script>

<div class="context-controls" aria-label={copy.contextAria}>
  <button
    bind:this={teamTrigger}
    class="context-trigger"
    type="button"
    onclick={() => open(teamDialog)}
    disabled={controlsDisabled}
    aria-haspopup="dialog"
  >
    <span>{copy.team}</span>
    <strong>{activeTeam?.name ?? copy.noTeam}</strong>
  </button>
  <button
    bind:this={brainTrigger}
    class="context-trigger"
    type="button"
    onclick={() => open(brainDialog)}
    disabled={controlsDisabled || !activeTeam || $modelContext.phase === 'idle'}
    aria-haspopup="dialog"
  >
    <span>{copy.brain}</span>
    <strong>{selectedBrain?.title ?? copy.modelLoading}</strong>
  </button>
  <button
    bind:this={assistantTrigger}
    class="context-trigger"
    type="button"
    onclick={() => open(assistantDialog)}
    disabled={controlsDisabled || !activeTeam}
    aria-haspopup="dialog"
  >
    <span>{copy.assistants}</span>
    <strong>{assistantCount}</strong>
  </button>
</div>

<dialog bind:this={teamDialog} aria-labelledby="chat-team-dialog-title" oncancel={(event) => cancelDialog(event, teamDialog, teamTrigger)}>
  <div class="dialog-panel">
    <header>
      <p>{copy.teamKicker}</p>
      <h2 id="chat-team-dialog-title">{copy.teamTitle}</h2>
      <span>{copy.teamLead}</span>
    </header>
    <ul class="choice-list" aria-labelledby="chat-team-dialog-title">
      {#each $teamContext.teams as team (team.id)}
        <li class="team-choice">
          <button
            class="choice-button"
            type="button"
            class:active={team.id === $teamContext.selectedTeamId}
            aria-pressed={team.id === $teamContext.selectedTeamId}
            onclick={() => chooseTeam(team.id)}
          >
            <strong>{team.name}</strong>
            {#if team.id === $teamContext.selectedTeamId}<small>{copy.current}</small>{/if}
          </button>
          <button
            class="danger-action"
            type="button"
            aria-label={format(copy.deleteTeamNamed, { name: team.name })}
            onclick={() => openDelete(team)}
          >{copy.deleteTeam}</button>
        </li>
      {/each}
    </ul>
    <footer>
      <button class="secondary" type="button" onclick={() => close(teamDialog, teamTrigger)}>{copy.close}</button>
      <button class="primary" type="button" onclick={openCreate}>{copy.addTeam}</button>
    </footer>
  </div>
</dialog>

<dialog bind:this={brainDialog} aria-labelledby="chat-brain-dialog-title" oncancel={(event) => cancelDialog(event, brainDialog, brainTrigger)}>
  <div class="dialog-panel">
    <header>
      <p>{copy.brainKicker}</p>
      <h2 id="chat-brain-dialog-title">{copy.brainTitle}</h2>
      <span>{copy.brainLead}</span>
    </header>
    {#if $modelContext.phase === 'loading' || $modelContext.phase === 'idle'}
      <p class="dialog-status" role="status">{copy.modelLoading}</p>
    {:else}
      <ul class="choice-list" aria-labelledby="chat-brain-dialog-title">
        {#each brainOptions as brain (brain.value)}
          <li>
            <button
              class="choice-button"
              type="button"
              class:active={brain.value === selectedBrain?.value}
              aria-pressed={brain.value === selectedBrain?.value}
              disabled={$modelContext.phase === 'saving'}
              onclick={() => chooseBrain(brain)}
            >
              <span><strong>{brain.title}</strong><small>{brain.providerTitle}</small></span>
              {#if brain.value === selectedBrain?.value}<small>{copy.current}</small>{/if}
            </button>
          </li>
        {/each}
      </ul>
    {/if}
    {#if $modelContext.error}<p class="dialog-error" role="alert">{copy.modelFailed}</p>{/if}
    <footer><button class="secondary" type="button" onclick={() => close(brainDialog, brainTrigger)}>{copy.close}</button></footer>
  </div>
</dialog>

<dialog bind:this={assistantDialog} aria-labelledby="chat-assistant-dialog-title" oncancel={(event) => cancelDialog(event, assistantDialog, assistantTrigger)}>
  <div class="dialog-panel">
    <header>
      <p>{copy.assistantKicker}</p>
      <h2 id="chat-assistant-dialog-title">{copy.assistantTitle}</h2>
      <span>{copy.assistantLead}</span>
    </header>
    {#if runningAssistants.length > 0}
      <div class="bulk-actions">
        <button type="button" onclick={selectAllTeamAssistants}>
          {assistantLimitApplies
            ? format(copy.selectMaximum, { limit: MAX_SELECTED_ASSISTANTS })
            : copy.selectAll}
        </button>
        <button type="button" onclick={unselectAllTeamAssistants}>{copy.unselectAll}</button>
      </div>
    {/if}
    {#if assistantLimitApplies}
      <p class="selection-limit">
        {format(copy.selectionLimit, { limit: MAX_SELECTED_ASSISTANTS })}
      </p>
    {/if}
    {#if runningAssistants.length > 0}
      <fieldset class="assistant-choices">
        <legend class="visually-hidden">{copy.assistantTitle}</legend>
        {#each runningAssistants as assistant (assistant.id)}
          <div class="assistant-choice">
            <label class:blocked={!$teamContext.selectedAssistantIds.includes(assistant.id) && selectedCount >= MAX_SELECTED_ASSISTANTS}>
              <input
                type="checkbox"
                checked={$teamContext.selectedAssistantIds.includes(assistant.id)}
                disabled={!$teamContext.selectedAssistantIds.includes(assistant.id) && selectedCount >= MAX_SELECTED_ASSISTANTS}
                onchange={() => toggleTeamAssistant(assistant.id)}
              />
              <span class="checkmark" aria-hidden="true"></span>
              <AssistantIcon assistant={assistant.id} size={34} />
              <strong>{assistant.name}</strong>
            </label>
            <button
              type="button"
              aria-label={format(copy.onlyThisNamed, { name: assistant.name })}
              onclick={() => selectOnlyTeamAssistant(assistant.id)}
            >{copy.onlyThis}</button>
          </div>
        {/each}
      </fieldset>
    {:else}
      <p class="dialog-status">{copy.assistantEmpty}</p>
    {/if}
    <footer>
      <button class="secondary" type="button" onclick={() => close(assistantDialog, assistantTrigger)}>{copy.close}</button>
    </footer>
  </div>
</dialog>

<dialog
  bind:this={deleteDialog}
  aria-labelledby="chat-delete-team-title"
  aria-describedby="chat-delete-team-lead"
  oncancel={cancelDelete}
>
  <form class="dialog-panel delete-panel" onsubmit={submitDelete}>
    <header>
      <p>{copy.deleteKicker}</p>
      <h2 id="chat-delete-team-title">{copy.deleteTitle}</h2>
      <span id="chat-delete-team-lead">
        {format(copy.deleteLead, { name: deletingTeam?.name ?? '' })}
      </span>
    </header>
    <label class="field" for="chat-delete-team-name">
      <span>{copy.deleteName}</span>
      <input
        id="chat-delete-team-name"
        type="text"
        bind:value={deleteName}
        placeholder={format(copy.deleteNamePlaceholder, { name: deletingTeam?.name ?? '' })}
        maxlength="80"
        autocomplete="off"
        autocapitalize="off"
        spellcheck="false"
        required
        disabled={deleting}
      />
    </label>
    <label class="field" for="chat-delete-team-password">
      <span>{copy.adminPassword}</span>
      <input
        id="chat-delete-team-password"
        type="password"
        bind:value={adminPassword}
        placeholder={copy.passwordPlaceholder}
        maxlength="4096"
        autocomplete="current-password"
        required
        disabled={deleting}
      />
    </label>
    {#if deleteError}<p class="dialog-error" role="alert">{deleteError}</p>{/if}
    <footer>
      <button class="secondary" type="button" onclick={closeDelete} disabled={deleting}>{copy.cancel}</button>
      <button
        class="danger"
        type="submit"
        disabled={deleting || !deletingTeam || deleteName !== deletingTeam.name || !adminPassword}
      >{deleting ? copy.deleting : copy.deleteAction}</button>
    </footer>
  </form>
</dialog>

<dialog bind:this={createDialog} aria-labelledby="chat-create-team-title" oncancel={cancelCreate}>
  <form class="dialog-panel" onsubmit={submitCreate}>
    <header>
      <p>{copy.createKicker}</p>
      <h2 id="chat-create-team-title">{copy.createTitle}</h2>
      <span>{copy.createLead}</span>
    </header>
    <label class="field" for="chat-create-team-name">
      <span>{copy.teamName}</span>
      <input
        id="chat-create-team-name"
        type="text"
        bind:value={teamName}
        placeholder={copy.teamPlaceholder}
        maxlength="80"
        autocomplete="off"
        autocapitalize="words"
        spellcheck="false"
        required
        disabled={creating}
      />
    </label>
    {#if dialogError}<p class="dialog-error" role="alert">{dialogError}</p>{/if}
    <footer>
      <button class="secondary" type="button" onclick={closeCreate} disabled={creating}>{copy.cancel}</button>
      <button class="primary" type="submit" disabled={creating || !teamName.trim()}>{creating ? copy.creating : copy.create}</button>
    </footer>
  </form>
</dialog>

<style>
  .context-controls {
    display: grid;
    min-width: 0;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 1px;
    padding: 1px;
    background: var(--border-strong);
  }

  .context-trigger {
    display: grid;
    min-width: 0;
    min-height: 2.55rem;
    align-content: center;
    gap: 0.1rem;
    border: 0;
    padding: 0.45rem 0.65rem;
    background: #050708;
    color: var(--text);
    cursor: pointer;
    text-align: start;
  }

  .context-trigger:hover { background: rgba(0, 240, 255, 0.055); }
  .context-trigger:disabled { cursor: not-allowed; opacity: 0.4; }
  .context-trigger span { color: var(--accent); font-family: var(--font-mono); font-size: 0.47rem; font-weight: 700; letter-spacing: 0.1em; text-transform: uppercase; }
  .context-trigger strong { overflow: hidden; font-family: var(--font-mono); font-size: 0.62rem; font-weight: 500; text-overflow: ellipsis; white-space: nowrap; }

  button:focus-visible,
  input:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }

  dialog {
    width: min(32rem, calc(100dvw - 1rem));
    max-height: calc(100dvh - 2rem);
    border: 0;
    padding: 0;
    background: transparent;
    color: var(--text);
  }

  dialog::backdrop { background: rgba(0, 0, 0, 0.82); backdrop-filter: blur(8px); }

  .dialog-panel {
    display: grid;
    max-height: calc(100dvh - 2rem);
    gap: 1rem;
    padding: clamp(1.25rem, 4vw, 2rem);
    background: var(--surface-1);
    box-shadow: inset 0 0 0 1px var(--border-strong), 0 24px 80px rgba(0, 0, 0, 0.65);
    clip-path: polygon(var(--cut) 0, 100% 0, 100% calc(100% - var(--cut)), calc(100% - var(--cut)) 100%, 0 100%, 0 var(--cut));
    overflow: auto;
  }

  header { display: grid; gap: 0.45rem; }
  header p { margin: 0; color: var(--accent); font-family: var(--font-mono); font-size: 0.58rem; font-weight: 600; letter-spacing: 0.14em; text-transform: uppercase; }
  header h2 { margin: 0; font-size: clamp(1.4rem, 4vw, 2.1rem); letter-spacing: -0.05em; }
  header span { color: var(--text-dim); font-size: 0.74rem; line-height: 1.55; }

  .choice-list { display: grid; gap: 0.4rem; min-height: 0; margin: 0; padding: 0; overflow: auto; list-style: none; }
  .choice-list > li { min-width: 0; }
  .choice-button {
    display: flex;
    width: 100%;
    min-height: 3rem;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    border: 1px solid var(--border-strong);
    padding: 0.65rem 0.8rem;
    background: #050708;
    color: var(--text);
    cursor: pointer;
    text-align: start;
  }
  .choice-button:hover, .choice-button.active { border-color: var(--accent); background: rgba(0, 240, 255, 0.05); }
  .choice-button > span { display: grid; gap: 0.15rem; }
  .choice-list strong { font-size: 0.75rem; }
  .choice-list small { color: var(--accent); font-family: var(--font-mono); font-size: 0.5rem; letter-spacing: 0.07em; text-transform: uppercase; }

  .team-choice { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 0.4rem; }
  .danger-action {
    min-width: 4.5rem;
    border: 1px solid rgba(255, 46, 99, 0.42);
    padding: 0 0.65rem;
    background: rgba(255, 46, 99, 0.035);
    color: var(--danger);
    cursor: pointer;
    font-family: var(--font-mono);
    font-size: 0.5rem;
    font-weight: 700;
    text-transform: uppercase;
  }
  .danger-action:hover { border-color: var(--danger); background: rgba(255, 46, 99, 0.1); }

  .bulk-actions { display: flex; flex-wrap: wrap; gap: 0.45rem; }
  .bulk-actions button, .assistant-choice > button {
    min-height: 2rem;
    border: 1px solid var(--border-strong);
    padding: 0 0.65rem;
    background: transparent;
    color: var(--accent);
    cursor: pointer;
    font-family: var(--font-mono);
    font-size: 0.52rem;
    text-transform: uppercase;
  }

  .selection-limit { margin: -0.45rem 0 0; color: var(--text-faint); font-size: 0.64rem; line-height: 1.45; }

  .assistant-choices { display: grid; gap: 0.4rem; min-width: 0; margin: 0; border: 0; padding: 0; }
  .assistant-choice { display: grid; min-width: 0; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: 0.5rem; }
  .assistant-choice label { display: grid; min-width: 0; min-height: 3.2rem; grid-template-columns: auto auto minmax(0, 1fr); align-items: center; gap: 0.65rem; padding: 0.5rem 0.7rem; background: #050708; cursor: pointer; }
  .assistant-choice label.blocked { cursor: not-allowed; opacity: 0.42; }
  .assistant-choice input { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
  .checkmark { display: grid; width: 1rem; height: 1rem; place-items: center; border: 1px solid var(--border-strong); color: var(--accent-ink); }
  input:checked + .checkmark { border-color: var(--accent); background: var(--accent); }
  input:checked + .checkmark::after { content: '✓'; font-size: 0.65rem; }
  input:focus-visible + .checkmark { outline: 2px solid var(--accent); outline-offset: 2px; }
  .assistant-choice strong { overflow: hidden; font-size: 0.7rem; text-overflow: ellipsis; white-space: nowrap; }

  .dialog-status, .dialog-error { margin: 0; color: var(--text-faint); font-size: 0.7rem; line-height: 1.5; }
  .dialog-error { color: var(--danger); }
  .field { display: grid; gap: 0.35rem; }
  .field > span { color: var(--text-faint); font-family: var(--font-mono); font-size: 0.55rem; letter-spacing: 0.08em; text-transform: uppercase; }
  .field input { width: 100%; min-height: 2.8rem; border: 1px solid var(--border-strong); padding: 0 0.8rem; background: #020304; color: var(--text); font-family: var(--font-mono); }

  footer { display: flex; justify-content: flex-end; gap: 0.6rem; }
  footer button { min-height: 2.6rem; border: 0; padding: 0 0.9rem; cursor: pointer; font-family: var(--font-mono); font-size: 0.58rem; font-weight: 700; text-transform: uppercase; }
  footer .secondary { background: transparent; box-shadow: inset 0 0 0 1px var(--border-strong); color: var(--text-dim); }
  footer .primary { background: var(--accent); color: #001013; }
  footer .danger { background: var(--danger); color: #160007; }
  footer button:disabled { cursor: not-allowed; opacity: 0.42; }

  @media (max-width: 640px) {
    .context-trigger { min-height: 2.4rem; padding: 0.35rem 0.4rem; }
    .context-trigger span { font-size: 0.4rem; letter-spacing: 0.06em; }
    .context-trigger strong { font-size: 0.52rem; }
    footer { align-items: stretch; flex-direction: column-reverse; }
  }
</style>

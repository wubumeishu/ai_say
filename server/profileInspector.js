function normalizeText(text) {
  return String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
}

function normalizeLines(lines) {
  return (Array.isArray(lines) ? lines : []).map((line) => normalizeText(line)).filter(Boolean);
}

function isUnfilled(value) {
  const text = normalizeText(value);
  if (!text) return true;
  return ['未入力です', '未設定', '未设置', '未入力', '設定なし', 'なし', '-'].includes(text);
}

function inferStatusLabel(value) {
  return isUnfilled(value) ? '未填写' : '已填写';
}

function looksLikeSelect(control) {
  if (!control) return false;
  const type = String(control.type || '').toLowerCase();
  if (type === 'select' || control.hasOptions || control.optionsText) return true;
  const text = normalizeText(control.name || control.label || control.value);
  return /(?:選択|下拉|请选择|下拉框|select|option)/i.test(text);
}

function classifyControl(control = {}) {
  const rawType = String(control.type || '').toLowerCase();
  const text = normalizeText(`${control.name || ''} ${control.label || ''} ${control.value || ''} ${control.optionsText || ''}`);
  if (looksLikeSelect(control)) return 'select';
  if (rawType === 'radio' || text.includes('radio')) return 'radio';
  if (rawType === 'checkbox' || text.includes('checkbox')) return 'checkbox';
  if (rawType === 'textarea' || text.includes('textarea')) return 'textarea';
  if (rawType === 'input' || rawType === 'text' || text.includes('input')) return 'input';
  if (control.buttonText || control.clickable || text.includes('设定') || text.includes('クリック')) return 'button';
  return 'text';
}

function buildFieldKey(field = {}) {
  const base = normalizeText(field.key || field.label || field.name || field.group || field.title || 'field');
  return base.replace(/[\s:：|/]+/g, '_').toLowerCase() || `field_${Math.random().toString(36).slice(2, 8)}`;
}

function buildFields(raw = {}) {
  const controls = Array.isArray(raw.controls) ? raw.controls : [];
  const groups = Array.isArray(raw.groups) ? raw.groups : [];
  const groupKeys = new Set(groups.map((g) => g.name));
  const fields = [];
  for (const control of controls) {
    if ((control.type === 'radio' || control.type === 'checkbox') && groupKeys.has(control.name)) {
      continue;
    }
    fields.push({
      type: control.type,
      tag: control.tag,
      name: control.name,
      id: control.id,
      label: control.label,
      group: control.group,
      value: control.value,
      options: control.options,
      hasOptions: control.hasOptions,
      optionsText: control.optionsText,
      selector: control.selector,
      readonly: control.readonly,
      disabled: control.disabled,
      required: control.required
    });
  }
  for (const group of groups) {
    const checked = (group.options || []).find((o) => o.checked);
    fields.push({
      type: group.type,
      tag: group.type === 'radio' ? 'radio-group' : 'checkbox-group',
      name: group.name,
      label: group.label,
      group: group.group,
      value: checked ? checked.value : '',
      options: group.options,
      hasOptions: true,
      optionsText: group.optionsText,
      selector: (group.options && group.options[0] && group.options[0].selector) || ('[name="' + group.name + '"]'),
      readonly: false,
      disabled: false
    });
  }
  return fields;
}

function summarizeField(field = {}) {
  const value = normalizeText(field.value);
  const type = classifyControl(field);
  const key = buildFieldKey(field);
  const hasDom = Boolean(field.tag || field.selector);
  let readonly;
  let editable;
  if (hasDom) {
    readonly = (type === 'input' || type === 'textarea') ? Boolean(field.readonly) : false;
    editable = !field.disabled;
  } else {
    readonly = field.readonly === true || type === 'text';
    editable = field.editable !== false && !readonly;
  }
  return {
    key,
    label: field.label || field.name || field.group || key,
    group: field.group || '',
    value,
    displayValue: value || '空',
    controlType: type,
    status: inferStatusLabel(value),
    filled: !isUnfilled(value),
    editable,
    readonly,
    disabled: Boolean(field.disabled),
    options: field.options && field.options.length ? field.options : undefined,
    nextUrl: field.nextUrl,
    buttonText: field.buttonText,
    selector: field.selector,
    platform: field.platform,
    source: hasDom ? 'dom' : 'doc'
  };
}

function normalizePageMeta(page = {}) {
  return {
    url: normalizeText(page.url),
    title: normalizeText(page.title),
    readyState: page.readyState,
    platform: page.platform,
    targetId: page.targetId
  };
}

function summarizeProfile(raw = {}) {
  const fields = (Array.isArray(raw.fields) ? raw.fields : buildFields(raw)).map(summarizeField);
  const page = normalizePageMeta(raw.page || {});
  const lines = normalizeLines(raw.lines);
  const buttons = normalizeLines(raw.buttons);
  return {
    ok: true,
    source: raw.source || 'unknown',
    page,
    fields,
    lines,
    buttons,
    unfilled: fields.filter((field) => !field.filled),
    filled: fields.filter((field) => field.filled),
    controls: fields,
    sections: Array.isArray(raw.sections) ? raw.sections : [],
    nextActions: (Array.isArray(raw.nextActions) ? raw.nextActions : []).map((action) => ({
      label: normalizeText(action.label || action.text || action.name || 'next'),
      url: normalizeText(action.url || action.href || action.target || action.nextUrl),
      tag: action.tag,
      selector: action.selector
    })).filter((action) => action.label || action.url)
  };
}

function planPatch(profile = {}, patch = {}) {
  const normalized = Array.isArray(profile.fields) ? profile : summarizeProfile(profile);
  const changes = Object.keys(patch || {})
    .map((key) => {
      const field = normalized.fields.find((item) => item.key === key || item.label === key || item.name === key);
      if (!field) return null;
      return {
        key: field.key,
        label: field.label,
        name: field.name,
        from: field.value,
        to: normalizeText(patch[key]),
        controlType: field.controlType,
        editable: field.editable,
        readonly: field.readonly,
        selector: field.selector,
        options: field.options
      };
    })
    .filter(Boolean);
  const executableChanges = changes.filter((change) => change.editable && !change.readonly);
  const previewChanges = changes.filter((change) => !change.editable || change.readonly);
  const warnings = [];
  for (const change of previewChanges) {
    warnings.push(`${change.label} 暂不支持自动填写（控件类型：${change.controlType}）`);
  }
  const unknownKeys = Object.keys(patch || {}).filter((key) => !changes.some((change) => change.key === key || change.label === key));
  return {
    ok: true,
    total: changes.length,
    unknownKeys,
    previewCount: previewChanges.length,
    executableCount: executableChanges.length,
    changes,
    warnings,
    safeToSubmit: executableChanges.length > 0 && previewChanges.length === 0 && unknownKeys.length === 0
  };
}



function controlPurpose(controlType) {
  switch (String(controlType || '').toLowerCase()) {
    case 'select':
      return '选择器：可从选项里选择一个值。';
    case 'textarea':
      return '多行文本：可填写较长说明。';
    case 'radio':
      return '单选项：在同一组里选择一项。';
    case 'checkbox':
      return '复选项：可勾选或取消。';
    case 'button':
      return '按钮：触发保存、提交或跳转。';
    case 'input':
      return '输入框：可手动输入或修改值。';
    default:
      return '页面元素：当前用途需结合标签确认。';
  }
}

function buildProfileInspect(raw = {}) {
  const profile = summarizeProfile(raw);
  const nextLevelPages = detectNextLevelPagesLocal(raw);
  const pageFeatures = {
    fieldCount: profile.fields.length,
    unfilledCount: profile.unfilled.length,
    filledCount: profile.filled.length,
    sectionCount: (raw.sections || []).length,
    nextLevelPageCount: nextLevelPages.length
  };
  const fields = profile.fields.map((field) => ({
    ...field,
    purpose: controlPurpose(field.controlType),
    optionCount: Array.isArray(field.options) ? field.options.length : 0
  }));
  return {
    ok: true,
    source: profile.source,
    page: profile.page,
    sections: profile.sections,
    fields,
    controls: fields,
    nextLevelPages,
    nextActions: profile.nextActions,
    unfilled: profile.unfilled,
    filled: profile.filled,
    pageFeatures
  };
}

function detectNextLevelPagesLocal(raw = {}) {
  const actions = Array.isArray(raw.nextActions) ? raw.nextActions : [];
  const seen = new Set();
  const pages = actions.map((action) => ({
    label: normalizeText(action && (action.label || action.text || action.name)),
    url: normalizeText(action && (action.url || action.href || action.target || action.nextUrl)),
    tag: action && action.tag,
    selector: action && action.selector
  })).filter((item) => item.label || item.url);
  const out = [];
  for (const page of pages) {
    const key = page.url || page.label;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(page);
  }
  return out.slice(0, 80);
}



module.exports = {
  summarizeProfile,
  planPatch,
  buildFields,
  inferStatusLabel,
  isUnfilled,
  normalizeText,
  normalizeLines,
  buildProfileInspect,
  controlPurpose
}

import { createLocalModelControls } from './localModelControls.js';
import { t } from './i18n/index.js';

/** Settings are saved by the panel; model downloads go directly to browser storage. */
export function appendAiSettings(documentRef, row, ai) {
  const controls = documentRef.createElement('div');
  controls.className = 'key-setup-ai';
  const add = (name, label, options) => {
    const wrapper = documentRef.createElement('label');
    wrapper.textContent = label;
    const input = documentRef.createElement(options ? 'select' : 'input');
    if (options) {
      for (const [value, text] of options) {
        const option = documentRef.createElement('option');
        option.value = value;
        option.textContent = text;
        input.append(option);
      }
    } else {
      input.type = 'url';
      input.placeholder = 'http://127.0.0.1:8000/mcp';
    }
    input.value = ai[name]?.value || '';
    input.disabled = Boolean(ai[name]?.external);
    input.dataset.aiSetting = name;
    input.dataset.initialValue = input.value;
    input.setAttribute('aria-label', label);
    if (input.disabled) input.title = t('Configured externally');
    wrapper.append(input);
    controls.append(wrapper);
    return { input, wrapper };
  };
  const provider = add('GEV_AI_PROVIDER', t('AI provider'), [
    ['openai', 'OpenAI'],
    ['local', t('Local — no API key')],
  ]);
  const profile = add('LOCAL_AI_PROFILE', t('Local profile'), [
    ['low', 'low · Bonsai 1.7B / Whisper tiny'],
    ['balance', 'balance · Bonsai 4B / Whisper base'],
    ['max', 'max · Bonsai 8B / Whisper small'],
  ]);
  const language = add('LOCAL_AI_LANGUAGE', t('Voice language'), [
    ['ru', 'Русский · Piper Irina'],
    ['en', 'English · Piper Lessac'],
  ]);
  const models = createLocalModelControls(documentRef);
  controls.append(models.root);
  const hint = documentRef.createElement('p');
  hint.className = 'key-setup-unlocks';
  hint.textContent = t(
    'Download once, then run in this browser. Bonsai uses WebGPU; speech stays on your device. Chrome or Edge with hardware acceleration required. Save settings after choosing your profile.',
  );
  controls.append(hint);
  const mcp = add('LOCAL_AI_MCP_URL', t('Search MCP URL (optional)'));
  const searchHint = documentRef.createElement('p');
  searchHint.className = 'key-setup-unlocks';
  searchHint.textContent = t(
    'Only web search sends queries to this optional MCP server.',
  );
  controls.append(searchHint);
  let selection;
  const sync = () => {
    const local = provider.input.value === 'local';
    for (const field of [profile, language, mcp]) field.wrapper.hidden = !local;
    hint.hidden = !local;
    models.root.hidden = !local;
    searchHint.hidden = !local;
    const next = `${profile.input.value}:${language.input.value}`;
    if (local && next !== selection) {
      selection = next;
      models.select({
        profile: profile.input.value,
        language: language.input.value,
      });
    }
    const keyFields = row.querySelector('.key-setup-fields');
    if (keyFields) keyFields.hidden = local;
    for (const selector of [
      '.key-setup-tier',
      '.key-setup-get',
      '.key-setup-external',
      '.key-setup-cloud-auth',
    ]) {
      const element = row.querySelector(selector);
      if (element) element.hidden = local;
    }
    row.dataset.aiProvider = provider.input.value;
  };
  provider.input.addEventListener('change', sync);
  profile.input.addEventListener('change', sync);
  language.input.addEventListener('change', sync);
  row.append(controls);
  sync();
  return models.destroy;
}

export function collectAiSettings(fields) {
  return Object.fromEntries(
    [...fields]
      .filter(
        (field) =>
          !field.disabled && field.value.trim() !== field.dataset.initialValue,
      )
      .map((field) => [field.dataset.aiSetting, field.value.trim() || null]),
  );
}

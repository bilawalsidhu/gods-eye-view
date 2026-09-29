/** Portuguese copy for the first-run card. Other locales retain the original English copy. */
export const FIRST_RUN_PT_BR = Object.freeze({
  '.first-run-kicker': 'CONTROLE DE MISSÃO · PRIMEIRO ACESSO',
  '#first-run-title': 'Escolha sua primeira vista',
  '#first-run-description':
    'Parece um centro de operações restrito — mas as fontes são públicas e os dados são reais.',
  '[data-first-run-choice="contacts"] strong': 'CONTATOS AO VIVO',
  '[data-first-run-choice="contacts"] small':
    'Aeronaves, embarcações e informações próximas',
  '[data-first-run-choice="space-missions"] strong': 'MISSÕES ESPACIAIS',
  '[data-first-run-choice="space-missions"] small':
    'Lançamentos, espaçonaves e contexto orbital',
  '[data-first-run-choice="environmental"] strong': 'AMBIENTAL',
  '[data-first-run-choice="environmental"] small':
    'Terremotos e incêndios ativos, de USGS e NASA',
  '[data-first-run-choice="explore"] strong': 'EXPLORAR MANUALMENTE',
  '[data-first-run-choice="explore"] small': 'Comece com o globo limpo',
  '.first-run-suppress span': 'Não mostrar novamente',
  '.first-run-footer > span': 'ESC para fechar',
  '[data-first-run-status]':
    'Dica: o botão GEV MIC permite conversar com o mapa.',
});

export const FIRST_RUN_PT_BR_BUSY = Object.freeze({
  contacts: 'Abrindo contatos ao vivo…',
  'space-missions': 'Abrindo missões espaciais…',
  environmental: 'Buscando eventos ativos…',
});

export function isPortugueseLocale(locale) {
  return /^pt(?:-|$)/i.test(String(locale || ''));
}

export function localizeFirstRun(root, locale) {
  if (!isPortugueseLocale(locale)) return false;
  for (const [selector, copy] of Object.entries(FIRST_RUN_PT_BR)) {
    const element = root.querySelector(selector);
    if (element) element.textContent = copy;
  }
  root.setAttribute('lang', 'pt-BR');
  return true;
}

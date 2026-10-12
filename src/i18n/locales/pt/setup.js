// Catálogo em português — namespace setup (primeiro acesso, chaves, cenas, voz).
export const NAMESPACE = 'setup';

export default {
  'firstRun.kicker': 'CENTRO DE CONTROLE · PRIMEIRO ACESSO',
  'firstRun.title': 'Escolha sua primeira vista',
  'firstRun.choice.contacts': 'CONTATOS AO VIVO',
  'firstRun.suppress': 'Não mostrar novamente',
  'keySetup.chip': 'ATIVAR',
  'keySetup.kicker': 'ESTAÇÃO TERRESTRE · CONFIGURAÇÕES DE PROVEDORES',
  'keySetup.title': 'Ative o globo',
  'keySetup.apply': 'SALVAR CHAVES',
  'keySetup.status.saving': 'Salvando…',
  'firstRun.description':
    'Parece uma cabine proibida—até você perceber que as fontes são públicas e os dados são reais.',
  'firstRun.choice.contactsSub':
    'Aeronaves, embarcações e inteligência próxima',
  'firstRun.choice.spaceMissions': 'MISSÕES ESPACIAIS',
  'firstRun.choice.spaceMissionsSub':
    'Lançamentos, espaçonaves e contexto orbital',
  'firstRun.choice.explore': 'EXPLORAR MANUALMENTE',
  'firstRun.choice.exploreSub': 'Comece com um globo limpo',
  'firstRun.dismissHint': 'ESC para dispensar',
  'firstRun.note': 'Dica: o botão GEV MIC no dock permite falar com o mapa.',
  'keySetup.closeAriaLabel': 'Fechar configuração de chaves',
  'keySetup.description':
    'O globo já voa sem chaves. Cada chave abaixo ativa mais uma fonte real — cole uma e ela será salva na configuração local deste app, e então o servidor reinicia sozinho. As chaves do servidor ficam nesta máquina; Google Maps e Cesium ion rodam no navegador e devem ser restritas ao provedor. Chaves configuradas em outro lugar são exibidas, mas nunca alteradas.',
  'keySetup.hint': 'ESC para fechar',
  'keySetup.note':
    'A chave do Google Maps libera o planeta fotorrealista — todo o resto se soma a ela.',
  'scenes.panelTitle': 'CENAS',
  'scenes.collapseTitle': 'Recolher painel',
  'scenes.recipeAriaLabel': 'Receita de cena',
  'scenes.new': 'NOVA',
  'scenes.delete': 'EXCL',
  'scenes.capture': 'CAPTURAR PLANO',
  'scenes.updateShot': 'ATUALIZAR PLANO',
  'scenes.start': 'INICIAR',
  'scenes.stop': 'PARAR',
  'scenes.next': 'PRÓX',
  'scenes.exportPresets': 'EXPORTAR PREDEFINIÇÕES',
  'scenes.import': 'IMPORTAR',
  'scenes.runLog': 'REGISTRO',
  'scenes.statusReady': 'Pronto',
  'firstRun.busy.contacts': 'Iniciando contatos ao vivo…',
  'firstRun.busy.spaceMissions': 'Abrindo missões espaciais…',
  'firstRun.busy.environmental': 'Varrendo eventos ativos…',
  'firstRun.busy.working': 'Processando…',
  'firstRun.status.failed':
    'Não foi possível abrir essa missão{detail}. Tente novamente ou explore manualmente.',
  'firstRun.status.storageBlocked':
    'Este navegador está bloqueando o armazenamento, então não foi possível salvar.',
  'firstRun.choice.environmentalSub':
    'Terremotos e incêndios ativos ao vivo, de USGS e NASA',
  'firstRun.environmentalTitle.environmental': 'AMBIENTAL',
  'firstRun.environmentalTitle.earthWatch': 'VIGIA DA TERRA',
  'firstRun.environmentalTitle.activeEvents': 'EVENTOS ATIVOS',
  'keySetup.chipWaiting': {
    one: 'ATIVAR · {count} CHAVE PENDENTE',
    other: 'ATIVAR · {count} CHAVES PENDENTES',
  },
  'keySetup.chipReady': 'ATIVADO',
  'keySetup.status.saveFailed': 'Falha ao salvar ({status}).',
  'keySetup.status.saveFailedDetail': 'Falha ao salvar: {detail}',
  'keySetup.status.pasteFirst': 'Cole pelo menos uma chave primeiro.',
  'keySetup.status.saved':
    'Salvo em {store}. Reiniciando — esta página recarrega sozinha.',
  'keySetup.status.removed':
    'Removido de {store}. Reiniciando — esta página recarrega sozinha.',
  'keySetup.store.pinokio': 'sua configuração do app',
  'keySetup.store.env': 'seu .env local',
  'keySetup.confirm.remove': 'Remover esta chave da sua configuração salva?',
  'mapStack.fallbackName': 'Esta pilha de mapa',
  'mapStack.unavailableReason': '{label} indisponível',
  'mapStack.unavailableAriaLabel': '{label} indisponível: {hint}',
  'scenes.recipe.flightsRadar': 'Radar Global de Voos',
  'scenes.recipe.orbitalWatch': 'Vigilância Orbital',
  'scenes.recipe.thermalThreats': 'Painel de Ameaças Térmicas',
  'scenes.recipe.cityOverload': 'Sobrecarga Urbana',
  'scenes.recipe.omnisciencePullback': 'Recuo da Onisciência',
  'voice.status.idle': 'DESLIGADO',
  'voice.status.connecting': 'CONECTANDO',
  'voice.status.listening': 'OUVINDO',
  'voice.status.executing': 'EXECUTANDO',
  'voice.status.error': 'ERRO',
  'voice.status.sessionCostCap': 'Sessão encerrada — limite de custo {cost}',
  'voice.detail.standby': 'VOZ EM ESPERA',
  'voice.detail.active': 'VOZ ATIVA',
  'voice.detail.unavailable': 'VOZ INDISPONÍVEL',
  'voice.detail.microphoneUnavailable':
    'Suporte a microfone WebRTC indisponível',
  'voice.detail.requestingMicrophone': 'Solicitando microfone',
  'voice.detail.holdSpaceTalk': 'Segure Espaço para falar',
  'voice.detail.releaseSpaceSend': 'Solte Espaço para enviar',
  'voice.detail.askOrCommand': 'Pergunte ou comande',
  'voice.detail.voiceOff': 'Voz desligada',
  'voice.detail.runningCommand': 'Executando comando',
  'voice.detail.radioDidNotStart': 'O rádio não iniciou',
  'voice.hint.default':
    'Segure Espaço para falar · toque em Espaço para ativar controles em foco',
  'voice.error.sessionStart': 'Não foi possível iniciar a sessão de voz.',
  'voice.error.trayTitle': 'ERRO NO SISTEMA DE VOZ',
  'voice.error.dismiss': 'DISPENSAR',
  'voice.error.hint':
    'Verifique a permissão do microfone e o acesso à rede, e tente novamente.',
  'voice.kicker.agent': 'AGENTE DE IA',
  'voice.kicker.control': 'CONTROLE POR VOZ',
  'voice.tier.appliesNextSession': '{tier} vale na próxima sessão',
  'voice.tier.buttonTitle': 'Nível do modelo de voz — vale na próxima sessão',
  'voice.cost.buttonTitle': 'Custo estimado da sessão',
  'voice.button.ariaLabel':
    'Controle por voz — ative para alternar a voz; segure Espaço para falar',
  'scenes.status.captureCameraNotReady':
    'Não foi possível capturar o plano: câmera não está pronta',
  'scenes.status.shotTitleDefault': 'Plano {n}',
  'scenes.status.captured': 'Capturado: {scene} / {shot}',
  'scenes.status.selectShotFirst': 'Selecione um plano primeiro',
  'scenes.status.updated': 'Atualizado: {scene} / {shot}',
  'scenes.status.deleteShotConfirm': 'Excluir o plano "{shot}"?',
  'scenes.status.loaded': 'Carregado: {scene} / {shot}',
  'scenes.status.cameraUnavailable':
    'Câmera indisponível — saia da cabine primeiro',
  'scenes.status.noShotsToRun': 'Nenhum plano para executar',
  'scenes.status.runningShot': 'Executando {index}/{total}: {scene} / {shot}',
  'scenes.status.runComplete': 'Execução da cena concluída',
  'scenes.status.runError': 'Erro: {message}',
  'scenes.status.contextExitFailed':
    'Não foi possível sair de {mode} — as camadas da cena podem ser recusadas',
  'keySetup.row.remove': 'REMOVER',
  'keySetup.row.removeTitle': 'Remover {title} das chaves salvas deste app',
  'keySetup.requirement':
    'Requer {envVars} — adicione em Configurações de Provedores',
  'keySetup.unlocks.google-maps':
    'O planeta 3D fotorrealista + busca de lugares',
  'keySetup.unlocks.google-maps-server':
    'Contexto de lugares + alternativa do Street View; chave separada opcional',
  'keySetup.unlocks.openai': 'Controle por voz — fale com o planeta',
  'keySetup.unlocks.aisstream': 'Navios ao vivo, no mundo todo',
  'keySetup.unlocks.firms': 'Detecções de incêndios ativos ao vivo',
  'keySetup.unlocks.tomtom':
    'Trânsito real ao vivo (sem chave roda uma simulação)',
  'keySetup.unlocks.cesium-ion':
    'Pilhas de mapa com imagens Bing + relevo mundial',
  'keySetup.unlocks.opensky':
    'Mais créditos de consulta de voos (funciona sem, de forma anônima)',
  'keySetup.unlocks.launch-library':
    'Maior limite de requisições de missões espaciais',
  'scenes.status.actionFailed': 'A ação da cena falhou',
  'scenes.status.projectExported': 'Projeto exportado',
  'voice.tierNextSession':
    'Próxima sessão: {pendingId} — esta sessão continua em {modelId}',
  'voice.tierSwitchHint':
    'Modelo de voz: {pendingId} — clique para mudar para {target}; vale na próxima sessão',
  'voice.costTooltip':
    'Custo estimado da sessão em {modelId} — {responses} resposta(s). Alerta em {warn}, encerra a sessão em {cap}.',
};

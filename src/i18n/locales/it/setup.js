// Italian catalog, setup namespace: first-run, key setup, scenes, voice control chrome.
export const NAMESPACE = 'setup';

export default {
  'firstRun.kicker': 'CONTROLLO MISSIONE · PRIMO AVVIO',
  'firstRun.title': 'Scegli la tua prima vista',
  'firstRun.choice.contacts': 'CONTATTI LIVE',
  'firstRun.suppress': 'Non mostrare più',
  'keySetup.chip': 'POWER UP',
  'keySetup.kicker': 'STAZIONE A TERRA · IMPOSTAZIONI PROVIDER',
  'keySetup.title': 'Accendi il globo',
  'keySetup.apply': 'SALVA CHIAVI',
  'keySetup.status.saving': 'Salvataggio…',
  'firstRun.description':
    'Sembra un cockpit proibito, poi capisci che le fonti sono pubbliche e i dati sono reali.',
  'firstRun.choice.contactsSub': 'Aerei, navi e intelligence nelle vicinanze',
  'firstRun.choice.spaceMissions': 'MISSIONI SPAZIALI',
  'firstRun.choice.spaceMissionsSub':
    'Lanci, veicoli spaziali e contesto orbitale',
  'firstRun.choice.explore': 'ESPLORA A MANO',
  'firstRun.choice.exploreSub': 'Inizia con un globo pulito',
  'firstRun.dismissHint': 'ESC per chiudere',
  'firstRun.note':
    'Suggerimento: il pulsante GEV MIC nel dock ti permette di parlare con la mappa.',
  'keySetup.closeAriaLabel': 'Chiudi la configurazione delle chiavi',
  'keySetup.description':
    'Il globo funziona già senza chiavi. Ogni chiave qui sotto attiva un altro feed reale: incollane una e verrà salvata nella configurazione locale di questa app, poi il server si riavvia da solo. Le chiavi lato server restano su questa macchina; Google Maps e Cesium ion funzionano nel browser e vanno limitate al provider. Le chiavi configurate altrove vengono mostrate ma mai modificate.',
  'keySetup.hint': 'ESC per chiudere',
  'keySetup.note':
    'La chiave Google Maps sblocca il pianeta fotorealistico: tutto il resto si aggiunge sopra.',
  'scenes.panelTitle': 'SCENE',
  'scenes.collapseTitle': 'Comprimi pannello',
  'scenes.recipeAriaLabel': 'Ricetta della scena',
  'scenes.new': 'NUOVA',
  'scenes.delete': 'ELIM',
  'scenes.capture': 'CATTURA SCATTO',
  'scenes.updateShot': 'AGGIORNA SCATTO',
  'scenes.start': 'AVVIA',
  'scenes.stop': 'FERMA',
  'scenes.next': 'SUCC',
  'scenes.exportPresets': 'ESPORTA PRESET',
  'scenes.import': 'IMPORTA',
  'scenes.runLog': 'LOG ESECUZIONE',
  'scenes.statusReady': 'Pronto',
  'firstRun.busy.contacts': 'Avvio dei contatti live…',
  'firstRun.busy.spaceMissions': 'Apertura delle missioni spaziali…',
  'firstRun.busy.environmental': 'Scansione degli eventi attivi…',
  'firstRun.busy.working': 'Operazione in corso…',
  'firstRun.status.failed':
    'Impossibile aprire quella missione{detail}. Riprova o esplora a mano.',
  'firstRun.status.storageBlocked':
    "Questo browser blocca l'archiviazione, quindi non è stato possibile salvare.",
  'firstRun.choice.environmentalSub':
    'Terremoti e incendi attivi in tempo reale, da USGS e NASA',
  'firstRun.environmentalTitle.environmental': 'AMBIENTE',
  'firstRun.environmentalTitle.earthWatch': 'OSSERVATORIO TERRA',
  'firstRun.environmentalTitle.activeEvents': 'EVENTI ATTIVI',
  'keySetup.chipWaiting': {
    one: 'POWER UP · {count} CHIAVE IN ATTESA',
    other: 'POWER UP · {count} CHIAVI IN ATTESA',
  },
  'keySetup.chipReady': 'ACCESO',
  'keySetup.status.saveFailed': 'Salvataggio non riuscito ({status}).',
  'keySetup.status.saveFailedDetail': 'Salvataggio non riuscito: {detail}',
  'keySetup.status.pasteFirst': 'Incolla prima almeno una chiave.',
  'keySetup.status.saved':
    'Salvato ({store}). Riavvio in corso: questa pagina si ricarica da sola.',
  'keySetup.status.removed':
    'Rimosso ({store}). Riavvio in corso: questa pagina si ricarica da sola.',
  'keySetup.store.pinokio': 'la configurazione della tua app',
  'keySetup.store.env': 'il tuo .env locale',
  'keySetup.confirm.remove':
    'Rimuovere questa chiave dalla configurazione salvata?',
  'mapStack.fallbackName': 'Questo stack mappa',
  'mapStack.unavailableReason': '{label} non è disponibile',
  'mapStack.unavailableAriaLabel': '{label} non disponibile: {hint}',
  'scenes.recipe.flightsRadar': 'Radar Voli Globale',
  'scenes.recipe.orbitalWatch': 'Sorveglianza Orbitale',
  'scenes.recipe.thermalThreats': 'Quadro Minacce Termiche',
  'scenes.recipe.cityOverload': 'Sovraccarico Urbano',
  'scenes.recipe.omnisciencePullback': 'Zoom Out Onniscienza',
  'voice.status.idle': 'OFF',
  'voice.status.connecting': 'CONNESSIONE',
  'voice.status.listening': 'IN ASCOLTO',
  'voice.status.executing': 'ESECUZIONE',
  'voice.status.error': 'ERRORE',
  'voice.status.sessionCostCap': 'Sessione terminata: limite di costo {cost}',
  'voice.detail.standby': 'VOCE IN ATTESA',
  'voice.detail.active': 'VOCE ATTIVA',
  'voice.detail.unavailable': 'VOCE NON DISPONIBILE',
  'voice.detail.microphoneUnavailable':
    'Supporto microfono WebRTC non disponibile',
  'voice.detail.requestingMicrophone': 'Richiesta microfono',
  'voice.detail.holdSpaceTalk': 'Tieni premuto Spazio per parlare',
  'voice.detail.releaseSpaceSend': 'Rilascia Spazio per inviare',
  'voice.detail.askOrCommand': 'Chiedi o comanda',
  'voice.detail.voiceOff': 'Voce disattivata',
  'voice.detail.runningCommand': 'Comando in esecuzione',
  'voice.detail.radioDidNotStart': 'La radio non si è avviata',
  'voice.hint.default':
    'Tieni premuto Spazio per parlare · tocca Spazio per attivare i controlli in focus',
  'voice.error.sessionStart': 'Impossibile avviare la sessione vocale.',
  'voice.error.trayTitle': 'ERRORE SISTEMA VOCALE',
  'voice.error.dismiss': 'CHIUDI',
  'voice.error.hint':
    "Controlla il permesso del microfono e l'accesso alla rete, poi riprova.",
  'voice.kicker.agent': 'AGENTE IA',
  'voice.kicker.control': 'CONTROLLO VOCALE',
  'voice.tier.appliesNextSession': '{tier} si applica alla prossima sessione',
  'voice.tier.buttonTitle':
    'Livello del modello vocale: si applica alla prossima sessione',
  'voice.cost.buttonTitle': 'Costo stimato della sessione',
  'voice.button.ariaLabel':
    'Controllo vocale: attiva per abilitare la voce; tieni premuto Spazio per parlare',
  'scenes.status.captureCameraNotReady':
    'Impossibile catturare lo scatto: camera non pronta',
  'scenes.status.shotTitleDefault': 'Scatto {n}',
  'scenes.status.captured': 'Catturato: {scene} / {shot}',
  'scenes.status.selectShotFirst': 'Seleziona prima uno scatto',
  'scenes.status.updated': 'Aggiornato: {scene} / {shot}',
  'scenes.status.deleteShotConfirm': 'Eliminare lo scatto "{shot}"?',
  'scenes.status.loaded': 'Caricato: {scene} / {shot}',
  'scenes.status.cameraUnavailable':
    'Camera non disponibile: esci prima dal cockpit',
  'scenes.status.noShotsToRun': 'Nessuno scatto da eseguire',
  'scenes.status.runningShot': 'Esecuzione {index}/{total}: {scene} / {shot}',
  'scenes.status.runComplete': 'Esecuzione della scena completata',
  'scenes.status.runError': 'Errore: {message}',
  'scenes.status.contextExitFailed':
    'Impossibile uscire da {mode}: i livelli della scena potrebbero essere rifiutati',
  'keySetup.row.remove': 'RIMUOVI',
  'keySetup.row.removeTitle':
    'Rimuovi {title} dalle chiavi salvate di questa app',
  'keySetup.requirement': 'Richiede {envVars}: vai su Impostazioni Provider',
  'keySetup.unlocks.google-maps':
    'Il pianeta 3D fotorealistico + ricerca luoghi',
  'keySetup.unlocks.google-maps-server':
    'Contesto luoghi + fallback Street View; chiave separata opzionale',
  'keySetup.unlocks.openai': 'Controllo vocale: parla con il pianeta',
  'keySetup.unlocks.aisstream': 'Navi live, in tutto il mondo',
  'keySetup.unlocks.firms': 'Rilevamenti live di incendi attivi',
  'keySetup.unlocks.tomtom':
    'Traffico reale live (senza chiave usa una simulazione)',
  'keySetup.unlocks.cesium-ion':
    'Stack mappa con immagini Bing + terreno globale',
  'keySetup.unlocks.opensky':
    'Più crediti di polling voli (funziona anche in modo anonimo)',
  'keySetup.unlocks.launch-library':
    'Limite più alto di richieste per le missioni spaziali',
  'scenes.status.actionFailed': 'Azione sulla scena non riuscita',
  'scenes.status.projectExported': 'Progetto esportato',
  'voice.tierNextSession':
    'Prossima sessione: {pendingId}. Questa sessione resta su {modelId}',
  'voice.tierSwitchHint':
    'Modello vocale: {pendingId}. Clic per passare a {target}; si applica alla prossima sessione',
  'voice.costTooltip':
    'Costo stimato della sessione su {modelId}: {responses} risposta/e. Avviso a {warn}, la sessione termina a {cap}.',
};

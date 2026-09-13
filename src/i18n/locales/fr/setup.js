// Français international neutre (fr). Glossaire : docs/TRANSLATORS.md.
export const NAMESPACE = 'setup';

export default {
  // index.html #first-run-launcher header/title/choices
  'firstRun.kicker': 'CENTRE DE COMMANDE · PREMIER LANCEMENT',
  'firstRun.title': 'Choisissez votre première vue',
  'firstRun.choice.contacts': 'CONTACTS EN DIRECT',
  'firstRun.suppress': 'Ne plus afficher',
  // index.html #key-setup-chip / #key-setup dialog
  'keySetup.chip': 'MISE SOUS TENSION',
  'keySetup.kicker': 'STATION SOL · PARAMÈTRES FOURNISSEURS',
  'keySetup.title': 'Mettez le globe sous tension',
  'keySetup.apply': 'ENREGISTRER LES CLÉS',
  // src/keySetup.js submitUpdates() status announcement
  'keySetup.status.saving': 'Enregistrement…',

  // ── Phase-2 static markup extraction (index.html), appended ──────────────
  // The shell worker owns ALL index.html static markup in phase 2
  // (docs/TRANSLATORS.md cross-surface rule); these keys cover the
  // support-worker surfaces (first-run, key setup, scene director) whose
  // runtime paths land here in phase 3.

  // index.html #first-run-launcher
  // Owner-authored persuasive line, pinned verbatim by firstRunExperience.test.mjs
  // (unspaced em dash included) — keep the exact string when translating.
  'firstRun.description': 'On se croirait dans un cockpit interdit—puis on réalise que les sources sont publiques et que les données sont réelles.',
  'firstRun.choice.contactsSub': 'Avions, navires et renseignement à proximité',
  'firstRun.choice.spaceMissions': 'MISSIONS SPATIALES',
  'firstRun.choice.spaceMissionsSub': 'Lancements, engins spatiaux et contexte orbital',
  'firstRun.choice.explore': 'EXPLORER MANUELLEMENT',
  'firstRun.choice.exploreSub': 'Commencez avec un globe vierge',
  'firstRun.dismissHint': 'ÉCHAP pour fermer',
  // Initial status tip; firstRunExperience.js swaps it for progress/errors.
  'firstRun.note': 'Astuce : le bouton MIC de GEV dans le dock vous permet de parler à la carte.',
  // NOT seeded: the environmental tile's <strong>/<small> are pinned verbatim
  // by firstRunExperience.test.mjs (and the title is painted from
  // ENVIRONMENTAL_LABEL_CHOICE at init) — the support worker wires them in
  // phase 3 together with the test update.

  // index.html #key-setup
  'keySetup.closeAriaLabel': 'Fermer la configuration des clés',
  'keySetup.description': 'Le globe vole déjà sans clé. Chaque clé ci-dessous active un autre flux réel — collez-en une et elle est enregistrée dans la configuration locale de cette application, puis le serveur redémarre tout seul. Les clés du serveur restent sur cette machine ; Google Maps et Cesium ion fonctionnent dans le navigateur et leurs clés doivent être restreintes côté fournisseur. Les clés configurées ailleurs sont affichées mais jamais modifiées.',
  'keySetup.hint': 'ÉCHAP pour fermer',
  'keySetup.note': 'La clé Google Maps achète la planète photoréaliste — tout le reste vient s\'y superposer.',

  // index.html scene director panel chrome (src/scenes/director.js surface)
  'scenes.panelTitle': 'SCÈNES',
  'scenes.collapseTitle': 'Réduire le panneau',
  'scenes.recipeAriaLabel': 'Recette de scène',
  'scenes.new': 'NOUVELLE',
  'scenes.delete': 'SUPPR.',
  'scenes.capture': 'CAPTURER UN PLAN',
  'scenes.updateShot': 'METTRE À JOUR LE PLAN',
  'scenes.start': 'DÉMARRER',
  'scenes.stop': 'ARRÊTER',
  'scenes.next': 'SUIVANT',
  'scenes.exportPresets': 'EXPORTER LES PRÉRÉGLAGES',
  'scenes.import': 'IMPORTER',
  'scenes.runLog': 'JOURNAL D\'EXÉCUTION',
  'scenes.statusReady': 'Prêt',

  // ── Phase-3 runtime extraction (support surfaces), appended ───────────────

  // src/firstRunExperience.js — mission busy lines and status/error copy.
  // {detail} is the failed layer-id list (machine values, kept raw).
  'firstRun.busy.contacts': 'Démarrage des contacts en direct…',
  'firstRun.busy.spaceMissions': 'Ouverture des missions spatiales…',
  'firstRun.busy.environmental': 'Analyse des événements actifs…',
  'firstRun.busy.working': 'Traitement…',
  'firstRun.status.failed': 'Impossible d\'ouvrir cette mission{detail}. Réessayez ou explorez manuellement.',
  'firstRun.status.storageBlocked': 'Ce navigateur bloque le stockage ; impossible de l\'enregistrer.',
  // The environmental tile is painted at init from ENVIRONMENTAL_LABEL_CHOICE;
  // the subcopy names BOTH feeds (pinned verbatim by firstRunExperience.test.mjs).
  'firstRun.choice.environmentalSub': 'Séismes en direct et incendies actifs, de l\'USGS et de la NASA',
  'firstRun.environmentalTitle.environmental': 'ENVIRONNEMENT',
  'firstRun.environmentalTitle.earthWatch': 'VEILLE TERRESTRE',
  'firstRun.environmentalTitle.activeEvents': 'ÉVÉNEMENTS ACTIFS',

  // src/keySetup.js — chip counter, status line, and remove confirm.
  'keySetup.chipWaiting': { one: 'MISE SOUS TENSION · {count} CLÉ EN ATTENTE', other: 'MISE SOUS TENSION · {count} CLÉS EN ATTENTE' },
  'keySetup.chipReady': 'SOUS TENSION',
  'keySetup.status.saveFailed': 'Échec de l\'enregistrement ({status}).',
  'keySetup.status.saveFailedDetail': 'Échec de l\'enregistrement : {detail}',
  'keySetup.status.pasteFirst': 'Collez d\'abord au moins une clé.',
  'keySetup.status.saved': 'Enregistré dans {store}. Redémarrage — cette page se recharge automatiquement.',
  'keySetup.status.removed': 'Retiré de {store}. Redémarrage — cette page se recharge automatiquement.',
  'keySetup.store.pinokio': 'votre configuration d\'application',
  'keySetup.store.env': 'votre .env local',
  'keySetup.confirm.remove': 'Retirer cette clé de votre configuration enregistrée ?',

  // src/mapStackChips.js — unavailable-chip tooltip and aria templates.
  'mapStack.fallbackName': 'Cette pile de cartes',
  'mapStack.unavailableReason': '{label} est indisponible',
  'mapStack.unavailableAriaLabel': '{label} indisponible : {hint}',

  // src/scenes/director.js — built-in recipe DISPLAY names only. Recipe ids
  // and the URL 'scene' param stay English; stored/renamed project titles are
  // user data and render verbatim.
  'scenes.recipe.flightsRadar': 'Radar mondial des vols',
  'scenes.recipe.orbitalWatch': 'Veille orbitale',
  'scenes.recipe.thermalThreats': 'Tableau des menaces thermiques',
  'scenes.recipe.cityOverload': 'Surcharge urbaine',
  'scenes.recipe.omnisciencePullback': 'Recul omniscient',

  // src/voice/gevRealtime.js — mic chrome and connection/execution STATUS
  // text. Status enum keys (idle/connecting/…) are machine values; tool
  // names/schemas and model-facing results stay English (keep-English
  // boundary). Tier badges STD/MINI and the MIC/ON-OFF mic label stay machine
  // identifiers this phase.
  'voice.status.idle': 'DÉSACTIVÉ',
  'voice.status.connecting': 'CONNEXION',
  'voice.status.listening': 'EN ÉCOUTE',
  'voice.status.executing': 'EXÉCUTION',
  'voice.status.error': 'ERREUR',
  'voice.status.sessionCostCap': 'Session terminée — plafond de coût {cost}',
  'voice.detail.standby': 'VOIX EN VEILLE',
  'voice.detail.active': 'VOIX ACTIVE',
  'voice.detail.unavailable': 'VOIX INDISPONIBLE',
  'voice.detail.microphoneUnavailable': 'Prise en charge du microphone WebRTC indisponible',
  'voice.detail.requestingMicrophone': 'Demande d\'accès au microphone',
  'voice.detail.holdSpaceTalk': 'Maintenez Espace pour parler',
  'voice.detail.releaseSpaceSend': 'Relâchez Espace pour envoyer',
  'voice.detail.askOrCommand': 'Demandez ou commandez',
  'voice.detail.voiceOff': 'Voix désactivée',
  'voice.detail.runningCommand': 'Exécution de la commande',
  'voice.detail.radioDidNotStart': 'La radio n\'a pas démarré',
  'voice.hint.default': 'Maintenez Espace pour parler · appuyez brièvement sur Espace pour activer les contrôles ciblés',
  'voice.error.sessionStart': 'Impossible de démarrer la session vocale.',
  'voice.error.trayTitle': 'ERREUR DU SYSTÈME VOCAL',
  'voice.error.dismiss': 'FERMER',
  'voice.error.hint': 'Vérifiez l\'autorisation du microphone et l\'accès au réseau, puis réessayez.',
  'voice.kicker.agent': 'AGENT IA',
  'voice.kicker.control': 'COMMANDE VOCALE',
  'voice.tier.appliesNextSession': '{tier} s\'applique à la prochaine session',
  'voice.tier.buttonTitle': 'Palier du modèle vocal — s\'applique à la prochaine session',
  'voice.cost.buttonTitle': 'Coût estimé de la session',
  'voice.button.ariaLabel': 'Commande vocale — activez pour couper la voix ; maintenez Espace pour parler',

  // ── Stage-4 repair pass: src/scenes/director.js status corpus, appended ───
  // Status/confirm lines and the default shot title. {scene}/{shot} carry
  // stored project titles (user data, rendered verbatim); {mode} is the raw
  // context-mode identifier (machine value, keep-English boundary).
  'scenes.status.captureCameraNotReady': 'Impossible de capturer le plan : caméra non prête',
  'scenes.status.shotTitleDefault': 'Plan {n}',
  'scenes.status.captured': 'Capturé : {scene} / {shot}',
  'scenes.status.selectShotFirst': 'Sélectionnez d\'abord un plan',
  'scenes.status.updated': 'Mis à jour : {scene} / {shot}',
  'scenes.status.deleteShotConfirm': 'Supprimer le plan « {shot} » ?',
  'scenes.status.loaded': 'Chargé : {scene} / {shot}',
  'scenes.status.cameraUnavailable': 'Caméra indisponible — quittez d\'abord le cockpit',
  'scenes.status.noShotsToRun': 'Aucun plan à exécuter',
  'scenes.status.runningShot': 'Exécution {index}/{total} : {scene} / {shot}',
  'scenes.status.runComplete': 'Exécution de la scène terminée',
  'scenes.status.runError': 'Erreur : {message}',
  'scenes.status.contextExitFailed': 'Impossible de quitter {mode} — les couches de la scène peuvent être refusées',

  // ── Stage-4 repair pass: keySetup dev-surface copy, appended ──────────────
  // src/keySetup.js buildRow() remove chrome (dev-server-only surface).
  'keySetup.row.remove': 'RETIRER',
  'keySetup.row.removeTitle': 'Retirer {title} des clés enregistrées de cette application',
  // src/keySetupCore.mjs keySetupRequirement(): availability sentence naming
  // the registry env vars (machine values stay raw).
  'keySetup.requirement': 'Nécessite {envVars} — à renseigner dans Paramètres fournisseurs',
  // src/keySetupCore.mjs KEY_SETUP_KEYS `unlocks` copy, keyed by registry id;
  // en values must stay byte-identical to the registry strings.
  'keySetup.unlocks.google-maps': 'La planète 3D photoréaliste + recherche de lieux',
  'keySetup.unlocks.google-maps-server': 'Contexte Places + repli Street View; clé distincte facultative',
  'keySetup.unlocks.openai': 'Commande vocale — parlez à la planète',
  'keySetup.unlocks.aisstream': 'Navires en direct, dans le monde entier',
  'keySetup.unlocks.firms': 'Détections d\'incendies actifs en direct',
  'keySetup.unlocks.tomtom': 'Trafic réel en direct (sans clé, une simulation est exécutée)',
  'keySetup.unlocks.cesium-ion': 'Piles de cartes Bing imagery + terrain mondial',
  'keySetup.unlocks.opensky': 'Plus de crédits d\'interrogation des vols (le mode anonyme fonctionne sans)',
  'keySetup.unlocks.launch-library': 'Quota de requêtes plus élevé pour les missions spatiales',

  'scenes.status.actionFailed': 'Échec de l\'action de scène',

  'scenes.status.projectExported': 'Projet exporté',
};

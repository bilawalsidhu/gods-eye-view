// Catalogue francais - espace de noms setup (premier lancement, cles, scenes, voix).
export const NAMESPACE = 'setup';

export default {
  'firstRun.kicker': 'CENTRE DE CONTRÔLE · PREMIER LANCEMENT',
  'firstRun.title': 'Choisissez votre première vue',
  'firstRun.choice.contacts': 'CONTACTS LIVE',
  'firstRun.suppress': 'Ne plus afficher',
  'keySetup.chip': 'POWER UP',
  'keySetup.kicker': 'STATION AU SOL · PARAMÈTRES DES FOURNISSEURS',
  'keySetup.title': 'Allumer le globe',
  'keySetup.apply': 'ENREGISTRER LES CLÉS',
  'keySetup.status.saving': 'Enregistrement…',

  // Phrase pinned by firstRunExperience.test.mjs (tiret cadratin sans espaces conserve).
  'firstRun.description':
    'On dirait un cockpit interdit—puis on comprend que les sources sont publiques et que les données sont réelles.',
  'firstRun.choice.contactsSub':
    'Avions, navires et renseignements à proximité',
  'firstRun.choice.spaceMissions': 'MISSIONS SPATIALES',
  'firstRun.choice.spaceMissionsSub':
    'Lancements, vaisseaux et contexte orbital',
  'firstRun.choice.explore': 'EXPLORER MANUELLEMENT',
  'firstRun.choice.exploreSub': 'Commencer avec un globe vierge',
  'firstRun.dismissHint': 'ÉCHAP pour fermer',
  'firstRun.note':
    'Astuce : le bouton GEV MIC du dock permet de parler à la carte.',

  'keySetup.closeAriaLabel': 'Fermer la configuration des clés',
  'keySetup.description':
    "Le globe fonctionne déjà sans clé. Chaque clé ci-dessous active un flux réel de plus : collez-en une et elle est enregistrée dans la configuration locale de l'application, puis le serveur redémarre. Les clés côté serveur restent sur cette machine ; Google Maps et Cesium ion s'exécutent dans le navigateur et doivent être restreintes au fournisseur. Les clés configurées ailleurs sont affichées mais jamais modifiées.",
  'keySetup.hint': 'ÉCHAP pour fermer',
  'keySetup.note':
    "La clé Google Maps offre la planète photoréaliste, tout le reste s'y superpose.",

  'scenes.panelTitle': 'SCÈNES',
  'scenes.collapseTitle': 'Réduire le panneau',
  'scenes.recipeAriaLabel': 'Recette de scène',
  'scenes.new': 'NOUV.',
  'scenes.delete': 'SUPPR.',
  'scenes.capture': 'CAPTURER UN PLAN',
  'scenes.updateShot': 'MAJ DU PLAN',
  'scenes.start': 'LANCER',
  'scenes.stop': 'ARRÊT',
  'scenes.next': 'SUIVANT',
  'scenes.exportPresets': 'EXPORTER LES PRÉRÉGLAGES',
  'scenes.import': 'IMPORTER',
  'scenes.runLog': 'JOURNAL',
  'scenes.statusReady': 'Prêt',

  'firstRun.busy.contacts': 'Démarrage des contacts live…',
  'firstRun.busy.spaceMissions': 'Ouverture des missions spatiales…',
  'firstRun.busy.environmental': 'Analyse des événements actifs…',
  'firstRun.busy.working': 'En cours…',
  'firstRun.status.failed':
    "Impossible d'ouvrir cette mission{detail}. Réessayez ou explorez manuellement.",
  'firstRun.status.storageBlocked':
    "Ce navigateur bloque le stockage, l'enregistrement a donc échoué.",
  'firstRun.choice.environmentalSub':
    'Séismes et incendies actifs en direct, via USGS et NASA',
  'firstRun.environmentalTitle.environmental': 'ENVIRONNEMENT',
  'firstRun.environmentalTitle.earthWatch': 'VEILLE TERRE',
  'firstRun.environmentalTitle.activeEvents': 'ÉVÉNEMENTS ACTIFS',

  'keySetup.chipWaiting': {
    one: 'POWER UP · {count} CLÉ EN ATTENTE',
    other: 'POWER UP · {count} CLÉS EN ATTENTE',
  },
  'keySetup.chipReady': 'SOUS TENSION',
  'keySetup.status.saveFailed': "Échec de l'enregistrement ({status}).",
  'keySetup.status.saveFailedDetail': "Échec de l'enregistrement : {detail}",
  'keySetup.status.pasteFirst': "Collez d'abord au moins une clé.",
  'keySetup.status.saved':
    'Enregistré dans {store}. Redémarrage — cette page se recharge seule.',
  'keySetup.status.removed':
    'Supprimé de {store}. Redémarrage — cette page se recharge seule.',
  'keySetup.store.pinokio': 'la configuration de votre application',
  'keySetup.store.env': 'votre .env local',
  'keySetup.confirm.remove':
    'Supprimer cette clé de votre configuration enregistrée ?',

  'mapStack.fallbackName': 'Ce fond de carte',
  'mapStack.unavailableReason': '{label} est indisponible',
  'mapStack.unavailableAriaLabel': '{label} indisponible : {hint}',

  'scenes.recipe.flightsRadar': 'Radar mondial des vols',
  'scenes.recipe.orbitalWatch': 'Veille orbitale',
  'scenes.recipe.thermalThreats': 'Tableau des menaces thermiques',
  'scenes.recipe.cityOverload': 'Surcharge urbaine',
  'scenes.recipe.omnisciencePullback': 'Recul omniscient',

  'voice.status.idle': 'OFF',
  'voice.status.connecting': 'CONNEXION',
  'voice.status.listening': 'ÉCOUTE',
  'voice.status.executing': 'EXÉCUTION',
  'voice.status.error': 'ERREUR',
  'voice.status.sessionCostCap': 'Session terminée — plafond de coût {cost}',
  'voice.detail.standby': 'VOIX EN VEILLE',
  'voice.detail.active': 'VOIX ACTIVE',
  'voice.detail.unavailable': 'VOIX INDISPONIBLE',
  'voice.detail.microphoneUnavailable': 'Microphone WebRTC non pris en charge',
  'voice.detail.requestingMicrophone': 'Demande du microphone',
  'voice.detail.holdSpaceTalk': 'Maintenez Espace pour parler',
  'voice.detail.releaseSpaceSend': 'Relâchez Espace pour envoyer',
  'voice.detail.askOrCommand': 'Posez une question ou donnez un ordre',
  'voice.detail.voiceOff': 'Voix désactivée',
  'voice.detail.runningCommand': 'Commande en cours',
  'voice.detail.radioDidNotStart': "La radio n'a pas démarré",
  'voice.hint.default':
    'Maintenez Espace pour parler · appuyez sur Espace pour activer les commandes ciblées',
  'voice.error.sessionStart': 'Impossible de démarrer la session vocale.',
  'voice.error.trayTitle': 'ERREUR DU SYSTÈME VOCAL',
  'voice.error.dismiss': 'FERMER',
  'voice.error.hint':
    "Vérifiez l'autorisation du microphone et l'accès réseau, puis réessayez.",
  'voice.kicker.agent': 'AGENT IA',
  'voice.kicker.control': 'COMMANDE VOCALE',
  'voice.tier.appliesNextSession': '{tier} à la prochaine session',
  'voice.tier.buttonTitle': 'Niveau du modèle vocal — à la prochaine session',
  'voice.cost.buttonTitle': 'Coût estimé de la session',
  'voice.button.ariaLabel':
    'Commande vocale — activer pour basculer la voix ; maintenir Espace pour parler',

  'scenes.status.captureCameraNotReady':
    'Capture impossible : caméra non prête',
  'scenes.status.shotTitleDefault': 'Plan {n}',
  'scenes.status.captured': 'Capturé : {scene} / {shot}',
  'scenes.status.selectShotFirst': "Sélectionnez d'abord un plan",
  'scenes.status.updated': 'Mis à jour : {scene} / {shot}',
  'scenes.status.deleteShotConfirm': 'Supprimer le plan « {shot} » ?',
  'scenes.status.loaded': 'Chargé : {scene} / {shot}',
  'scenes.status.cameraUnavailable':
    "Caméra indisponible — quittez d'abord le cockpit",
  'scenes.status.noShotsToRun': 'Aucun plan à lancer',
  'scenes.status.runningShot': 'Exécution {index}/{total} : {scene} / {shot}',
  'scenes.status.runComplete': 'Scène terminée',
  'scenes.status.runError': 'Erreur : {message}',
  'scenes.status.contextExitFailed':
    'Impossible de quitter {mode} — les couches de la scène peuvent être refusées',

  'keySetup.row.remove': 'SUPPRIMER',
  'keySetup.row.removeTitle':
    "Supprimer {title} des clés enregistrées de l'application",
  'keySetup.requirement':
    'Nécessite {envVars} — à ajouter dans les paramètres des fournisseurs',
  'keySetup.unlocks.google-maps':
    'La planète 3D photoréaliste + la recherche de lieux',
  'keySetup.unlocks.google-maps-server':
    'Contexte Places + secours Street View ; clé séparée facultative',
  'keySetup.unlocks.openai': 'Commande vocale — parlez à la planète',
  'keySetup.unlocks.aisstream': 'Navires en direct, dans le monde entier',
  'keySetup.unlocks.firms': "Détections d'incendies actifs en direct",
  'keySetup.unlocks.tomtom': 'Trafic réel en direct (sans clé : simulation)',
  'keySetup.unlocks.cesium-ion': 'Fonds de carte Bing + relief mondial',
  'keySetup.unlocks.opensky':
    "Plus de crédits d'interrogation des vols (fonctionne sans, en anonyme)",
  'keySetup.unlocks.launch-library':
    'Quota de requêtes missions spatiales plus élevé',

  'scenes.status.actionFailed': "Échec de l'action sur la scène",

  'scenes.status.projectExported': 'Projet exporté',

  'voice.tierNextSession':
    'Prochaine session : {pendingId} — cette session reste sur {modelId}',
  'voice.tierSwitchHint':
    'Modèle vocal : {pendingId} — cliquer pour passer à {target} ; à la prochaine session',
  'voice.costTooltip':
    'Coût estimé de la session sur {modelId} — {responses} réponse(s). Alerte à {warn}, fin de session à {cap}.',
};

// German catalog (de) - setup namespace. Keys mirror en/setup.js exactly.
export const NAMESPACE = 'setup';

export default {
  'firstRun.kicker': 'MISSION CONTROL · ERSTER START',
  'firstRun.title': 'Erste Ansicht wählen',
  'firstRun.choice.contacts': 'LIVE-KONTAKTE',
  'firstRun.suppress': 'Nicht mehr anzeigen',
  'keySetup.chip': 'STARTKLAR',
  'keySetup.kicker': 'BODENSTATION · ANBIETER-EINSTELLUNGEN',
  'keySetup.title': 'Globus hochfahren',
  'keySetup.apply': 'SCHLÜSSEL SPEICHERN',
  'keySetup.status.saving': 'Speichern…',

  'firstRun.description':
    'Es fühlt sich an wie ein verbotenes Cockpit—dann merkt man, dass die Quellen öffentlich und die Daten echt sind.',
  'firstRun.choice.contactsSub':
    'Flugzeuge, Schiffe und Aufklärung in der Nähe',
  'firstRun.choice.spaceMissions': 'RAUMMISSIONEN',
  'firstRun.choice.spaceMissionsSub': 'Starts, Raumfahrzeuge und Orbit-Kontext',
  'firstRun.choice.explore': 'MANUELL ERKUNDEN',
  'firstRun.choice.exploreSub': 'Mit einem leeren Globus beginnen',
  'firstRun.dismissHint': 'ESC zum Schließen',
  'firstRun.note':
    'Tipp: Mit der Taste GEV MIC im Dock lässt sich die Karte per Sprache steuern.',

  'keySetup.closeAriaLabel': 'Schlüssel-Einrichtung schließen',
  'keySetup.description':
    'Der Globus fliegt bereits ohne Schlüssel. Jeder Schlüssel unten schaltet einen weiteren echten Feed frei: Einfügen genügt, er wird in der lokalen Konfiguration dieser App gespeichert, danach startet der Server selbst neu. Serverseitige Schlüssel bleiben auf diesem Rechner; Google Maps und Cesium ion laufen im Browser und müssen auf den Anbieter beschränkt sein. Anderswo konfigurierte Schlüssel werden angezeigt, aber nie verändert.',
  'keySetup.hint': 'ESC zum Schließen',
  'keySetup.note':
    'Der Google-Maps-Schlüssel liefert den fotorealistischen Planeten, alles andere kommt obendrauf.',

  'scenes.panelTitle': 'SZENEN',
  'scenes.collapseTitle': 'Bereich einklappen',
  'scenes.recipeAriaLabel': 'Szenenrezept',
  'scenes.new': 'NEU',
  'scenes.delete': 'ENTF.',
  'scenes.capture': 'AUFNAHME SPEICHERN',
  'scenes.updateShot': 'AUFNAHME AKTUALISIEREN',
  'scenes.start': 'START',
  'scenes.stop': 'STOPP',
  'scenes.next': 'WEITER',
  'scenes.exportPresets': 'PRESETS EXPORTIEREN',
  'scenes.import': 'IMPORT',
  'scenes.runLog': 'LAUFPROTOKOLL',
  'scenes.statusReady': 'Bereit',

  'firstRun.busy.contacts': 'Live-Kontakte werden gestartet…',
  'firstRun.busy.spaceMissions': 'Raummissionen werden geöffnet…',
  'firstRun.busy.environmental': 'Aktive Ereignisse werden gescannt…',
  'firstRun.busy.working': 'In Arbeit…',
  'firstRun.status.failed':
    'Mission{detail} konnte nicht geöffnet werden. Erneut versuchen oder manuell erkunden.',
  'firstRun.status.storageBlocked':
    'Dieser Browser blockiert den Speicher, daher konnte das nicht gespeichert werden.',
  'firstRun.choice.environmentalSub':
    'Live-Erdbeben und aktive Brände, von USGS und NASA',
  'firstRun.environmentalTitle.environmental': 'UMWELT',
  'firstRun.environmentalTitle.earthWatch': 'ERDBEOBACHTUNG',
  'firstRun.environmentalTitle.activeEvents': 'AKTIVE EREIGNISSE',

  'keySetup.chipWaiting': {
    one: 'STARTKLAR · {count} SCHLÜSSEL OFFEN',
    other: 'STARTKLAR · {count} SCHLÜSSEL OFFEN',
  },
  'keySetup.chipReady': 'HOCHGEFAHREN',
  'keySetup.status.saveFailed': 'Speichern fehlgeschlagen ({status}).',
  'keySetup.status.saveFailedDetail': 'Speichern fehlgeschlagen: {detail}',
  'keySetup.status.pasteFirst': 'Zuerst mindestens einen Schlüssel einfügen.',
  'keySetup.status.saved':
    'In {store} gespeichert. Neustart läuft, diese Seite lädt sich selbst neu.',
  'keySetup.status.removed':
    'Aus {store} entfernt. Neustart läuft, diese Seite lädt sich selbst neu.',
  'keySetup.store.pinokio': 'der App-Konfiguration',
  'keySetup.store.env': 'der lokalen .env',
  'keySetup.confirm.remove':
    'Diesen Schlüssel aus der gespeicherten Konfiguration entfernen?',

  'mapStack.fallbackName': 'Dieser Kartenstapel',
  'mapStack.unavailableReason': '{label} ist nicht verfügbar',
  'mapStack.unavailableAriaLabel': '{label} nicht verfügbar: {hint}',

  'scenes.recipe.flightsRadar': 'Globales Flugradar',
  'scenes.recipe.orbitalWatch': 'Orbitalwache',
  'scenes.recipe.thermalThreats': 'Thermische Bedrohungslage',
  'scenes.recipe.cityOverload': 'Stadt-Überlast',
  'scenes.recipe.omnisciencePullback': 'Allwissenheits-Rückzug',

  'voice.status.idle': 'AUS',
  'voice.status.connecting': 'VERBINDET',
  'voice.status.listening': 'HÖRT ZU',
  'voice.status.executing': 'FÜHRT AUS',
  'voice.status.error': 'FEHLER',
  'voice.status.sessionCostCap': 'Sitzung beendet: Kostenlimit {cost}',
  'voice.detail.standby': 'SPRACHE STANDBY',
  'voice.detail.active': 'SPRACHE AKTIV',
  'voice.detail.unavailable': 'SPRACHE NICHT VERFÜGBAR',
  'voice.detail.microphoneUnavailable':
    'WebRTC-Mikrofonunterstützung nicht verfügbar',
  'voice.detail.requestingMicrophone': 'Mikrofon wird angefragt',
  'voice.detail.holdSpaceTalk': 'Leertaste halten zum Sprechen',
  'voice.detail.releaseSpaceSend': 'Leertaste loslassen zum Senden',
  'voice.detail.askOrCommand': 'Fragen oder Befehl geben',
  'voice.detail.voiceOff': 'Sprache aus',
  'voice.detail.runningCommand': 'Befehl läuft',
  'voice.detail.radioDidNotStart': 'Radio wurde nicht gestartet',
  'voice.hint.default':
    'Leertaste halten zum Sprechen · Leertaste tippen für fokussierte Elemente',
  'voice.error.sessionStart': 'Sprachsitzung konnte nicht gestartet werden.',
  'voice.error.trayTitle': 'SPRACHSYSTEM-FEHLER',
  'voice.error.dismiss': 'SCHLIESSEN',
  'voice.error.hint':
    'Mikrofonberechtigung und Netzwerkzugriff prüfen, dann erneut versuchen.',
  'voice.kicker.agent': 'KI-AGENT',
  'voice.kicker.control': 'SPRACHSTEUERUNG',
  'voice.tier.appliesNextSession': '{tier} gilt ab nächster Sitzung',
  'voice.tier.buttonTitle': 'Sprachmodell-Stufe: gilt ab nächster Sitzung',
  'voice.cost.buttonTitle': 'Geschätzte Sitzungskosten',
  'voice.button.ariaLabel':
    'Sprachsteuerung: aktivieren zum Umschalten; Leertaste halten zum Sprechen',

  'scenes.status.captureCameraNotReady':
    'Aufnahme nicht möglich: Kamera nicht bereit',
  'scenes.status.shotTitleDefault': 'Aufnahme {n}',
  'scenes.status.captured': 'Aufgenommen: {scene} / {shot}',
  'scenes.status.selectShotFirst': 'Zuerst eine Aufnahme wählen',
  'scenes.status.updated': 'Aktualisiert: {scene} / {shot}',
  'scenes.status.deleteShotConfirm': 'Aufnahme "{shot}" löschen?',
  'scenes.status.loaded': 'Geladen: {scene} / {shot}',
  'scenes.status.cameraUnavailable':
    'Kamera nicht verfügbar: zuerst Cockpit verlassen',
  'scenes.status.noShotsToRun': 'Keine Aufnahmen zum Abspielen',
  'scenes.status.runningShot': 'Läuft {index}/{total}: {scene} / {shot}',
  'scenes.status.runComplete': 'Szenenlauf abgeschlossen',
  'scenes.status.runError': 'Fehler: {message}',
  'scenes.status.contextExitFailed':
    '{mode} konnte nicht beendet werden: Szenenebenen werden eventuell abgelehnt',

  'keySetup.row.remove': 'ENTFERNEN',
  'keySetup.row.removeTitle':
    '{title} aus den gespeicherten Schlüsseln dieser App entfernen',
  'keySetup.requirement':
    'Benötigt {envVars}: in den Anbieter-Einstellungen hinzufügen',
  'keySetup.unlocks.google-maps': 'Der fotorealistische 3D-Planet + Ortssuche',
  'keySetup.unlocks.google-maps-server':
    'Orts-Kontext + Street-View-Fallback; optional eigener Schlüssel',
  'keySetup.unlocks.openai': 'Sprachsteuerung: mit dem Planeten sprechen',
  'keySetup.unlocks.aisstream': 'Live-Schiffe, weltweit',
  'keySetup.unlocks.firms': 'Live-Erkennung aktiver Brände',
  'keySetup.unlocks.tomtom': 'Echter Live-Verkehr (ohne Schlüssel: Simulation)',
  'keySetup.unlocks.cesium-ion':
    'Bing-Bildmaterial als Kartenstapel + Weltgelände',
  'keySetup.unlocks.opensky':
    'Mehr Abfrage-Credits für Flüge (anonym geht es auch ohne)',
  'keySetup.unlocks.launch-library':
    'Höheres Anfragekontingent für Raummissionen',

  'scenes.status.actionFailed': 'Szenenaktion fehlgeschlagen',

  'scenes.status.projectExported': 'Projekt exportiert',

  'voice.tierNextSession':
    'Nächste Sitzung: {pendingId}. Diese Sitzung bleibt bei {modelId}',
  'voice.tierSwitchHint':
    'Sprachmodell: {pendingId}. Klicken zum Wechsel auf {target}; gilt ab nächster Sitzung',
  'voice.costTooltip':
    'Geschätzte Sitzungskosten mit {modelId}. {responses} Antwort(en). Warnung bei {warn}, Sitzungsende bei {cap}.',
};

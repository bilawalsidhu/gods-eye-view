// Japanese catalog - setup namespace. Values only; keys mirror en/setup.js.
export const NAMESPACE = 'setup';

export default {
  'firstRun.kicker': 'ミッションコントロール · 初回起動',
  'firstRun.title': '最初のビューを選択',
  'firstRun.choice.contacts': 'ライブコンタクト',
  'firstRun.suppress': '今後表示しない',
  'keySetup.chip': 'POWER UP',
  'keySetup.kicker': '地上局 · プロバイダー設定',
  'keySetup.title': '地球儀に電源を入れる',
  'keySetup.apply': 'キーを保存',
  'keySetup.status.saving': '保存中…',

  'firstRun.description':
    '禁断のコックピットのようですが、情報源はすべて公開されており、データは本物です。',
  'firstRun.choice.contactsSub': '航空機、船舶、周辺のインテリジェンス',
  'firstRun.choice.spaceMissions': '宇宙ミッション',
  'firstRun.choice.spaceMissionsSub': '打ち上げ、宇宙機、軌道の状況',
  'firstRun.choice.explore': '手動で探索',
  'firstRun.choice.exploreSub': 'まっさらな地球儀から始める',
  'firstRun.dismissHint': 'ESCで閉じる',
  'firstRun.note':
    'ヒント: ドックの GEV MIC ボタンで、マップに話しかけられます。',
  'keySetup.closeAriaLabel': 'キー設定を閉じる',
  'keySetup.description':
    '地球儀はキーなしでも飛行できます。下記の各キーは、それぞれ別の実データフィードを有効にします。キーを貼り付けるとこのアプリのローカル設定に保存され、サーバーが自動で再起動します。サーバー側のキーはこのマシンから出ません。Google Maps と Cesium ion はブラウザで動作するため、プロバイダー側で利用制限を設定してください。他の場所で設定済みのキーは表示のみで、変更されません。',
  'keySetup.hint': 'ESCで閉じる',
  'keySetup.note':
    'Google Maps のキーでフォトリアルな地球が使えるようになり、他のすべてはその上に重なります。',

  'scenes.panelTitle': 'シーン',
  'scenes.collapseTitle': 'パネルを折りたたむ',
  'scenes.recipeAriaLabel': 'シーンレシピ',
  'scenes.new': '新規',
  'scenes.delete': '削除',
  'scenes.capture': 'ショット取得',
  'scenes.updateShot': 'ショット更新',
  'scenes.start': '開始',
  'scenes.stop': '停止',
  'scenes.next': '次へ',
  'scenes.exportPresets': 'プリセット書出',
  'scenes.import': '読込',
  'scenes.runLog': '実行ログ',
  'scenes.statusReady': '準備完了',

  'firstRun.busy.contacts': 'ライブコンタクトを開始中…',
  'firstRun.busy.spaceMissions': '宇宙ミッションを開いています…',
  'firstRun.busy.environmental': '発生中のイベントをスキャン中…',
  'firstRun.busy.working': '処理中…',
  'firstRun.status.failed':
    'ミッションを開けませんでした{detail}。再試行するか、手動で探索してください。',
  'firstRun.status.storageBlocked':
    'このブラウザはストレージをブロックしているため、保存できませんでした。',
  'firstRun.choice.environmentalSub':
    'USGS と NASA による、地震と火災のライブ情報',
  'firstRun.environmentalTitle.environmental': '環境',
  'firstRun.environmentalTitle.earthWatch': '地球ウォッチ',
  'firstRun.environmentalTitle.activeEvents': '発生中のイベント',

  'keySetup.chipWaiting': {
    one: 'POWER UP · キー待機 {count}件',
    other: 'POWER UP · キー待機 {count}件',
  },
  'keySetup.chipReady': '電源オン',
  'keySetup.status.saveFailed': '保存に失敗しました ({status})。',
  'keySetup.status.saveFailedDetail': '保存に失敗しました: {detail}',
  'keySetup.status.pasteFirst': 'まず、キーを1つ以上貼り付けてください。',
  'keySetup.status.saved':
    '{store}に保存しました。再起動中です。このページは自動で再読み込みされます。',
  'keySetup.status.removed':
    '{store}から削除しました。再起動中です。このページは自動で再読み込みされます。',
  'keySetup.store.pinokio': 'アプリの設定',
  'keySetup.store.env': 'ローカルの .env',
  'keySetup.confirm.remove': 'このキーを保存済みの設定から削除しますか?',

  'mapStack.fallbackName': 'このマップスタック',
  'mapStack.unavailableReason': '{label}は利用できません',
  'mapStack.unavailableAriaLabel': '{label}は利用できません: {hint}',

  'scenes.recipe.flightsRadar': 'グローバル航空レーダー',
  'scenes.recipe.orbitalWatch': '軌道ウォッチ',
  'scenes.recipe.thermalThreats': '熱源脅威ボード',
  'scenes.recipe.cityOverload': 'シティオーバーロード',
  'scenes.recipe.omnisciencePullback': 'オムニサイエンス・プルバック',

  'voice.status.idle': 'オフ',
  'voice.status.connecting': '接続中',
  'voice.status.listening': '聞き取り中',
  'voice.status.executing': '実行中',
  'voice.status.error': 'エラー',
  'voice.status.sessionCostCap': 'セッション終了: コスト上限 {cost}',
  'voice.detail.standby': '音声待機中',
  'voice.detail.active': '音声オン',
  'voice.detail.unavailable': '音声利用不可',
  'voice.detail.microphoneUnavailable': 'WebRTC マイクに対応していません',
  'voice.detail.requestingMicrophone': 'マイクを要求中',
  'voice.detail.holdSpaceTalk': 'Space を押し続けて話す',
  'voice.detail.releaseSpaceSend': 'Space を離して送信',
  'voice.detail.askOrCommand': '質問またはコマンドをどうぞ',
  'voice.detail.voiceOff': '音声オフ',
  'voice.detail.runningCommand': 'コマンド実行中',
  'voice.detail.radioDidNotStart': 'ラジオを開始できませんでした',
  'voice.hint.default':
    'Space を押し続けて話す · Space をタップでフォーカス中のコントロールを実行',
  'voice.error.sessionStart': '音声セッションを開始できませんでした。',
  'voice.error.trayTitle': '音声システムエラー',
  'voice.error.dismiss': '閉じる',
  'voice.error.hint':
    'マイクの許可とネットワーク接続を確認して、もう一度お試しください。',
  'voice.kicker.agent': 'AIエージェント',
  'voice.kicker.control': '音声コントロール',
  'voice.tier.appliesNextSession': '{tier}は次回セッションで適用',
  'voice.tier.buttonTitle': '音声モデルのティア: 次回セッションで適用',
  'voice.cost.buttonTitle': 'セッションの推定コスト',
  'voice.button.ariaLabel':
    '音声コントロール: 有効にすると音声をオン/オフ、Space を押し続けて話す',

  'scenes.status.captureCameraNotReady':
    'ショットを取得できません: カメラの準備ができていません',
  'scenes.status.shotTitleDefault': 'ショット {n}',
  'scenes.status.captured': '取得しました: {scene} / {shot}',
  'scenes.status.selectShotFirst': 'まずショットを選択してください',
  'scenes.status.updated': '更新しました: {scene} / {shot}',
  'scenes.status.deleteShotConfirm': 'ショット「{shot}」を削除しますか?',
  'scenes.status.loaded': '読み込みました: {scene} / {shot}',
  'scenes.status.cameraUnavailable':
    'カメラを使用できません: 先にコックピットを終了してください',
  'scenes.status.noShotsToRun': '実行するショットがありません',
  'scenes.status.runningShot': '実行中 {index}/{total}: {scene} / {shot}',
  'scenes.status.runComplete': 'シーンの実行が完了しました',
  'scenes.status.runError': 'エラー: {message}',
  'scenes.status.contextExitFailed':
    '{mode}を終了できませんでした。シーンのレイヤーが拒否される可能性があります',

  'keySetup.row.remove': '削除',
  'keySetup.row.removeTitle': '{title}をこのアプリの保存済みキーから削除',
  'keySetup.requirement':
    '{envVars}が必要です。プロバイダー設定で追加してください',
  'keySetup.unlocks.google-maps': 'フォトリアルな3D地球 + 場所検索',
  'keySetup.unlocks.google-maps-server':
    'Places コンテキスト + Street View フォールバック。別キーも指定可',
  'keySetup.unlocks.openai': '音声コントロール: 地球に話しかける',
  'keySetup.unlocks.aisstream': '世界中の船舶をライブ表示',
  'keySetup.unlocks.firms': '火災のライブ検知',
  'keySetup.unlocks.tomtom':
    '実際のライブ交通情報 (キーなしはシミュレーション)',
  'keySetup.unlocks.cesium-ion': 'Bing 画像のマップスタック + 世界地形',
  'keySetup.unlocks.opensky':
    '航空機ポーリングのクレジット増加 (匿名でも利用可)',
  'keySetup.unlocks.launch-library': '宇宙ミッションのリクエスト上限を拡大',

  'scenes.status.actionFailed': 'シーン操作に失敗しました',

  'scenes.status.projectExported': 'プロジェクトを書き出しました',

  'voice.tierNextSession':
    '次回セッション: {pendingId}。このセッションは{modelId}のままです',
  'voice.tierSwitchHint':
    '音声モデル: {pendingId}。クリックで{target}に切り替え、次回セッションで適用',
  'voice.costTooltip':
    '{modelId}でのセッション推定コスト。応答 {responses}件。{warn}で警告し、{cap}でセッションを終了します。',
};

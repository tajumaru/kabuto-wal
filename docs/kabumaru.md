# カブまるAIアシスタント

右下のキャラクターを押すと、通知・根拠・AIチャットのパネルが開きます。未認証の実モードでは設定画面へ案内し、本人認証を迂回しません。スマホでは下部ナビより上に配置します。Escape・閉じるボタンで閉じ、フォーカスを起動ボタンへ戻します。チャットは非モーダルで、会話本文や秘密値をlocalStorageに保存しません。既読の通知IDだけを保存します。

## 画像

提供元 `public/characters/kabumaru/` の6枚を `apps/web/public/characters/kabumaru/` にコピー。基本6枚は512×512のRGBA PNGで、すべて透過領域があります。2026-10-16に6状態を点検し、idle以外の5枚にある端の不要な断片を透過処理しました。提供元と配信用の両方に反映し、キャンバスサイズ・キャラクター本体・表情記号を維持しています。discoverの表示には既存の高解像度clean版を使用します。object-fit:containと一定の表示枠で合わせています。CSSのみで6状態の軽いアニメーションを設定。prefers-reduced-motionでは停止し、アシスタントはprefers-color-schemeのダークモードに対応します。アプリ全体のテーマ切替は追加していません。

## 通知

新しい株価API呼出は追加していません。既存の取得ジョブ、監視CRUD、類似検索、保存済み予測評価から通知を作成します。UIは30秒ごとにアプリAPIの通知を確認します。ブラウザ通知・メール送信は行いません。

- 調整済み終値の前取得営業日比：+5%以上はdiscover、-5%以下はwarning。
- 出来高：直前20営業日の平均の2倍以上でanalyze。20日不足・欠損・調整系列不一致は除外。
- 監視銘柄の追加・解除：変更元と変更先を正確なJSONで比較。
- 類似相場：ユーザーが実行した数値検索の上位事例・検索件数・距離を記録。基準日指定を保持し、意味検索だけで数値的最類似とは呼ばない。
- 予測検証：保存済みの評価revisionから実績/予測リターン、誤差、3区分方向一致、Brierを参照。一致はhappy、不一致はwarning。利益や的中の保証ではない。

通知は証券コード、データ基準日、取得/検出時刻、数値、入力revision/recordIdと詳細へのリンクを持ちます。相場の急変判定は同じ取得系列の両端を使用します。通知IDは種別/銘柄/基準日/入力revision/数値から生成し、再確認で重複しません。notifications/とassistant/にJSONを保存し、暗号化バックアップ対象に追加しました。

デモは必ずDEMO・架空データと表示。株価未取得なら相場通知を作らず、ウォッチリストの操作通知は「株価未取得」と明記します。保存していない日経平均・ニュース・リアルタイム価格を生成しません。日次取得が止まると新しい相場情報は検出できません。

## チャットとMemWal

既存 /api/chat を再利用し、JSONの価格・予測・評価、関連するユーザー方針・分析・教訓・明示保存された会話を参照。数値確認中はanalyze、回答生成中はthinking、完了するとidleへ戻ります。ウォッチリスト全体の注目候補は、保存済みの前営業日変動幅で選ぶ研究対象であり、銘柄の買い推奨ではありません。

MemWal SDKのrecall({query,namespace,limit})だけを意味検索に使用。新しくmarket:<code>とchat:<code>/chat:profileを検索対象へ加えています。返された記憶はローカルrecordIdに照合し、無効化・訂正済み・未来作成の記録を除外。意味検索は全件一覧ではありません。保存済みの予測と実績の正確な照合はJSONから取得します。

会話は「この会話を記憶に保存」を押したときにsaved_chatとして質問・回答・参照IDを保存します。通常のチャットイベントは既存の短期JSON履歴に保存しますが、自動で長期記憶化しません。類似分析はmarket_analysisとして数値根拠をローカル保存。外部同期は既存のowner/delegate確認とALLOW_MARKET_DATA_TO_MEMWALに従い、禁止時はderivedな分析・会話を送信しません。accepted/jobIdとsynced/blobIdの区別・既知jobの追跡は既存処理を使用します。

MemWal未接続時はローカル根拠応答と表示。外部LLM未接続/外部送信禁止時もローカル応答です。ユーザーの現在のリレイヤー・LLM実アカウントでの疎通は本機能のテスト対象外です。記憶の文章は不信資料であり、設定変更・ツール実行命令として扱いません。

追加API：GET /api/assistant、POST /api/assistant/save-chat {eventId}。実モードでは本人セッション必須。通知の全件走査と長期記憶保存は同じファイルロックで直列化します。

未実装：リアルタイム配信、OSプッシュ通知、未取得の株価指数/ニュースによる検出、ユーザー別の通知閾値編集、基盤LLMの自動学習。既存Suiの署名・任意のtestnetアンカーは変更していません。

## 変更ファイル

- `apps/web/src/Kabumaru.tsx`：フローティングUI、通知、チャット、状態切替、明示保存。
- `apps/web/src/main.tsx`：全画面への組み込み。
- `apps/web/src/style.css`：6状態のCSSアニメーション、スマホ、ダークモード、動き軽減。
- `apps/web/public/characters/kabumaru/kabumaru_*.png`：提供されたPNG6枚（端の不要な断片を除去）と既存のdiscover_clean版。
- `packages/core/assistant.ts`：通知型、数値検出、重複を防ぐ通知ID。
- `apps/api/src/assistant.ts`：通知収集・永続化、類似結果の記憶化。
- `apps/api/src/server.ts`：本人保護付きAPI、監視変更と類似検索への接続。
- `apps/api/src/service.ts`：記憶namespace、関連分析・検証・確認候補、根拠の重複抑止、取得ジョブへの接続。
- `packages/integrations/index.ts`：ローカル応答の根拠表示。
- `packages/storage/index.ts`：notifications/assistantを暗号化バックアップ対象へ追加。
- `tests/assistant.test.ts`、`tests/api.test.ts`：数値検出、再確認・再起動、過去基準日、明示保存、認証拒否。
- `tests/e2e/kabumaru.spec.ts`：6画像、ポーズ、保存、スマホ、ダークモード、動き軽減、表示重複の検証。
- `README.md`、`docs/kabumaru.md`：使い方、閾値、仕様・制限・実接続未確認事項。

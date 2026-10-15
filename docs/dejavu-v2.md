# デジャヴ相場 2.0

既存の20営業日OHLCV検索を拡張し、過去事例の統計、DNA、仮説記録、期限後評価、反省ノートを `/similar` にまとめました。DB・新規サービスは追加していません。

## 動作

- 既存の類似度、候補選定、未来除外を維持。表示用上位5件を統計にも使用し、40営業日の比較＋結果窓が重なる事例を再度除外します。画面には走査数・非重複候補数・実際の集計数を分けて表示します。
- 1/5/20営業日の件数、上昇割合、平均、中央値、最小最大、25/75分位、類似度加重平均、方向のConsensus Score、サンプル数別の注意表示を計算します。ゼロ騰落率は横ばいです。
- 加重は `max(score/100,0)^CONSENSUS_WEIGHT_POWER`。定数は `packages/core/dejavu-consensus.ts`。無効値は期間ごとに除外し、空集合・重み合計ゼロはnullを返します。
- 過去チャートは従来の初日100比較を維持。別の未来チャートで基準日を0%に揃えた中央値・四分位帯を表示します。帯は過去の経験分布であり、予測区間ではありません。
- DNAは5要素の `100*exp(-distance)` を横棒で表示。総合類似度、重み、加重距離への寄与、最も似る／異なる要素を表示します。
- かぶまるは既存の画像と共通Portraitを利用。画面内の表情は局所状態で管理し、既存通知・チャットのポーズを変更しません。解説は集計値に基づく決定的テンプレートです。外部LLMは呼びません。
- 予測記録は3期間をまとめて既存ジャーナルへ保存します。mode・銘柄・比較銘柄・基準日・手法・期間から決定的UUIDを作り、同条件の原本を再作成しません。実データでも少数の経験統計なので `research` とします。通常のneighbors-v1予測の最低20件要件は維持します。
- 既存の `evaluateDue` と日次ジョブで評価します。実績未取得はpending。価格欠損時もデジャヴはpendingを維持し、次回取得後に再評価します。価格訂正は別の評価revisionとなり、同一評価は重複しません。
- 評価と反省記憶は個別に冪等化し、中断後の再実行で不足した反省記憶を作成できます。観測値と解釈は別フィールドです。検索結果は解説の振り返りに使い、統計には混ぜません。

## API

共通入力は `code`（必須）、`asOf?`、`compareCode?`。コードと日付はZod検証。実モードの既存本人認証とOrigin検査が適用されます。

| API | 内容 |
|---|---|
| GET `/api/similar` | 従来のフィールドを維持し、`consensus` と `dna` を追加 |
| GET `/api/dejavu/consensus` | 期間別統計、未来軌跡の中央値・四分位、集計対象ID、選択基準、重み定数 |
| GET `/api/dejavu/explanation` | 数値テンプレート解説、DNA、検証済み構造の反省記憶、取得経路とエラー |
| POST `/api/dejavu/forecast` | 共通入力をJSONで送信。既存予測3件を `records` で返す。接続失敗時も保存結果を返す |
| GET `/api/dejavu/evaluations` | 当該銘柄・比較条件のデジャヴ予測と状態・評価一覧 |
| POST `/api/evaluations` | 既存の期限後評価を拡張。許可された実モードでは評価後に既存キューを同期 |
| POST `/api/dejavu/save` / GET `/api/dejavu/memories` | 従来どおり利用可能 |

## JSON保存スキーマ

新しいディレクトリは作らず、既存のロック・原子的書込・索引・暗号化バックアップを利用します。

- `predictions/<uuid>/original.json`：従来のschemaVersion=1予測。`methodVersion=dejavu-consensus-v1`。`predictedReturn` は中央値、`returnQuantiles` は25/75分位、`pUp` は経験上昇割合です。
- 追加する任意の `dejavu` オブジェクト：schemaVersion=1、compareCode、asOf、sourceDejavuRecordId、dataCutoff、consensusScore、weightedReturn、medianReturn、upRatio、percentileRange、exampleIds、selection、dnaSummary、evaluationStatus。元レコードの初期evaluationStatusはpendingのまま固定し、現在の状態は別ファイルで管理します。
- featureVersion・methodVersion・createdAt・source・mode・horizonSessions・sampleCount・inputRevisionIdsは既存予測フィールドを再利用。入力改訂には比較元と全選択事例の改訂IDを含めます。
- `predictions/<uuid>/state.json`：pending/evaluated等の現在状態。原本を更新しません。
- `evaluations/<predictionId>/<hash>.json`：既存評価項目に、任意の `dejavu`（予測中央値、Score、件数、DNA、Scoreの符号と実績の一致）を追加します。
- `memories/<sourceRecordId>.json`：予測の元になった分析結果。既存dejavu_memoryスキーマを再利用。
- `memories/<uuid>.json`：schemaVersion=1、kind=dejavu_reflection、mode、providerCode、predictionId、dataAsOf（評価期限日）、namespace、createdAt、active、text、observations、interpretation。
- `sync/<recordId>.json`：既存pending/accepted/synced/uncertain等。MemWalから削除された記憶は既存の再送抑止に従います。

旧予測の `dejavu` は任意のため、旧JSONはそのまま読み込めます。既存の予測一覧・手法別集計・バックアップ・Suiアンカーは同じ予測型と保存領域を利用します。アンカー処理自体は変更していません。

## MemWal

分析のnamespaceは `kabutowal:dejavu:v1:<mode>:<code>`。反省ノートは `kabutowal:dejavu:reflection:v1:<mode>:<code>`。

demoはローカルのみ。実モードでも `ALLOW_MARKET_DATA_TO_MEMWAL=true` の場合だけ外部保存・検索を行い、既存の本人/delegate確認とMemoryProviderを利用します。未接続でも仮説と評価はローカルに残り、既存ジョブで再同期できます。受付job IDと保存完了blob IDを区別し、受付済みの記憶を再送しません。

recall結果はZodで構造検証し、mode・銘柄・namespace・日付・作成時刻を検査。ローカルで無効化済みのIDも除外します。指定された過去基準日の締切後に作った反省記憶は過去分析に表示しません。最新日付の分析では、その時点までに作成された過去評価を参照できます。

## 変更ファイル

追加：`packages/core/dejavu-consensus.ts`、`apps/api/src/dejavu-journal.ts`、`apps/web/src/DejavuResearch.tsx`、`tests/dejavu-consensus.test.ts`、`tests/dejavu-journal.test.ts`、本書。

更新：`packages/core/index.ts`、`apps/api/src/dejavu.ts`、`apps/api/src/service.ts`、`apps/api/src/server.ts`、`apps/web/src/main.tsx`、`apps/web/src/Kabumaru.tsx`、`apps/web/src/MemoryContent.tsx`（種類名のみ追加）、`apps/web/src/style.css`、`tests/assistant.test.ts`（旧namespace期待値の修正）、`tests/e2e/dejavu.spec.ts`、`tests/e2e/server.ts`（既存保存状態から分離）、`tests/e2e/demo.spec.ts`、`tests/e2e/kabumaru.spec.ts`（現行UIに合わせた回帰確認）、READMEとAPI/デジャヴ文書。

作業開始前からあった記憶削除・暗号資産表示などの変更は、この機能の追加としては扱っていません。

## 動作確認

1. `pnpm dev` を起動。ホームで銘柄を監視に追加し日足を用意する。実データの場合は通常の本人認証・取得設定を行う。
2. 類似相場画面で銘柄・基準日を選び、1/5/20営業日の統計、DNA、かぶまる解説を確認。
3. 「このデジャヴから予測を記録」を押す。3期間の記録を確認。再押下して件数が増えないことを確認。
4. 期限後のデータがある基準日を使い「期限後の答え合わせ」を押す。demoなら2026-08-03で確認可能。
5. 基準日を空に戻して最新分析を表示し、作成済みの反省ノートを確認。過去基準日に戻すと後日作成した反省は表示されない。
6. 390px幅とナイトモードで、カード、凡例、横スクロールを確認する。

## 制限

統計は上位5事例だけです。最低20件の通常予測とは異なり、少数事例の研究仮説として扱います。類似度もScoreも校正済みの確率ではありません。DNAの距離から変動率の高低や出来高の増減は推論しません。テンプレート解説はニュース・決算を取得しません。

実J-Quants・MemWal・実ウォレット・Suiへの新しい取引送信は、この検証では行っていません。接続障害と同期はモックで検証します。既存のpoint-in-time取得履歴の制限と配備上の制限は引き続き適用されます。

## 検証結果（2026-10-15 JST）

- `pnpm run lint`：成功。
- `pnpm run build`：TypeScript型チェックとproduction build成功。既存の大きいJSチャンクに関する500kB警告あり。
- `pnpm run test`：全12ファイル・53テスト成功。その後追加した書込中断復旧テストを含め、新機能の2ファイル・7テストも再実行して成功。
- `pnpm run test:e2e`：全8テスト成功。デジャヴ統計・DNA・3期間保存・評価・最新分析での反省参照・明示記憶・390px幅・ダークテーマを確認。既存の監視→詳細→類似→通常予測→検証→記憶→チャット、かぶまる、銘柄検索、記憶削除の確認画面、認証表示も通過。
- PC・390pxモバイルのライト／ダーク画面キャプチャを目視確認。チャートは描画待ちや動きの軽減設定に影響されないよう、デジャヴ画面のアニメーションを無効化。
- 本人ウォレットでの実取引や外部MemWalへの実書込は行っていません。ウォレットSDKの外部メタデータ取得失敗ログはテスト環境で出ますが、テストは成功しています。

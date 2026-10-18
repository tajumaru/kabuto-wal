# 第5弾：かぶまるAI研究所 — 底打ちアルゴリズム実験室

実装日：2026-10-18。開始時にorigin/mainをfetchし、最新mainに対して手元の文言統一コミット`1f40ab4`のみ先行、未コミット差分なしを確認した。第4弾の固定コホート・追記型評価・paired-v2比較・研究ノートと既存Fastify/React/Zod/JSON/SDKを利用した。DB・常駐サービス・追加依存なし。

## 利用手順

1. `/research/notebook`で候補と非候補を同時に固定し、保存済み価格で評価する。評価は新しい再開可能ジョブを使う。
2. `/research/lab`でコホートIDとTraining・Validation・Testの期間を入力し、検証計画を固定する。十分な履歴がなければ、期間を推測せずエラーになる。
3. Training内の研究ノートから仮説を生成するか、手動仮説とallowlist内の重みを設定する。実験方式を保存しても本番方式は変わらない。
4. 設定・分割の確認欄を明示的に選んで実験を開始する。Trainingは探索、Validationは比較・選択に利用する。
5. 十分なValidation完了レポートがある方式だけを、明示操作でTest用に固定できる。その後に最終Testを開始する。
6. 結果が悪い場合もそのまま表示する。Test開封後の期間は、調整後の方式に対する未使用Testへ戻せない。
7. 採用状態は追記型で記録する。本番切替は未実装。必要に応じて実験記憶をローカル保存し、別の明示操作でのみ外部同期する。

## Phase 1：調査・現行方式の回帰固定

調査対象：`hunter-method.ts`、`hunter-schema.ts`、`hunter.ts`、`hunter-jobs.ts`、`hunter-consistency.ts`、`bottom-score.ts`、`bottom-features.ts`、`bottom.ts`、コホート3モジュール、研究ノート・insights、研究・outcomes、JSON Store、MemWal同期処理。

現行候補判定は点数だけではなく、流動性、警戒リスク、反発進行度、drawdown/oversoldの必須条件で決まる。そこで本番の採点・分類を直接変更せず、保存された条件の意味をそのまま再利用する。現行10条件・重み・満点と1,024通りの固定条件組み合わせの点数を回帰検証した。現行ハンター、予測ジャーナル、研究ノートは従来方式を使い続ける。

## Phase 2：実験方式と履歴

`bottom-rule-v1` / `bottom-80-v1`を親とする`hunter-experiment-v1`を追加した。変更可能な条件は次の10個だけ。

`drawdown`、`oversold`、`support`、`above_sma5`、`sma5_rising`、`rsi_recovery`、`macd_recovery`、`volume_rebound`、`lower_wick`、`above_sma20`。

各重みは有限な0〜100、合計は正、候補追加閾値は0〜100。任意の特徴量・NaN・Infinity・未知フィールドをZodで拒否する。重みは合計100点へ正規化する。現行の安全条件を通過した候補集合に追加閾値を適用するため、流動性や警戒リスクを重みで回避できない。今回は必須条件やリスク判定自体の変更実験を扱わない。

実験IDは正規化した方式バージョン・設定・仮説・参照情報のSHA-256。作成日時はIDから除くが、原本には保持する。同一設定は同じ原本を再利用し、変更は新IDになる。状態は`draft → testing → validated → proposed-for-adoption`、または`rejected`への追記。各イベントは前イベントIDと内容hashを持ち、分岐・改変を拒否する。validatedには原本から照合した十分なValidationが必要。

## Phase 3：根拠付き仮説

LLM未設定時にも動く決定的な提案生成を実装した。出来高、RSI、支持条件、長期平均などの研究テーマを、許可済み重み変更へ対応させる。設定提案は改善の証明ではない。

研究ノートは計画作成前に存在し、同一データ区分で、参照コホートが全てTrainingへ割り当てられ、参照評価が固定計画に含まれるものだけを使う。Test・Validationのノートを提案の入力にできない。固定済みデジャヴ類似度がないテーマだけの場合は提案を拒否する。

提案にはノートID・Evidence ID・参照件数・注意点を保存する。参照件数は重複期間を含み得るため独立標本数とは呼ばない。提案を保存するだけでは実験を開始しない。変更した提案は別の手動仮説として扱い、元の根拠IDを無断で引き継がない。任意JS・SQL・シェル実行や外部LLM接続は行わない。

## Phase 4：時間分割とTest封印

比率を自動適用せず、営業日・結果窓・対象銘柄を確認できる明示期間を採用した。Training→Validation→Testは非重複・時系列順が必須。

- 固定した20営業日結果窓が各期間内に収まらないコホートはpurgeする。1/5営業日だけが都合よく残る方式別選択はしない。
- 次期間の先頭では営業日カレンダーに基づくembargoを適用する。初期値は20営業日。
- 判定日末より後のcutoffで作成された特徴量は除外する。将来の結果・後日計算した指標で補完しない。
- mode、実験区分、ハンター・採点・特徴量・設定、契約プランと遅延が一致するコホートだけを比較する。
- 計画にmanifest hash、calendar hash、割当・除外理由、固定評価cutoffと評価revision IDを保存する。後日の訂正評価を途中で混ぜない。
- 既存研究ノートで成績参照済みの期間は未使用Testに指定できない。計画後にTest期間のノートが作られた場合も開封前に再確認する。
- 実験で参照したTraining/Validationと、開封したTestの期間を永続記録する。別計画で「未使用Test」へ付け替えることを拒否する。別計画の封印中Testを探索に転用することも拒否する。
- Test方式の固定には同一計画の十分なValidationが必要。選択は不変で、Test開封履歴は結果を読む前に保存する。開封後は同計画で方式探索を追加できない。

これはアプリ内の実験・研究ノートの利用履歴に基づく封印である。人が別ツールで既に知った市場価格まで未観測と保証する仕組みではない。手動仮説の事前知識や保管先の直接編集にも注意が必要。現在作った方式を昔選択していたかのように説明しない。

複数foldの自動探索・方式選択は今回は追加していない。各期間を固定した独立計画で検証できるが、完全自動walk-forwardや多数のfoldに対する補正は第6弾の候補。未使用Testを残せない保存履歴では最終評価を生成しない。

## Phase 5〜6：再開可能な実験と固定対応比較

再採点には保存済み条件だけを使う。親方式・特徴量・BOTTOM_CONFIGのhash・入力revision・元点数を照合し、元点数が十条件から再現できなければ除外する。既存コホートの点数だけから未知の特徴量を推定しない。

同一のコホート・銘柄・日付・cutoff・revision・調整系列・期限後評価を、新旧両方式へ渡す。再採点不能な銘柄は両方式から同じように除外する。結果shardは固定特徴量から再採点し、評価原本へ再照合してからレポートを作る。

Storeのwriter lockとPID/期限/token付きleaseで複数workerを制御する。研究実験とコホート評価は同じアクティブworker枠を共有する。各コホート完了後にcheckpointを保存し、中断・キャンセルは単位処理の境界で反映する。途中shardだけでは完成扱いにしない。再開時に固定入力を検査し、保存済みshardのhashを確認して再利用する。異常終了workerは状態照会時にpausedへ復旧する。別worker待ちは失敗結果を作らず再開可能にする。

レポートは1/5/20営業日の候補数・非候補数・評価件数・平均・中央値・上昇割合・終値ベース最大下落・再下落割合・候補対照差・4スコア帯・候補集合の一致率/Jaccard・特徴量不足率を含む。全銘柄数だけで優劣を決めない。

候補対照差は第4弾のpaired-v2と、銘柄クラスタ・5観測時点ブロックの探索的bootstrapを再利用する。同一銘柄の重複結果窓を結果を見る前に共通除外し、方式ごとに都合よく選別しない。方式間の候補平均差は同じ日付を対応させた記述平均で、方式間差の信頼区間自体は未推定。

市場平均との差は同じ固定ユニバースの等銘柄平均を基準とする。TOPIX、業種、規模調整後の超過収益ではない。業種・時価総額・上場廃止・欠損の偏りは未調整と明示する。取引コスト・スリッページは各片道0〜1000bpsで、往復分を平均・中央値・上昇判定から控除する。最大下落・再下落は元の終値系列の指標で、約定シミュレーションではない。

各群20評価、20銘柄、10対応時点など既存の標本条件を全期間で満たさなければsufficient=false。十分でも統計的な優位性や採用を自動判定しない。試行数は保存済み全実験ジョブ数として記録し、多重比較補正済みとは表現しない。

## Phase 7〜10：説明・UI・採用判断・記憶

かぶまるの説明は検証済み数値から決定的に作る。変更条件・理由・参照ノート、期間、比較数、成績差、不確実性、欠損、過学習、次の確認条件、Evidence IDを表示する。保存済み説明も固定原本から再計算し、hashだけを付け直した架空の説明を拒否する。

`/research/lab`は遅延ロード。カード中心の設定・履歴・進捗・成績グラフ・折りたたみ・根拠を備える。履歴は20件単位、上限50件。初期レポートは検証済みcompact viewを使用し、大量の評価参照配列は先頭20件と総数だけ返す。完全な原本APIは残す。各検証区間は最大50,000銘柄時点として、過大な単発集計は切り捨てず拒否する。

320px、16px入力、44px操作、Safe Area、スクロール復元を対象に検証する。ノート画面も汎用headerスタイルによる固定高さの重なりを局所修正した。既存のかぶまる画像は変更していない。iPhone Safari実機・仮想キーボード操作は未検証。

`proposed-for-adoption`は利用者の明示操作だけ。本番方式の切替APIはない。採用候補の撤回はrejectedイベントの追記で記録する。将来の本番切替では、別の有効方式ポインタと有効期間・承認・ロールバック履歴を設ける設計とし、今回の予測原本を書き換えない。

実験記憶の正本はローカルJSON。SDKを置き換えず、既存同期処理のprojectionへ小さな実験要約を追加した。初期externalConsent=falseで一般同期からも除外する。今回の明示許可・市場データ送信許可・J-Quants権利確認・非demo・接続済みproviderが揃わなければ送信しない。pending/accepted/synced/uncertainと冪等性を維持する。削除・無効化・検索リセット・blob/直接削除の既存ガードと、記憶ID/同期receiptによる再生成抑止を共有する。リモート文は事実として採用せず、ローカル実験原本へID照合する。

実験manifestのSHA-256を計算できる。設定・計画・入力・結果shard・レポート・Evidenceを結び付ける。Sui書き込みはなく、ウォレット未接続で実験可能。

## Phase 11：コホート評価ジョブ

既存`evaluateCohort()`とPOST `/cohorts/:id/evaluate`の同期APIは維持した。共通評価関数を切り出し、新ジョブは25銘柄単位で1/5/20営業日を評価する。取得締切、manifest、カレンダー原本を固定し、途中でカレンダーが変わった再開は拒否する。

進捗には対象・完了銘柄、評価済・期限前・価格不足・判定不能、計算失敗を分離する。欠損は収益0へ補完しない。評価原本は同一IDの冪等保存で、価格訂正は追記。失敗・中断後に未完了単位を再実行しても既存原本を重複保存しない。

同一銘柄の1/5/20営業日に使う系列は、期限が到来した最長窓の範囲で共有する。未来の対象日まで価格を取得せず、各窓の判定ではその窓内のデータだけを利用する。JSONの原子的書込・fsyncは維持し、原本を削って高速化しない。

## 保存先

```text
research/lab/
  methods/{experimentId}/original.json
  methods/{experimentId}/events/{eventId}.json
  methods/{experimentId}/validation/{runId}.json
  proposals/{proposalId}/original.json
  plans/{planId}/original.json
  plans/{planId}/selection/original.json
  observed/{runId}/original.json
  exposures/{planId}/original.json
  runs/{runId}/checkpoint.json
  runs/{runId}/parts/{cohortId}.json
  runs/{runId}/report/original.json
  runs/{runId}/provenance/original.json
  cohort-jobs/{runId}/checkpoint.json
  cohort-jobs/{runId}/calendar/original.json
  cohort-jobs/{runId}/parts/{index}.json
```

manifest、方式、計画、原本、履歴、結果shardは不変。checkpointとアクティブworker参照だけを更新する。暗号化バックアップの既存research保存を利用し、復元で原本・履歴・shard・Validation receiptが競合する場合は上書きを拒否する。既存JSONの破壊的移行なし。

## 新規API

全て既存認証・Origin検証内。GET以外は利用者の画面操作で呼ぶ。外部サービスの自動取得はない。

| メソッド | `/api`以下のパス | 用途 |
|---|---|---|
|GET|`/research/lab`|現行方式とallowlist|
|GET/POST|`/research/lab/methods`|ページング/明示保存|
|GET|`/research/lab/methods/:id`|方式と追記履歴|
|POST|`/research/lab/methods/:id/state`|明示状態変更|
|POST|`/research/lab/hypotheses`|Training根拠の提案|
|GET/POST|`/research/lab/plans`|計画一覧/固定|
|POST|`/research/lab/plans/:id/select`|最終Test方式の固定|
|GET/POST|`/research/lab/runs`|履歴/確認付き実験開始|
|GET|`/research/lab/runs/:id`|checkpointと異常終了復旧|
|POST|`/research/lab/runs/:id/control`|中断・キャンセル・再開|
|GET|`/research/lab/runs/:id/report`|完全原本。`?view=compact`で画面用参照上限付き|
|GET|`/research/lab/runs/:id/provenance`|manifest hash。`?view=compact`でhashのみ|
|POST|`/research/lab/runs/:id/memory`|ローカル記憶|
|POST|`/research/lab/runs/:id/sync`|明示許可付きSDK同期|
|POST|`/research/lab/recall`|明示許可付き原本照合検索|
|POST|`/bottom/hunter/cohorts/:id/evaluation-jobs`|評価ジョブ作成・開始|
|GET|`/bottom/hunter/cohort-evaluation-jobs/:id`|対象・完了・欠損・失敗|
|POST|`/bottom/hunter/cohort-evaluation-jobs/:id/control`|評価中断・キャンセル・再開|

## 性能測定

旧`a2768e3`の評価関数と新ジョブを、同じ一時JSON保存先の複製で各3回比較した。4銘柄・3窓、外部fetch禁止。旧同期評価と新ジョブ作成から完了までの時間である。

| 指標 | 旧 | 新 |
|---|---:|---:|
|処理時間中央値|538.48 ms|561.96 ms|
|3回の測定範囲|471.71〜560.41 ms|532.97〜563.27 ms|
|価格再構成回数|12|4|

価格再構成は3分の1になったが、checkpoint・lease・カレンダー原本保存を含む処理時間は4.36%増加した。速度向上と表現しない。測定値：[lab-evaluation-performance.json](lab-evaluation-performance.json)。再現コマンド：`pnpm exec tsx scripts/benchmark-lab.ts`。保存済み原本の削減や耐久性の弱化はしていない。

320×568 Chromiumで同じ保存済みレポートの再表示を5回測定：1004.48、992.66、960.81、984.55、957.23 ms。中央値984.55 ms、範囲957.23〜1004.48 ms。測定値：[lab-mobile-performance.json](lab-mobile-performance.json)。開発サーバー、並行テスト実行環境での表示完了時間で、iPhone実機や本番ネットワークの時間ではない。旧研究所は存在しないため、画面の改善率は算出していない。

本番ビルドの研究所JavaScriptチャンクは21.72 kB（gzip 7.61 kB）、CSSは1.48 kB（gzip 0.63 kB）。共有スキーマ・React等は別チャンク。Vite部分は1.09秒。全市場サイズ・iPhone実機・メモリ使用量・本番ネットワークの応答時間・独立したグラフ描画時間は未測定。

## 検証・残る課題

現行回帰、パラメータ・任意プロパティ拒否、時間分割・purge・embargo、未来cutoff拒否、根拠ノートのTraining限定、固定設定冪等性、二重worker、中断・キャンセル・復旧、Test封印、別方式での再Test拒否、負のTest成績、説明改変拒否、MemWal初期送信OFF・削除抑止、Sui自動書込なし、期限前取得なし、calendar変更拒否、価格系列共有をfixtureで検証する。

最終結果：

| コマンド | 結果 |
|---|---|
|`pnpm run lint`|成功|
|`pnpm run typecheck`|成功|
|`pnpm run test`|53ファイル・168件成功|
|`pnpm run test:e2e --reporter=line,json`|27件成功、失敗0・skip0・flaky0、約78.9秒|
|`pnpm run build`|成功|

E2Eのfixture結合でカレンダー重複を検知したため、検査を弱めずfixture側を一意化した。検証区間のアクセシブル名も明示した。全E2Eでは既存J-Quants demo分離、ハンター、デジャヴ、研究、チャット、記憶削除、ウォレット認証、予測の導線を回帰検証した。外部SDKのメタデータ取得拒否と開発警告は残るが、実接続成功とは扱わない。

検証は並行作業の未コミット差分を保持した現在の作業ツリーで行った。その研究画面・説明処理の差分自体は今回のコミット対象から除外した。

実市場の優位性は未検証で、架空の好成績は作っていない。研究所の人工成績はテスト専用で実運用保存先には投入しない。実J-Quants・MemWal・LLMへの接続、Suiトランザクションは実行していない。並行作業の研究画面・説明処理の未コミット変更は保持し、今回の残りコミットには含めない。

第6弾では、明示取得した実市場コホートの蓄積、独立した複数時系列foldの自動化、方式間の対応付き信頼区間・多重比較、業種・規模・市場リターン・上場廃止の補正、約定・コストモデル、全市場サイズのストリーミング集計、iPhone実機検証を優先する。本番方式の切替は別開発で承認・有効期間・ロールバックを設計する。

## 変更ファイル

- core：`hunter-experiment-schema.ts`、`hunter-experiment-method.ts`、`hunter-lab-report-schema.ts`、`cohort-evaluation-job-schema.ts`。
- API：`hunter-experiment.ts`、`hunter-experiment-hypotheses.ts`、`hunter-experiment-temporal.ts`、`hunter-experiment-runner.ts`、`hunter-experiment-report.ts`、`hunter-experiment-api.ts`、`hunter-experiment-memory.ts`、`research-json-worker.ts`、`hunter-cohort-jobs.ts`、`hunter-cohort-evaluation.ts`、`hunter-cohort.ts`、`server.ts`。
- web：`KabumaruLab.tsx/.css`、`LabMethodEditor.tsx`、`LabResearchReport.tsx`、`LabMemory.tsx`、`KabumaruNotebook.tsx/.css`、`main.tsx`の追加ルート。
- 基盤：`packages/storage/index.ts`、`packages/integrations/index.ts`。
- fixture・テスト：`fixtures/lab.ts`、`hunter-experiment-method/temporal/runner/holdout.test.ts`、`research-json-worker.test.ts`、`hunter-cohort-jobs.test.ts`、`tests/e2e/lab.spec.ts`、`tests/e2e/notebook.spec.ts`、`tests/e2e/server.ts`。
- 測定・文書：`scripts/benchmark-lab.ts`、本書、性能JSON2件、既存研究ノート文書へのリンク。

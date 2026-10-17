# 第4弾：かぶまる研究ノートと固定コホート

実装日：2026-10-17。開始時にorigin/mainをfetchし、`e855135`との差分0/0、作業ツリーがクリーンであることを確認した。既存の底打ち判定、JSONストレージ、調整系列、MemWal SDK、Sui認証、かぶまる画像を再利用した。新しいDB、常駐サービス、有料LLMの追加なし。

## 利用手順

1. 底打ちハンターで保存済みデータの分析を完了する。
2. `/research/notebook` で完了済みジョブと研究区分を選び、「固定コホートを作成」を押す。
3. 「期限後評価を実行」で、既に保存されている価格だけを使って1・5・20営業日後を評価する。追加取得は行わない。
4. テーマと研究時点の仮説を選び、「研究ノートを作成」を押す。
5. 候補・非候補の比較、スコア帯、事例、根拠を確認する。研究記憶はまずローカル保存し、別の明示操作でのみMemWal同期・検索する。

`/research` の「研究ノートに質問する」からも参照できる。過去の研究締切より後に作られたノートは、その過去時点の回答には使わない。今日作った過去研究ノートが昔の判断材料だったかのような説明はしない。

## Phase 1：固定コホート

`hunter-cohort-schema.ts`、`hunter-cohort.ts`、既存hunter-consistency、hunter-jobs、universe、coverageを調査・再利用した。候補だけを記録する予測ジャーナルでは対照群が欠けるため、完了ジョブのユニバース全体を同時に固定した。

コホートはschemaVersion、cohortId、jobId、datasetId、analysisId、asOf、cutoff、universeId、methodVersion、採点方式・特徴量バージョン・configHash、作成時刻、区分、契約プランと遅延、固定した結果窓を持つ。銘柄ごとにスコア、候補フラグ、分類、基準価格、入力revision、判定可能性、除外理由、一致条件、リスク、指標、調整方式を保存する。

- queued/running/paused/cancelled、不完全な件数、変更された分析参照、未来の基準日・cutoff、異なるデータ区分は拒否する。
- 対象銘柄はユニバースで固定し、候補・非候補の両方を同時に保存する。判定不能・取得失敗・基準価格不足・当時未知の入力はeligible=falseとして別扱い。非候補には混ぜない。
- 同一入力のcohortIdは内容hashから決まり、同時作成・再実行も冪等。createdAtを変えるために元のmanifestを上書きしない。
- 1/5/20営業日の予定対象日も固定する。カレンダーが未取得・改訂・重複している場合は別の営業日を推測して評価しない。
- prospectiveはJST当日の事前記録だけ。retrospective、walk-forward、demoと混ぜない。walk-forwardの入力cutoffは基準日当日末まで。

```text
market/hunter/cohorts/{cohortId}/
  manifest.json
  members/00000.json
  members/00001.json
  evaluations/{code}/{horizon}/{evaluationId}.json
```

membersは200銘柄単位。manifestに各shardのhash・件数を記録し、manifestを最後に不変保存する。読込時にコホートID、区分、shard hash、件数、銘柄重複を検査する。途中で止まったshardだけを完成済みコホートとして一覧に出さない。対象は最大20,000銘柄。

## Phase 2：期限後評価

`hunter-cohort-evaluation.ts` は既存のMarketIngestion.series、snapshot、営業日カレンダーを再利用する。未来の対象日では価格系列を読まない。日付が過ぎただけでは確定せず、全ての必要な終値が実際に利用可能になったことを確認する。ISO日時と時差を数値で比較し、欠損・異なる系列・0以下の価格・不正時刻では成績を作らない。

基準日と対象日の価格は、評価取得締切における同一の調整系列から再構成する。分割等で調整基準が変わっても、昔の絶対価格と新しい絶対価格を直接割らない。コホートの基準価格はそのまま残し、評価には共通基準のbasePrice/targetPriceと使用revisionを保存する。

評価項目は騰落率、上昇の有無、終値ベースのピークからの最大下落、基準終値からの最大上昇、再下落、欠損理由、入力revision、調整方式、利用可能時刻、評価日時・取得締切。再下落は「結果窓で一度基準終値を上回り、その後基準終値を下回ったか」であり、最終騰落率や原因とは別の事実。

evaluated/pending/missing/excludedを分離。評価済みの価格・騰落率・上昇フラグ・参照・時刻が不整合なら検証を拒否する。評価対象日・対象群もコホートへ照合する。同じ価格・revisionでの再評価は同じIDを再利用し、訂正された価格やrevisionは新しい評価原本を追加保存する。予測ジャーナル・既存の予測原本は変更しない。

暗号化バックアップにも既存のmarket/research保存をそのまま利用する。復元時に同じパスのコホート・評価原本と内容が競合する場合も、元予測と同様に上書きを拒否する。

## Phase 3：比較の方法と限界

`hunter-cohort-report.ts` と共有Zodスキーマを追加。1回最大100コホートを比較できる。mode、実験区分、ハンター・採点・特徴量・設定の版、契約プラン、営業日期間を分離する。作成時点・評価締切より後の情報は利用しない。

各群の評価件数、未実行・期限前等、価格不足、判定不能等の除外、上昇割合、平均・中央値、終値ベース最大下落、再下落割合、平均差、4スコア帯（0–39/40–59/60–79/80–100）を表示。差は百分率の相対変化ではなく、騰落率のポイント差。判定可能な非候補は対照群として残し、取得できなかった銘柄を勝手に0%へ補完しない。

主比較は `paired-v2`。同じコホート内で候補平均と対照平均の差を求め、同じ日のコホート間、さらに日付間を均等に平均する。両群が評価できる日数（matchedDates）と、全銘柄をまとめた従来の群平均差（pooledDifference）も表示する。日付ごとの銘柄数の偏りで結論が逆転する人工例をテストした。旧ノートは `pooled-v1` で再計算し、既存原本を変更しない。

同一銘柄・方式・区分・期間の重複結果窓は、結果を見る前に日付・コホート順で除外する。候補フラグが後から変わっても、その結果に有利な観測を選び直さない。

区間推定は銘柄クラスタと、並べた観測時点の連続5時点ブロックを二軸で再標本化する400回の決定的な探索的bootstrap。主比較と同じ日付均等の差を再計算する。各群20評価以上、20銘柄以上、両群を比較できる10時点以上が必要。それ以下では区間を出さない。観測時点の間隔が不規則な場合、5時点は5営業日を意味しない。この区間は厳密な市場モデルや選別能力の証明ではない。

市場全体・業種・時価総額の偏り、上場廃止を含む生存者バイアス、欠損の偏りは未調整。取引コスト控除前。候補と対照の取得条件が同じでも、取得できた銘柄だけの比較に偏る可能性がある。80点以上の優位性は仮定せず、スコアを確率として扱わない。採点・閾値は変更していない。

## Phase 4：研究ノート

原本は `research/notebooks/{notebookId}/original.json` に不変保存。テーマ、対象期間、仮説、採点方式を含む比較条件、コホート・評価revision、比較レポート、成功・失敗例、Evidence、限界、次回の確認条件、作成日時を持つ。notebookIdは正規化した原本内容全体のhash。

`summary.json` は決定的な派生要約で、破損しても原本から再生成できる。原本読込時には内容hashだけでなく、当時参照できたコホートと評価からレポートを再計算して照合する。後日の評価訂正を古いノートへ混ぜず、必要なら新しいノートを作る。

| テーマ | 固定時点の根拠・扱い |
|---|---|
| 出来高急増を伴う底打ち | volume_rebound |
| RSI回復後の反転 | rsi_recovery |
| 長期下降トレンド中の反発 | long_trend_down |
| 底固めからの上昇 | 底固め観察、またはsupport |
| V字回復 | above_sma5・sma5_rising・rsi_recoveryの代理条件。V字形状の実証とは表現しない |
| 偽の反発・再下落 | 固定母集団は削らず、期限後の再下落指標と失敗例を記述 |
| デジャヴ類似度と実績 | コホートに固定された類似度がないため「判断できません」。後日計算した類似度で補完しない |
| 高スコアなのに失敗 | 固定母集団を維持し、80点以上で負の結果だった事例を記述 |

結果テーマで対照群を未来の結果から選別しない。例示は成功・失敗それぞれ最大5件で、全体成績とは区別する。各コメントに標本数とEvidence IDを付け、原因や一般化を断定しない。自由記述の仮説は仮説としてその作成時点を保存する。

## Phase 5：MemWal

既存memoryProvider・syncMemories・SDK・接続設定を利用。記憶はテーマ、条件コード、期間、コホート参照、集計、例示件数、注意点、Evidence、方式を中心とし、全価格系列・市場原本・自由記述の仮説を送らない。送信対象は最大12集計。

ローカル保存時はpendingかつexternalConsent=false。通常の自動同期はこの記憶を送らない。専用同期は今回の明示操作、ALLOW_MARKET_DATA_TO_MEMWAL、JQUANTS_MEMWAL_RIGHTS_CONFIRMED、非demo、接続済みproviderが必要。既存のpending/accepted/synced/uncertainと受付冪等性を維持する。

記憶IDは同じテーマ・コホート・評価結果で安定させる。同じ内容のノートを作り直しても、削除済み記憶を新しいIDで復活させない。記憶または同期状態だけが残る場合も再生成を抑止。deleted/disabled、remoteDeletion、searchResetAt、blobDeletedAt、directWalrusDeletion等を確認し、同期・検索の両方から除外する。

検索は明示操作のみ。リモート文章は事実として採用せず、記憶IDとnotebookIdをローカルの不変原本へ照合する。ノートの作成時点も検索締切以前であることを確認する。実MemWal送信・検索は未実施、SDKモックで検証した。

## Phase 6：AI研究員との連携

既存`/research`へノートへの導線と6質問を追加した。同じパターン、失敗銘柄、候補対照比較、80点以上、過去ノート、以前の知見を、ローカル原本から回答する。既存の研究Evidence・LLM設定・自由記述制限は維持。

研究cutoffより後のノート・評価は除外。条件の照合は保存済み条件コードの一致で、完全に同じパターンという断定はしない。根拠不足は「まだ判断できません」。検索は時点・区分を絞った直近100ノート、最大5参照・20文。返却する評価IDはノートごと先頭20件と総数で、全件はノート画面のページング・原本から確認できる。

## Phase 7：性能

Store経由の原子的JSON書込に世代と書込中マーカーを追加。複数Storeインスタンスの書込でも世代を共有する。書込中、マーカー欠落・不整合、旧保存先は高速キャッシュを使わず従来走査へ戻す。プロセス再起動後の最初の研究では全fingerprintを監査する。破損索引はchecksum/Zod/ファイル更新検出から再構築する。

変更がない再研究では、全件の列挙・statを省き、検証済み索引を利用する。ノート履歴も軽量メタデータの世代キャッシュを使い、ページ単位で返す。更新時の全件再構築は残っており、真の銘柄別差分索引は今後の改善点。

アプリの既存書込はStoreを経由する。**実行中に外部ツールでJSONを直接編集する場合は、RESEARCH_INDEX_FULL_AUDIT=trueを使うか、アプリを再起動すること。** Storeを経由しない変更は高速世代キャッシュへ通知されない。異常終了で書込中マーカーが残った場合も安全側の全件走査を続けるため、性能復旧の運用整備には余地がある。これらの補助ファイルはバックアップ原本ではない。

`kabumaru-outcomes.ts`は期限前の価格取得を省き、保存済み評価を優先。同一銘柄・対象日の価格系列を共有する。結果キャッシュは入力世代、区分、プラン、対象ジョブで識別し、評価・価格revisionで失効。保存済みの未来観測・作成時刻が利用可能になる瞬間とJST日付境界でも期限切れにする。初回で既に読んだ予測・評価を期限計算のために再読込しない。

### 同じfixtureによる旧実装との比較

旧実装は`e855135`から読み、旧索引モジュールも別に読み込んだ。根拠キャッシュの名前空間も分けて、旧・新の結果を相互流用しない。Windows、Node 24.14.0、一時JSON保存先、外部fetch禁止。件数は追加予測・記憶で、元予測3件も含む。研究測定は対象日にジョブがない予測・記憶検索経路で、全市場デジャヴ再計算の測定ではない。

| 件数 | 研究初回 旧→新 ms | 再研究中央値 旧→新 ms | 短縮 | 銘柄切替 旧→新 ms | 記憶削除後 旧→新 ms |
|---:|---:|---:|---:|---:|---:|
|1,000|999.30→305.94|251.62→43.99|82.52%|236.61→38.23|246.25→257.98|
|10,000|8,783.33→3,648.71|2,069.73→108.81|94.74%|2,132.35→159.50|2,189.39→2,132.08|

| 未評価予測件数 | 旧初回 ms | 新初回 ms | 新再集計 ms | 価格系列再構成 旧→新→再集計 |
|---:|---:|---:|---:|---|
|1,000|919.98|1,045.15|1.64|1,003→102→0|
|10,000|10,339.79|10,478.93|1.93|10,003→102→0|

価格系列再構成は同じ保存fixtureを返すモックで、外部通信なし。したがって、実市場原本の再構成時間の短縮率を推定していない。初回集計は期限管理の準備負荷で悪化し、記憶削除後の1,000件も悪化した。再研究・再集計の効果と混同しない。初回・切替・削除は各1回、再研究は3回の中央値。OSキャッシュ・並行作業の影響を含み、統計的な性能保証ではない。実測値は [notebook-performance.json](notebook-performance.json)。全10,000研究ノートの巨大な原本アーカイブやメモリ使用量は未測定。

再現用PowerShell：

```powershell
$env:RESEARCH_BENCHMARK_BASELINE='e855135'
$env:RESEARCH_BENCHMARK_OUTPUT='docs/notebook-performance.json'
$env:BENCHMARK_OUTCOMES='true'
$env:BENCHMARK_SIZES='1000,10000'
pnpm exec tsx scripts/benchmark-research.ts
```

## Phase 7補足：LLMネットワーク

[IANA IPv4特殊用途](https://www.iana.org/assignments/iana-ipv4-special-registry/)、[IANA IPv6特殊用途](https://www.iana.org/assignments/iana-ipv6-special-registry/)の2025-10-09更新版を2026-10-17に確認。独自の数値範囲比較をNode標準BlockListのCIDR判定へ変更し、AS112、AMT、IPv6文書用範囲等も除外した。特殊用途の到達可能例外もLLM送信先として許可しない。IPv6は公開ユニキャスト2000::/3の中からさらに特殊用途を除外する。

allowlist、IPリテラル禁止、全DNS回答検査、接続IP固定、元ホストのTLS検証、プロキシ・redirect禁止、時間・サイズ・同時数制限、送信許可は維持。prefix、境界、IPv4-mapped、zone ID、DNS rebinding等をモック検証。特殊用途レジストリの将来更新は定期的に確認が必要で、実行時にIANAへ通信しない。

## Phase 8：画面

`/research/notebook` は既存画像、8テーマ、固定コホート操作、比較カード、4帯の平均騰落率グラフ、成功・失敗例、コメント、標本・欠損、Evidence、MemWal操作、履歴を表示する。ノート一覧は20件単位。初期表示にはコンパクトなviewを使い、最大数万件になる評価revision一覧は開いた時に100件ずつ取得する。不変原本のAPIは別に残す。

銘柄を変えたAI研究画面は古いノート回答を表示しない。320px、16px入力、44px操作領域、Safe Area、固定吹き出しによる操作妨害抑止、URL別スクロールを確認。キーボードを開く実機操作・iPhone Safariは未検証。画面測定の値は [notebook-mobile-performance.json](notebook-mobile-performance.json) を参照。

本番ビルドのノート画面は遅延ロードのJavaScript 18.21 kB（gzip 6.51 kB）、CSS 1.26 kB（gzip 0.52 kB）。既存チャート依存はこのサイズに含まない。

320×568 Chromiumで同じ保存済みノートの再読込を5回測定：996.51、953.75、952.85、451.80、419.78 ms。中央値952.85 ms、範囲419.78〜996.51 ms。開発サーバーでの表示完了までの測定で、実機Safariやネットワーク越しの本番時間ではない。単独のチャート描画時間とiPhone実機のメモリ使用量は未測定。

## API

| メソッド・パス | 用途 |
|---|---|
| POST `/api/bottom/hunter/cohorts` | 完了ジョブから固定コホートを作成 |
| GET `/api/bottom/hunter/cohorts?page=&pageSize=` | manifestのページング、上限100 |
| GET `/api/bottom/hunter/cohorts/:id` | 全原本・membersを検証して取得 |
| POST `/api/bottom/hunter/cohorts/:id/evaluate` | 保存済み価格で追加評価 |
| GET `/api/bottom/hunter/cohorts/:id/evaluations?page=&pageSize=` | 検証済み評価原本のページング、上限100 |
| POST `/api/bottom/hunter/cohorts/report` | cohortIdsから公平な比較レポート |
| POST `/api/research/notebook` | 不変原本を作成。`?view=compact`ならID・作成時刻のみ返す |
| GET `/api/research/notebook?page=&pageSize=` | 作成時刻順の軽量履歴、上限100 |
| GET `/api/research/notebook/:id` | 原本と再生成した要約 |
| GET `/api/research/notebook/:id/view` | 画面用のコンパクトな検証済みview |
| GET `/api/research/notebook/:id/evidence/:evidenceId?page=` | 評価参照IDを100件ずつ取得 |
| POST `/api/research/notebook/:id/summary` | 派生要約を再生成 |
| POST `/api/research/notebook/:id/memory` | コンパクト記憶のローカル保存 |
| POST `/api/research/notebook/:id/sync` | 今回の明示許可付き同期 |
| POST `/api/research/notebook/recall` | 明示許可・作成締切付きの原本照合検索 |
| POST `/api/research/notebook/answer` | 研究入力と定義済み質問に根拠付き回答 |

既存のハンター・研究・予測APIを置き換えず追加した。既存予測ジャーナルの集計と固定コホートの比較は別の集計。

## Phase 9：検証

全lint・typecheck・単体統合テスト・E2E・buildを実施。結果は完了報告と併せて記録する。追加テストは不変性、同時コホート作成、未完了拒否、候補対照の同条件、未知・欠損・不正時刻・時差、調整基準、1/5/20営業日、再下落、価格訂正の追加保存、重複結果窓、標本不足、負の成績、二軸の探索的区間、ノート根拠照合、要約破損、過去締切、MemWal削除・送信許可、1,000未評価予測の共有、世代更新・書込中拒否、特殊用途IP、320pxの一連操作を含む。

`pnpm run lint`、`pnpm run typecheck`、`pnpm run test`（47ファイル・155件）、`pnpm run build` は成功。ページングE2Eでは以前のランキングが残る間に新規ジョブ受付が完了する競合が見つかり、受付後のjobId反映を待ってからページ切替を検証するよう修正した。

最終の `pnpm run test:e2e` は26件すべて成功（約1.2分）。修正後のlintも成功。RTK v0.50.0のWinGet実行ファイルを絶対パスで利用し、対応シェルコマンドの出力を圧縮した。RTK探索前に実行中だった検証は再起動していない。

既存のロゴの代替テキストとE2E期待値、モバイルで隠れるサイドバーへの期待に、起点mainから不一致があったため、画像を変更せずテストを現行表示へ合わせた。並行編集中の「調整済み／調整後終値」は同義として回帰検証する。未コミットの別作業差分は保持しており、今回の残りコミット・pushには含めない。

外部サービスはfixture・モック。ブラウザ外向き通信も既存の拒否プロキシで遮断する。ウォレットSDKのメタデータ取得失敗とLit開発警告は残るが、Sui認証・既存機能のモック検証と区別する。既存の個人用JSONの破壊・移行、実J-Quants取得、実MemWal送信、Suiトランザクション、実LLM送信は行っていない。

## 変更ファイル

- core：`hunter-cohort-schema.ts`、`hunter-cohort-report-schema.ts`、`kabumaru-notebook-schema.ts`、`notebook-answer-schema.ts`。
- API：`hunter-cohort.ts`、`hunter-cohort-evaluation.ts`、`hunter-cohort-report.ts`、`kabumaru-notebook.ts`、`kabumaru-notebook-insights.ts`、`kabumaru-notebook-memory.ts`、`kabumaru-notebook-answer.ts`、`kabumaru-notebook-index.ts`、`kabumaru-outcomes.ts`、`kabumaru-record-index.ts`、`hunter-summary-cache.ts`、`research-network.ts`、`server.ts`。
- 画面：`KabumaruNotebook.tsx/.css`、`NotebookMemory.tsx`、`NotebookQuestions.tsx`、`KabumaruResearch.tsx`、`main.tsx`のルート。
- 既存基盤：`packages/storage/index.ts`、`packages/integrations/index.ts`、`.env.example`。
- テスト：`hunter-cohort.test.ts`、`hunter-cohort-evaluation.test.ts`、`hunter-cohort-report.test.ts`、`kabumaru-notebook.test.ts`、`notebook-memory.test.ts`、`outcome-report-cache.test.ts`、`storage.test.ts`、`research-index.test.ts`、`research-network.test.ts`、`tests/e2e/notebook.spec.ts`、`tests/e2e/demo.spec.ts`、`tests/e2e/hunter.spec.ts`。
- 測定・文書：`scripts/benchmark-research.ts`、本書、`kabumaru-ai-researcher.md`、性能測定JSON2件。

## 未検証・第5弾候補

実市場での候補対照比較、取引コスト込みの選別能力、十分な銘柄・時点での区間妥当性、業種・時価総額・市場リターンによる調整、上場廃止・欠損の補正は未検証。架空の優位性や実市場成績は作成していない。

次は、実市場の固定コホートを明示取得・蓄積し、原本の取得時点を保ったまま継続評価する。固定済みデジャヴ類似度をコホートへ追加する別バージョン、条件ごとの対照バランス、手数料・スリッページを含む検証、銘柄別の差分索引、異常終了マーカー復旧、iPhone実機・大規模ノート原本アーカイブの測定を優先する。成績が悪い場合も閾値を無断で変えず、新しい方式として比較する。

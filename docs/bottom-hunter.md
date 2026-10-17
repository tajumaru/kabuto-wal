# 底打ちハンター2.0

2026-10-17実装。開始点はmain `1698ac1`（GitHub mainと一致を確認）。DB・外部DB・追加常駐サーバーは導入しない。既存の `/bottom`、デジャヴv1予測原本、認証・送信許可・削除抑止・暗号化バックアップを維持する。

## 再利用と変更ファイル

- 個別計算: `apps/api/src/bottom.ts` の `analyzeBottom()` をスキャナーから直接呼ぶ。80営業日・10条件・100点、`bottom-rule-v1` の配点・閾値を変更しない。内部呼出し用の取得締切・調整系列・calendar引数と、描画用OHLCVを追加。
- ユニバース・共有応答: `packages/core/hunter-schema.ts`, `hunter-method.ts`, `hunter.ts`, `apps/api/src/hunter-universe.ts`。
- ジョブ・索引・API: `apps/api/src/hunter-jobs.ts`, `hunter-index.ts`, `hunter.ts`, `server.ts`。取得・系列構築は既存 `packages/integrations/market-ingestion.ts` を再利用。
- 画面: `apps/web/src/BottomHunter.tsx`, `HunterPriceChart.tsx`, `main.tsx`, `style.css`。既存StockPickerを変更しない。
- デジャヴ接続: `apps/api/src/hunter-research.ts`, `dejavu.ts`, `dejavu-journal.ts`, `apps/web/src/research-params.ts`, `DejavuResearch.tsx`。Zod統計スキーマを `packages/core/dejavu-stat-schema.ts` へ抽出し共用。
- 予測・評価・要約: `apps/api/src/hunter-journal.ts`, `hunter-memory.ts`, `hunter-backtest.ts`, `service.ts`, `packages/core/index.ts`, `packages/integrations/index.ts`, `.env.example`, `apps/web/src/MemoryContent.tsx`。
- 運用: `scripts/hunter.ts`, `scripts/hunter-benchmark.ts`, `fixtures/hunter-market.ts`, `package.json`。
- 検証: `tests/hunter-*.test.ts`, `tests/hunter-fixture.ts`, `tests/e2e/hunter.spec.ts`。既存の検索索引確認APIのモックをE2Eへ追加。Windowsで再現した後処理EPERMに対し、既存Storeのロック解放と認証テストの一時ディレクトリ削除へ短い再試行を追加。

## 対象銘柄と判定

指定営業日・取得締切以前のマスターsnapshotを用いる。`ProdCat=011`、5桁コード末尾0、認識済み株式市場区分を採用する。ETF、REIT、外国株、優先出資、予備コードが0以外の株式、分類不明は除外理由を保存。名前・コードの印象で商品分類を補完しない。

上場状態は `present_at_asof`（指定日のマスターに存在）。上場日・廃止日を推定しない。未来のマスターを過去のユニバースへ使わない。対象はJ-Quantsの東証収録範囲であり、地方単独上場やPTSを含む日本全取引所の完全走査ではない。

確認した公式仕様: [上場銘柄一覧](https://jpx-jquants.com/ja/spec/eq-master)、[商品区分](https://jpx-jquants.com/ja/spec/eq-master/product-category)、[予備コードによる普通株判別](https://jpx-jquants.com/ja/help/data)、[市場区分](https://jpx-jquants.com/ja/spec/eq-master/marketcode)。分類コード・提供項目の変更時は再確認する。

分類設定は `hunter-classification-v2`。計算スコアとは分離する。

| 分類 | 条件 |
| --- | --- |
| 判定不能 | 既存解析がunavailable（履歴・欠損・系列等） |
| 警戒 | 流動性未確認／不足、新安値、高ATR、出来高ゼロ。前提なし・反転条件も限定的な場合も候補から外す |
| 反発進行中 | 5日騰落率10%以上、20日安値との距離10%超、または前提なしで反転条件3個以上 |
| 反転兆候あり | 下落・売られ過ぎの両前提、既存条件3〜10のうち3個以上。上の警戒・進行中に該当しない |
| 底固め観察 | 両前提を満たすが反転条件3個未満。上の警戒に該当しない |

候補は最後の2区分のみ。20日平均売買代金1億円以上の確認も必要。前提なしの高得点を候補として上位へ出さない。候補優先→反転兆候優先→点数降順→コード昇順の固定順序。全体順位はフィルター前に固定し、フィルター結果はその順位を保つ。

## JSON保存

```text
market/hunter/
  universe/<universeHash>.json
  jobs/<jobUuid>.json
  indexes/active.json
  indexes/latest.json
  indexes/dates/<asOf>.json
  indexes/<datasetHash>/manifest.json
  indexes/<datasetHash>/shards/<date>/<0..63>.json
  rankings/<jobUuid>/<code>.json
  rankings/<jobUuid>/index.json
  details/<datasetHash>/<code>.json
  coverage/<jobUuid>.json
  backtests/<studyUuid>.json
market/bottom-series/<code>/<asOf>/<seriesId>.json
predictions/<predictionId>/original.json
predictions/<predictionId>/state.json
evaluations/<predictionId>/<evaluationHash>.json
memories/<summaryUuid>.json
sync/<summaryUuid>.json
```

主要レコードにはschemaVersion、methodVersion、基準日、締切、入力識別子を保存。索引は `hunter-shard-v2` の版をdatasetHashに含める。原本ページ・master hash・calendar・スコア/分類設定・mode・cutoffを識別する。派生索引のhashも検証。版・入力が変わった中断ジョブは混ぜて再開せず、新ジョブを要求する。

すべて既存Storeのatomic write／writer lockを使う。市場原本・予測原本の破壊的移行なし。market、predictions、evaluations、memories、sync配下なので既存の暗号化export/import対象に含まれる。

## API

すべて既存Fastifyの認証・Originチェック配下。入力はZod、ランキング・詳細・状態は共有スキーマを使う。

| メソッド | パス | 内容 |
| --- | --- | --- |
| GET | `/api/bottom/hunter/status` | 直近10ジョブ・プラン・直近完了coverage |
| GET | `/api/bottom/hunter/rankings` | jobId/asOf、各フィルター、page/pageSize（最大100件） |
| GET | `/api/bottom/hunter/candidates/:code` | 個別解析・根拠・必要な銘柄だけデジャヴ |
| GET | `/api/bottom/hunter/jobs/:id` | 永続化された進捗 |
| POST | `/api/bottom/hunter/jobs` | scan/initial/update/correctionの明示開始、または `{resumeJobId}` |
| POST | `/api/bottom/hunter/jobs/:id/cancel` | 協調キャンセル要求 |
| POST | `/api/bottom/hunter/forecasts` | `{jobId, code, recordingMode}` から1・5・20営業日の原本保存 |
| GET | `/api/bottom/hunter/forecasts` | ページ単位のハンター予測ジャーナル |
| POST | `/api/bottom/hunter/evaluations` | 保存済みデータだけで期限後評価。外部送信なし |
| GET | `/api/bottom/hunter/evaluations` | 区分・期限・分類・点数帯別の集計 |

既存 `/api/similar` と説明APIは任意の `hunterJobId` を受け取る。ジョブの基準日と一致を要求し、新経路の両比較系列だけを使う。旧呼出しの挙動は維持。新経路の仮説は専用APIで記録する。

## 起動・中断・再開

起動・閲覧で市場取得は始めない。`/bottom/hunter` の基準日を指定し、ジョブ欄から明示開始する。scanはローカルJSONだけ。initialは指定期間を初回取得、updateは完了日を既存checkpointで省略、correctionは指定期間の末尾5営業日を明示revisionへ取得する。HTTPでの取得開始は `confirmExternal: true` が必要。

CLIも同じサービス関数を使う。実データには既存live保存先と接続設定が必要。以下は操作例であり、この開発作業では実API取得を実行していない。

```powershell
pnpm job:hunter -- --kind scan --asOf 2026-10-09 --from 2026-01-05
pnpm job:hunter -- --resume <jobUuid>
pnpm job:hunter -- --cancel <jobUuid>
pnpm job:hunter -- --kind initial --from 2026-01-05 --asOf 2026-10-09 --confirm-external
pnpm job:hunter -- --kind update --from 2026-10-01 --asOf 2026-10-09 --confirm-external
pnpm job:hunter -- --kind correction --from 2026-10-01 --asOf 2026-10-09 --revision correction-20261017 --confirm-external
pnpm job:hunter -- --walk-forward --from 2026-07-01 --asOf 2026-10-09 --step 20
```

Freeでは84日の遅延範囲へ日付を置き換える。APIキーはJSON・ログに保存しない。既存JQuantsLimiterを共有し、429/Retry-After、401/403、5xx、ページ再開を再利用する。取得中はネットワーク待ちで全体writer lockを保持しない。

キャンセルは処理中の取得ページ／銘柄の境界で反映。終了を待って同じjobUuidを再開する。強制終了後もcheckpointは残り、明示再開で死んだPIDのleaseを回復する。生存中かつ有効期限内の別workerのleaseは奪わない。自動的な外部接続再開はしない。

## 性能と制限

内部関数を直接呼び、銘柄数分のHTTP要求は発行しない。取得ページを日付ごとに64分割し、同じ分割の銘柄を続けて処理。ジョブ内だけの読込キャッシュは32 MiB相当（JSON bytes×4の見積もり）、並列数1〜4、対象最大20,000、期間最大5,500営業日、日付別revision最大200,000、単一銘柄revision最大100,000。これらは安全停止用の上限で、契約の取得範囲を拡張しない。プロセスRSSそのものの厳密な上限ではない。

完了済み銘柄はcheckpointから再利用。全件へデジャヴを実行しない。候補詳細・予測作成で要求された銘柄だけ解析する。coverageは対象・取得済み・連続80日・判定可能・候補・判定不能・失敗・除外理由・基準日・締切・遅延を保存する。取得不足を隠さず、全対象が判定できた場合だけcompleteとする。

ベンチマークは `pnpm exec tsx scripts/hunter-benchmark.ts 2000`。一時フォルダー内の2,000銘柄×80営業日（160,000行）を使い、外部接続はゼロ。測定結果は末尾に記録する。

## デジャヴ・予測・検証・MemWal

`readHunterSeries()` はジョブの索引・締切から `MarketIngestion.series()` を呼ぶ。単一調整基準を守り、既存 `dejavu()` の比較窓・結果窓重複除外、未来情報除外、revision固定を維持。表示5例、統計5/10/20件比較、四分位・中央値・経験的上昇割合・候補不足警告を既存DejavuResearchで表示する。事例ゼロなら中央値を捏造せず予測作成を拒否。

仮説は `bottom-hunter-hypothesis-v1`。底打ち解析・指標・分類・リスク・統計・全統計候補のrevision ID・期限・締切・作成時刻を原本へ固定。同一入力の再作成は既存原本を返す。既存の `dejavu-consensus-v1` 原本は変更しない。

recordingModeはresearch／walk-forward／live。liveは基準日と取得締切が当日で、対象営業日が未来の場合だけ受け付ける。過去日の新規作成はresearch。walk-forwardは各基準日末以前の締切で、その時点に取得済みのマスター・価格だけを使い、時点順に候補抽出と統計計算を再実行する。今日ダウンロードした過去価格を「当時取得済み」とみなさない。過去データの取得記録がなければ、その時点を失敗・除外として記録する。

評価は同一調整基準の基準日〜期限日価格から実現リターン、中央値誤差、方向一致、終値ベース最大ドローダウンを別JSONへ保存。欠損を補間しない。訂正実績は別評価hashへ保存。集計はmode／experiment／期間／分類／20点帯で分離し、未評価・評価可能・評価済みを返す。現時点のスコアや経験的上昇割合を校正済み的中確率として扱わない。

MemWalへは原本・価格系列・ランキングを送らず、`hunter_research_summary` と `hunter_reflection` の決定的要約・参照IDだけを保存する。予測・評価単位の固定IDで重複防止。既存記憶が無効・削除済みでも再作成しない。同期は既存SDK・pending/accepted/synced/uncertain・pendingText・job追跡・削除抑止を維持する。

新しいハンター要約の送信には両方必要:

```text
ALLOW_MARKET_DATA_TO_MEMWAL=true
JQUANTS_MEMWAL_RIGHTS_CONFIRMED=true
```

後者は利用者が契約上の外部送信権限を確認した場合だけ設定する。既定false。未確認・MemWal未接続・通信障害でもランキングと評価は動き、要約はローカルに残る。この開発ではMemWal実送信・Suiトランザクションを実行していない。

## 検証結果・残課題

2,000銘柄×80営業日の隔離fixtureで、取得済み2,000、連続80日2,000、判定可能2,000、失敗0、判定不能0、重複0を確認。横ばいのfixtureなので候補は0件であり、全件デジャヴを実行していない。

| 測定項目 | 結果 |
| --- | ---: |
| コールド走査（並列4） | 154.77秒 |
| 完了済みジョブの再実行 | 6.60 ms |
| 50 ms間隔でサンプリングした最大RSS | 297,775,104 bytes（約284 MiB） |
| 市場API・MemWal・Suiへの実処理 | 0回 |

初回測定は220.76秒・系列保存失敗1件で正常完走ではなかった。分割単位の処理順・限定キャッシュ・Windowsロック解放の再試行後に上記の全件成功を確認。単回で並列テスト負荷も異なるため、厳密な速度改善率は主張しない。これは160,000行の検証であり、20年分の実市場履歴の速度保証ではない。

HTTP応答時間、React初期表示・チャート描画時間は未計測。ハンター画面の別JSチャンクは19.16 kB（gzip 6.61 kB、共有依存を除く）。

最終チェック結果は末尾の表へ記録する。

追加検証: 0/1/複数銘柄、2,000銘柄バッチ、個別解析との一致、分類不明除外、前提なし高得点、流動性未確認、80日不足・欠損、訂正revision・入力変更による再開拒否、同時ジョブ・キャンセル・再開、取得401の復旧、索引hash破損、未取得時点、予測不変・評価冪等、実際に仮説を作るwalk-forward、記憶の権限・削除・通信障害、URL・モバイル。分割・併合・ライツ、429/Retry-After・403・5xx、JSON・暗号化バックアップは既存foundation/storageテストも継続実行する。

Windows一時ディレクトリ削除のEPERMと、高負荷中の短いE2E待機期限の超過を検出して修正・再検証。別作業で追加された記憶の検索索引確認については、製品コードを上書きせず既存E2Eへavailabilityのモックを追加した。wallet SDKの外部メタデータ取得失敗・Lit開発モードの警告は、外部実接続成功を意味しない。

未検証: 実J-Quants接続、実MemWal保存・検索品質、実Sui取引、実市場全銘柄での長期性能、実端末の初期描画時間。fixture・モックの成功と区別する。

第3弾: 実データ運用での取得カバレッジ監査、取得計画の自動提案、上場廃止・市場区分変更の長期検証、JSON索引の世代整理、ネットワーク待機の即時キャンセル、進捗UIの詳細化、out-of-sample校正・比較モデル、クラス別サンプル不足の統計的評価。DB導入や旧原本の削除は本実装の前提にしない。

## コミットと最終確認

| 段階 | コミット | 内容 |
| --- | --- | --- |
| 1 | `dfce0bc` | universe・coverageモデル |
| 2 | `2eb83a0` | 再開可能スキャナー |
| 3 | `2a66d2c` | API・ページング |
| 4 | `06a9c56` | ダッシュボード |
| 5 | `0e00900` | 新原本とデジャヴの接続 |
| 6 | `9854b26` | 不変予測原本・別レコード評価 |
| 7 | `51bd6c2` | 要約・反省・MemWal送信制御 |
| 8 | `176fd31` | 安全性・walk-forward・CLI・大量銘柄・E2E |
| 9 | 本ドキュメントのコミット | 構成・操作・制約・検証記録 |

各段階でlint・typecheck・testを実行。中断時点の未コミット差分も再調査してから続行した。並行して変更されていた開発サーバー／Origin認証／記憶削除・検索リセットの製品コードは上書き・巻き込みコミットをしない。最終テストの実行値は、それらの並行変更も存在する作業ツリーに対する結果である。

ウォッチリスト追加は既存APIを利用し、走査済み銘柄の照合後に必要な1銘柄だけ既存表示マスターへ追加する。全市場ユニバースを監視リストへ流し込まない。10銘柄上限を超える操作は既存と同様に拒否する。

E2Eは共有するJSON fixtureへの同時変更を避けるため1 workerで実行する。複数workerで発生した予測・チャット完了待機の競合を解消し、状態の期待値は緩めていない。製品のbounded concurrencyと別ジョブの同時起動抑止は単体テストで別途検証する。

| 最終コマンド | 結果 |
| --- | --- |
| `pnpm lint` | 成功 |
| `pnpm typecheck` | 成功 |
| `pnpm test` | 32ファイル・118件成功、28.36秒 |
| `pnpm test:e2e` | 22件成功、44.8秒（1 worker） |
| `pnpm build` | 成功、Vite処理717 ms |
| `git diff --check` | 成功 |

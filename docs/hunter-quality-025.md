# 底打ちハンター2.5 品質強化

調査・実装日：2026-10-17。開始時に `git fetch origin main` を実行し、mainとorigin/mainの差分が0/0であることを確認。起点は `d5f6ccb`。DB・常駐サーバーの追加なし。市場データ取得、MemWal送信、Sui取引の実行なし。

## 1. データ整合性

調査：`hunter-jobs.ts` のcreate/acquire/patch/run/screen、`hunter-index.ts` のbuildHunterIndex/readHunterObservations、`hunter.ts` のランキング・詳細、`hunter-research.ts` の系列再構成、`bottom.ts` のanalyzeBottom。既存のcutoff除外、原本hash検証、revision別索引、JSON writer lock、シャード上限は再利用。

問題：詳細キャッシュはdatasetIdだけを参照し、分類設定・調整方式・プラン等の分析条件の識別が不十分。分析後の保存時にcancel/leaseを再確認していない。期限切れleaseの旧workerがactive参照を更新できる余地があった。明示cutoffが取得後に上書きされる。予測IDにも分析条件の識別が必要だった。

対策：`hunter-consistency.ts` を追加。新しいanalysisIdは以下をhash化する。

| 入力 | 識別する内容 |
| --- | --- |
| datasetId | シャード版、モード、基準日、cutoff、カレンダー営業日、取得ページ・master hash、失敗日、既存設定を含む既存ID |
| universeId | その時点の対象・除外銘柄・マスター |
| index.dates/inputIds | 取得期間、原本revision入力 |
| BOTTOM_CONFIG | 特徴量版、採点methodVersion、閾値・配点・流動性条件 |
| HUNTER_CONFIG/HUNTER_METHOD | 分類条件・ハンター方式 |
| ADJUSTMENT_VERSION | 調整系列の方式 |
| mode/asOf/cutoff/plan | demo分離、基準時点、取得締切、遅延リスクに影響する契約プラン |

詳細は `market/hunter/details/{analysisId}/{code}.json` に保存し、完全一致条件だけ再利用。ジョブにanalysisIdを追記。中断ジョブの入力revision・分析条件が変わったら新規ジョブを要求する。保存前にjobのlease/status/cancelとactive lease所有者を確認し、旧workerの更新を拒否。完了index公開前もcancelを再確認。明示cutoffを保持する。

詳細表示・予測記録はZodで検証し、銘柄・ジョブ・基準日・cutoff・revision参照hashとランキングの一致を確認。新規予測のID・hunterメタデータにもanalysisIdを含める。過去の予測原本は上書き・削除しない。

互換性：analysisIdのない旧JSONはdatasetIdの旧パスから読める。既存JSONの移動・変換なし。ただし旧形式の中断ジョブは安全に分析条件を証明できないため再開を拒否し、新規ジョブを案内する。過去の完了結果・原本は維持。

検証：完全一致入力の別ジョブ再利用（詳細の追加書き込み0）、cutoff違いのID分離、obsolete分析IDの再開拒否、2つのHunterJobsインスタンスの同時実行で片方だけ成功、分析中cancel後の結果保存0件、demo/live変更拒否、既存の訂正revision・未来cutoff・破損シャード・中断再開テスト、旧詳細JSONの読み取りと不一致revisionの拒否が成功。

残課題：worker抑止は同一JSONルート・ローカルPIDによる既存設計。複数ホストで共有ネットワークディスクを使う分散workerは対象外。既存の単一走査worker制限を維持した。

## 2. 人工相場

調査：bottom-features/score/schema、classifyBottom、原本調整処理、既存bottom/hunter安全性テスト。採点・閾値・分類方式は変更していない。

`fixtures/hunter-scenarios.ts` と `tests/hunter-patterns.test.ts` でOHLCVから算出する分類・点数・リスクを固定。期待値はレビュー可能なsnapshotとして保存。

| 人工相場 | スコア | 分類・確認事項 |
| --- | ---: | --- |
| 急落後V字回復 | 70 | 反発進行中、支持帯からの乖離リスク |
| 長期下落後の底固め | 50 | 反転兆候あり、長期下降リスクは残る |
| 偽の反発 | 70 | 反転兆候あり。その後の失敗で過去判定を変更しない |
| 出来高急増反転 | 85 | 反転兆候あり |
| RSI回復・終値下落 | 40 | 警戒、新安値リスク。RSI回復条件と終値下落を別途assert |
| 1:2分割・2:1併合 | 各70 | 調整系列で反転兆候あり |
| 最終日出来高ゼロ | 70 | 警戒、no_trading_volume |
| 履歴60日 | null | 判定不能 |
| 途中営業日欠損 | — | 調整処理が連続原本不足で拒否 |
| cutoff後の改訂 | 70 | 未取得revisionを除外し、過去判定は不変 |

成功と失敗のfutureReturn20は入力と別のfixtureメタデータ。同一観測prefixで異なる未来を持つことを検証するもので、実市場の的中率ではない。実績計算と原本不変性は既存ジャーナルテストでも検証。売買停止の全null原本や複雑な企業行動は既存の調整・bottom安全性テストも併用する。全種類の企業行動を網羅したものではない。

## 3. データ取得カバレッジ

既存coverage JSON/APIを拡張し、periodFrom/periodTo/planを任意項目として追加。旧JSONは「開始日未記録」と表示。新規保存分は営業日カレンダーまたは明示fromを記録する。データ品質欄は以下を表示する。

- 対象数・除外数・処理済みから分かる未処理数
- 取得済み・80営業日連続・分析可能・候補・取得失敗・判定不能数
- 取得対象期間・基準日・cutoff・最終観測時刻・プラン・契約遅延
- 欠損・除外・判定不能理由の件数（理由は重複し得るため合計と銘柄数は一致しない）

かぶまるは未取得・未判定を含むことと未処理数を通常の文章で説明し、操作を遮らない。API・画面表示のために実J-Quantsへ接続しない。中断中のジョブは完成indexがないためランキングが空になる問題も修正し、保存済み銘柄行から部分結果を返す。APIテストで部分結果1/4銘柄とcomplete=falseを確認。

periodFromは要求・索引対象期間であり、各銘柄がすべて取得できたことを意味しない。lastObservedAtは処理済み結果に含まれる最終観測時刻で、未処理原本まで走査した時刻ではない。

## 4. スコア帯別実績

調査：hunter-journalの原本・期限後評価・集計、hunter-backtestの時点別cutoff、hunter-methodと予測スキーマ。既存原本と評価を使用し、80点以上の有効性を検証できる集計を追加。

以前のfloor(score/20)では100点が独立帯になる問題があった。報告帯を0–39、40–59、60–79、80–100へ統一し、nullスコアはunknownとして0点へ混ぜない。

集計軸：mode、prospective/retrospective/walk-forward、1/5/20営業日、判定分類、スコア帯、基準月、予測methodVersion。demoも実市場と分離する。

集計値：総数、未評価、評価可能（評価済み含むeligible）、未保存だが評価可能なavailable、評価済み、平均リターン、中央値、上昇割合（return>0）、方向一致率、予測中央値との差の平均・平均絶対誤差、最大下落のmin/25%/median/75%/maxと取得件数。分位点は既存quantileと同じ線形補間。下落値のない旧評価を0で補完しない。

各群20評価未満は「少数標本・信頼性が低い」と表示。上昇割合・スコアを校正済み確率とは呼ばない。集計対象は既存ジャーナルに記録された仮説であり、全ランキング銘柄を自動的に予測へ変換しない。記録がないスコア帯の成績は算出できない。

検証：境界値0/39/40/59/60/79/80/100/null、空分布・奇数/偶数中央値、4帯×3実験区分×2月=24群の分離を固定。人工評価値+10%/-20%、上昇割合100%/0%、少数標本、eligibleを確認。既存の原本不変・冪等評価・walk-forward再実行テストも成功。

**実市場のスコア帯別成績は未検証。80点以上が好成績という結論は出していない。配点・閾値・既存methodVersionの計算結果は変更していない。**

## 5. 画面と性能

調査：BottomHunter、HunterPriceChart、mainの遅延route、React Queryキーと既存CSS。mainは既に遅延routeだったため重複実装しない。80点のSVG演算にuseMemoを追加する根拠はなく、追加しない。

- ページ単位取得（既存page/pageSize）を維持。URLのcodeをランキングクエリキーへ混ぜない。
- 30秒のstaleTime。初回status取得で不要にランキングをinvalidateしない。ジョブ進捗変更時は更新する。
- 評価集計は「成績集計を表示」を開くまで取得しない。初期集計リクエスト0件をE2Eで確認。
- チャート・デジャヴは詳細選択時のdynamic import。読込中のSuspense状態を表示。
- 700px以下ではモバイルカードだけをDOMへ生成。デスクトップ表を重複生成しない。viewport変更も追随。
- フィルター・ページはURL、スクロール位置は同一タブのsessionStorageでランキング条件別に保持。再読込の復元処理は描画前のlayout effectと標準復元の制御で適用。テストはURLだけでなく次ページの銘柄描画完了を待つ。pagehideでも最終位置を保存する。
- ランキング読込中・通信エラー・空結果、詳細読込中、成績集計中・記録なしを区別。

### 実測値と制約

Windows・ローカル開発サーバー・Chromium・4銘柄fixture。ネットワーク/CPU固定なし、各計測は単発。純粋なReact commit/paintやiPhone実機の計測ではない。詳細→チャート時間はAPI・chunk取得・SVG可視確認を含む。

| 指標 | 変更前 | 変更後（単独ハンターE2E） |
| --- | ---: | ---: |
| navigation開始→見出し可視 | 1,103.9 ms | 1,010.8 ms |
| 詳細クリック→SVG可視 | 591.8 ms | 939.0 ms |
| ランキングAPI 1回 | 24.5 ms | 33.2 ms |
| BottomHunter単体chunk | 19.18 kB / gzip 6.61 kB | 21.50 kB / gzip 7.32 kB（追加説明と状態処理を含む） |
| HunterPriceChart遅延chunk | 分離なし | 1.65 kB / gzip 0.92 kB |

再計測（全回帰中）：見出し854.6 ms、詳細984.3 ms、API12.3 ms。最終関連E2E：見出し1,164.4 ms、詳細966.9 ms、API27.4 ms。最終全回帰時は見出し714.4 ms、詳細946.2 ms、API11.5 ms。ばらつきがあり速度改善の統計的結論は出せない。初回詳細は遅延chunk取得の待ちが増えた。変更の確定効果は初期集計0リクエスト、詳細chunkの遅延化、ランキングDOMの二重生成解消。総転送量削減や描画高速化を実測で証明したものではない。

同時作業のmain/ブランドCSS/ハンタージョブ案内の変更も作業ツリーに存在する。最終ビルドのBottomHunterは22.76 kB/gzip7.77 kB、CSS48.92 kB/gzip11.09 kBだったが、今回だけの増減として扱わない。最終Viteビルドは802 ms（並列テスト実行中）。iPhone Safari実機・純粋なchart paint・本番回線の初期表示・大量実データのAPI時間は未計測。

## 6. 回帰・安全性

実行結果：pnpm run lint成功、pnpm run typecheck成功、pnpm run test 33ファイル123件成功、pnpm run test:e2e 23件成功、pnpm run build成功、git diff --check成功。最終参照検証追加後に全123テスト、ハンターE2E2件、lint、型検査を含むbuildを再実行して成功。旧JSON互換assert追加後にhunter-apiも再実行して成功。

回帰範囲：demo/実データ分離、デジャヴ・底打ち、原本と期限後評価、J-Quants原本調整、MemWal同期/削除/再送抑止、かぶまる、Sui認証・コミットメントのモック、JSON永続化・暗号化バックアップ、390×844モバイル操作。追加E2Eはページング・URL再読込・スクロール復元・初期集計0・エラー時に空結果文を表示しないことを確認。

追加の再読込テスト中にWindowsのJSON renameが一時的にEPERMで失敗し、ジョブがfailedになる現象を確認。既存のatomic renameを最大5回だけ待って再試行し、旧ファイルを削除しない。テストで一時失敗からの復旧と、全6回失敗時の旧データ保持を確認。

E2E開始時に前回のfixtureサーバーが5517ポートを占有。PIDとcommandLineが本リポジトリのtests/e2e/server.tsであることを確認し、そのプロセスだけ停止して再実行した。財布SDKのメタデータ取得失敗とLitの開発モード警告は残るがテスト成功。市場データの実取得・MemWal外部送信・Sui取引は実施していない。外部実接続の成功を意味しない。

## 7. 変更ファイル・コミット・次の候補

変更ファイル：

- apps/api/src/hunter-consistency.ts（新規）、hunter-jobs.ts、hunter-journal.ts、hunter.ts
- apps/web/src/BottomHunter.tsx
- packages/core/hunter-method.ts、hunter-schema.ts、index.ts、packages/storage/index.ts
- fixtures/hunter-scenarios.ts（新規）
- tests/hunter-patterns.test.ts（新規）、__snapshots__/hunter-patterns.test.ts.snap（新規）
- tests/hunter-api.test.ts、hunter-jobs.test.ts、hunter-journal.test.ts、storage.test.ts、e2e/hunter.spec.ts
- docs/hunter-quality-025.md（本文）

コミット：

1. 6657252 fix: harden hunter dataset and job consistency
2. 9de0045 test: add bottom reversal and failure scenarios
3. f6c52ba feat: improve hunter data coverage visibility
4. fc1e0bb feat: add bottom score outcome validation
5. b31826b perf: improve hunter mobile rendering
6. 35c2d01 test: verify hunter reliability and regressions
7. docs: document hunter quality improvements

別作業のmain.tsx/HomeBrand.module.css/style.cssおよびBottomHunter.tsxのジョブ案内の未コミット差分は保存したまま今回のcommitから除外。

次の候補：権利と取得許可の確認後に実市場データのcoverageを点検、十分な記録数を貯めてスコア帯×期間別の実測比較、候補だけを記録する選択バイアスの明示、実iPhone Safariで初回詳細のプロファイル、繰り返し測定と本番chunk転送量の比較、全null売買停止や複雑な企業行動fixtureの追加。成績が悪くても既存閾値を変更せず結果を報告し、改良方式は別methodVersionとする。

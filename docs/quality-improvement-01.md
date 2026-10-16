# KABUTO WAL 第1弾 品質改善記録

実施日: 2026-10-17（JST）。開始ブランチ `main`、HEAD `da54f02`。
GitHub `origin/HEAD` の読み取り結果も同一。個人データの変更・移行・削除は実施していない。

## Phase 0: 再調査

1. 調査: `packages/core/dejavu-consensus.ts`, `packages/core/dejavu.ts`, `apps/api/src/dejavu.ts`, `dejavu-journal.ts`, `service.ts`, `apps/web/src/DejavuResearch.tsx`, `BottomResearch.tsx`, `main.tsx`, `packages/integrations/index.ts`, `packages/storage/index.ts`, 既存単体・E2Eテスト、predictionSchema、recall用Zodスキーマ。
2. 問題: URLとReact stateの二重管理、Requestのany、表示5事例のみの統計、payloadとtextの重複送信、snapshotの全revision展開。
3. 方針: 重複窓除外・結果窓除外・取得締切・同点順序・削除抑止・同期復旧は既に実装済み。作り直さず再利用。v1予測生成とID計算を維持する。
4. 変更ファイル: 本記録と各Phase記載のファイル。
5. 検証: 開始時build成功。既存のテスト用サーバーは隔離した一時ディレクトリとdemo fixtureを使うことを確認。
6. 影響: APIへの追加フィールドを基本とし、既存予測JSON・既存記憶の移行は行わない。
7. 残課題: 全市場探索は本変更の対象外。全銘柄の取り込み制御・取得計画・走査ジョブは第2弾で設計する。

## Phase 1: URL同期

1. 調査: BottomResearch、Similar、StockPicker、APIのコード・日付検証。
2. 問題: BottomResearchの日付、Similarの銘柄・日付が初回URLからのみ初期化される。
3. 修正: `useResearchParams`でuseSearchParamsを唯一の状態にした。Zodで実在日付と英数字4〜5桁コードを検証。不正パラメータは警告し解析を抑止。URLの他パラメータと日付だけの選択を保持。比較銘柄もURL化。
4. 変更: `apps/web/src/research-params.ts`, `BottomResearch.tsx`, `main.tsx`, `tests/research-params.test.ts`, `tests/e2e/bottom.spec.ts`, `tests/e2e/research-navigation.spec.ts`。
5. テスト: 直接URL、銘柄変更、日付変更、戻る・進む、不正URLで解析通信しないこと、底打ち→デジャヴ遷移、既存モバイルE2E。
6. 影響: StockPicker本体は未変更。URL共有・再読み込み時にも選択条件を復元。
7. 残課題: StockPicker入力途中の文字列は従来どおりコンポーネントが管理。URLの不正値は勝手に書き換えず、編集で修正する。

## Phase 2: API型安全性

1. 調査: Request、searchDejavuの戻り値、predictionSchema、storedSchema、evaluations、reflections、memories。
2. 問題: フロントのanyは壊れた応答をそのまま描画する。
3. 修正: RequestはPromise<unknown>。共通 `dejavu-api-schema.ts` で解析・consensus・DNA・評価・説明・記憶・保存応答を検証。predictionSchemaを再利用。recallのスキーマを共通化。関連するmapのanyを除去。null統計を維持し、空配列は許可、不正な応答はクエリエラーとして扱う。
4. 変更: `packages/core/dejavu-api-schema.ts`, `apps/api/src/dejavu.ts`, `apps/web/src/DejavuResearch.tsx`, `main.tsx`, `tests/dejavu-memory-projection.test.ts`。
5. テスト: 型検査、スキーマのnull・空応答、既存API・予測・E2E回帰。
6. 影響: APIの既存フィールドは削除しない。従来の通知警告と日足不足応答も保持。未知の追加フィールドは描画用検証で除去されるだけでAPI原本は変更しない。
7. 残課題: 汎用api()・Service.predictions()等の既存anyは残存。今回のデジャヴ応答境界で検証し、他画面の全面改修は避けた。

## Phase 3: 統計の信頼性

1. 調査: dejavu候補選別、consensus、recordDejavuForecast、画面の統計表示。
2. 問題: 上位5例の経験分布だけでは標本数による変動を確認できない。
3. 修正: 既存選別を通過した最大20件を統計用に取得。表示は5件のまま。`statistics.comparisons`で5・10・20件の経験分布を返す。新methodVersionは `dejavu-consensus-comparison-v2`。画面で各期間の実件数・候補不足・上昇割合・中央値を並べる。
4. 変更: `packages/core/dejavu.ts`, `dejavu-consensus.ts`, `dejavu-api-schema.ts`, `apps/api/src/dejavu.ts`, `apps/web/src/DejavuResearch.tsx`, `tests/dejavu-consensus.test.ts`, `tests/dejavu.test.ts`。
5. テスト: 0・1・5・25件、全上昇・全下落・混在、欠損将来値、重複ID・比較窓・結果窓、同点入力順序、未来追加・未来改変・未取得データを除外。新統計プールも結果窓が比較元より前であることを検証。
6. 影響: `consensus`と予測生成は従来の5例・`dejavu-consensus-v1`を維持。過去原本・評価は上書きしない。比較統計は予測記録へ採用しない。上昇割合を校正済み確率と呼ばない。
7. 残課題: 20件でも統計的独立性や市場レジームの偏りは保証できない。校正、アウトオブサンプル評価は第2弾以降。

## Phase 4: MemWal送信最適化

1. 調査: saveDejavu、forecast内の原本保存、syncMemories、recallDejavu、同期・削除・バックアップテスト。
2. 問題: JSON分析全体がpayloadとtextへ重複し、同期時にそのままJSON化される。
3. 修正: 新規送信の境界でのみ `projectDejavuMemory` を適用。参照ID・銘柄・時点・特徴量版・上位事例の日付/スコアと検索要約へ投影し `transportVersion: 2` を付加。旧recallスキーマで読める構造を維持。ローカルpayload・textは完全保持。
4. 変更: `packages/core/dejavu-memory.ts`, `packages/integrations/index.ts`, `tests/dejavu-memory-projection.test.ts`。
5. テスト: 投影の旧スキーマ適合、原本非変更、許可false時送信なし、deleted/searchReset抑止、旧pendingTextと受付キーの再利用、既存同期・削除・暗号化保存テスト。
6. 影響: SDK・接続先・ネットワーク・namespace・送信許可・状態遷移は変更なし。acceptedのjob追跡は従来どおり。既に永続化された送信本文を再投影しない。既存の削除抑止を通過した新規送信だけに適用。
7. 残課題: 実MemWalでの検索品質と保存サイズは未検証。外部サービスへ送信していない。旧リモート記憶を置換・削除しない。ローカルの重複text削減は原本互換性のため見送った。

## Phase 5: 性能

1. 調査: snapshotのrevision読み込みと展開、検索呼出し、チャート40行生成、クエリ再取得、build出力。
2. 問題: 取得記録ごとに全日足オブジェクトを中間配列へ展開してから再走査。画面モジュールが同期import。操作後に全条件の関連クエリを再取得。
3. 修正: cutoffを一度パースし、revision走査中に日付別の最新既知価格を選別。同時刻は従来と同じ先着優先。履歴フォールバック条件も維持。キャッシュは導入しない。研究2画面をlazy化しSuspenseを追加。再取得は操作と現在条件に限定し並列実行。小規模チャート生成は計測根拠がないためuseMemoを増やさない。
4. 変更: `apps/api/src/dejavu.ts`, `apps/web/src/main.tsx`, `DejavuResearch.tsx`, `scripts/dejavu-benchmark.ts`。
5. 検証: 再現コマンド `pnpm exec tsx scripts/dejavu-benchmark.ts`。隔離fixture 2,006日足、content1件＋observation20件、展開相当40,120行、各7回の中央値。測定は統計比較追加後のsnapshot最適化前後。ネットワーク・個人データ不使用。
6. 影響: 永続化・APIの選択結果を変えず、一時配列を削減。revision読み込み件数は21件のまま。別HTTPリクエスト間の重複検索は残る。
7. 残課題: 本番データでの計測、revision索引、同条件解析再利用。導入時はmode・銘柄・比較銘柄・基準日・取得締切・revision・calendar・methodVersionをキーにし、削除や取得更新を考慮する。

| 指標 | 改善前 | 改善後 | 備考 |
| --- | ---: | ---: | --- |
| snapshot中央値 | 77.00 ms | 44.00 ms | 約43%減、ローカルfixture |
| searchDejavu全体中央値 | 179.39 ms | 138.13 ms | 約23%減、HTTP通信を含まない |
| heapUsed終了時参考値 | 137,251,008 bytes | 80,759,640 bytes | GC未固定、ピーク・厳密な比較ではない |
| payload＋重複text | 76,176 bytes | ローカルでは維持 | 共通メタデータを除く |
| MemWal投影JSON | — | 1,025 bytes | メタデータ込みのfixture1例、実送信なし |
| 主entry JS | 824.57 kB | 285.78 kB | minify後、共有チャンクを除く |
| 主entry gzip | 246.37 kB | 90.47 kB | 初期転送総量ではない |
| 研究画面の別チャンク | — | 底打ち7.59 / デジャヴ19.04 kB | 共有ライブラリを除く |
| HTTP API応答時間 | 未計測 | 未計測 | 上の関数時間と区別 |
| React初期表示 / チャート描画時間 | 未計測 | 未計測 | ブラウザ性能測定なし |

共有チャンクの再編があるためentry縮小だけをページ高速化とみなさない。
初回build 1.33秒、分割後0.696秒はVite処理のみで、単回・キャッシュ条件も違う参考値。
最終的な静的依存チャンク総量や実端末表示速度の改善は未確認。

## Phase 6: 品質保証

1. 調査: 全既存テスト、playwrightのdemo専用サーバー、追加したURL・送信境界テスト。
2. 問題: 追加URLテストがパラメータ順序を固定して初回失敗。値は正しく同期していた。
3. 修正: URLSearchParamsで値を比較する期待値へ修正。
4. 変更: `tests/e2e/research-navigation.spec.ts`, `tests/dejavu.test.ts`, `tests/dejavu-memory-projection.test.ts`, 本記録。
5. 結果: 最終確認結果は下記。失敗した追加テストは修正後に再実行。
6. 影響: J-Quants/demo分離、デジャヴ、底打ち、予測・期限後評価、MemWal同期・検索・削除、通知・チャット、Sui認証・コミットメント、JSONと暗号化バックアップはfixture・モックで回帰確認。個人データの移行なし。
7. 残課題: 実J-Quants/MemWal/Suiへの接続検証は未実施。E2Eでwallet SDKのメタデータ取得失敗とLit開発モード警告が出るが、テストは通過。市場データ実送信やSuiトランザクションは実行していない。

### 最終チェック

| コマンド | 最終結果 |
| --- | --- |
| `pnpm lint` | 成功 |
| `pnpm typecheck` | 成功 |
| `pnpm test` | 23ファイル・105件成功（16.02秒） |
| `pnpm test:e2e` | 21件成功（31.6秒） |
| `pnpm build` | 成功（最終Vite処理2.40秒、他チェック並列実行下） |
| `git diff --check` | 成功 |

モック・fixtureによる成功であり、外部実接続検証済みという意味ではない。

### コミット

- `8ae02e3`: URL同期
- `f16e69d`: API応答の共通スキーマ
- `c7de732`: v1を保持した統計比較
- `554d556`: MemWal送信境界の投影
- `a5b2afa`: snapshotと画面分割、ベンチマーク
- 最終コミット: クエリ再取得の限定・追加回帰テスト・本記録

第2弾では、この表示/統計候補の分離、URL条件、応答検証、時点整合性を保つsnapshotを再利用できる。全市場走査・ランキング・モデル校正はまだ実装していない。

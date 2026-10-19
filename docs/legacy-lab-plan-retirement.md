# 旧形式研究計画の廃止（2026-10-19）

起点main `5acf742`。fetchと未コミット差分なしを確認。旧形式は `research/lab/plans/{planId}/original.json` にevaluationHashesプロパティを持たない計画。現在はoptionalであり、manifest検証だけの旧計画を実行できる。

## 読み取り専用調査

`scripts/audit-legacy-lab-plans.ts` はService・dotenv・SDKを起動せず、明示した保存先だけを調査する。計画の件数・ID・作成日時と参照ファイル名だけを返す。変更・削除・外部送信はしない。確認不能・部分確認は0件と扱わない。

| 保存先 | 状況 | 旧形式 | 新形式 |
| --- | --- | --- | --- |
| ローカル `data/demo` | 読取確認済み | 0 | 0 |
| 標準 `data/personal` | 自動承認レビューで読取拒否、追加承認待ち | 未確認 | 未確認 |
| 実データの例 `data/live` | 自動承認レビューで読取拒否、追加承認待ち | 未確認 | 未確認 |
| 配備例 `/data/stock-memory` | 接続していない | 未確認 | 未確認 |
| 任意の別DATA_DIR・別端末 | .env・秘密設定を読まないため実稼働先不明 | 未確認 | 未確認 |

確認済みデモでは旧形式planId・作成日時の集計対象なし。ローカル標準先とliveは既存AGENTSの実データ読取禁止との衝突で自動承認レビューが拒否したため、別途利用者の承認を確認する。実際のDATA_DIRは環境依存で、例のパスを本番確認済みとは扱わない。

## ソースから確認した参照関係

- 研究実行：`research/lab/runs` のcheckpointがplanId、shard・完成レポート・Validation受領記録がrunIdとplanIdを参照する。
- Training/Validation/Test：計画のpartitions・固定評価ID、selection、exposures/observedが期間と方式を固定する。削除すると期間再利用防止の判断を壊すため保持する。
- 研究ノート・仮説：提案にplanId、完成レポートにnotebookIdsが入り、ノートやEvidenceから間接参照される。旧形式は新しい仮説・実験の根拠として再実行しない。
- 自律エージェント：foldPlanIds/sourceHashesが計画を固定し、承認計画・成果物・実験・記憶・研究証跡へ連鎖する。実行時は共通の固定入力検証で拒否する。
- MemWal：ローカル記憶・同期状態にrunId/reportId/sessionId等の参照がある。SDKや削除仕様は変更せず、原本・削除抑止を保持する。リモートの記憶は未照会。
- Sui：研究証跡は現行ソースではローカルhash生成のみ（sendSupported=false）。予測アンカーとは別物。過去の外部チェーン上の状態は未確認。SDK・ウォレット・署名処理は変更しない。

削除は行わない。外部MemWal・Suiの実参照件数は未確認であり、ローカル調査から0件とは推定しない。

## 実装

`labPlanHistorySchema`は旧形式を含む読取専用、`labPlanSchema`はevaluationHashes必須の実行用とした。新規作成はサーバーが現在の入力からhashを固定し、ID集合とhashキー集合の完全一致を検証する。旧JSONへ現在のhashを後付けしない。

開始・再開・方式選択・Test開封・完成レポート生成は実行用の共通検証を通す。自律エージェントのfold入力も同じ境界で拒否する。過去のTest封印・参照期間は、旧形式を含め保持し、未使用Testへ戻さない。

通常の`readLabReport`は旧形式を拒否する。別の`readLegacyLabReportHistory`だけが保存済みレポートのschema・hash・ジョブ/計画/方式参照を照合して読み取る。現在の価格や評価から再生成せず、レポートがなければ生成しない。これは作成当時の評価証拠の完全な再検証ではなく、保存済み履歴の整合性確認に限定する。

旧形式のGET閲覧ではcheckpoint復旧を書き込まない。APIと研究所画面にlegacy/executableの状態を付け、旧形式の開始・再開・Test方式選択・新規仮説生成を無効化する。画面に「旧形式・再実行不可」と、新しい計画を作る案内を表示する。履歴専用レポートでは記憶保存・同期・証跡生成の操作を表示しない。既存SDK・MemWal削除・ウォレット・アンカーは変更しない。

監査の参照一覧はJSON内の直接IDと、run/report/session/manifest等を介する静的な参照候補であり、外部で実際に利用された証明とは扱わない。原本はすべて保持する。

## 検証結果

- 新形式の正常作成、旧形式raw JSONの実行用schema/新規作成への投入拒否。
- 旧形式の開始・実行・resume操作・Test直接開封・完成ジョブからの新規レポート生成を拒否。エージェントのfold入力でも拒否。
- 旧計画・checkpoint・保存済み完成レポートを変更せず、GETでlegacy=true/executable=false、レポートでhistoryOnly=trueを返す。
- 新形式のevaluationHashesがID集合と一致していても、実際の評価原本hashと違えば拒否。
- 旧形式のブラウザ画面で方式と確認を選んでも実行・再開・Test方式選択を無効化し、320px幅と再作成案内を確認。
- 新形式の通常実験、Test封印、底打ちスカウト・AI研究員などの既存回帰を維持。

`pnpm lint`、`pnpm typecheck`、`pnpm test`（71ファイル・204件、194.20秒）、`pnpm test:e2e`、`pnpm build`が成功。追加assertionを含む関連3ファイル・8件も再実行して成功した。最初の旧形式UIテストはラベルの厳密指定で対象を見つけられずタイムアウトしたが、役割とアクセシブル名による指定へ修正して成功した。テストはfixture・一時ディレクトリとブラウザのモックを使い、実外部サービスに接続していない。

実行用schemaの必須化によって、旧形式のAPI利用者・CLIも再実行できなくなる。保存済みhashの自己整合性は履歴閲覧で確認するが、当時存在しなかった評価hashの証明にはならない。壊れた原本・欠損レポートは読取エラーとし、推測による修復や現在データでの補完はしない。

今回の変更ファイル：読取専用監査スクリプトと監査テスト、coreの研究計画/レポートview schema、APIの計画読取・時系列検証・runner・仮説・report・routing、エージェントの実行用計画読取、KabumaruLab画面、固定入力/旧形式単体テスト・旧形式E2E。この文書を含め、実データJSONや.env・SDK・ネットワーク設定は変更していない。

変更ファイル一覧：

```text
scripts/audit-legacy-lab-plans.ts
packages/core/hunter-experiment-schema.ts
packages/core/hunter-lab-report-schema.ts
apps/api/src/hunter-experiment.ts
apps/api/src/hunter-experiment-temporal.ts
apps/api/src/hunter-experiment-runner.ts
apps/api/src/hunter-experiment-hypotheses.ts
apps/api/src/hunter-experiment-report.ts
apps/api/src/hunter-experiment-api.ts
apps/api/src/kabumaru-agent-walk-forward.ts
apps/web/src/KabumaruLab.tsx
tests/legacy-lab-audit.test.ts
tests/legacy-lab-retirement.test.ts
tests/hunter-lab-input-integrity.test.ts
tests/e2e/legacy-lab.spec.ts
docs/legacy-lab-plan-retirement.md
```

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

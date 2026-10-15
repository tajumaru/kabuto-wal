# API

すべて `/api` 配下。実モードはauth以外本人セッション必須。demoは架空データだけを匿名利用。書込はOrigin照合と共通ファイルロック。入力はZod、提供コードは英数字4〜5文字、IDはUUID。

| API | 用途 |
|---|---|
| GET auth/challenge / POST auth/verify / POST auth/logout | Sui本人認証 |
| GET status / master / watchlist | 接続、銘柄、監視一覧 |
| POST watchlist `{code}` / DELETE watchlist/:code | 10銘柄までの監視 |
| GET stocks/:code/history | JSONの厳密な日足取得 |
| GET similar?code=&asOf= | 数値類似検索。asOf省略時は最終日足 |
| GET dejavu/consensus / dejavu/explanation | `code,asOf?,compareCode?`。統計・DNA・定型解説と反省記憶 |
| POST dejavu/forecast | `{code,asOf?,compareCode?}`。1/5/20営業日の研究仮説を冪等記録 |
| GET dejavu/evaluations | `code,asOf?,compareCode?`。デジャヴ予測と評価一覧 |
| GET predictions / POST predictions `{code,horizon,asOf?}` | 予測一覧と1/5/20営業日予測 |
| GET evaluations/summary / GET backtest?code=&horizon= | 期限・モード・手法別集計とwalk-forward数値検証 |
| POST predictions/:id/anchor / POST predictions/:id/receipt | testnet用hash準備とreceipt検証 |
| POST connections/memwal | 実MemWalAccountのowner/active/delegate確認 |
| POST evaluations | 保存済みの期限後日足で評価 |
| GET memories / POST memories `{text}` | ローカル全件一覧・明示保存 |
| PATCH memories/:id `{text?,active?}` | 訂正・無効化、履歴追加 |
| GET memory-delete/config | 削除機能の利用条件・所有者・MemWalネットワーク（秘密情報なし） |
| POST memories/:id/remote-delete/:action | `challenge` / `verify` / `prepare` / `submit` / `status` / `cancel`。本人認証に加えMemWal所有者署名が必要。選択記憶のblob 1件のみ。詳細はmemory-delete.md |
| POST chat `{question,code?}` | 正確なJSON根拠＋MemWal候補で回答 |
| PATCH settings `{fetchTime}` | 取得時刻表示。cronも運用側で更新 |
| POST jobs/fetch | 手動取得。cronは `pnpm job` 推奨 |
| POST backup/export `{password}` | 暗号化base64payload |
| POST backup/import `{password,payload}` | 復元と索引再構築 |

エラーは `{error}`。バックアップサイズ上限20MB。大規模履歴は停止中のボリュームバックアップを使用。セッションは非永続のHMAC署名Cookie、有効期限1時間。秘密値をstatusへ返さない。

デジャヴ2.0のレスポンスとJSONの詳細は [dejavu-v2.md](dejavu-v2.md)。既存similarにはconsensus/dnaを追加し、既存evaluationsにもデジャヴ評価を統合しています。

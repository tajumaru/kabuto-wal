# 検証結果

デジャヴ相場2.0の2026-10-15再検証結果は [dejavu-v2.md](dejavu-v2.md#検証結果2026-10-15-jst) を参照。以下は初期実装時の記録です。

2026-10-11、Windows / Node.js v24.14.0 / pnpm 9.12.3で確認。

- lint：成功
- TypeScript typecheck：成功
- Vitest：17テスト成功（営業日、類似・未来除外、分割基準、Brier、canonical hash、保存排他、再起動、原本不変、訂正revision、暗号化復元、J-Quantsページ/null/429、MemWal受付追跡、owner/delegate、LLM参照検証、認証拒否・nonce）
- Playwright：監視追加 → 詳細 → 類似 → 予測 → 期限後検証 → 記憶保存 → チャット根拠。成功。390pxスマホ幅の横スクロールなしも確認。
- Move：owner/hash長/重複predictionId/正常hashの4テスト成功
- production build：成功。チャート等を含むメインJSの500kB超警告あり。ウォレットは別chunkで遅延読み込み。
- CLI日次ジョブ：demoでstatus=done
- デスクトップ・スマホの画面キャプチャを目視確認

外部J-Quants、MemWalリレイヤー、OpenAI、実ウォレット、Sui testnetアンカー取引は未接続。APIキー・account/delegate・package/registry未設定のため、モックと架空fixtureで検証。Docker/Linux実配備は未実施。Windowsでは親ディレクトリfsync対象外。point-in-time市場データの厳密な運用バックテストは未検証。

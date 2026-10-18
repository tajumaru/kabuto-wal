# KABUTO WAL 開発方針

## 構成と保護範囲

- `apps/web` は React/Vite、`apps/api` は Fastify、`packages/core` は研究ロジック、`packages/integrations` は外部接続、`packages/storage` は JSON 保存、`move` は予測コミットメント。
- MemWal、J-Quants、デジャヴ相場の仕様・保存形式・外部送信制御を維持する。作業開始時の未コミット変更を上書きしない。
- `.env`、鍵ストア、秘密鍵、シード、認証情報、実利用者の `data/` を読取・表示・外部送信しない。調査はソースと公開文書で行う。

## 公式スキルの使い分け

`.agents/skills/` に必要な MystenLabs/skills だけを配置している。該当する `SKILL.md` を読み、作業に必要な参照文書だけを追加で読む。

| 対象 | スキル | 主な適用先 |
|---|---|---|
| Sui SDK/API | `sui-sdks` | `packages/integrations/sui.ts`, `anchor.ts` |
| ウォレット接続・署名 | `frontend-apps` | `apps/web/src/wallet.tsx`, `MemoryDelete.tsx` |
| PTB構築・シリアライズ | `ptbs` | `wallet.tsx`, `apps/api/src/blob-delete.ts` |
| Sui読取・Walrus blob | `accessing-data` | `packages/integrations`, `blob-delete.ts`。Walrusは `walrus.md` |
| サーバー・AIエージェントのSui連携 | `sui-ts-sdk-backend` | `packages/integrations`, `apps/api/src/kabumaru-agent*.ts` |

## バージョンに合う根拠

- 実装前に `node_modules/@mysten/sui/docs/llms-index.md` と `node_modules/@mysten/dapp-kit-react/docs/llms-index.md` から該当ページを読む。APIはインストール済みバージョンと型で確認する。
- 現行の `@mysten/sui` v2、`SuiGrpcClient`、`@mysten/dapp-kit-react` を維持する。スキル例を理由にSDKや依存を自動更新しない。
- 不明点は https://sdk.mystenlabs.com 、https://docs.sui.io 、https://docs.wal.app で検証する。利用可能なら Sui documentation MCP (`https://sui.mcp.kapa.ai`) も使う。秘密情報や利用者データを検索・MCPへ渡さない。
- スキルは開発支援であり、署名・送金・配備・鍵生成・外部同期の許可ではない。一般例と既存仕様が衝突する場合は既存の安全境界を優先する。

## 実装時の確認点

- 通常のウォレット送信は `Transaction` を渡し、成功/失敗を確認し、依存読取の前に `waitForTransaction` を行う。受理・digestだけで成功扱いにしない。
- blob削除はサーバーで固定したbytes/digest・署名者・所有者・network・対象blob・削除イベントを照合する。固定署名フローを通常のウォレットgas選択フローへ一律変換しない。不明な送信結果は同じdigestで確認し、自動再送しない。
- MemWalは既存SDK/リレイヤーを維持する。Walrus直接アップロードへの置換やSitesへの移行を行わない。MainnetのMemWalとtestnet限定予測アンカーを分離する。
- AIエージェントは承認済み計画・権限・予算・許可ツールを維持する。J-Quants追加取得、外部書込、Sui取引の予算ゼロと禁止操作を緩めない。ローカルhashをオンチェーン証明と表示しない。

## 検証

`pnpm typecheck`、`pnpm lint`、`pnpm test`、`pnpm build`、`pnpm test:e2e` を変更範囲に応じて実行する。テストはfixture/一時ディレクトリを使用し、実環境設定を読み込ませず実サービスへ接続しない。結果と既存失敗を分けて報告する。

導入元・適用確認・更新方法は [docs/sui-agent-skills.md](docs/sui-agent-skills.md) を参照。

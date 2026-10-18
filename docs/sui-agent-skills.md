# Sui Agent Skills 導入記録

## 調査結果（2026-10-18）

GitHub `tajumaru/kabuto-wal` の `origin/main` をfetchして確認。コミットは `478b4ca`。作業開始時のローカルmainは7コミット先で、既存の未コミット変更8ファイルがあった。その内容は保持し、checkout/reset/pullはしていない。

mainはReact/Vite + Fastify + 共通TypeScript + JSON保存 + Moveという構成。MemWal SDK、J-Quants、デジャヴ研究が既存機能。mainとローカルに公式 `SKILL.md` / `AGENTS.md` は見つからなかった。調査したユーザースキルディレクトリにも該当スキルなし（今回のセッションの利用可能スキル一覧にもなし）。

ローカルのインストール済みバージョンは `@mysten/sui` 2.35.0、`@mysten/dapp-kit-react` 2.1.39、package.jsonのMemWalは0.1.8。SDK v2/gRPCへの移行をやり直す必要はない。

## 選定と出所

- 公式ソース: https://github.com/MystenLabs/skills
- 固定コミット: `e31b38016723e2dcee36161d59c50e028e13b52a`
- 導入先: `.agents/skills/`（Codexのプロジェクトスキル）
- 導入方法: skill-installerの `install-skill-from-github.py` に `--repo MystenLabs/skills --ref <上記SHA> --path sui-sdks frontend-apps ptbs accessing-data sui-ts-sdk-backend --dest .agents/skills --method download` を指定。
- 原文と各スキル配下の参照ファイルを保持。ファイル別SHA-256は `sui-agent-skills-lock.json`。Apache-2.0ライセンスは `third-party/mystenlabs-skills-LICENSE`。

5つのスキルはSDK、Reactウォレット、PTB、Walrusを含むデータアクセス、バックエンド/エージェントをカバーする。`walrus-sites` はホスティング用途で本構成に不要。DeepBook、zkLogin、ブリッジ、CLI設定・配備、設定ファイル生成用スキルも今回不要。Move実装を変更しないためMove専用スキルは追加していない。

## 現行実装への適用確認

| 対象 | 確認と利用方針 |
|---|---|
| SDK | `sui.ts` / `anchor.ts` はgRPCを使用。SDK v1のコード例を混入させず、インストール済みdocsと型を根拠にする |
| ウォレット | `wallet.tsx` は新dApp Kitと `/ui` のConnectButtonを使用。ログインはpersonal messageの署名。予測アンカーはTransactionをウォレットへ渡している |
| PTB | `wallet.tsx` はtyped pure/object入力を使用。`blob-delete.ts` はbytesを固定・simulateし、digestと署名者を照合する別フロー。通常送信用のgas方針をそのまま適用しない |
| Walrus/MemWal | MemWal経由の保存・照合を維持。blob削除の所有者・blob一致検証と削除イベント確認を維持。Walrus一般例から直接保存へ置換しない |
| AIエージェント | `kabumaru-agent-schema.ts` / `kabumaru-agent-policy.ts` の追加取得・外部書込・Sui取引ゼロ、禁止操作を維持。バックエンドスキルにある鍵生成や署名送信例を実行権限として扱わない |

導入時に、予測アンカーの送信後 `client.core.getTransaction` の前に `waitForTransaction` がない点を発見。後続の改善作業で `wallet.tsx` に確認待ちを追加した（下記）。スキル導入自体では実行コードを変更していない。実ウォレット・実チェーンでの検証済みという意味ではない。

## 更新と利用

AGENTS.mdが対象ファイルから必要スキルへの入口となる。次のターンからプロジェクトスキルとして利用できる。現在の作業ではインストールした文書も直接読んで方針へ反映した。

更新時は上流の差分を確認し、必要な5ディレクトリだけを新SHAで別の一時導入先へ取得する。レビュー後に置換し、ライセンスとlockのSHA/ハッシュを更新する。`--all`や実行時の自動追従は行わない。依存パッケージ更新は別の作業として扱う。

今回の追加はスキル文書と開発ルールのみ。既存アプリ、Move、依存、MemWal/J-Quants/デジャヴ、既存作業中ファイルの変更は含まない。認証情報や実データは参照していない。

## 検証結果

- `pnpm run typecheck` / `pnpm run lint`: 成功。
- Webビルド: 成功（Vite）。型検査と合わせてpackage.jsonのbuild相当を確認。
- Vitest: 60ファイル・178件のうち177件成功、`kabumaru-agent-walk-forward.test.ts` の1件が120秒でタイムアウト。その1件を同じ設定で単独再実行し成功（84.87秒）。全体実行が一度ですべて成功したわけではない。
- Playwright: 27件すべて成功（1.7分）。MemWal削除、デジャヴ、研究、認証などのfixture回帰を含む。
- 導入文書41ファイルのSHA-256照合: 不一致0件。

秘密情報の読込を避けるため、Vitest/Viteの既存configを継承して `envDir: false` を上書きした一時configを使用。E2Eも元のfixtureサーバーの `createServer` に同じ設定を適用した一時コピーを使用し、ブラウザの外部通信遮断proxyを維持した。ウォレットSDKの外部metadata取得が遮断されたログは出たが、E2Eは成功。一時検証ファイルは終了後に除去した。実サービス接続・実署名・チェーン書込は実施していない。

作業中に別のエージェント関連ファイルにも変更が追加されているため、上記は検証時点の作業ツリーに対する結果。今回の変更はREADME、AGENTS.md、本記録、スキル原文、lock、ライセンスのみ。

## 後続改善：予測アンカーの確認待ち

`apps/web/src/wallet.tsx` の送信後、同じtestnet endpointの `client.core.waitForTransaction({ digest })` を待ってからeffects・receiptを取得する。SDK既定の待機上限は60秒。待機失敗時は再送を促さず、確認対象のdigestを表示する。RPCが失敗取引を返した場合も成功としてreceiptを登録しない。

`tests/wallet-anchor.test.ts` のモックテスト4件で、待機完了前の読取・保存抑止、待機失敗時のdigest案内と再送抑止、ウォレット失敗、RPC失敗を検証し成功。実サービスへの接続・実署名・チェーン書込は行わない。ビルドは `envDir: false` の一時configで確認した。

変更した2ファイルの個別型検査・lintとWebビルドは成功。全体型検査は並行作業中の `KabumaruAgent.tsx` の型エラー（166行目のZodDefaultに対するoptions参照など）で失敗しており、そのファイルは本修正の対象外。

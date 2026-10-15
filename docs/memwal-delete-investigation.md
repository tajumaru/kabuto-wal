# MemWal削除調査（2026-10-16 JST）

対象はローカルcheckout `tajumaru/kabuto-wal`。既存データへの削除・移行・索引リセット・再保存は実行していない。本番へのデプロイも行っていない。

## 確認した設定と実接続

- `.env`: APP_MODE=live、DATA_DIR=./data/live。MEMWAL_NETWORK=mainnet、MEMWAL_SERVER_URL=https://relayer.memory.walrus.xyz、MEMWAL_SUI_ENDPOINT=https://fullnode.mainnet.sui.io:443。
- MainnetのMemWalAccount取得でowner、active、delegate登録を確認。秘密鍵は表示・記録せず、署名付きGET /api/whoamiで同じowner/accountを確認できた。
- Relayerの公開GET /configはnetwork=mainnet、package IDもローカル設定と一致。securityDeleteEnabled=true。
- インストール済みSDKは0.1.8。稼働Relayerは0.1.0、API 1.0.0、TypeScript SDK最低0.0.4。SDK compatibility()が成功。ビルドcommitは250f4f9bd76015b5529c45626a239e6942e74faa。
- プロセス環境にMEMWAL_*/SUI_*/OWNER_ADDRESSの上書きは検出されなかった。Docker Composeは同じ.envを読む。実際の外部デプロイ環境・稼働中の別プロセスの環境はこの検査の対象外。
- SUI_NETWORK未指定時の本人認証・ウォレット設定はtestnetにフォールバックしていた。既定値とローカル.envをmainnetへ統一。実験用Moveアンカーは従来のtestnet専用機能として無効のまま維持。

## 根本的なAPI制約と実装上の問題

稼働commitの[公式Security Delete仕様](https://github.com/MystenLabs/MemWal/blob/250f4f9bd76015b5529c45626a239e6942e74faa/docs/api/security-delete.md)は、旧V1の追跡DBに登録されたWalrus Blobだけを削除する。呼び出し元から任意のblobを登録できず、vector_entriesを直接削除しない。現在のrememberで保存できることは、このAPIで個別削除できる証拠にはならない。

SDK 0.1.8に個別delete/forgetメソッドはない。アプリのSecurity Deleteのパス・camelCaseパラメーター・所有者personal-message認証・取引署名の仕様は稼働版と一致していた。delegate秘密鍵では所有者のSecurity Delete署名を代替できない。

ただし今回の調査では所有者ウォレット署名を取得していないため、実際の対象blobが旧V1追跡一覧に含まれないこと自体は実証していない。API制約は確認済みだが、個別の失敗をBLOB_NOT_TRACKEDと断定するには、UIからの一覧照合が必要。

以前のアプリは削除取引completedだけで完了扱いし、再検索していなかった。また保存時の接続先・namespaceを同期記録に残していなかった。修正では環境bindingを新しい同期・バッチに保存し、変更時の別環境への送信を停止する。古い同期記録にbindingを推測で追記することはしない。

既存3件の保存jobは、いずれもMainnet上の同じownerとローカルblob IDに一致した。プロフィール2件の実namespaceはstock-memory:v1:profileであり、kabutowalへ機械的に置換した検索では0件、保存時の名前空間では2件とも取得できた。既存検索の旧namespace併用を維持し、削除後の再検索も同期記録のnamespace（未記録なら元のmemory.namespace）で行う。新しい同期には完了jobのnamespaceを記録する。

デジャヴ1件の保存先はstock-memory:dejavu:v1:live:94320。job照合は成功したがrecall呼び出しが失敗し、検索状態は未確認。この失敗を「0件」として扱わない。

## 変更内容

- packages/integrations/memwal-config.ts: Mainnet接続設定共通化、staging/testnet混在拒否、環境binding。
- packages/integrations/index.ts: 保存・検索のSDK設定共通化、同期時のbindingと実namespace保存。
- packages/integrations/sui.ts: Mainnetチェーン・Relayer公開設定・署名付きidentityの照合。
- packages/integrations/memwal-reset.ts、apps/api/src/memory-reset.ts: 接続設定と環境binding共通化。
- apps/api/src/memory-delete.ts: 保存先照合、旧V1制約の明示、submitエラーコード維持、completed後の再検索と検証状態保存。
- apps/web/src/MemoryDelete.tsx: サーバーと同じSui endpoint、検索検証未完了の表示と再確認導線。
- apps/api/src/server.ts、apps/web/src/wallet.tsx、.env.example、ローカル.env: Mainnet既定値。
- package.json、pnpm-lock.yaml: MemWal SDKを検証済み0.1.8へ固定。
- scripts/memwal-audit.ts: 読み取り専用の再現可能なMainnet診断。`pnpm exec tsx scripts/memwal-audit.ts`。recall失敗時は終了コード1。
- tests/memory-delete.test.ts、tests/memwal-environment.test.ts: 再検索・残存・照合不能・環境変更・再試行の回帰テスト。tests/memory-reset.test.tsの未使用引数lintも修正。

## 検証の範囲と残る制約

最終検証: `pnpm run test -- --maxWorkers=2` は14ファイル・66テスト成功。J-Quants、デジャヴ相場、かぶまる等の既存回帰テストを含む。`pnpm run test:e2e -- tests/e2e/memory-delete.spec.ts tests/e2e/memory-reset.spec.ts` は4件成功。lint、型検査を含む本番ビルド、git diff --checkも成功（既存の大きなbundle警告あり）。

既存データの実削除は行っていない。専用データのMainnet保存・実削除も行っていないため、Mainnet上の「保存→削除→再取得して消失」の実地検証は未完了。旧V1 API対象の削除には所有者ウォレットでの2段階署名が必要で、対象外の記憶の個別物理削除にはRelayer側の対応が必要。

実装した再検索確認は同じ記憶テキスト・namespaceで上位50件を検索し、対象blob IDの不在を確認するもの。全検索クエリ・取得済みコピー・Walrus全体の消去を保証するものではない。検索失敗・ID未返却・対象残存ではpendingを保持し、削除取引を再送しない。

[公式Relayer API](https://github.com/MystenLabs/MemWal/blob/250f4f9bd76015b5529c45626a239e6942e74faa/docs/relayer/api-reference.md)のPOST /api/forgetは名前空間全体の検索索引を削除する操作であり、物理blobは残る。個別削除の代わりには使っていない。

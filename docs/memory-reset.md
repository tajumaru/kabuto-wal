# MemWalの検索用データのリセット

現在の画面では保存区分を選択できる。初期状態で全区分を削除することはなく、チェックした区分だけを実行する。[現在の手順](blob-and-index-delete.md)を参照。以下の「全保存区分」は全区分を明示選択した場合の範囲。

設定画面の「MemWalの検索用データをリセット」で実行する。これは検索索引の削除であり、Walrus上の暗号化された原本やアプリ内の記録を削除しない。restoreで索引を復元できる。他のアプリから保存した記憶も含め、設定されたMemWalアカウントの全保存区分が対象。

1. 実モードで本人確認する。
2. 「対象を確認」で保存区分名と件数を確認する。
3. 確認欄に `検索リセット` と入力して実行する。

アプリは `GET /api/whoami` でdelegateが解決するownerとaccountを確認する。区分一覧はSDKの `listNamespaces` と同じ `/v1/owners/{owner}/namespaces` を使い、`has_more` がfalseになるまで `next_cursor` を `updated_after` に渡す。一覧に未対応のサーバーでは、推測した区分に対して実行しない。

実行は各区分について `POST /api/forget` に `{ "namespace": "対象区分" }` を渡し、`POST /api/stats` で0件を確認する。公式のHTTP認証仕様に沿い、`timestamp.method.path_and_query.body_sha256.nonce.account_id` のUTF-8バイト列をEd25519 delegateで署名する。GETは空bodyのSHA-256、POSTは送信するJSONそのもののSHA-256を使う。ヘッダーは `x-public-key`, `x-signature`, `x-timestamp`, `x-nonce`, `x-account-id`。delegate秘密鍵・Security DeleteのBearer・Seal復号用credentialは送らない。

対象確認は10分有効。実行前にアカウント設定と区分・件数を再確認する。ローカルで送信中・送信結果不明のジョブがある間は実行できない。既存の対象記録には送信防止マーカーを先に保存し、自動同期で再送しない。ローカル記録の参照状態は維持し、今後新しく作成する記録は通常どおり同期できる。

結果は `settings/memwal-search-reset.json` に区分ごとの件数・状態を保存する。途中失敗や通信断を全件成功と表示しない。実行済みの確認IDは再利用できない。「対象を確認」で現在の区分・件数を確認し直す。外部アプリの保存中ジョブや他端末の操作は制御できないため、リセット中はほかの書き込みとrestoreを止める。リセット後も新規保存やrestoreで索引は増え得る。

公式仕様:
- [Relayer HTTP API：認証・forget・stats](https://docs.wal.app/walrus-memory/relayer/api-reference)
- [TypeScript SDK：listNamespaces](https://docs.wal.app/walrus-memory/sdk/api-reference)

開発テストでは実際のMemWal記憶に対するforgetは実行しない。

# 外部仕様確認

## BTC価格

`COINGECKO_API_KEY` にCoinGecko Demoキーを設定。BTCを含む記憶チャットの質問で、Demo APIのmarket_chartから円建て過去90日の価格を取得し、crypto/bitcoin.jsonに保存します。1時間以内は保存済みの結果を再利用します（常時の定期取得ではありません）。APIキーはサーバーの認証ヘッダーにのみ使用します。取得失敗はチャットの根拠欄で表示します。

株価の直近2営業日の各15:30 JST以前、最大2時間前までのBTC観測値で変動率を比較します。対応する時刻の観測値がない場合は比較不能と表示し、未来の価格は使いません。現在価格は履歴の最新観測値で、時刻を併記します。比較は因果関係を示しません。チャットにCoinGeckoへの出典リンクを表示します。

確認日：2026-10-11。Node v24.14.0。導入版はpnpm-lock.yamlに固定。

| SDK | 確認版 | 確認内容 |
|---|---|---|
| @mysten-incubation/memwal | 0.1.8 | dist/types.d.ts、memwal.d.ts、account.d.ts、memwal.js、account.js |
| @mysten/sui | 2.35.0 | verifyPersonalMessageSignature、Ed25519Keypair、SuiGrpcClient、core object include.json |
| @mysten/dapp-kit-react | 2.1.39 | createDAppKit、ConnectButton、signPersonalMessage |

MemWal.create({key,accountId,serverUrl,namespace})、remember受付のjob_id、waitForRememberJob完了のblob_id、recall({query,namespace,limit})のresultsを確認してadapterに使用。SDK distanceは小さいほど近い。MCP scoreへ直接変換して混用しません。同期のexactly-onceは保証しません。0.1.8のrememberAsyncにはidempotencyKeyもありますが、このアプリでは受付不明の安全停止を使います。

公式 `services/contract/sources/account.move` のMemWalAccount owner/active/admin_quarantined/delegate_keysとDelegateKey.sui_addressを確認。現在のgRPC core.getObject(include.json)で取得し、設定MEMWAL_PACKAGE_IDの型とowner、登録delegateを照合してから同期/recallを許可します。不明なJSON形式は推測せず接続を停止します。

一次資料：

- [MemWal SDK](https://docs.wal.app/walrus-memory/sdk/api-reference)
- [MemWal configuration](https://docs.wal.app/walrus-memory/reference/configuration)
- [MemWal contract](https://docs.wal.app/walrus-memory/contract/overview)
- [SDK source](https://github.com/MystenLabs/MemWal)
- [J-Quants official Python V2 client](https://github.com/J-Quants/jquants-api-client-python/blob/main/jquantsapi/client_v2.py)
- [J-Quants daily spec](https://jpx-jquants.com/ja/spec/eq-bars-daily)
- [J-Quants updates](https://jpx-jquants.com/ja/spec/data-update)
- [Sui cryptography](https://sdk.mystenlabs.com/sui/cryptography)
- [Current dApp Kit](https://sdk.mystenlabs.com/dapp-kit/getting-started/react)
- [OpenAI structured outputs](https://developers.openai.com/api/docs/guides/structured-outputs?api-mode=responses)

J-Quants日足仕様の一部ページは閲覧ツールで取得できず、公式Python client V2ソースも照合しました。認証はx-api-key、日足 `/v2/equities/bars/daily`、マスター `/v2/equities/master`、営業日 `/v2/markets/calendar`。dataとpagination_keyを検証し、nullを0へ変換しません。実レスポンスとプランの取得可能期間・レート制限は実キーで再確認してください。

OpenAI Responses APIをサーバーのfetchで使用し、text.format/json_schemaで出力を制限。モデル名はLLM_MODEL。参照IDと申告数値の根拠照合、不正応答時のローカルfallbackを実装。自由文に含まれる全数値の完全な事実保証はできないため、数値の正本はUIのJSONカードです。外部送信禁止時はLLMを呼びません。

確認済みは型定義・公式資料・モック/デモ動作です。キー、本人署名の実ウォレット、リレイヤーのaccount/network/package確認、Suiアンカーの配備取引は未接続です。契約で生データ・派生値の外部送信可否を確定してから外部許可フラグを変更してください。

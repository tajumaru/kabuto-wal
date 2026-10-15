# KABUTO WAL

デジャヴ相場2.0：過去類似事例の未来シナリオ・DNA・かぶまる解説から、仮説記録と期限後の答え合わせ、MemWal反省ノートまでつながりました。[仕様と動作確認](docs/dejavu-v2.md)。

日本株の研究用アプリ。React + Fastify + **JSONファイル**、実接続時の長期記憶は **MemWal SDK** を使用します。DBエンジン・DBサービスは導入していません。キーなしで7画面と主要導線が動くデモを用意しました。

## 起動

右下の「カブまる」を押すと、取得済みデータの通知と記憶チャットを開けます。急変・出来高・監視変更・類似相場・予測検証の根拠を表示します。仕様と未接続項目は [カブまるの運用メモ](docs/kabumaru.md) を参照してください。

Node.js 24 LTS、pnpm 9.12.3以上を用意して、このフォルダで実行します。

```powershell
pnpm install --frozen-lockfile
if (!(Test-Path .env)) { Copy-Item .env.example .env }
pnpm dev
```

ブラウザで **http://localhost:5173** を開きます。APIはlocalhost:3001です。初期状態は監視・予測・記憶が空です。監視追加した銘柄だけの架空日足を生成しJSONへ保存します。次回起動時は自分で追加・保存したデータを読みます。デモ名・価格・カレンダーは架空で、日本の実際の取引カレンダーではありません。サンプル入り環境が必要な場合は別のDATA_DIRとDEMO_SEED=trueを使用してください。

デモ操作：ホームで銘柄を追加 → 詳細 → 類似相場 → 予測と検証で同じ銘柄を選び、基準日を `2026-08-03` にして生成 → 「期限後の検証」 → 記憶一覧で方針を保存 → 記憶チャットで質問。現在の日付を将来へ動かす機能はなく、保存済みfixtureで過去期限の検証をします。E2Eは専用のdata/e2eと別ポートを使い、利用者の空データへ記録を作りません。

```powershell
pnpm lint
pnpm typecheck
pnpm test
pnpm test:e2e
pnpm build
pnpm start
```

`pnpm start` はビルド済みWebも http://localhost:3001 で配信します。ブラウザテスト用Chromiumがない場合は `pnpm exec playwright install chromium` を実行してください。

銘柄選択は検索式です。証券コード（4桁・英字入り・提供元の5桁）または銘柄名を入力し、候補をクリックするかEnterで選択してください。全角英数字にも対応します。入力途中・該当なしでは監視追加や銘柄依存の操作を無効にし、以前の選択銘柄を誤って使用しません。ホーム・チャット・類似相場・予測で共通の検索UIを使います。

## 実データへ切り替える設定

空の状態から始める場合は `.env` を `APP_MODE=demo`、`DATA_DIR=./data/personal`、`DEMO_SEED=false` にして起動します。監視銘柄・株価履歴・予測・会話・記憶は空です。銘柄候補とデモ取引カレンダーだけを用意し、選んで監視追加した銘柄の日足をその時点で生成します。APIキーなしでも、自分で選択した銘柄から研究を始められます。データは架空のままなので実市場を調べる場合は下記の実接続設定を行ってください。初期化方式は保存先の設定に記録し、再起動時にデモ記録を補充しません。以前のデモは `./data/demo` に残ります。

`.env` はGitへ含めません。**デモと実データは異なるDATA_DIR** を使用してください。ブラウザは本アプリのAPIだけを呼びます。

| 変数 | 設定内容 |
|---|---|
| `APP_MODE` | `live`（外部データ取得。予測は保守的にresearchとして保存） |
| `DATA_DIR` | 例 `./data/live`。Linux配備は `/data/stock-memory` |
| `APP_ORIGIN` | 開発 `http://localhost:5173`、本番は本人用HTTPS URL。認証domain/Origin照合に使用 |
| `OWNER_ADDRESS` | 利用者本人のSuiアドレス |
| `SESSION_SECRET` | ランダムな32文字以上の秘密値 |
| `JQUANTS_API_KEY` | 契約したJ-Quants V2キー |
| `JQUANTS_PLAN` | `Free` / `Light` / `Standard`。Freeは12週遅延、研究用 |
| `MEMWAL_ACCOUNT_ID` | 本アプリ専用のMemWalAccount ID |
| `MEMWAL_DELEGATE_KEY` | そのアカウントに登録したアプリ専用Ed25519 delegate秘密鍵。ウォレットの秘密鍵は不要 |
| `MEMWAL_SERVER_URL` | 利用する管理リレイヤーのURL |
| `MEMWAL_NETWORK` / `MEMWAL_PACKAGE_ID` / `MEMWAL_SUI_ENDPOINT` | リレイヤーに対応する実際のネットワーク、MemWal package ID、gRPC URL。アプリがowner/active/delegateを確認してから接続 |
| `LLM_PROVIDER` | `local` または `openai` |
| `LLM_API_KEY` / `LLM_MODEL` | 外部LLMキーとJSON Schema対応モデル名。モデル名は固定していません |
| `SUI_NETWORK` / `SUI_ENDPOINT` | 本人認証対象ネットワーク・gRPC endpoint。ウォレットUIへ公開設定として読み込み。初期値testnet |
| `ALLOW_MARKET_DATA_TO_MEMWAL` | 契約で派生情報の送信を確認してから `true`。初期値false |
| `ALLOW_MARKET_DATA_TO_LLM` | 独立して送信権利を確認してから `true`。質問に価格を貼り付ける可能性もあるため、falseでは外部LLM呼出自体を停止 |
| `ENABLE_AUTO_FORECAST` | trueなら日次ジョブで1/5/20営業日の数値予測。候補不足を記録 |
| `ENABLE_SUI_COMMITMENTS` | 初期値false。testnet限定。Moveソース・ハッシュ・ウォレット署名UIあり。配備・実接続は未検証 |
| `COMMITMENT_PACKAGE_ID` / `COMMITMENT_REGISTRY_ID` | 自分でtestnet配備したMove packageとcreate_registryで作った本人registry。IDを捏造せず、未設定時は操作不可 |
| `BACKUP_PASSWORD` | 予約設定。現在のexport/importはUI/API入力のパスフレーズを使用 |

1. J-Quantsを本人用として契約し、再配布・外部MemWal/LLM送信可否を確認します。生株価はローカルに保存します。無料スクレイピングへの置換はありません。
2. 実モードのサーバーを起動し、設定画面で本人ウォレットを接続・署名します。domain/network/用途/nonce/期限を含む署名を検証し、HttpOnlyの1時間セッションを発行します。
3. `pnpm job` で銘柄マスターと取引カレンダーを取得します。ホームで**マスターにある提供コード**を選び監視追加 → 再度 `pnpm job` または手動取得。無条件の0追加はしません。
4. MemWalの公式アカウント管理手順で本人アカウントとdelegateを準備します。CodexのMCP記憶・`setup-memwal-codex.ps1` は流用しません。MemWalのネットワークは利用リレイヤーに合わせ、独自Moveのtestnetと同一と仮定しません。
5. 各サービスで少量の取得・ユーザー記憶の同期/recallを確認してください。キーがないため本実装作業では実サービス接続を検証していません。接続状況は「設定済み」と「検証済み」を混同しません。

## 定期取得と配備

```bash
docker compose up -d --build
docker compose exec -T app pnpm job
```

Web/APIは単一のコンテナで配信します。localhost:3001をHTTPS reverse proxy/VPN経由で本人だけに公開します。Dockerのnamed volumeを永続保存に使い、コンテナを削除してもボリュームを削除しないでください。複数書込サーバーや一時ディスクのサーバーレス配備は対象外です。LinuxファイルロックはAPIとCLIで共有します。

UTCのcron例（JST 17:30 / 18:00 / 19:00。パスを実環境に合わせる）：

```cron
30 8 * * 1-5 cd /opt/stock-memory && docker compose exec -T app pnpm job >> /var/log/stock-memory.log 2>&1
0 9,10 * * 1-5 cd /opt/stock-memory && docker compose exec -T app pnpm job >> /var/log/stock-memory.log 2>&1
```

取得範囲内の履歴を再取得して未取得日・訂正を補完し、contentHashが変わった日足はrevisionを追記します。元予測は上書きせず、訂正評価も別revisionです。Freeの遅延を反映した終了日を使用します。料金は固定していません。J-Quants、外部LLM、MemWal/Walrus、サーバー、任意のSui書込の費用が発生します。

## 保存と障害対応

`settings/market/prices/revisions/features/predictions/evaluations/chats/memories/indexes/sync/jobs/commitments/nonces/audit` にJSONを保存します。株価は銘柄×月、予測原本は `predictions/<id>/original.json`、評価は別ファイルです。索引は元ファイルから再生成できます。temp → fsync → renameを使用し、Linuxでは親ディレクトリも同期します。Windowsではディレクトリfsyncは対象外です。

MemWalのremember受付は `accepted/jobId`、保存完了は `synced/blobId`。既知jobは再送せず追跡します。受付直後に中断しjob不明の場合はuncertainとして自動再送を停止します。SDK接続障害でもローカル記録は残ります。記憶の訂正・無効化はローカルで除外する機能です。別の「MemWalから削除」は、対応サーバーのSecurity Delete APIと所有者ウォレット署名で、選択した保存済みblobを削除します。ローカル記録は残して利用停止にし、自動再同期しません。通信断後は同じバッチの結果を確認します。設定・制限は[記憶削除の運用メモ](docs/memory-delete.md)を参照してください。

設定画面で12文字以上のパスフレーズを入力して暗号化export。AES-256-GCM + scryptを使用し、元予測・索引・同期状態・commitment saltを含めます。キー・環境変数・ログインnonceは含めません。パスフレーズ紛失時は復元できません。復元時は原本競合と保存パスを検査します。運用バックアップは停止中のボリュームコピーも併用してください。MemWalのrecall/restoreだけでアプリ全件復旧はできません。

## 正確な実装範囲と制限

類似検索は同銘柄の数値全走査、重複窓除外、訓練期間だけで標準化します。十分な非重複候補20件を満たさなければ予測不能です。上昇割合は校正前の過去サンプル比率。1/5/20営業日期限、中央値、経験分位、ゼロ予測比較、方向・誤差・Brierを実装しています。

実データ予測の**live**は、遅延なしのプラン、最新必要営業日の日足、将来期限、基準日指定なしの条件を満たすときのみです。それ以外はresearch。カレンダーと取得日足は検査しますが公表時点の完全保証はしていません。walk-forward数値バックテストと期限・モード・手法別評価集計を実装。厳密なpoint-in-timeデータ付き運用検証は未実施です。現在LLMの過去解説を当時予測とは扱いません。

TOPIX追加指標は未実装です。類似画面では明示選択時のみ別銘柄の数値比較もできます。Suiアンカーはtestnetのウォレット署名UIとサーバー側receipt照合まで実装し、anchoredAtが期限営業日の開始前の場合にのみ事前証明と表示します。Moveのowner・hash・重複をテストしています。デプロイやSUI送金は行っていません。実API/リレイヤー・実ウォレット・外部LLMの接続は未検証です。詳細は `docs/integration-notes.md` を参照してください。

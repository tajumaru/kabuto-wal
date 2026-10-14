# Sui × MemWal 日本株AI — DBサービスなしの設計とCodex用完全プロンプト

作成日：2026-10-11。以下の画面、ファイル構造、独自コントラクトは本アプリの提案設計です。外部サービスの実在する仕様とは区別しています。料金・契約・SDKは実装開始時にも公式資料で再確認してください。

## 1. 作るアプリ

仮称「Stock Memory」。日本株の株価を1日1回取得し、過去の相談・相場の特徴・予測・検証結果をMemWalに記憶する、個人用の株式研究アプリです。

独自性は、予測そのものより「以前何を根拠に考えたか」「その予測はどうなったか」「同じ失敗を繰り返していないか」を追跡できることです。Suiは記憶の所有権と任意の予測記録証明に使います。

初期版は個人1ユーザー、監視10銘柄、日足、1・5・20営業日先の予測を対象とします。売買執行機能は含めません。自動取得はブラウザを閉じてもサーバー側で動きます。

### 「DBなし」の定義

- アプリがPostgreSQL、MySQL、SQLite、MongoDB、Firestore、Supabase、Redis、専用ベクトルDBを導入・運用しない。
- MemWalを長期記憶と意味検索の中心にする。
- 株価の時系列計算、IDによる正確な取得、未検証予測の全件列挙、障害後の再処理には、永続ディスク上のJSONファイルを併用する。
- ファイルをデータ保存に使うが、DBエンジン・DBサーバーは使わない。JSONファイルまで禁止する条件とは異なる。
- MemWalの管理リレイヤー内部には検索用インデックス等がある。この構成は「自分のアプリにDBを持たない」であり、サービス内部までDBを一切使わないという意味ではない。

重要：MemWalのrecallは類似度検索です。日付・IDの厳密な検索や、全予測の漏れない一覧を、それだけで保証してはいけません。sort: recentも候補内の新しさであり全件最新の保証ではありません。記憶の再インデックス機能と、アプリ全状態の完全復旧も別です。

## 2. 画面構成

| 画面・パス | 表示内容 | 主な操作 |
|---|---|---|
| ホーム `/` | 監視銘柄、前営業日比、データ基準日、今日の要約、検証待ち件数 | 銘柄追加、手動取得、チャットへ移動 |
| 銘柄詳細 `/stocks/:code` | 日足チャート、出来高、指標、過去の記憶、類似例、予測履歴 | 期間変更、予測生成、類似検索 |
| AI記憶チャット `/chat` | 会話、参照した記憶カード、対象銘柄、数値の出典 | 質問、重要事項の記憶保存 |
| 類似相場 `/similar` | 現在と過去の正規化チャート、特徴量距離、期間、その後の実績 | 銘柄・基準日・比較期間を選択 |
| 予測と検証 `/predictions` | 期限、予測、実績、誤差、上昇確率の評価、Sui証明状態 | 期限別絞り込み、詳細比較 |
| 記憶一覧 `/memories` | 利用者の方針、相場要約、過去の仮説、検証から得た教訓 | 検索、ローカル記録表示、訂正・無効化 |
| 設定 `/settings` | API接続状態、MemWal接続状態、取得時刻、ウォレット、バックアップ | 接続確認、取得設定、エクスポート・復元 |

スマホでは下部に「ホーム・チャット・類似・予測・設定」。株価には必ず基準日と最終取得時刻を表示します。デモ／遅延データ／実データを区別します。ウォレットの初期化は遅延読み込みとし、ホーム表示をブロックしません。

チャット例：
- 「この銘柄について前に何を心配していた？」
- 「現在の値動きに似た過去の20営業日を探して」
- 「先月の予測は実際どうなった？」
- 「過去の外れ方を踏まえて今回の仮説を説明して」

## 3. 技術構成

| 担当 | 推奨構成 |
|---|---|
| フロント | React、TypeScript、Vite、Tailwind CSS、Recharts、TanStack Query |
| サーバー | Node.jsの実装時LTS、TypeScript、Fastify、Zod |
| 記憶 | `@mysten-incubation/memwal` の管理リレイヤー対応SDK |
| 株価 | J-Quants API V2をサーバーから呼ぶ |
| AI | サーバー側LlmProvider。JSON Schema対応のモデルを設定で選択 |
| 厳密な保存 | 永続ボリューム上のJSON、JSONL、ファイル単位の索引 |
| 定期実行 | 常時稼働サーバーのOS cronとジョブCLI |
| Sui | 現行のMysten Sui SDK、dApp Kit、任意のMove予測コミットメント |
| 検証 | Vitest、主要導線のPlaywright、Moveの単体テスト |
| 配備 | 単一Linuxサーバー＋Docker Compose＋永続ディスク |

ブラウザは自分のAPIだけを呼びます。J-Quants、LLM、MemWalの秘密情報はサーバー環境変数に保存します。アプリ用のMemWalアカウント・delegateと、Codex開発用の記憶設定は区別します。CodexにMCPを入れただけでは、アプリの定期取得や記憶保存は実装されません。

サーバーレスの一時ディスクを永続保存に使う構成は採用しません。初期版は1書き込みプロセスに制限し、ジョブとAPIの更新を同じファイルロック機構で直列化します。複数サーバーへ拡張する場合は別途保存・競合設計が必要です。

## 4. データ保存設計

### 役割分担

| データ | 厳密な記録 | MemWalに入れる記憶 |
|---|---|---|
| 株価 | 銘柄×月のJSON。取得時点別revisionも保存 | 原則、生の全日足は保存しない。条件を満たす日次特徴・要約のみ |
| 監視銘柄・設定 | JSON。実行時の現在設定を明示 | ユーザー方針や関心の要約 |
| チャット | 会話イベントファイル | 長期的な方針、重要な仮説、訂正履歴 |
| 相場特徴 | 銘柄・営業日別のJSON | 数値特徴を含む短い説明、ローカルrecordId |
| 予測 | 変更不可の予測JSON＋別の状態ファイル | 規約上送信可能な予測JSONと根拠・参照ID |
| 結果検証 | predictionIdに紐づく別JSON | 検証結果と教訓。元の予測は書き換えない |
| MemWal同期 | recordId、jobId、blobId、送信状態 | 検索対象の記憶本体 |
| バックアップ | 暗号化したアプリ記録・索引の完全export | recallだけで完全復旧できると約束しない |

MemWalへの外部送信が許可されないデータはローカルに留めます。LLMへの送信も独立した契約確認が必要です。「暗号化されるので契約確認不要」とはしません。

### 永続ファイル配置

```text
/data/stock-memory/
  settings/settings.json
  settings/watchlist.json
  market/master.json
  market/calendar.json
  prices/<providerCode>/<YYYY-MM>.json
  revisions/<providerCode>/<date>/<revisionId>.json
  features/<providerCode>/<sessionDate>.json
  predictions/<predictionId>/original.json
  predictions/<predictionId>/state.json
  evaluations/<predictionId>/<evaluationId>.json
  chats/<conversationId>/<eventId>.json
  memories/<recordId>.json
  indexes/predictions.json
  indexes/memories.json
  sync/<recordId>.json
  jobs/<jobId>.json
  commitments/<predictionId>.json
  nonces/<nonceHash>.json
  audit/<YYYY-MM-DD>.jsonl
  backups/<timestamp>.enc
```

索引はファイル列挙から再作成可能とします。ファイル名はサーバーで生成し、ユーザー入力をそのままパスに使いません。JSON更新は「同一ディレクトリの一時ファイル→fsync→rename」、重要な変更は親ディレクトリも同期します。多重実行を排他し、起動時に中断ジョブを復旧します。

MemWalのnamespaceは `stock-memory:v1:profile`、`stock-memory:v1:market:<code>`、`stock-memory:v1:prediction:<code>`、`stock-memory:v1:lesson:<code>` 等を使用。namespace自体をユーザー認証と見なしてはいけません。初期版のアクセス制御は固定OWNER_ADDRESSの認証、MemWal accountId、登録delegateにより行います。

### 共通レコードの例（アプリ独自）

```json
{
  "schemaVersion": 1,
  "recordId": "generated-id",
  "kind": "market_snapshot",
  "providerCode": "72030",
  "displayCode": "7203",
  "sessionDate": "YYYY-MM-DD",
  "observedAt": "ISO-8601",
  "availableAt": "ISO-8601",
  "source": "jquants-v2",
  "inputRevisionIds": [],
  "featureVersion": "v1",
  "summary": "数値は検証済み入力から生成",
  "payload": {}
}
```

availableAtはアプリが取得・利用可能となった時刻です。過去データを今日取得しただけでは「当時利用可能だった」と証明できません。バックテストでは公表時点を確認できない追加情報を使わず、仮定を明記します。

### MemWal同期の扱い

現在の公式SDKにはMemWal.create、remember、rememberAndWait、recall等があります。rememberは非同期ジョブ受付であり、受付成功はWalrus保存完了ではありません。

アプリではまずローカル記録と同期予定ファイルを保存し、accepted/jobIdを記録、保存・索引完了後にsynced/blobIdへ更新します。rememberAndWaitの仕様を実装時の型定義で確認します。タイムアウト時に既知jobIdを追跡し、直ちに同じ記憶を再送しません。

サーバーが受付直後に落ちたケースなど、MemWal側にidempotencyキーがなければ完全なexactly-onceは保証しません。recordIdとcontentHashでアプリ表示の重複を排除し、複数blobを保持した同期履歴から整理します。

## 5. 日本株API

第一候補は [J-Quants](https://jpx-jquants.com/) です。今回の個人用・日足・毎日1回という条件に合わせます。

| プラン | 2026-10-11確認時の表示料金 | 用途 |
|---|---:|---|
| Free | 0円 | 12週間遅延、2年分の履歴。過去データでの開発・研究 |
| Light | 月1,650円（税込） | 5年分の履歴。日次運用の第一候補 |
| Standard | 月3,300円（税込） | 10年分の履歴。長期類似検索・追加データ向け |

Freeを直近の株価監視に使う設計にはしません。Light等でも本設計は日足であり、リアルタイム配信を意味しません。表示料金以外にLLM、MemWal、サーバー、任意のSui書き込み費用が発生します。これらの金額は利用条件と頻度が決まるまで固定しません。

V2の株価エンドポイント：

```text
GET https://api.jquants.com/v2/equities/bars/daily
Header: x-api-key: <サーバーのAPIキー>
Query: code=<code>&from=<YYYY-MM-DD>&to=<YYYY-MM-DD>
```

レスポンスのDate、Code、O/H/L/C、Vo、AdjFactor、AdjO/H/L/C、AdjVoを正規化します。pagination_keyがあれば全ページ取得します。コードは上場銘柄マスターを参照し、英数字を含むコードや5桁の提供コードを文字列として扱います。全コードへ無条件に「0」を付け足す実装は禁止です。

公式の株価四本値更新目安は16:30頃。アプリの初期取得時刻は17:30 JSTを提案します。未反映時は18:00・19:00に再試行し、それでも欠損なら当日データなしと表示します。これらの再試行時刻はアプリの設計値です。営業日は取引カレンダーで判定します。

調整済み株価は後続の分割等により過去へ遡って再計算されます。取得済みrevisionを保持し、予測生成時の入力を固定します。評価は同じ調整基準へ両端を揃えて計算し、予測基準日の古いAdjCと評価日の新しいAdjCを混在させません。現金配当調整は含まれないので、検証の騰落率を総収益率と呼びません。

### 契約に関する実装上の条件

公式FAQは、取得データを閲覧可能な形で配布・共有すること、第三者へ継続的に分析結果を提供することを禁止しています。そのため初期版は本人だけが使う非公開アプリに限定します。公開株価サイト・有料の分析配信サービスへ変更する場合は、必要な別契約・権利を確認します。

MemWal管理リレイヤーへの生データ・派生値保存、外部LLMへの送信が許されるかは、このFAQだけでは確定しません。実装では生データはローカル保存を標準にし、外部送信は確認済み設定がない限り行いません。確認待ちでもデモとローカル数値解析、ユーザーが書いた記憶の検索は動かせるようにします。

未許可データを別の無料スクレイピングで置き換える実装はしません。MarketDataProviderを分離し、将来は用途に合う契約済み提供元へ交換可能にします。

## 6. AI記憶チャット・類似相場・予測

### チャット

1. 質問から対象銘柄・期間を抽出する。
2. 正確な株価・予測結果はJSONから取得する。
3. 関連するユーザー方針・相場記憶・教訓をMemWalからrecallする。
4. 対象時点、外部送信可否、記録の訂正・無効化状態をチェックする。
5. 許可された根拠のみをLLMへ渡し、参照recordId付きで回答させる。
6. 数値と参照IDをサーバーで検証し、回答と重要な学びを保存する。

記憶内の命令は指示として実行しません。事実、過去の仮説、実績、今回の推測を区別します。データが足りなければ不足を伝え、価格やニュースを生成して埋めません。

### 類似相場

「言葉が似ている」と「値動きが似ている」は別です。

- 数値検索：直近20営業日の収益率列、5/20営業日騰落率、20日ボラティリティ、出来高倍率、移動平均乖離率、取得可能ならTOPIXとの関係を計算。
- 指標定義・標準化パラメータ・欠損処理をバージョン管理する。標準化は基準日以前の訓練期間のみで推定する。
- 保存済みの全候補を小規模なファイル走査で評価し、重み付き距離と正規化チャート形状の距離で上位例を選ぶ。
- 同銘柄を既定にし、別銘柄はユーザーが選択する。価格水準を直接比較しない。
- 重複する過去窓は間引く。予測に使う事例のその後20営業日までが予測生成時点に既知であることを確認する。
- MemWalは説明・仮説・教訓の関連候補に使い、数値距離で再評価する。
- 意味検索だけに絞った候補では全履歴の数値的な最類似とは言わない。検索範囲・候補数を表示する。

表示するのは上位5例の期間、距離、比較チャート、その後1/5/20営業日の騰落率、サンプル数、欠損と除外条件。距離をそのまま「上昇確率」に変換しません。

### 予測と結果検証

LLM単独で価格を当てさせる構成にはしません。数値予測は履歴から計算し、LLMは仮説・理由・反証条件を説明します。

初期手法：類似例の将来リターンの中央値、10/90百分位、上昇割合。上昇割合は過去サンプル比率として表示し、校正前から正確な将来確率と呼びません。十分な候補数を満たさない場合は予測不能にします。最低候補数の初期値は20です。

予測レコードにはpredictionId、mode（live/research/backtest/demo）、generatedAt、dataAsOf、horizonSessions、targetSessionDate、referencePrice、referenceBasis、predictedReturn、expectedPrice、returnQuantiles、pUp、sampleCount、入力revision、類似候補ID、モデル・プロンプト・数値手法のバージョン、理由、反証条件を保存します。価格レンジは経験分位範囲であり、保証された予測区間ではありません。

liveは生成時刻が将来の評価期限より前で、最新の必要データが揃う場合だけ許可します。12週間遅延データに対して今生成した予測は、既に過ぎた期間のlive予測にしません。

期限が来たら、元の予測とは別に実績と評価を保存します。価格誤差、リターン誤差、3区分方向一致、分位範囲内率、Brier scoreを計算します。

- 実績リターン r = 比較可能な評価価格 / 比較可能な基準価格 - 1。
- 方向は上昇：r > +0.5%、横ばい：-0.5% ≤ r ≤ +0.5%、下落：r < -0.5%。予測側も同じ閾値。
- pUpのイベントは r > 0 とし、Brier = (pUp - I[r > 0])²。3区分方向とは混同しない。
- 常にリターン0を予測するベースラインと比較する。
- 期限別・生成モード別・手法バージョン別に集計する。件数、除外数、未検証件数も表示する。
- 売買停止等で期限日の価格がない場合は評価待ちまたは評価不能とし、勝手に別日に置き換えない。
- 過去データ訂正時は評価revisionを追加し、初回結果を削除しない。

バックテストはwalk-forward方式を使い、当時以降の情報を入力・候補選択・標準化へ混ぜません。現在のLLMが過去の結末を知る可能性があるため、過去時点のLLM解説を厳密な予測実績として宣伝しません。数値手法の検証と区別します。

「学習」は初期版では検証からの教訓を次回のチャットへ渡すことです。基盤LLMの重みを自動更新するわけではありません。外れた理由の因果関係は価格だけでは特定できず、仮説として記録します。

## 7. Sui連携

### 初期版で実装すること

- Suiウォレットで本人を確認し、固定OWNER_ADDRESSと一致する利用者だけに実データを表示する。
- domain、nonce、有効期限、network、用途を含むメッセージにpersonal message署名を要求する。
- サーバーで署名を検証し、nonceを一度だけ消費する。短期HttpOnlyセッションを発行する。
- MemWalAccountのownerと登録delegateを確認し、アプリ専用delegateをサーバーだけに置く。
- ログイン署名とMemWalのdelegate認証は別物とする。署名しただけではMemWalの保存権限が付かない。
- 開発用のSui独自コントラクトはtestnet。MemWalは使用する管理リレイヤーに合うnetwork/package/accountを確認する。双方が自動的に同一networkになると仮定しない。

MemWal自体にSui上の所有権・委任・復号アクセス制御があります。記憶チャットを始めるために独自Moveコントラクトを追加する必要はありません。

### 任意の追加機能：予測の事前記録

アプリ独自のMoveモジュール `prediction_commitment` を設計します。

- PredictionReceiptはtransfer可能なNFTにせず、所有者に紐づく変更不可の記録オブジェクトとする。
- owner、predictionId、commitmentHash、サーバー申告generatedAt、Sui Clock由来anchoredAt、targetSessionDate、schemaVersionを持つ。
- commitmentHash = SHA-256(JCSで正規化した予測JSON + ランダムsalt)。saltはローカルで保存し、検証時だけ開示する。
- generatedAtは自己申告であり、事前記録の証拠に使う時刻はanchoredAt。
- 同じowner＋predictionIdの重複をMove側の所有者用Registryで防ぐ。ownerチェックとhash長チェックを行う。
- 詳細予測、API由来の価格、秘密鍵をオンチェーンに保存しない。
- ウォレット署名でtestnetに記録し、txDigestとreceiptIdをローカルに保存する。
- 評価期限を過ぎてアンカーした予測は「事前証明なし」と表示する。
- 証明は「その時点にこの内容へコミットしていた」であり、価格データの正しさや将来の的中を保証しない。

最初は任意の手動アンカーです。毎日ウォレット署名なしで自動記録する機能は、限定権限のsigner・費用上限を別途設計するまで追加しません。アンカー失敗がチャット・取得・検証を停止させない構成にします。

## 8. 実装順序

| 段階 | 実装 | 完了条件 |
|---|---|---|
| 0 | 公式仕様確認、API/SDKの試験、契約確認項目、デモfixture | 外部の未確認機能を仮定せずbuild可能 |
| 1 | フロント、本人認証、永続ファイル保存、監視リスト | 再起動しても設定保持、デモと実データ分離 |
| 2 | J-Quants V2、営業日、定期取得、再試行、欠損表示 | サーバーで日次取得でき、再実行で二重計上しない |
| 3 | MemWal adapter、同期予定、ジョブ追跡、記憶チャット | 接続時は保存後に検索可能、障害時に状態が明確 |
| 4 | 特徴量・数値類似検索・チャート比較 | 未来情報を使わず既知fixtureの類似順が再現可能 |
| 5 | 数値予測・LLM説明・期限後の自動検証 | 元予測の不変性と期待される誤差計算を検証 |
| 6 | 任意のSui予測アンカー、暗号化export/import | testnet証明と復元テストが通る |

以下はCodexにそのまま渡す独立したプロンプトです。この文書の上半分を読まなくても開発範囲が分かるようにしています。

---

# Codexに渡す完全な日本語プロンプト

あなたはSui、Walrus Memory（MemWal）、日本株APIに対応するフルスタックエンジニアです。個人用の日本株AI研究アプリ「Stock Memory」を、このリポジトリ内で実装してください。計画だけで終了せず、動くコード、検証、起動・配備手順まで作ってください。

## 目的と必須条件

日本株の株価自動取得、AI記憶チャット、過去の類似相場検索、AI予測と結果検証を実装する。長期記憶と意味検索の中心にMemWalを使う。

アプリ用のDBエンジン・DBサービスは一切導入しない。PostgreSQL/MySQL/SQLite/MongoDB/Firestore/Supabase/Redis、Prisma、専用ベクトルDBを使わない。永続ディスク上のJSON/JSONLファイルは利用してよい。MemWal管理リレイヤー内部のインデックスは外部サービスの実装として扱い、自分でホストしない。

初期版は本人1ユーザー、監視10銘柄、日足、1/5/20営業日先を対象。売買注文は行わない。実データは非公開。設定されたOWNER_ADDRESSのみ利用できる。鍵なしで触れるデモは架空fixtureを使い、DEMOを明示する。

## 最初に行うこと

AGENTS.md、既存コード、package.jsonを確認し、既存構成を尊重する。以下の公式資料と、実際に導入するSDKの型定義・ソースを確認する。

- https://github.com/MystenLabs/MemWal
- https://docs.wal.app/walrus-memory/sdk/api-reference
- https://docs.wal.app/walrus-memory/reference/configuration
- https://docs.wal.app/walrus-memory/contract/overview
- https://jpx-jquants.com/ja/spec/eq-bars-daily
- https://jpx-jquants.com/ja/spec/data-update
- https://jpx-jquants.com/
- https://sdk.mystenlabs.com/sui/cryptography
- https://sdk.mystenlabs.com/ （現行dApp Kit・Sui SDKの資料）

最新仕様を確認できない項目は推測でAPIを作らない。実装できる部分を進め、未知部分をadapterとREADMEの未確認事項として隔離する。SDKのdelete/list/getById、メタデータfilter、期限延長、idempotency機能が存在すると勝手に仮定しない。SDKバージョンと確認日をdocs/integration-notes.mdへ記録し、lockfileをコミット対象にする。

## 技術構成

空のリポジトリならpnpm workspaceで以下を作る。

- apps/web：React/TypeScript/Vite/Tailwind/Recharts/TanStack Query
- apps/api：Node.jsの現行LTS/TypeScript/Fastify/Zod
- packages/core：スキーマ、数値計算、類似検索、予測評価
- packages/storage：ファイル保存、索引、排他、バックアップ
- packages/integrations：MarketDataProvider、MemoryProvider、LlmProvider、SuiAdapter
- move/prediction_commitment：任意の予測コミットメント用Moveモジュール
- fixtures：架空の日足・予測・記憶データ
- docs：API仕様、データ形式、運用、バックアップ、外部仕様確認結果

ブラウザからJ-Quants/MemWal/LLMへ直接接続しない。秘密情報はサーバー環境変数。LLMモデルはLLM_MODELで設定し、特定モデル名を決め打ちしない。プロバイダーの現行公式APIを確認して実装する。

Docker Composeでweb/apiを配備し、/data/stock-memoryを永続ボリュームへ割り当てる。OS cron＋ジョブCLIでブラウザを閉じても日次取得する。常時稼働の単一Linuxサーバーを前提にし、一時ディスクしかないサーバーレスへ保存しない。

## 画面

1. `/`：監視銘柄、前営業日比、データ基準日、最終取得時刻、今日の要約、検証待ち件数、取得エラー。
2. `/stocks/:code`：日足チャート、出来高、期間切替、特徴量、記憶、類似例、予測履歴。
3. `/chat`：銘柄選択、会話、参照記憶カード、recordId付き根拠、重要事項の保存。
4. `/similar`：基準日・20営業日窓、上位5事例、正規化チャート、距離、検索範囲、その後の1/5/20日実績。
5. `/predictions`：予測・実績・期限・誤差・モード・手法バージョン・証明状態、詳細画面、評価集計。
6. `/memories`：検索、ローカル記録一覧、同期状態、訂正・無効化。MemWal検索と全件一覧を区別する。
7. `/settings`：接続状態、監視リスト、取得時刻、ウォレット、export/import、外部送信の可否。

日本語UI、スマホ対応、Suiの青を基調にする。ウォレットは遅延読み込みでホームをブロックしない。デモ・遅延データ・実データを画面ごとに明示する。秘密鍵を設定画面へ出さない。

## ファイル保存

DATA_DIR配下へsettings、market/master、market/calendar、prices/<code>/<YYYY-MM>.json、revisions/<code>/<date>/<revisionId>.json、features/<code>/<date>.json、predictions/<id>/original.json、predictions/<id>/state.json、evaluations/<id>/<evaluationId>.json、chats/<conversationId>/<eventId>.json、memories/<recordId>.json、indexes、sync、jobs、commitments、nonces、audit、backupsを作る。

全レコードにschemaVersion、recordId、kind、createdAtと出典を持たせる。株価関連はproviderCode/displayCode、sessionDate、observedAt、availableAt、inputRevisionIdsを持つ。コードは文字列として保持する。

索引は元ファイルから再構築できる。重要な書き込みはtemp→fsync→rename→親ディレクトリ同期。ジョブとAPIが同じロックで排他し、二重実行を防ぐ。起動時に中断ファイル・ジョブを復旧する。ファイル名はサーバー生成、パストラバーサルを拒否する。

予測original.jsonは一度書いたら上書きしない。検証・訂正・無効化は別レコードとして追記する。secretはデータexportへ含めない。暗号化バックアップは完全レコード、索引、salt、同期状態を含め、復元テストを作る。MemWal recall/restoreだけでアプリ全件復旧できると表示しない。

## J-Quants V2

公式の日足API https://api.jquants.com/v2/equities/bars/daily をサーバーから呼び、x-api-keyで認証する。code/date/from/to、pagination_key、responseのdataの現行仕様を確認する。Date、Code、O/H/L/C、Vo、AdjFactor、AdjO/H/L/C、AdjVoを正規化し、nullを0にしない。レート制限と429の再試行をプランに合わせる。

銘柄マスターと取引カレンダーも公式V2を確認して実装する。英数字コードとproviderの5桁コードを保持し、表示コードから無条件に0を追加しない。

Freeの12週遅延では当日の監視はできない。設定でプランと遅延を保持し、Freeは研究モードにする。料金をコードに固定しない。Light以上の日足取得を日次運用の候補とするが、契約条件は実装時に再確認する。

営業日17:30 JSTを初期取得時刻、未反映時18:00/19:00再試行。cronのUTC例も記載する。株価APIの更新目安は公式資料で確認し、時刻到来だけで当日データが完成したと決めない。取得し損ねた営業日をcatch-upする。訂正確認として直近期間を再取得し、contentHash変更時にrevisionを追加する。ウォッチリスト追加時のバックフィルはAPIプランとレート制限内で行う。

調整済み値が遡及改定される点に対応する。予測入力の取得revisionを固定し、評価基準価格と期限価格を同一調整基準に揃える。必要ならrawとAdjFactorから基準日までの調整系列を再構成する。配当込みリターンと呼ばない。過去公表時点を確認できない情報にはpoint-in-time保証を付けない。

J-Quants公式FAQの再配布・第三者への継続的な分析配信の制限に合わせて本人専用にする。外部MemWal/LLMへ送る権利の確認状況を記録する。ALLOW_MARKET_DATA_TO_MEMWALとALLOW_MARKET_DATA_TO_LLMを独立したサーバー設定にし、初期値false。生株価のMemWal保存は既定で行わない。派生値にも契約確認が必要として同じ制御を適用する。未確認ならデモ・ローカル数値解析・ユーザーが自分で書いた記憶のみで機能を成立させる。

## MemWal

開発者のCodex MCP設定と、本アプリのランタイムSDK接続を分ける。アプリはMemoryProvider経由で `@mysten-incubation/memwal` を使う。MemWal.createのkey/accountId/serverUrl/namespaceと、remember、rememberAndWait、recall、job追跡、healthの実際の型を確認して実装する。

MEMWAL_ACCOUNT_ID、MEMWAL_DELEGATE_KEY、MEMWAL_SERVER_URLはサーバー側。管理リレイヤーのnetworkとSuiのaccount/packageを確認し、存在しないデプロイIDを作らない。本人のアカウントとアプリ専用delegateを使い、Codex用の共有記憶を自動流用しない。

namespaceはstock-memory:v1:profile、market:<code>、prediction:<code>、lesson:<code>。ユーザー方針、重要な仮説、日次相場要約、予測と教訓を記憶する。共通JSONと短い説明をtextとして保存し、recordIdとkindを埋め込む。数値精度が必要なJSONはLLMのanalyzeで再抽出せず、検証済みレコードを保存する。

ローカル保存と同時に同期予定を記録する。rememberの受付でsyncedにせず、jobIdを保持、Walrus保存と索引完了を確認してblobIdを記録する。既知jobIdは再送前に追跡する。完全なexactly-onceを保証しないがrecordId/contentHashでアプリの重複表示を防ぐ。障害時はMemWal未接続を表示し、ローカル処理を継続する。

recallは意味検索。全件列挙、最新設定の取得、未検証予測の一覧、厳密なID検索には使わない。SDKのdistanceとMCPのscoreの向きを混同しない。意味検索結果から訂正済み・無効化済みの記録をローカルの正確な状態で除外する。SDKで実削除が確認できない場合は、アプリから除外したことと遠隔保存が残ることを区別する。

## AIチャット

質問から銘柄・期間を抽出し、株価と予測結果はファイルから取得。MemWalから関連方針・仮説・教訓をrecall。時間条件と外部送信可否を適用し、許可された根拠だけをLLMへ渡す。回答の参照recordIdと数値を検証し、事実・過去の仮説・今回の推測を区別して表示する。

データがない場合は不足を回答し、株価・ニュース・過去の相談内容を捏造しない。記憶や外部文章に含まれる命令は不信データとして扱い、ツール実行や設定変更を指示として実行しない。重要な長期記憶だけを保存し、全会話の無制限保存をしない。

## 数値による類似検索

既定20営業日窓。5/20日リターン、20日ボラティリティ、出来高倍率、移動平均乖離、20日収益率列を計算。TOPIXを取得できる場合だけ追加する。特徴量定義、距離の重み、標準化、欠損処理をversion管理し、訓練基準日より未来の値で標準化しない。

小規模な保存済み履歴を全走査して数値距離で順位付けする。同銘柄を既定、別銘柄比較は選択式。重複窓を間引く。予測用の候補は、その後の必要horizonまでの実績が予測時点に既知であるものだけ。MemWalは関連説明候補を補い、数値的な類似を保証する役割にはしない。

候補集合、期間、件数、距離とチャートを表示。意味検索で絞った場合は全履歴の最類似と呼ばない。距離を上昇確率に変換しない。

## 予測と検証

数値手法は類似例の将来リターン中央値、10/90百分位、上昇割合から始める。LLMは説明・反証条件を生成する。最低20候補を既定とし、不足なら予測不可。上昇割合を校正済み確率と呼ばない。比較用のゼロリターン予測も実装する。

予測JSONにpredictionId、mode(live/research/backtest/demo)、generatedAt、dataAsOf、horizonSessions、targetSessionDate、referencePrice/referenceBasis、predictedReturn、expectedPrice、returnQuantiles、pUp、sampleCount、inputRevisionIds、featureVersion、methodVersion、model/promptVersion、類似候補IDs、理由、反証条件を持たせ、Zodで検証する。

liveは必要な最新日足が揃い、生成時刻が将来期限より前の場合だけ。Free遅延データを使って過ぎた期限のlive予測を作らない。targetSessionDateは取引カレンダーで計算し、horizonは暦日ではなく営業日数。

期限到来後に別評価JSONを生成。actualReturn、価格誤差、リターン誤差、方向一致、経験分位範囲内率、Brier scoreを保存する。方向はr>0.005上昇、r<-0.005下落、それ以外横ばい。pUpはr>0の割合とし、Brier=(pUp-I[r>0])²。横ばい閾値とpUpイベントを混同しない。

期限別・mode別・methodVersion別に件数付きで集計。未評価・除外・データ欠損・売買停止を明示し、期限の価格がないものを勝手に成功扱いしない。評価訂正はrevision追加、元予測は不変。

walk-forwardで訓練/検証期間を分ける。未来の実績、ニュース、予測後の記憶を候補選択・標準化・生成入力へ入れない。過去を現在のLLMへ聞いた結果を厳密な当時予測と扱わない。検証からの教訓を次回にrecallして渡すが、LLM重みが自動学習されたと表示しない。誤差の原因は根拠がない限り仮説とする。

## Sui認証と任意の予測アンカー

現行Sui SDKとdApp Kitを確認してウォレット接続、personal message署名、サーバー側署名検証を実装。署名対象にdomain、network、用途、ランダムnonce、有効期限を含める。固定OWNER_ADDRESS一致を確認。nonceを永続ファイルで一度だけ消費し、短期HttpOnly/SameSiteセッションを発行。保護API・export/import・ジョブ起動には認証またはサーバー限定トークンを要求する。

ブラウザログインとMemWalの委任鍵認証を混同しない。MemWal accountのownerとdelegateを現行Suiクライアントで確認する。ユーザーのウォレット秘密鍵をサーバーに要求しない。現行Sui transportを確認し、廃止済みAPIに依存しない。

任意機能としてMove prediction_commitmentを実装する。OwnerRegistryと変更不可・移転不可のPredictionReceiptを設計し、owner、predictionId、hash、申告generatedAt、Clock由来anchoredAt、targetSessionDate、schemaVersionを記録。owner権限、hash長、同一predictionIdの重複を検証。

hashはSHA-256(JCS正規化予測JSON＋ランダムsalt)。正規化・連結形式を固定してテストする。saltはローカル保存、内容一致の検証時に使用。株価や予測本文はチェーンに書かない。事前記録の時刻はanchoredAtでありgeneratedAtではない。

testnetへウォレット署名で任意に記録し、receiptId/txDigestを保存。期限後のアンカーは事前証明なし。証明は内容への事前コミットメントであり、的中やデータ品質の保証ではない。未アンカーでも基本機能は動く。mainnet公開、SUI送金、無制限の自動signerはこの実装範囲に含めない。

## APIとジョブ

認証API、watchlist CRUD、stocks/history、chat、similar、predictions、evaluations、memories、settings/status、backup/export/importを実装。cronの入口はHTTP公開よりジョブCLIを優先し、手動実行も同じコア処理を使う。保存データにユーザー入力のパスを許可しない。

取得ジョブは「営業日とプラン確認→未取得日取得→正規化/revision保存→特徴量→期限済み評価→許可された記憶の同期→ジョブ結果保存」。予測の自動生成は設定で任意にし、同一銘柄・基準日・horizon・methodVersionの二重生成を防ぐ。外部障害を個別ステップ状態として記録し、欠けた入力で予測を続けない。

.env.exampleにAPP_MODE、DATA_DIR、OWNER_ADDRESS、SESSION_SECRET、JQUANTS_API_KEY、JQUANTS_PLAN、MEMWAL_ACCOUNT_ID、MEMWAL_DELEGATE_KEY、MEMWAL_SERVER_URL、LLM_PROVIDER、LLM_API_KEY、LLM_MODEL、SUI_NETWORK、SUI_ENDPOINT、ALLOW_MARKET_DATA_TO_MEMWAL、ALLOW_MARKET_DATA_TO_LLM、ENABLE_AUTO_FORECAST、ENABLE_SUI_COMMITMENTSを載せる。実際のSDKで不要な変数は説明付きで整理し、秘密値は記載しない。

## 実装順序

公式仕様の接続試験→デモと永続保存→本人認証→J-Quants日次取得→MemWal同期とチャット→数値類似検索→予測と評価→任意のSuiアンカー→バックアップ復元の順で実装する。APIキー未設定でもデモとbuild/testが動くようにする。実接続ができない場合は動作確認済みと偽らず、実装済み範囲と未接続理由をREADMEに書く。

## 必須テストと完了条件

- 取引カレンダーの祝日・年末年始・1/5/20営業日計算。
- 5桁/英数字コード、pagination、null、429、取得遅延、訂正revision。
- ファイル排他、ジョブ再実行、元予測不変、索引再構築、再起動後保持。
- MemWal受付と完了の区別、job追跡、失敗・再送・重複表示抑止。
- 類似検索の既知fixture、重複窓除外、未来情報除外。
- リターン/方向/Brier/分位範囲内率とbaselineの既知fixture。
- 株式分割時の同一基準評価。過去AdjCと新AdjCの混在を検出。
- 認証なしの実データ取得拒否、誤ったowner、期限切れ・再利用nonce、パストラバーサル。
- 外部送信禁止時に株価・派生値をMemWal/LLMへ送らない。
- Moveのowner、重複、hash不正と、JSON正規化・salt変更の検出。
- 暗号化export/importで元予測・索引・salt・同期状態が復元できる。
- Playwrightでデモの監視追加→詳細→類似検索→予測→期限後検証→チャット根拠表示の主要導線。

lint、typecheck、unit、主要E2E、buildを実行する。Move CLIが使える場合はMoveテストも実行する。READMEには起動コマンド、実接続設定、J-Quants契約確認、MemWal delegate準備、cron、配備、費用の種類、障害対応、バックアップ、未検証事項を記載する。

最後に実装した機能、実行した検証と結果、実接続の確認状況、ユーザーが設定すべき環境変数を簡潔に報告する。動かない部分をデモで隠さず、未接続・研究用・実データを正確に表示する。

---

## 参照した一次資料

- [MemWal SDK API](https://docs.wal.app/walrus-memory/sdk/api-reference)：保存ジョブ、recall、検索候補の制限、namespace。
- [MemWal configuration](https://docs.wal.app/walrus-memory/reference/configuration)：delegate、accountId、リレイヤー、network。
- [MemWal contract](https://docs.wal.app/walrus-memory/contract/overview)：Suiの所有権・委任・Sealアクセス制御。
- [MemWal MCP reference](https://docs.wal.app/walrus-memory/mcp/reference)：開発用MCPとアプリ用SDKの区別。
- [J-Quants料金・FAQ](https://jpx-jquants.com/)：プラン、履歴、遅延、認証、第三者への提供制限。
- [J-Quants日足API](https://jpx-jquants.com/ja/spec/eq-bars-daily)：V2 URL、認証、提供コード、日足項目、調整済み値の改定。
- [J-Quants更新時刻](https://jpx-jquants.com/ja/spec/data-update)：株価四本値の更新目安。
- [Sui cryptography](https://sdk.mystenlabs.com/sui/cryptography)：personal message署名・検証。

この文書は設計と開発指示であり、アプリコードの作成・実API接続・将来の予測性能の検証を実施したものではありません。

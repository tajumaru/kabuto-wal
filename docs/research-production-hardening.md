# かぶまるAI研究員 3.5 実運用強化

2026-10-17。起点は `536cddf`。作業開始時にorigin/mainをfetchし、HEADとの差分0/0を確認した。既存の未コミットUI変更、および作業中に並行編集された底打ち・ランキングの差分は上書きせず、本件のコミットから除外した。

## Phase 1：LLM通信

調査：`kabumaru-llm.ts`、Evidence検証、決定的説明、既存の送信許可テスト。従来のfetchでは、HTTPSとredirect禁止だけで内部宛先やDNS rebindingを防げず、応答上限も全文読込後だった。

`research-network.ts`を追加。`RESEARCH_LLM_ALLOWED_HOSTS`をカンマ区切りの完全一致allowlistとする。未設定なら外部LLM接続を拒否。ワイルドカード、IPリテラル、localhost、443以外、認証情報・query・fragmentを含むURLを許可しない。名前解決結果を全件検査し、1件でも内部・特殊用途IPなら拒否する。IPv6は保守的な公開ユニキャスト範囲だけを許可し、2001系・遷移アドレス等も除外するため、一部の正当な公開IPv6宛先は利用できない。

Node標準の`https.request`に検証したIPだけを返すlookupを指定する。family固定、autoSelectFamily無効、agent無効、proxyEnv空、元のホスト名によるSNIと標準の証明書検証を維持。再名前解決、接続再利用、環境プロキシ、redirectを使わない。DNSから本文受信まで全体2秒、本文は受信中に200,000バイト、同時通信はAPIプロセス当たり2件まで。複数APIプロセスを動かす場合はプロセス数分の上限になる。

通信仕様の確認元：[Node HTTPS](https://nodejs.org/docs/latest-v24.x/api/https.html)、[Node net](https://nodejs.org/docs/latest-v24.x/api/net.html)。検証環境はNode 24.14.0。TLS検証は無効化していない。キーや例外の接続先詳細は利用者向け応答へ出さない。

専用許可`ALLOW_RESEARCH_DATA_TO_LLM`、既存市場データ許可`ALLOW_MARKET_DATA_TO_LLM`、今回のUI明示許可をすべて維持。provider既定値はdeterministic。失敗時はローカル説明へ戻る。LLMへ送る内容と根拠文の照合ルールは既存のものを再利用。

モック検証：localhost、IPv4/IPv6 loopback、private、link-local/metadata、IPリテラル、未許可ホスト、DNS回答変更、接続IP固定、redirect、時間上限、同時上限、不正JSON、過大ストリーム。実LLMや危険な宛先へのリクエストなし。公開サービスとの実TLS接続は未検証。

## Phase 2：検索とキャッシュ

調査：`kabumaru-research.ts`、`kabumaru-research-cache.ts`、`service.predictions()`、Store、同期・削除状態。従来はキャッシュ確認前に全予測・評価・記憶・同期JSONを読み込んでいた。

`indexes/kabumaru-records.json`は再生成可能な派生メタデータ。銘柄・基準日・方式・時点・区分・原本参照だけを保持する。予測、評価、記憶、同期、研究原本、保存チャットのファイル名・サイズ・mtimeNs・ctimeNsから世代を識別する。checksum/Zod/JSON破損時は原本から再構築する。原本自体は変更しない。同期・評価だけの変更では索引の原本メタデータを再読込せず、世代だけ更新する。

研究の原本読込は直近20予測、関連記憶は直近100件、採用記憶は20件まで。時点・対応方式を絞ってから制限する。1予測の評価改訂が100件を超えた場合は、任意の改訂を選ばずエラーにする。初回索引構築は全件を32件ずつ処理する。通常検索もファイル列挙・statはO(N)であり、定数時間ではない。

`GET /api/research/records`はcode/asOf/method/page/pageSizeで検索し、予測と研究記録のメタデータを返す。`GET /api/research/chats`もcode/asOf/method/page/pageSizeを受け付け、既存records配列を維持しtotal/page/pageSizeを追加。pageSizeの上限は100。

評価は索引の自由な参照を信頼せず、検証した予測原本のIDから読み、predictionId/methodVersion/作成時点を照合。記憶はactive、削除・無効化・検索リセット・blob削除等の同期状態を採用直前に確認し、キャッシュ返却時にも再確認する。リモート記憶の文章は引き続きEvidenceへ採用しない。

同一Service内の同一研究は進行中Promiseを共有し、返却値はcloneする。最大16種類の研究を同時処理し、超過は再試行を案内。別プロセス間の計算重複排除は未対応。質問分類は根拠キャッシュのキーから分離し、同じEvidenceを再利用する。原本・評価・記憶・同期世代、ジョブ、詳細、coverage、方式、銘柄、asOf、cutoff、区分をキーに含める。破損キャッシュは原本のエラーとして扱わず再計算する。

### オフライン速度比較

`pnpm exec tsx scripts/benchmark-research.ts`。旧実装はgitの`536cddf`から読み込む。外部fetchは禁止。一時ディレクトリに100/1,000/10,000件の予測・関連記憶・同期fixtureを作成し、同じ保存先と入力で旧・新の研究処理を比較する。セットアップ用の元予測3件もある。通常のStore永続化は変更せず、fixture生成だけ直接ファイル書込を使う。

この測定は対象日にジョブがない予測・記憶検索経路であり、底打ち・デジャヴの再分析、実市場API、HTTP往復時間を含まない。初回は各1回、再研究は各3回。Windowsローカル環境の測定で、OSファイルキャッシュ・並行作業の影響を含む。統計的な性能保証ではない。

| fixture件数 | 初回 旧→新 ms | 再研究中央値 旧→新 ms | 再研究短縮 | 銘柄切替 旧→新 ms | 記憶削除後 旧→新 ms |
|---:|---:|---:|---:|---:|---:|
|100|396.77→168.08|123.67→42.54|65.60%|256.80→56.82|301.13→55.59|
|1,000|3,406.65→1,159.43|1,616.52→288.85|82.13%|3,106.49→509.10|2,549.79→307.10|
|10,000|27,729.18→8,081.17|10,344.10→2,200.08|78.73%|18,211.55→2,028.94|17,118.16→2,153.05|

生データ：[research-benchmark.json](research-benchmark.json)。10,000件でも初回約8秒、再研究約2.2秒なので、追加の索引分割・変更追跡には改善余地がある。

## Phase 3：スコアと実績

調査：hunter-journal、hunter-summary-cache、hunter-backtest、hunter-method。既存集計・評価原本は維持。追加レポートは`GET /api/research/outcomes?jobId=...`。研究画面の「実績検証レポートを表示」から開く。現在時点の期限後検証であり、過去基準日当時のEvidenceとは明確に分ける。

0–39/40–59/60–79/80–100を実運用・過去研究・walk-forward、データ区分、1/5/20営業日、分類、基準月、methodVersion別に分離。評価可能・評価済み、平均・中央値・上昇割合、最大下落と分布、再下落割合、予測中央値との平均絶対誤差を表示。スコアを確率として扱わない。

同一銘柄・期間・実験・方式の重複結果窓は、スコアや結果を見る前に日付・ID順の先頭を残して除外する。重複除外数と銘柄数を表示し、20評価未満または20銘柄未満は低信頼。これは完全な独立標本化ではなく、期間間・市場全体・異なる銘柄間の相関は残る。

再下落は「結果窓で基準価格を一度上回り、その後基準価格を下回ったか」。新しい期限後評価へ追加記録する。旧評価に値がなければ推定せず未計測とし、分母を併記する。過去予測のスコア・条件・閾値や原本は変更しない。評価JSONは従来どおり追加保存で、古い評価を上書きしない。

非候補比較は、指定ジョブで判定可能な全銘柄を母集団にし、候補・非候補数とスコア帯内訳を診断する。候補と同じ締切・結果窓で非候補を評価する設計を記録した。現行の予測原本は候補に限られるため、非候補の将来成績は未記録と表示する。この段階で対照群の成績や80点以上の実市場優位性を主張しない。

テストでは4帯、負の成績、実験分離、連続日重複、未評価、旧評価の未記録値、予測と評価の参照照合を確認。85点の人工観測が−10%でも、そのまま平均−10%・上昇割合0として表示する。これは人工テストであり実市場成績ではない。

## Phase 4：取得ジョブ

429の待機、Retry-After、checkpoint、期限切れlease復旧、別workerの二重実行抑止は既存実装を再利用。failureStageとretryAtを後方互換の任意フィールドとして追加し、取得失敗と分析失敗を識別する。429/取得予算はpaused、401等はfailed。再開時は旧エラー・待機情報を消す。部分checkpointを再利用し、保存済み日を無条件に再取得しない。欠損対象は既存の訂正revision取得で明示的に補う。自動大量取得なし。

`JQUANTS_REQUESTS_PER_DAY`は任意のローカル日次予算で、未設定なら追加の上限なし。APIキーのハッシュで既存の分予算と保存先を共有し、JST日付と予約済みリクエスト数を保存する。Retry-Afterで件数を消さず、予算到達時はJST翌日まで再開可能な待機。J-Quants契約上の日次権利や別アプリの消費量を保証するものではない。

preflightは外部取得時だけ取得速度・契約取得期間を検査する。保存済みscanを外部接続設定だけで拒否しない。旧JSONの破壊的移行なし。実J-Quants接続は未実施。

## Phase 5：画面と性能

既存StockPicker・かぶまる画像・ハンターの遅延チャートとURL状態を維持。研究Evidence一覧と実績画面を別チャンクに分け、必要時に読み込む。Evidence詳細のJSON整形は展開時のみ。長い説明は3項目以降を折りたたむ。根拠リンクは一覧を開いて参照先へ移動する。

保存しない定義済み質問は現在のEvidenceで回答し、APIを再呼出ししない。履歴保存・MemWal検索・外部LLMは既存の明示操作を維持。銘柄等が変わった後の旧通信応答を破棄し、researchIdが一致しない旧回答も表示しない。URL別スクロールを保持し、Safe Area、16px入力、44px操作領域、320px幅を確認した。キーボード表示時は固定の研究操作バーを置かない。

最終E2Eの375×667/320×568 Chromium、5回の研究サマリー表示：1,415.19 / 490.25 / 608.77 / 248.69 / 553.79ms。中央値553.79ms、最小248.69ms、最大1,415.19ms。初回と再読込を混ぜたローカル開発サーバーの測定。Evidence一覧展開481.18ms。生データ：[research-mobile-benchmark.json](research-mobile-benchmark.json)。iPhone実機・Safari・実キーボード・低速回線は未検証。変更前の同条件の画面時間は未計測であり、速度向上率は算出しない。

ビルド：研究画面JS 13.59kB/gzip 5.46kB、Evidence 1.76kB/gzip 1.02kB、実績レポート3.05kB/gzip 1.58kB。旧研究チャンクは12.69kB/gzip 4.99kBで、機能追加後の親チャンク自体は増加した。遅延化をチャンク総量削減として報告しない。Viteビルド1.59秒。ハンターのチャート到達1,642ms、ランキングAPI28.4msは単回の参考値で、描画だけを分離した計測ではない。

## Phase 6：検証・互換性

- lint、typecheck、test（41ファイル142件）、test:e2e（25件）、build成功。
- LLM通信、送信許可、索引破損、履歴ページング、削除世代、キャッシュ破損、同時研究、未来情報除外、予測原本不変、スコア集計、429/日次待機・再開、狭幅UIを検証。
- 暗号化バックアップのresearchフォルダー漏れを修正し、研究原本の保存・復元と復元競合の拒否を回帰テストに追加。
- E2Eは別ポート5527/3012で既存プロセスを停止せず実施可能。ブラウザの外向き通信はローカルの拒否プロキシ経由にし、localhostのみ除外。ウォレットSDKのメタデータ取得失敗・Lit開発警告は残るがテストは成功。
- 途中のE2Eで並行編集のviewパラメータ不整合による失敗があった。変更反映後の再実行ではハンター2件を含む全25件が成功した。
- J-Quants、MemWal、Sui、実LLMの実接続・実送信・トランザクションは未検証。今回のテストと性能測定はモックと一時fixture。既存の個人用JSONは変更していない。

## 変更ファイル

API：`research-network.ts`、`kabumaru-llm.ts`、`kabumaru-record-index.ts`、`kabumaru-research.ts`、`kabumaru-research-cache.ts`、`kabumaru-outcomes.ts`、`hunter-jobs.ts`、`hunter-preflight.ts`、`hunter-journal.ts`。

共通：`packages/core/research-outcomes.ts`、`packages/core/hunter-schema.ts`、`packages/integrations/jquants-limiter.ts`、`packages/storage/index.ts`。

画面：`KabumaruResearch.tsx/.css`、`KabumaruEvidence.tsx`、`ResearchOutcomes.tsx`。

検証：`tests/research-network.test.ts`、`research-http.test.ts`、`research-index.test.ts`、`research-cache.test.ts`、`research-outcomes.test.ts`、`kabumaru-research.test.ts`、`hunter-acquisition.test.ts`、`jquants-foundation.test.ts`、`storage.test.ts`、`tests/e2e/research.spec.ts`、`tests/e2e/server.ts`、`playwright.config.ts`、`scripts/benchmark-research.ts`。

設定・文書：`.env.example`、本書、`kabumaru-ai-researcher.md`、測定JSON2件。並行編集のmain.tsx/BottomHunter.tsx/style.css/bottom.ts等の差分は本件のコミットに含めない。

## 第4弾への候補

非候補を含む固定コホートをJSONで保存し、同一取得締切・1/5/20営業日で期限後評価する。銘柄単位・期間単位の相関を考慮した区間推定、取引コスト・契約遅延・欠損を含むwalk-forward検証へ進む。十分な実市場記録が集まるまで採点や閾値は変更しない。併せて索引の銘柄別分割・変更追跡、複数プロセスの研究重複抑止、iPhone Safari実機測定を検討する。

# かぶまるAI研究員

第3.5弾の通信・検索・実績検証・モバイル改善と検証結果は [実運用強化](research-production-hardening.md) を参照。外部LLMは接続先allowlistも必須となった。

実装日：2026-10-17。開始時にorigin/mainをfetchし、mainとの差分0/0を確認。起点はc5696dd。既存の底打ちハンター2.5・デジャヴ2.0・JSONストレージ・予測ジャーナル・MemWal SDKを再利用した。DB・常駐サーバー・キャラクターの追加なし。

## 利用方法

底打ちハンターの銘柄行から「かぶまるに研究してもらう」を選ぶと、code/asOf/jobIdを維持して `/research` へ移動する。メニューからも開ける。StockPickerは既存コンポーネントを変更せず再利用。基準日とジョブが一致しなければ研究を拒否する。

画面は既存かぶまる画像、対象選択、信頼性・取得状況、研究サマリー、強気・弱気の根拠、類似相場比較、予測時の条件と実績の比較、観察条件、不確実性、定義済み質問、根拠一覧をカードで表示する。表の横スクロールは不要。根拠リンクで対応するEvidenceへ移動できる。

定義済み質問はwhy/similar/risk/high-score/outcome/watch。自由文・個人情報を外部へ送る入力欄は設けていない。原本にない情報は「確認できません」と答える。質問と回答のJSON保存は初期OFFのチェックボックスで選ぶ。保存と外部送信は独立している。URLで対象が変わった場合、前の銘柄の回答は表示しない。

研究画面では自動通知の吹き出しだけを非表示にし、既存のかぶまる起動ボタンとチャットパネルは維持する。モバイル画像の確認で保存欄との重なりを発見し、研究画面に限定して修正した。

## Evidenceと時点整合性

`packages/core/kabumaru-research-schema.ts` にstrictなZod discriminated unionを定義。

| kind | 事実の原本・主なfacts |
| --- | --- |
| bottom | 検証済みハンター詳細。スコア、分類、一致・未一致条件、リスク、RSI、下落率、出来高倍率、連続営業日数 |
| dejavu | 既存の非重複・未来除外検索。上位5/10/20設定×1/5/20営業日の実標本数、中央値、上昇割合、分位点、表示5事例の類似度・共通点・相違点 |
| forecast | immutableな予測原本。中央値、対象日、期間、実験区分、記録されたスコア・分類・条件・リスク |
| evaluation | 対応する評価JSON。実績、最大下落、予測値、期間・実験区分・基準月・分類 |
| memory | ローカル原本・評価・保存済み研究で照合した記憶IDと照合理由。リモートの文章はfactsに採用しない |

各EvidenceはevidenceId/kind/sourceId/asOf/cutoff/methodVersion/revisionIds/facts/limitationsを持つ。IDはZodで正規化した本文全体のSHA-256。改変、未定義フィールド、重複・存在しない参照を検証する。認証やSui署名の代替ではない。

研究結果はcode/asOf/cutoff/analysisId/jobId/evidenceIds/inputRevisionIds/explanationMethodVersion/generatedAt/mode/dataCoverageを保存する。初版方式は `kabumaru-grounded-v1`。元の採点・分類・予測methodVersionや原本は変更しない。

- 研究cutoffは、ジョブcutoff・基準日日本時間末・現在時刻の最小値。
- 分析窓全体の最終observedAtが研究cutoff以前であることを確認。後日改訂を含む分析は当時の根拠へ転用せず、当日以前の締切での再走査を案内する。
- 後日取得のジョブであっても、分析入力がすべて当時既知ならその事実だけを採用。デジャヴは元の系列を研究cutoffで再フィルターして計算し直す。
- 予測は作成・生成・記録時刻・入力cutoffが研究cutoff以前。評価はtargetがasOf以前、作成時刻と評価cutoffも研究cutoff以前。
- 評価のpredictionIdとmethodVersionが対応する原本と一致しなければ除外する。
- 対応方式はbottom-hunter-hypothesis-v1と既存dejavu-consensus-v1。原本に入力cutoffを持たない通常予測や未知の方式を推測で正規化しない。
- 底打ち条件を持たないデジャヴ予測はスコア・分類を未記録とし、0点や現在の判定で補完しない。
- demoと実市場の記録を分離。実運用/prospective、過去研究/retrospective、walk-forward、営業日先、方式、基準月、分類を混ぜて高スコア成績を語らない。
- かぶまるの関連予測・評価表示は直近20原本まで。超過時は対象総数と表示上限を警告する。全市場・全予測の集計と混同しない。

後日保存されたcoverageは「ジョブ全体の取得状況」というメタデータとして表示するが、当時の取得範囲の証明には使わず、警告とデータ取得不完全の区分を付ける。研究キャッシュは原本・評価・記憶・削除状態・ジョブ・coverageに依存し、Evidence IDと現行の決定的説明も再検証する。

## 説明と信頼性

数値はEvidenceのfactsからだけ表示する。説明は固定条件名・リスク辞書と決定的テンプレートで生成し、未知の自由文・ニュース・原因を補わない。過去の予測条件・リスク・予測中央値・実績・最大下落を並べても、原因を断定しない。スコアと上昇割合は校正済み確率ではない。

信頼性の基準：

| 区分 | 条件 |
| --- | --- |
| 根拠不足 | 当時のreadyな底打ちEvidenceを確認できない |
| データ取得不完全 | coverageが未完了・当時の情報でない・不明、80営業日未満、または遅延プラン |
| 限定的な根拠 | 取得が完了しても、20事例設定の各期間で20事例を満たさない、または関連評価が20件未満 |
| 十分な根拠 | 上記を満たし、各期間20事例以上かつ関連評価20件以上 |

これは材料の充足度であり、上昇確率や将来の成功保証ではない。少数標本では明示警告。記録された候補だけの選択バイアスも常に警告する。80点以上が優れているという仮定や閾値変更はしていない。

## MemWal

既存 `service.memoryProvider()` とMemWal SDKを利用し、接続先・ネットワーク・認証設定は変更していない。

既定はローカル要約の照合だけ。利用者が研究画面で関連記憶検索を明示した場合に限り、非demoでALLOW_MARKET_DATA_TO_MEMWAL=trueかつJQUANTS_MEMWAL_RIGHTS_CONFIRMED=trueならSDKのrecallを呼ぶ。

検索先は既存ハンター要約namespaceと既存デジャヴ反省namespace（各最大20）。queryは銘柄・分類・一致条件コード・リスク・成功失敗の観点。本人情報・会話・秘密値は含めない。リモートは最大2秒でローカルへフォールバックする。

返却文章はrecordIdだけ取り出し、実体はローカル記録から再取得する。ローカルに存在しない結果・原本に結び付かない結果は採用しない。active=false、remoteDeletedAt、deleted/disabled状態、検索索引削除、blob削除、削除処理の受付情報がある記憶は除外する。リモート検索の文章で削除済み記憶を復活させない。

「研究要約をローカル保存」は研究結果と、特徴量・一致条件・リスク・直近の予測実績・Evidence ID・研究参照IDを持つcompactなhunter_research_summaryをJSONへ保存する。チャートや全価格系列は入れない。既存syncのpendingから先は変更せず、既存の明示同期と許可設定に委ねる。この操作自体はrememberを呼ばない。記憶・syncが既に存在したら上書きや再活性化をしない。予測・評価時の既存要約生成も維持する。

## 任意のLLM

`ResearchLLMProvider.generateExplanation(evidence, instruction)` を抽象化し、外部不要のdeterministicとConfiguredResearchLlmを実装。外部は必須ではなく、既定は常にdeterministic。

外部を使うには全条件が必要：

1. ALLOW_MARKET_DATA_TO_LLM=true（既存設定）
2. ALLOW_RESEARCH_DATA_TO_LLM=true（研究専用設定）
3. リクエストallowExternalLlm=true（操作ごとの明示許可）
4. provider=configured-llm、RESEARCH_LLM_PROVIDER=configured-llm、有効なRESEARCH_LLM_URL

URLは認証情報・query・fragmentを含まないHTTPSのみ。redirectは禁止。必要なら既存LLM_API_KEYをAuthorizationヘッダーで使うが、プロンプトには入れない。個人情報・ウォレット情報・原本本文・銘柄名・会話・MemWal文章・revision一覧・チャート・不要な価格は送信対象外。送信は限定した数値集約、内容に結び付いたEvidence ID、検証済み文のcatalogと定義済み質問分類だけ。

ConfiguredResearchLlmは利用者が選んだ既存HTTPSエンドポイント向けのJSON契約。特定の有料モデルやOpenAI SDKは必須にしない。本実装はChat Completions等のモデル固有APIへ直接接続するアダプターではない。選んだ接続先が以下の契約に対応する必要がある。

```text
POST RESEARCH_LLM_URL
Content-Type: application/json
Authorization: Bearer LLM_API_KEY  （設定した場合だけ）

request: { instruction, evidence: [{ evidenceId, kind, facts }], catalog: { statements: [...] } }
response: { statements: [{ statementId, section, text, evidenceIds }] }
```

出力はcatalogの文を選択・並べ替える方式。自由な言い換え・新規数値・因果推論・新しい根拠IDは採用しない。textとevidenceIdsを含め完全一致で検証し、summary/bearish/reflection/uncertaintyの必須文の省略も拒否する。JSON不正・200,000文字超・HTTP失敗・2秒タイムアウト・検証失敗は決定的説明へフォールバック。エラー本文や秘密値を画面やプロンプトへ流さない。

自然言語の自由生成を優先する設計ではない。根拠なしの数値と断定を確実に拒否することを優先した初版で、将来の言い換え対応は別方式で評価する。

## API・JSON

既存FastifyのSui本人認証・Originチェックの内側に登録。新規認証方式は作らない。

| API | 内容 |
| --- | --- |
| POST /api/research | 確定した対象の研究。既定はローカルのみ |
| POST /api/research/chat | `{research: <研究入力>, saveHistory: boolean}`。保存は初期false |
| GET /api/research/chats | 保存済みの研究チャット結果（最大20） |
| POST /api/research/save | 研究原本・compact要約をローカル保存。外部送信なし |
| POST /api/research/diagnostics | 1銘柄の保存済みデータ診断。外部呼び出し0 |
| GET /api/bottom/hunter/evaluations | 既存互換の集計APIを高速化 |

研究入力はcode（5桁J-Quantsコード）、任意のasOf/jobId、question（summary/why/similar/risk/high-score/outcome/watch）、provider、allowExternalLlm、recallRemote。未知フィールドは拒否する。ハンター導線はcode/asOf/jobIdをすべて設定する。

JSON追加先：research/cache/{依存hash}.json、research/results/{researchId}.json、research/chats/{履歴hash}.json。結果原本は不変保存。要約は既存memories/{recordId}.jsonとsync/{recordId}.jsonへ追加する。過去の予測・評価・削除receipt・Suiコミットメントを更新しない。

診断は保存済みの実市場データでも使える。coverage、連続80営業日、adjustmentVersion、seriesConsistent、入力revision、類似事例数、関連評価のスコア帯件数、プラン・遅延を返す。系列を検証できない場合はfalseであり成功を推測しない。新規のJ-Quants取得機能は作らず、必要なら既存の明示取得操作を使う。起動時・研究表示時・診断時の全市場自動取得はない。

## 実績集計の高速化

hunterEvaluationSummaryは保存済み評価を優先し、期限前の予測は価格取得しない。未評価分は同一銘柄・同一対象日でPromiseを共有し、最も早い基準日から対象日までの必要な系列を一度だけ再構成する。

集計結果はServiceごとのWeakMapへ最大1件・4 MiBで保持。原本と評価の内容hash、取得ページ・revisionファイルの名前/サイズ/mtimeNs/ctimeNs、カレンダー、mode、プラン、期限到来状態をキーにする。保存済み未来観測が利用可能になる時刻と日本時間の日付境界でも失効し、時計が巻き戻った場合は再利用しない。返却値の変更でキャッシュを汚せないよう複製して返す。キャッシュは再起動時に消え、JSONの移行を要求しない。

既存のmode/experiment/1・5・20営業日/分類/スコア帯/基準月/方式別集計・少数標本表示を維持。予測原本と評価値の計算方法は変更していない。Service.predictions()と入力ファイル確認は引き続きO(N)で、全市場・長期の索引追加は今後の候補。

ローカルfixture測定：実際のハンター原本3件と複製120件、未評価123件、1銘柄・3対象日。両版で評価可能123件、外部呼び出し0。実市場の独立標本ではなく、IO・重複計算の比較用。

| 集計 | 変更前 | 変更後 |
| --- | ---: | ---: |
| 初回 | 2,920.17 ms | 419.68 ms |
| 同条件再実行 | 2,875.51 ms | 247.57 ms |

再現：`pnpm exec tsx scripts/research-summary-benchmark.ts 120`。OS・filesystemキャッシュを固定しない単発比較で、全市場・多銘柄で同じ比率になるとは限らない。測定ファイルはmkdtempで分離し、終了時に削除する。

研究画面はroute単位で遅延読込。計測時の研究JSは12.69 kB（gzip4.99 kB）、CSSは1.47 kB（gzip0.54 kB）。共有依存込みの転送量ではない。iPhone実機の初期表示時間・Safari描画性能・実ネットワークの応答時間は未計測。

## テスト・未検証

全体検証時点でlint/typecheck/build成功、ユニット・API36ファイル131件成功、E2E24件成功。最終の研究修正は研究3件＋キャッシュ2件、研究E2E1件、lint/typecheck/buildでも再確認。最終ビルドVite1.05秒の測定あり（ビルド全体の時間ではない）。同時作業の未コミットファイルも作業ツリーにあり、全体チェックの数にはそのテストも含まれる。

追加テストはEvidence本文とIDの一致、未定義フィールド・捏造数値・未知参照・断定の拒否、許可3条件、LLMタイムアウト、未来の評価と後日記憶、削除記憶のリモート再取得防止、原本不変、評価のID/方式一致、旧デジャヴ予測の読み取り、保存の冪等性・削除receipt保持、少数標本、データ不足、診断、価格取得の集約、revision/評価/未来観測時刻でのキャッシュ失効、URL導線・根拠リンク・任意履歴保存・390×844幅での横はみ出し防止を確認。

モバイルはChromiumのviewport検証とPNGの目視確認。iPhone Safari実機の検証とは区別する。ウォレットSDKのmetadata取得失敗とLit開発モード警告は既存E2Eに残るがテスト成功。市場データや秘密値の送信・Sui取引は行っていない。

実J-Quants接続、MemWal実検索/実保存、設定先LLMへの実HTTPS接続、Sui取引は未検証。外部障害・許可・フォールバックはモックで確認した。80点以上が実市場で優位という成績検証も未実施。

## 変更一覧・コミット

- packages/core/kabumaru-research-schema.ts
- apps/api/src/kabumaru-evidence.ts / kabumaru-explanation.ts / kabumaru-research.ts / kabumaru-research-cache.ts / kabumaru-llm.ts
- apps/api/src/hunter-journal.ts / hunter-summary-cache.ts / server.ts
- apps/web/src/KabumaruResearch.tsx / KabumaruEvidence.tsx / KabumaruResearch.css / main.tsx / BottomHunter.tsx（研究導線だけ）
- .env.example / scripts/research-summary-benchmark.ts
- tests/kabumaru-research.test.ts / hunter-summary-cache.test.ts / e2e/research.spec.ts
- docs/kabumaru-ai-researcher.md（本文）

指定の8コミット：

1. 4963fd4 feat: add kabumaru research evidence model
2. 7bf2ee3 feat: build deterministic research explanations
3. 2430c74 feat: connect dejavu forecasts and memory evidence
4. a0b8d0c perf: optimize hunter evaluation summaries
5. f02255b feat: add kabumaru research interface
6. 04642f7 feat: add optional llm research provider
7. 4fe2bb3 test: verify research grounding and safety
8. docs: document kabumaru ai researcher

同時作業のハンター取得UI・preflight・プラン補助・リミッター等の差分は保持し、今回のcommitへ含めない。pushは実施していない。

次の候補：許可した設定先LLMとの契約テスト、実データを用いた少数銘柄診断、長期間・多銘柄での集計負荷測定、進行中リクエストの重複抑制、研究キャッシュの世代管理、関連予測20件のページング、iPhone Safari実機での根拠・質問・保存操作の計測。自由なLLM言い換えを加える場合は数値だけでなく意味の一致も別方式で検証する。

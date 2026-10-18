# かぶまる自律研究エージェント（第6弾）

## 実装範囲と開始時の確認

2026-10-18、main / origin/main `478b4caa23f6d646e9ffd271e183555107ade1c7` を起点に、status・branch・fetch・logと第5弾の研究所／時間分割／JSON workerを確認した。既存の実験runner・cohort評価・レポート・研究ノート・MemWal SDKを再利用し、DB、常駐外部ジョブサービス、追加LLMを導入していない。

開始時の未コミット変更4件（kabumaru-explanation.ts、kabumaru-research.ts、KabumaruResearch.tsx、kabumaru-research.test.ts）は別作業として維持した。作業中に現れたREADME、AGENTS/.agents、Suiスキル資料、wallet.tsx、wallet-anchor.test.ts、output/anchor-pushもエージェントのコミット対象に含めない。push前fetchでSui側のorigin/main更新`1508ddd`を検出し、wallet.tsxとwallet-anchor.test.tsはローカル／remoteのGit blob hashが完全一致することを確認した。reset/stash/削除は行っていない。

## 操作と実行フロー

`/research/agent` → 研究目的・テーマでセッション作成 → 保存済み研究ノート／研究所のfold計画／実験方式を指定 → 計画提案 → データ・予算・ツール・失敗処理を確認して承認 → 別の開始操作 → 逐次実行 → 原本と照合した結果・研究記憶・ローカル証跡。

テーマは高スコア失敗、出来高、RSI、デジャヴ、候補対照、相場局面、方式安定性、欠損。保存されていない特徴量は推測しない。計画はdeterministicで、根拠IDを固定する。既存のTraining限定hypothesis generatorによる探索案は、承認済みの実験方式へ自動反映しない。変更して試す場合は新しい計画・承認が必要。

研究所で保存した2〜5個の期間計画と方式を入力できる。fold未指定でもローカル記録の調査は可能だが、評価は`insufficient-data`。UIの目的入力はセッション作成用で、既存計画の書き換えには使わない。

状態はdraft / awaiting-approval / approved / running / paused / completed / failed / cancelled。状態・試行・失敗・再開はsequenceとprevious hash付き追記イベント。計画、承認、結果、研究レポート、ローカル記憶原本、証跡はimmutableファイル。checkpointと要約は派生データ。暗号化復元時にも既存の監査イベントと原本の競合を拒否する。

## 承認・権限・予算

承認はcanonical plan hash、時刻、完全一致のツール・必要権限・予算・失敗方針に結び付く。開始時と各ステップで再検証する。研究モードは既存の認証を維持し、POSTは許可Origin・JSON・same-origin検証も必要。DEMOは既存仕様どおりウォレット認証対象外で、承認actorも`demo-user`として区別する。

権限はReadResearch / ProposeExperiment / RunApprovedExperiment / SaveLocalMemory / RequestExternalSync / RequestSuiAttestation。自律ツールはinspect-notebooks、propose-hypothesis、run-validation、compare-folds、select-final-method、run-final-test、evaluate-research、save-local-memory、local-attestationの閉じたswitch。承認、外部同期、署名、任意HTTP／コード／shellを実行するツールはない。

追加J-Quants取得・外部書込・Sui取引はZodのliteral 0。実験回数、ユニークcohort、累積時間はサーバーで強制し、失敗・再試行・再開でリセットしない。実験は開始前に予約し、同じ実験の再開では二重課金しない。許可を超える次の作業を開始しない。

実行時間は既存のcohort処理境界とステップ前後で確認する協調停止。進行中の同期計算／fsyncを強制終了するハードリアルタイム保証はない。境界までの超過時間も消費として記録し、後続作業を拒否する。長時間処理の細分化は今後の改善対象。未計測入力の所要時間は推測せず、上限と実測を表示する。

## 再開・競合制御

既存Storeのプロセス間lock、research-json-workerのleaseを利用。agent coordinatorと既存lab workerは別のleaseで、子実験は既存labの排他制御を使用する。結果の入力hashを確認して冪等にスキップする。二重開始は先行workerの状態を変更しない。

一時的障害はpausedにして利用者による明示再開を待つ。実際の障害は最大2試行（計画上限は1〜3）で恒久停止。利用者の一時停止は失敗上限に数えず、試行履歴と時間は保存する。キャンセル・中断は子実験へ伝播し、結果commit直前にも状態を確認する。失敗を成功として保存しない。

プロセス異常終了は失効leaseを検出してpausedへ復旧。未精算時間は停止中の時間を含め保守的に累積する。自動再開はせず、UI再訪・API参照後に明示再開する。画面を閉じても動作中サーバーの研究は継続できる。サーバーが停止すれば処理も停止する。

## walk-forwardと結果の意味

`agent-walk-forward-v1` / `positive-median-validation-20-v1`。

- 時系列順で重複しないValidation、共通の封印Test、既存purge/embargo、cohortごとの固定ユニバース・cutoff・revision・評価IDを維持。
- Training内の照合可能なノートのみ採用。単一foldの提案方式を複数foldの未来情報として流用しない。固定手動方式を各foldのValidationで比較できる。
- 全承認fold・全方式のValidation終了後にだけ選択。独立foldが2件以上あり、全foldが既存レポートの標本条件を満たす場合に、現行対比20営業日差の中央値が正の方式を選ぶ。同点はmethod ID順。
- 不十分なfoldは理由を記録し、全体を十分と判定しない。標本不足・改善なしなら最終Testを開封しない。
- 最終Testは選択後の1方式だけ。既存のexposure/observed登録で、参照済み期間の未使用Testへの再ラベル付けを拒否する。Test所有計画も固定。
- fold中央値・最悪／最良・標準偏差、候補／非候補差、欠損率、候補数範囲、同じ日時点・同じ銘柄の方式間対応付き差を表示。連続日／銘柄を独立したt検定標本として扱わない。
- 比較時点の探索ジョブ数を固定して表示。信頼区間、多重比較補正、因果推定は未実装であり、統計的優位性を断定しない。

分類は仮説への記述的評価。Validation不十分／最終評価不足はinsufficient-data、Validation中央値が正でなければnot-supported、全foldと最終Testの方向が正ならsupported、それ以外はmixed。全説明にEvidence ID・実験IDを結び付け、レポート読取時も原本から照合する。失敗・キャンセル時は未完了foldの理由を含む不足レポートを保存できる（承認前キャンセルは研究結果なし）。本番スコアや過去予測原本は変更しない。

人工市場の統合テストでは、正のValidationを経て負の最終Testを得るケースを`mixed`として保持する。これらは実市場での優劣を示す成績ではない。

## MemWalとSui

ローカル記憶には計画・承認参照・実験・結果・不確実性・次のテーマ・Evidence・source revision hashを保存。MemWal向けには小さな研究要約・ID・manifest hashのみを別に保持し、SDKを置き換えない。

初期externalConsentはfalse。同期・recallは自律allowlist外の別の利用者操作。環境の送信許可とJ-Quants権利確認が必要で、DEMOは実送信しない。SDKへの価格原本送信は追加しない。意味的な記憶IDと既存tombstoneを確認し、削除・無効化後は再生成／再送信を抑止。検索はリモート文章を根拠にせず、ローカル原本とID・mode・namespaceを照合する。

導入済みSui SDK 2.35.0、既存dapp-kit/walletとtestnet予測アンカーを確認。研究専用の安全な署名・gas・チェーン確認フローは未実装のため、今回のSui連携はユーザー指示の許容する**ローカルhash生成・検証まで**。SDK、既存署名フローを変更しない。

証跡はsession ID、plan hash、既存実験manifest hash、result hash、methodVersion、日時、検証バージョン、対象network。価格・鍵・個人情報は含まない。local/testnet/mainnetはhash対象に含め、異なるnetworkのhashを拒否する。送信機能・gas見積・digest保存・オンチェーン照合は未実装。`chainVerified=false`と明示し、ローカル一致をオンチェーン証明と表示しない。

## APIと画面

既存Fastify認証のもと、`/api/research/agent`を登録。sessions一覧／作成／詳細、propose、approve、start、control、timeline、report、memory、sync、attestationを実装。追加でfolds作成、Evidenceページ、recall、attestation/verify。session作成と提案はrequestId、承認はplan hash、実行はplan/run IDで冪等制御。

propose例：`{requestId:UUID,proposal:{notebookIds:[],foldPlanIds:[],methodIds:[],budget:{maxExperiments:0,maxCohorts:0,maxRuntimeSeconds:60,maxJQuantsRequests:0,maxExternalWrites:0,maxSuiTransactions:0}}}`。startは`{planId,approvalId}`、controlは`{action:"pause"|"resume"|"cancel"}`。

UIはルート単位の遅延読み込み、URL session/page、ローカルscroll復元、必要時Evidence20件ページング、結果詳細の折りたたみ、稼働中poll、320px、Safe Area、44px操作領域、16px入力。ランキングや価格チャートの大量データは初期取得しない。セッション一覧のファイル列挙・監査鎖全体検証は記録増加時に追加索引の余地がある。

## 変更ファイル

- core：kabumaru-agent-schema / policy / events / canonical / walk-forward / report-schema / attestation。
- API：kabumaru-agent / audit / planner / runner / tools / walk-forward / evaluation / memory / attestation / api、server.ts、research-json-worker.ts。
- Web：KabumaruAgent.tsx/.css、AgentResearchPlan、AgentApprovalPanel、AgentExecutionTimeline、AgentResearchResults、AgentMemoryPanel、AgentSuiAttestation、main.tsx、KabumaruLab.tsx。
- 既存連携・保存：packages/integrations/index.ts、packages/storage/index.ts。
- fixture：fixtures/agent.ts、fixtures/lab.ts（旧引数の既定動作を維持）。
- 検査：tests/kabumaru-agent-*.test.ts、tests/e2e/agent.spec.ts、scripts/benchmark-agent.ts、eslint.config.js。
- 記録：本書、agent-performance.json、agent-mobile-performance.json。

## 性能測定

詳細は[人工データ計測](agent-performance.json)と[モバイル計測](agent-mobile-performance.json)。Windows / Node 24.14.0、外部通信禁止。1回のAPI側計測で改善率を主張しない。

| 項目 | 実測 |
|---|---:|
| 計画生成 | 466ms |
| 開始〜最初のstep予約 | 451.64ms |
| 各Validation fold | 2050 / 1999 / 2559 / 2383 / 2335ms |
| 5fold処理合計 | 11,326ms |
| 全研究（記憶・証跡を含む） | 36,852.58ms |
| 研究ノート生成 | 3,876.74ms |
| agent・lab checkpoint書込 | 132回 |
| run開始前RSS | 168,361,984bytes |
| プロセスRSSピーク（fixture・研究・ノートを含む） | 273,383,424bytes |
| agent分割JS / gzip | 26,489 / 8,691bytes |
| agent CSS / gzip | 1,261 / 537bytes |

人工30銘柄・31cohort・5fold。各foldは独立Validation4時点で標本不足になり、Testは未開封。大規模全市場cohort処理、実市場成績、物理iPhone/Safari、チャート描画は未計測。新画面に価格チャートは追加していない。Chromium320×568の最終5回表示は中央値980.38ms、923.79〜993.02ms。生データをJSONに記録した。API側計測は別のE2Eと並行実行したため、負荷を固定した専用ベンチマークではない。

## 検査と残課題

承認前拒否、計画改変、閉じたツール、ゼロ外部予算、DAG循環、固定入力、累積予算、再開、二重起動、中断／キャンセル、失効lease、再試行上限、fold順序・重複、未使用Test再利用拒否、Evidence整合性、悪い最終成績、4分類、MemWal初期OFF・明示SDKモック・削除後抑止、network照合、暗号化復元、320px操作を追加した。

lintは既存生成物output/.move-cache内の別tsconfigを拾う問題を検出し、生成物を除外・config rootを固定して修正した。初回E2Eの最後のfocus操作をtextboxの明示clickに修正。外部サービスの実検証ではなく、モック・fixtureの成功として扱う。

| 最終検査 | 結果 |
|---|---|
| pnpm lint | 成功 |
| pnpm typecheck | 成功 |
| pnpm test | 64ファイル・187件成功（138.79秒） |
| pnpm test:e2e | 28件成功、failedTestsなし |
| pnpm build | 型検査・Viteビルド成功 |
| git diff --check | 成功 |

全体検査には別作業のローカル差分と、remote追加のSuiアンカーテストも含まれる。J-Quantsの実取得、MemWal実送信、Sui RPC・署名・トランザクションは行っていない。ブラウザ試験は外向きproxyを遮断しており、既存ウォレットSDKのメタデータ取得は遮断ログが出る。mainへpushするGit通信とは区別する。

RTKでコマンド出力を圧縮し、必要時はrecallで原出力を調査。最終確認時の`rtk gain`はグローバル集計156コマンド・約30.0Kトークン（73.3%）削減。今回だけの専用集計ではない。

第7弾候補：実市場データの正当なローカル蓄積後の独立期間検証、cohort処理の細分化と時間停止精度、セッション索引と長期監査アーカイブ、探索履歴／多重比較の統計補正、物理iPhone性能、安全な研究専用Suiコントラクト・署名／gas／イベント照合の別承認実装。

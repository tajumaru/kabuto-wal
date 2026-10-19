# 底打ち予測の精度検証1.0

## 調査・設計（2026-10-19）

起点main `6a3cf68`、fetch・未コミット変更なしを確認。実データ/.env/鍵は読まない。

既存のbottom-scout原本には銘柄・時点・スコア・指標・類似事例・revision IDs・入力hash・調整価格チャートがある。bottom-scout-journalは5/10/20営業日評価とスコア帯集計、MemWal記憶は明示保存・削除抑止を実装済み。cohortPathOutcomeはcutoff内の最新revisionを決定的に選び、系列混在・同順位矛盾を拒否し、最大上昇・終値ドローダウン・再下落を計算する。これらを再利用する。旧形式研究計画の実行禁止、ハンター/デジャヴ/エージェントの原本は変更しない。

新規分析生成時のみ、既存原本を参照する予測manifestを追加固定する。順位・当時の調整終値・カレンダー・比較銘柄を保存し、根拠の実体はhash検証済み分析原本を参照する。既存記録に現在の証拠を後付けしない。既存キャッシュからの応答で古いmanifestを新規生成しない。

的中は「期間末の調整終値リターン>0」。横ばいも不的中。評価待ち/評価不能は分母に入れず別件数を表示する。最大上昇・最大ドローダウン・再下落は調整終値ベース。既存の基準価格比の期間内安値下落も区別して保持する。分割等は評価時点の同一調整系列の基準価格でリベースし、当初の基準価格は書き換えない。

保存済みカレンダーの20営業日分を固定し、後日変更された場合は評価不能とする。未来のカレンダーが不足している場合も、現在データで当初の証拠を補完しない。実モードではJ-Quantsの保存済み市場カレンダーを使用し、DEMOは人工カレンダーであることを明示する。

一覧はページ単位（最大5分析原本）で評価し、集計範囲を明示する。実運用/過去研究、DEMO/実データを混在させない。同一銘柄・基準日の重複はページ内で最初の予測だけを集計し、期間重複や相関から独立標本とは扱わない。スコア帯・TOP3/5/10は確定した実件数を表示する。

比較銘柄は既存SCOUT_BENCHMARK_CODEの保存済みデータだけを使う。TOPIXと確認できない銘柄をTOPIXとは呼ばない。比較不能はnull。銘柄平均・指標平均・超過率は同じ評価可能ペアで計算する。比較銘柄が混在すれば集計比較を無効にする。追加取得・有料API・外部送信を行わない。

かぶまるの説明は保存条件と確定実績だけから生成する。成功例・失敗条件には予測/評価IDを結び、因果や将来の改善を断定しない。MemWalは既存の別途明示操作のみ。新規DB/LLM/常駐サービスは追加しない。

## 実装と使い方

かぶまるに底打ち候補を質問した後、「予測の答え合わせを見る」を選ぶ。かぶまる研究画面のリンク、または `/research/accuracy` から一覧を開ける。記録区分・5/10/20営業日後・成功/失敗/待ち/不能を切り替える。期間・結果の表示変更ではAPIを再取得しない。価格を更新した後は「保存済みデータで再評価」を明示操作する。追加取得やMemWal同期はしない。

対象はこの機能追加後に新規生成したbottom-scout-v1の分析上位10候補。質問への表示件数が5でも、分析に6候補あれば6件を固定する。候補なしなら0件。ハンターの本番bottom-rule-v1や既存コホートの非候補を含む評価範囲は変更しない。過去原本・旧形式研究計画を再実行して予測を作り足さない。キャッシュに存在する古い分析には、新しい証拠を後付けしない。

manifest保存先は `research/scout/forecasts/{demo|research}/{live|research}/{作成時刻}/{reportId}/original.json`。analysis原本の `reportId/inputHash` と行の `evidenceHash` を参照する。順位・当時の調整終値・観測時刻/revision・指標/類似事例は、manifestと既存analysis原本の組で固定される。後日の評価価格と当時の価格を別表示する。

既存の当日基準のrecordingMode=liveと、過去・遅延データのrecordingMode=researchを分離する。リアルタイム価格や、実際に約定した売買成績ではない。DEMO/実データも保存先・API・表示を分ける。

`GET /api/research/scout/accuracy` は既存認証の下で動作する。queryは `recordingMode=live|research`、`page`、`pageSize`（1〜5）、任意の `reportId`。最大5分析×10候補を読み、価格系列はリクエスト内で銘柄ごとに再利用する。全銘柄の履歴を初期表示へ渡さない。古い日付もページ移動で閲覧できるが、集計値はページ単位であり、全履歴累積とは表示しない。

## 評価と整合性

- 5/10/20営業日は保存済み市場カレンダーのopenフラグで数え、土日・休日を推測しない。固定範囲のカレンダー改訂や当初の期限不足は評価不能とする。
- 終値騰落率は `期限後の調整終値 / 同一評価系列の基準日調整終値 - 1`。後日分割・改訂によるリベースに使った価格/revisionも保存する。
- 最大上昇は基準日終値からの最大上昇。最大ドローダウンは、それまでの最高終値からの最大下落。再下落は基準日終値を一度上回った後、再び基準日終値を下回った場合。既存の「基準日終値に対する期間中安値の下落」と混同しない。
- 同日のrevisionはcutoff内で最新availableAtを採用し、同順位矛盾・系列混在・欠損は拒否。新しいスカウト入力と実績評価はstrict選択を使用する。デジャヴの既存呼出しのdefault挙動・予測原本は変えない。
- 評価原本は既存 `research/scout/evaluations` に追記。`scout-outcome-v2` と対象範囲 `all-analyzed` / `forecast-top10` を明示する。通常研究は非候補を含む従来範囲、答え合わせは固定上位候補だけ。同一結果の再閲覧は同じ評価IDを再利用し、価格revisionや結果が変われば別原本へ追記する。評価日時だけの違いでファイルを増やさない。
- `forecastId/reportId/evaluationId` と入力hash・revisionを振り返りに紐付ける。破損したIDや根拠の不一致を成功として読み飛ばさない。

比較対象は予測作成時の既存 `SCOUT_BENCHMARK_CODE` を固定する。追加の必須環境変数はない。終値だけの比較データでも同一系列・期日・revisionが揃えば使える。評価可能ペアで比較銘柄が混在すれば集計比較不能。未取得・未設定も比較不能で、TOPIXを架空に補完しない。

## テストと制約

人工相場で、順位/当初価格/hashの固定、未来価格改訂後の原本不変、休日を除く期限、入力逆順、未来revision除外、同順位矛盾、系列混在、欠損、分割リベース、再下落を確認した。評価待ち・評価不能を分母から除外し、TOP3/5/10・スコア帯・ペア比較・比較不能・重複除外・根拠付き振り返り・評価ID破損拒否をテストした。20銘柄を分析しても、答え合わせが上位10系列だけを読むことも確認した。

ブラウザではチャットからの導線、成功/失敗/不能の区別、フィルターでの不要な再取得なし、320px幅を確認し、スクリーンショットも目視確認した。既存のMemWal削除抑止、旧形式研究計画の実行禁止、底打ちスカウト/デジャヴ/AI研究員・エージェントの回帰テストを実行する。実外部サービスへは接続しない。

実行結果：`pnpm lint`・`pnpm typecheck`・`pnpm build`成功、`pnpm test`は72ファイル・210件成功（221.00秒）、`pnpm test:e2e`成功。最終の入力矛盾ガード追加後はscout/dejavu関連8ファイル・27件も成功。画面操作は人工データのChromiumで確認し、実機Safariの検証とは区別する。

回帰検査で確認した、固定上位候補だけの有限読込・新規スカウト入力の同順位矛盾拒否・指標表示の明確化は、最終のテスト/記録コミットに含める。採点方式や既存原本は変更しない。

これは実市場で精度を実証した結果ではない。実J-Quants/TOPIX・MemWal・Sui接続、実機iPhone、取引コスト/約定/配当/上場廃止バイアス、信頼区間や校正は未検証または未実装。条件の共通性は候補内の頻度に限定し、非候補との因果比較や自動重み変更はしない。長期・全履歴横断集計はページ単位の現版とは別の検証が必要。

変更ファイル：

```text
apps/api/src/bottom-scout-accuracy.ts
apps/api/src/bottom-scout-forecast.ts
apps/api/src/bottom-scout-journal.ts
apps/api/src/bottom-scout.ts
apps/api/src/dejavu.ts
apps/api/src/hunter-cohort-evaluation.ts
apps/api/src/server.ts
apps/web/src/KabumaruResearch.tsx
apps/web/src/ScoutAccuracy.css
apps/web/src/ScoutAccuracy.tsx
apps/web/src/ScoutAnswer.tsx
apps/web/src/main.tsx
packages/core/bottom-scout-schema.ts
packages/core/scout-accuracy.ts
packages/core/scout-forecast-schema.ts
fixtures/bottom-scout.ts
tests/scout-forecast-accuracy.test.ts
tests/e2e/scout-accuracy.spec.ts
tests/e2e/server.ts
docs/bottom-forecast-accuracy.md
```

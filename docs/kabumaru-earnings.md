# かぶまる決算分析1.0 — 設計・運用

調査日：2026-10-20（JST）。調査開始時のローカルHEADとGitHub `main` は `246972329590767e49ca6631361d6757e8edab33`（`git ls-remote origin refs/heads/main`で確認）。開始時の未追跡 `tests/scout-accuracy-v4.test.ts` および実装中に現れた精度改善・ストレージ変更は今回の編集対象外。関連既存テストは3ファイル11件成功。

## 取得仕様

利用者の「Lightの決算・予定を取得する」操作で、既存本人セッション認証・Origin検査を通る `POST /api/research/earnings/:code/acquire` を呼ぶ。`confirmFetch:true` が必須。保存済み銘柄一覧にある5桁コードのみ。`APP_MODE=live` 相当の実モードかつ `JQUANTS_PLAN=Light` の場合だけ、既存 `JQUANTS_API_KEY` を使用する。DEMOはボタン・APIからも外部通信ゼロ。新しい認証設定・契約・ニュースAPI・TDnetアドオンは不要。

- [財務情報API](https://jpx-jquants.com/ja/spec/fin-summary)：`GET /v2/fins/summary`。`code` または `date`、両方も可。
- [予定日API](https://jpx-jquants.com/ja/spec/fin-earnings-date)：`GET /v2/fins/earnings-date`。`code`・`date`・`scheduled_date` の厳密に1つ。
- [プラン一覧](https://jpx-jquants.com/ja/spec/data-spec)：両APIはLight標準範囲（5年）。Free/Standard/Premiumへ自動切替しない。
- ページングは `pagination_key` のみ。Premium専用 `cursor` を要求しない。空継続ページ・循環キー・上限超過・対象外銘柄/日付・不正レスポンスを拒否する。全ページ成功前に成功原本を公開しない。
- [レート仕様](https://jpx-jquants.com/ja/spec/rate-limits)：Lightは60回/分、summaryも専用60回/分。既存の共有Limiter・日次予算・Retry-After制御を両方に適用し、合計でも60回/分以下に抑える。既定48回/分。これは専用枠を別に使い切るより保守的。1操作は最大20 HTTP試行、60秒経過後は新規試行を止める（実行中のHTTPとgate待機は別）。429時は少なくとも60秒後へ共有gateを延期し、その操作では自動再送しない。別プロセス・別保存先・別APIキーからの同一アカウント利用も利用者側で合算管理が必要。

## 原本と時点整合性

既存Storeの `market/earnings/{code}/{summary|earnings-date}/evidence/{revision}/original.json` に取得単位の原本を追記する。全レスポンス行を文字列のまま保持し、Zodで検証。銘柄・期間・開示日/時刻・開示番号・各利益・予想・配当は原本内に保存される。欠損文字列を0に変換しない。`fetchedAt` は全ページ取得・検証完了後のUTC日時、開示日はJSTの原フィールド。`source=jquants-v2`、`plan=Light`、`rawHash` はJSON配列をJSON.stringifyしたSHA-256（HTTP転送bytesのhashではない）、`revision` は取得日時と原本hashを含む証拠本体のSHA-256。

同一開示番号でも提供側の値が後から変われば新しいrevisionとして保存する。訂正開示の新番号も旧番号と併存。APIは訂正フラグを提供しないため、訂正という断定はしない。取込試行も成功/失敗を独立した不変レコードに保存する。既存バックアップのmarket範囲に含まれ、original.jsonの競合保護が適用される。

読取はhash・銘柄・endpoint・保存パスを再検証する。取得日時がcutoff以下の原本のみ使用し、さらにsummaryはJST開示日時もcutoff以下とする。予定日は公表時刻がないためPubDateを時刻の証明に使わず、cutoff以前の実取得記録と、公表日がcutoffのJST日付以前であることを両方確認する。J-Quantsが過去に利用可能となった時刻は取得できないため、過去開示を今日取得して過去の予測根拠へ遡及適用しない。ローカルhashはオンチェーン証明ではない。

## 分析と表示

[書類種別](https://jpx-jquants.com/ja/spec/fin-summary/typeofdocument)から連結/非連結・JP/IFRS/US/JMISを確定できる実績だけを前年同期比較する。期間開始/終了・年度開始/終了が前年と対応し、期間長も整合するものに限定。会計基準/連結範囲変更・遡及修正の明示があれば比較しない。前年が0または赤字の場合は成長率を表示せず、実額と赤字・減益の注意を表示。IFRSの経常利益空欄も欠損のまま。

業績/配当予想は当年度Fと翌年度NxFを対象期間で照合する。比較可能な同一会計基準・連結区分の記載値だけを比較する。基準を持たない `EarnForecastRevision` / `DividendForecastRevision` 単独文書は基準を推測せず、記載値と比較未確認を表示する。未記載/レンジ予想を0・変更なし・撤回と解釈しない。配当の株式分割/併合調整は未確認と明記。

予定日は同じ決算区分の最新PubDateを先に選び、未定（SchDate空）や変更後に旧予定日を再利用しない。有効な将来日程の最短日と7暦日以内の注意を表示。取得成功・対象データなし・未取得・失敗を分け、取得失敗時に以前の原本があればその取得時点も表示する。保存原本破損は当該材料を失敗扱いにし、スカウト全体を止めない。

説明は構造化済み値から決定的に生成し、LLMへ原本や未確認ニュースを渡す経路を追加しない。ニュース状態は常に独立した「未確認」。スカウトの予測/探索原本・キャッシュ識別子・スコア・重みは変更せず、回答にcutoff付き材料情報を付加する。取得ボタン後は現在時点の確認と明記し、過去の予測根拠と区別する。チャット・自律エージェントに追加取得権限は与えない。

## 検証方法と制約

`tests/earnings.test.ts` は一時StoreとモックHTTPを使用する。Light許可・不正パラメータ・Premium cursor未使用・ページング・認証/429・訂正履歴・IFRS/日本基準/非連結・欠損・期間不一致・予想/配当・予定未定/未来公表・取得失敗・DEMO外部通信禁止・予測原本/スコアの不変性を検証。`tests/e2e/earnings.spec.ts` はDEMOで材料チェックと取得操作を検証する。

実APIは資格情報・実利用者データを読まない作業方針に従い未検証。モック成功を実API成功とみなさない。最新API仕様との契約適合は公開文書で確認し、実応答の検証は利用者がLight設定済みアプリ内から明示的に取得して行う。

## 調査・検証記録

- 調査後、同じcheckoutに別作業の `8cf044e7d943f2735453282f8617cf513e202d07`（既存精度テストのベースライン）が加わった。本機能の6コミットはその上に作成した。精度改善・ストレージ・ベンチマーク等の並行変更は本機能のコミットに含めていない。
- 元の作業ツリー：`pnpm lint` 成功。初回 `pnpm test` は79ファイル中77成功、254件中252成功、既存の `hunter-experiment-holdout` / `kabumaru-agent-walk-forward` の2件がタイムアウト。該当2件と当時の決算16件を `--maxWorkers=1` で再実行し、3ファイル18件成功（250.80秒）。
- 元の作業ツリー：並行中の `scout-accuracy-io.ts`、その後 `scout-accuracy-v4.test.ts` の型エラーで `pnpm typecheck` / `pnpm build` が停止。後者は開始時からの保護対象であり変更していない。前者に一時的に加えた型注釈は検証後に元に戻し、並行変更そのものを保持した。
- E2E：`pnpm test:e2e` 全36件成功（2.1分）。決算UIを調整後、`tests/e2e/earnings.spec.ts` も再実行して1件成功。既存wallet SDKのmetadata取得はfixture用proxyで遮断され、該当警告はテスト失敗ではない。
- コミット済みソースを `git archive` した隔離コピーで `pnpm typecheck`、`pnpm lint`、`KABUTO_VERIFY_NO_ENV=true` を指定した `pnpm build` が成功。依存は既存node_modulesを参照し、追加インストールなし。Viteのenvファイル読取を無効にする検証オプションを追加した。通常動作のenv設定は変更しない。
- 最終の決算回帰テスト：21件成功。公式の翌年度純利益キー `NxFNp` の大小文字と、翌年度予想から翌年の当年度予想への期間照合も確認。経常利益・同予想も欠損を保ったまま説明する。
- 実API検証：未実施。すべてfixture/モック、一時ディレクトリ、公開仕様による検証。認証情報・利用者のdataを読取/表示/送信せず、外部書込・Sui取引・MemWal同期は行っていない。
- 隔離ソースの全ユニットテスト：`pnpm run test --maxWorkers=1` は80ファイル中79成功、271件中270成功・1失敗（466.98秒、決算19件時点）。残る1件は `tests/scout-accuracy-v4.test.ts:14` のJSON再解析抑止期待（0回に対して2回）。決算変更前の親コミット `8cf044e` を別途隔離し、同じテストを単独実行して同じ失敗を再現した。既存キャッシュ性能の未対応であり、本機能の修正には含めない。初回の研究2件のタイムアウトはこの1 worker全体実行では再発しなかった。
- 全体実行後の最終コード（経常利益・翌年度純利益・公表当日cutoffの追加を含む）も隔離して、型・lint・env読取なしbuild・決算21件の成功を再確認。予測原本（research/scout/forecasts）と探索原本の両方が取得後も不変であるassertも成功。E2Eは前記36件＋決算UI最終再実行1件成功。
- 全テストがgreenという報告はしない。現在の未コミット並行変更を含む型エラー、親コミットから再現する1件の失敗、決算モック成功、実API未検証をそれぞれ区別する。

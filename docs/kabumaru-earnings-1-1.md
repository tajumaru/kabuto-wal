# かぶまる決算分析1.1 — 取得診断と履歴整合性

調査日：2026-10-20 JST。起点の最新main：`97e8b7e75301209a83b940a79ba0e1db2b9a5bb5`。開始時は未コミット差分なし、origin/mainとHEADの差分なし。専用ブランチ `codex/kabumaru-earnings-1-1` を作成。既存の[1.0設計](kabumaru-earnings.md)を再利用し、予測精度4.0のソース、スコア、重み、評価原本、MemWal、Suiを変更しない。

## 公開仕様の確認

- [財務情報](https://jpx-jquants.com/ja/spec/fin-summary)：`GET /v2/fins/summary`、`x-api-key`、codeまたはdate（併用可）。4/5文字コード、日付2形式、文字列の数値、欠損の空文字、`pagination_key`に既存実装が対応。Premium専用cursorは使わない。訂正開示は別DiscNo、提供側の欠損補正による上書きもあり得るため、ローカル取得revisionを保持する。
- [決算予定日](https://jpx-jquants.com/ja/spec/fin-earnings-date)：code/date/scheduled_dateのうち1つ。PubDate・SchDate・FQName・FYE・Code・CoName・CoNameEnを検証。SchDateの空文字は未定、FYEの0299も有効。予定は公表履歴を含むためPubDateの新旧を比較する。
- [提供範囲](https://jpx-jquants.com/ja/spec/data-spec)：Lightの標準範囲を利用し、TDnetアドオンや追加有料APIは不要。アプリは引き続きLight以外を拒否する。実契約の権限・現在利用可能な期間は実接続するまで未確認。
- [レート制限](https://jpx-jquants.com/ja/spec/rate-limits)：Light 60回/分、summary専用も60回/分。既存の共有Limiterで両方の合計を保守的に制限。429は即再送せず、共有待機を設定して再操作を案内。基本的にヘッダーなしの仕様だが、返された場合のRetry-After対応も維持する。別キーを含む同一アカウント全体の管理は別途必要。

この照合のための公開文書閲覧と、認証付き実API接続は別である。今回、認証情報・設定ファイル・利用者dataは読まず、実APIは呼んでいない。

## 発見した問題と修正

1. summaryのMap上書きが入力順を優先していた。DiscNoごとにcutoff以前の取得日時が最も新しいrevisionを使う。同じ取得日時で内容が矛盾すれば拒否。同じ開示日時の異なる開示番号は数値順（桁数・文字列）で順序を固定する。内容が同一の同順位revisionだけはrevision辞書順で参照を固定する。
2. 予定履歴を過去の全取得から合成すると、最新取得が空でも古い予定が復活した。codeによる全ページ取得の最新snapshotだけを利用し、その中で決算区分ごとの最新PubDateを選ぶ。未定・空snapshotは旧日程に戻らない。同順位snapshotや同じ区分・公表日の矛盾を拒否する。年度末変更の古いFYEで旧予定を復活させないため、最新予定の単位はFQNameとする。
3. 同一revisionの保存先が存在するだけで成功扱いしていた。既存内容の一致と保存後hashを確認し、成功記録が指す原本と取得日時も照合する。壊れた原本は上書きしない。同時刻の失敗記録を成功記録で隠さない。
4. fetchedAt/cutoffの文字列比較はミリ秒表記の有無で順序がずれた。Date.parseで実時刻を比較。開示日時はJST、公表日には時刻がないため実取得cutoffも必須。過去に未取得の情報を遡及利用しない。
5. 401/403を同じ表示にしていた。認証・権限・レート/予算・通信・応答検証・保存を安全な分類で返す。APIやファイル例外の本文は返さない。保存失敗の記録自体が書けない場合も安全な失敗結果を返す。
6. 画面では保存・検証成功が不明だった。取得結果に各endpointのfetched/saved/hashVerified・件数・日時・revisionを追加。既存status/results/reasonを維持し、ZodでAPI境界を検証する。空配列は対象データなし、失敗は成功にしない。
7. 銘柄変更時に古い取得結果が出る可能性を排除。銘柄・表示基準日時ごとに表示を分離し、unmount後の回答反映を止める。同じボタンの連打も抑制する。

`market/earnings/.../original.json`の形式と配置は維持し、移行・削除・過去原本のhash後付けは行わない。取得・保存・再読込照合の既存経路を使用し、決算確認とニュース確認を混同しない。既存の前年同期の売上・利益、赤字転落、予想・配当比較、決算7日以内の注意を維持し、根拠不足時は比較未確認とする。

最新summary取得が空の場合も「データなし」と明示する。過去の開示原本は保持し、以前の取得に基づくコメントであることを表示する。失敗後の表示も古い成功原本の情報と区別する。

## 利用者が実データを確認する手順

1. 通常のアプリを起動し、本人確認が必要な環境では設定画面で確認する。既存のサーバー側 `JQUANTS_PLAN=Light` と `JQUANTS_API_KEY` を使用する。新しい変数・キー入力画面は追加しない。
2. メニュー「決算チェック」、または `/research/earnings` を開く。銘柄一覧・保存済み決算のGETはローカルJSON読取のみ。
3. 保存済み銘柄一覧から1銘柄を選び、「決算情報を取得」を押す。この明示操作だけが既存の認証・Origin検査を受けるPOST（confirmFetch:true）を呼ぶ。ページ表示・銘柄切替・チャット質問だけでは実APIを呼ばない。DEMOは取得操作でも外部通信しない。
4. 「今回の取得結果」で決算サマリーと発表予定日を別々に確認。API取得完了・原本保存完了・hash照合成功の3段階を確認する。予定日だけ対象データなしでも、通信失敗とは区別される。
5. 最新開示日・次回予定日・取得日時と「かぶまるの決算メモ」を確認する。詳細にローカル原本hashとrevisionを表示。ニュースは独立して未確認。
6. 認証失敗なら設定、403ならLight権限、待機なら時間をおいて再操作。保存エラーの場合は成功扱いせず、ローカル保存先の状態を確認する。繰り返しの自動取得は行わない。

1銘柄の2種類のデータを取得する操作であり、必ずHTTP 2回とは限らない。ページング・既存再試行があり、既存の20試行・60秒の新規試行制限と共有予算を維持する。実行中HTTPのtimeoutやgate待機は別なので、全処理が60秒以内という保証ではない。

## 検証

追加テストは一時ディレクトリとモックのみ。修正前の追加9件は全件失敗し、順序依存、旧予定復活、原本破損の見逃し、診断分類不足を再現した。最初の修正後は既存を含む30件、追加拡充後35件成功。最終コードはミリ秒cutoffの追加分を含む決算36件が成功。

決算画面E2Eは4件成功：既存DEMO経路、銘柄選択/明示操作、モック診断表示、切替中の古い回答防止。320px幅で横溢れなし、既存画像・共通ヘッダーを使用。テストの疑似成功を実API成功とはみなさない。

実APIでの認証・実Light権限・実応答・実データの保存から画面表示：**未検証**。上記の画面操作で利用者が実行できる状態まで実装した。実APIを実行したとの記録や架空の実データ結果は作らない。

| チェック | 結果 |
|---|---|
| pnpm lint | 成功 |
| pnpm typecheck | 成功 |
| pnpm run test --maxWorkers=1 | 81ファイル・295件成功、433.73秒 |
| pnpm test:e2e | 39件成功、2.1分 |
| pnpm build | 成功、Vite 1.09秒 |

pnpmの組み込みtestコマンド経由のオプション解釈を避け、指定と同じVitest全件を `pnpm run test --maxWorkers=1` で実行した。時間制限の変更やテストの除外はなし。buildは既存の `KABUTO_VERIFY_NO_ENV=true` でenvファイル読取を無効化。E2Eは5519/3019の専用fixtureサーバー、ブラウザの外部通信は遮断。wallet SDK metadataの警告は遮断によるもので、実Sui接続を検証した意味ではない。最終チェックの失敗・timeout・未実行はなし。修正前の9件失敗と実API未検証は上記の通り別に記録する。

## コミット

- `f2b9776` fix: verify earnings revisions and acquisition diagnostics
- `ae872b4` feat: add explicit single-stock earnings check screen
- `6b75007` fix: enforce earnings cutoffs and cover acquisition recovery
- 本文書：docs: document earnings 1.1 verification and usage

最終fetchでもorigin/mainは起点97e8b7eのまま。無関係な未コミット変更なし。今回の依頼は機能単位のコミットまでとし、専用ブランチ上に保存する。

## 変更ファイル

- `apps/api/src/earnings.ts`
- `packages/core/earnings-analysis.ts`
- `packages/core/earnings-schema.ts`
- `packages/integrations/earnings-evidence.ts`
- `apps/web/src/EarningsCheck.tsx`
- `apps/web/src/CompanyMaterials.tsx`
- `apps/web/src/EarningsResearch.tsx`
- `apps/web/src/EarningsResearch.css`
- `apps/web/src/main.tsx`（遅延route・メニューのみ）
- `tests/earnings-integrity.test.ts`
- `tests/e2e/earnings.spec.ts`
- `docs/kabumaru-earnings.md` / 本文書

`packages/integrations/jquants.ts`は既存仕様が公式と整合しているため重複修正していない。精度4.0関連ファイル・storage・SDK・依存は変更しない。

## 残る制約

- 公式APIは提供側の全訂正前履歴や利用可能になった正確な時刻を保証しない。保存前のrevisionは復元できない。
- 同順位の矛盾はhash順で内容を勝手に選ばず、確認失敗になる。再取得で修復されない既存破損は別途診断が必要。原本を自動修復・削除しない。
- 予定日の全履歴snapshotに存在しない旧情報は次回日程へ流用しない。最新が失敗した場合は、古い成功原本として明示して表示する。
- 方式・予測・過去評価を変更せず、決算メモを売買判断や予測確率にしない。LLM・MemWal送信・Sui署名は追加しない。

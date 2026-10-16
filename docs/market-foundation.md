# 段階2：取得と調整系列の基盤

## 実装内容

`JQuants`は既存importを維持したまま専用モジュールへ分離。既存の個別銘柄日足、マスター、カレンダーと新しい日付取得が同じ待機処理を使います。APIキーは送信ヘッダーだけに使い、予算保存先にはSHA-256識別子だけを使用します。

Free/Light/Standard/Premiumの上限5/60/120/500 req/minに対し、初期設定は80%の4/48/96/400 req/minです。`JQUANTS_REQUESTS_PER_MINUTE`で契約上限以下に設定できます。同一キー・同一DATA_DIRのAPIとCLIは`market/request-budgets`の短いファイルロックで送信枠とRetry-Afterを共有します。別端末や異なるDATA_DIRの同じキーは共有できません。

すべてのページ・再試行が制限を通り、429のRetry-Afterは秒とHTTP-dateを解釈します。待機中は予算ロックを解放。5分を超える待機は再開時刻を含むエラーにして処理を中断します。401/403は再試行せず、5xx/通信失敗は最大4試行。レスポンス本文やAPIキーはエラー表示へ含めません。

FreeはJST当日から84日前を上限として、その2年前まで。Light/Standard/Premiumは5/10/20年。うるう年の境界を処理し、未知プランは拒否します。旧ジョブもこの期間計算を使用し、Freeでは将来カレンダーを要求しません。カレンダーの1/2を現物株営業日、3（OSE祝日取引）を株式休場日として扱います。

## 日付取得と再開

実行前に通常のアプリで本人用live保存先を初期化してください。既存demoのDATA_DIRを使わないでください。

```powershell
pnpm job:market -- --from 2026-10-01 --to 2026-10-16 --code 72030
```

例は遅延のないプラン向けです。Freeでは12週遅延の契約範囲内の日付へ置き換えてください。`.env`のAPP_MODE=live、DATA_DIR、JQUANTS_API_KEY、JQUANTS_PLANを利用します。起動時や画面閲覧時に全市場取得を自動実行することはありません。

日ごとに日付指定の銘柄マスターを原本保存し、日足をページ単位で取得します。部分失敗時は次のpagination_keyと保存済みページをcheckpointへ残します。同じコマンドを再実行すると完了済み日・ページを飛ばして再開します。空ページ、キー循環、銘柄重複、日付不一致、破損、契約外期間、非営業日を検査します。15分のleaseで同一日・revisionの同時処理を防ぎ、各ページで更新します。ネットワーク待ち中は全体writer lockを保持しません。

完了後に訂正を取り直す場合は別revisionを明示します。

```powershell
pnpm job:market -- --from 2026-10-01 --to 2026-10-16 --code 72030 --revision correction-20261017
```

取得ページ・マスターsnapshotは不変。最新ポインタとcheckpointは更新可能です。checkpointの完了はAPIページの取得完了を示し、全普通株の網羅率やランキングの完成を示しません。対象商品・全銘柄coverageの判定は段階3です。既存の日次ジョブとは別コマンドで、既存ジョブの全体ロック構造は維持しています。段階3のworker統合時にジョブ全体の排他を整理します。

## 調整系列

原本のO/H/L/C/Vo/Va/AdjFactor/ExRTとアプリ取得時刻を保持します。指定cutoffまでに取得した版だけを選び、asOfより後の企業行動を除外して計算します。

- 価格：その日より後、asOfまでのAdjFactorの積を掛けます。分割日の係数を分割日自身の価格へ重ねません。
- 出来高：累積係数で割ります。ただしExRT=3（ライツ・イシュー）の係数は出来高へ適用しません。
- 中間の係数は丸めず、最終価格・出来高だけ小数第1位へ丸めます。配当込みリターンではありません。
- factorが1以外で企業行動区分が不明なら計算を停止。欠損日を補完したり、未来の値で埋めたりしません。
- 系列IDは調整version、銘柄、asOf、入力revision/取得時刻manifestから生成し、全足を共通の調整基準にします。内容hashも検査します。

`--code`を指定した場合、指定期間全体に必要な原本があることを確認して系列を保存します。底打ち画面には80連続営業日以上が必要です。最初の取得で短い期間だけを指定した場合は、画面側で履歴不足になります。

個別の底打ち解析は保存済み整合系列があれば読取り専用で使用し、なければ既存取得系列へフォールバックします。既存の株価原本やseriesIdは書き換えません。実売買代金20日平均が揃うと1億円基準の流動性を表示できます。既存デジャヴ相場の数値スコアと保存方式は変更していません。

現段階のデジャヴ画面は旧取得経路を使用します。新原本だけを取得した銘柄について、デジャヴが自動的に利用できると表示しないでください。両経路の共通アダプタ化と候補詳細の取得は段階3以降で行います。

## 保存と復元

```text
market/request-budgets/<key-hash>/state.json
market/master-snapshots/<date>/<hash>.json
market/ingestion/<date>/<revision>/checkpoint.json
market/ingestion/<date>/<revision>/pages/<hash>.json
market/bottom-raw/<date>.json
market/bottom-series/<code>/<asOf>/<seriesId>.json
```

既存バックアップのmarket配下に収め、暗号化export/importに含めています。復元後も同じ系列IDを読み出せることをテストしました。取得時刻はアプリが実際に取得した時刻であり、提供元の公表時刻の保証ではありません。今日取得した過去データを、当時知っていたとして扱いません。

## 検証と範囲

分割・併合・ライツ、未来factor除外、cutoff、連続日不足、共有予算、Retry-After、認証エラー、ページ中断後の再開、完了後の冪等性、暗号化バックアップ復元をモック/fixtureで検証しています。実J-Quantsの呼出し、契約キーの読取り、MemWalへの送信は行っていません。

段階3の全銘柄スキャン・coverage UI・直近5日訂正の定期取得・全体worker、段階4の底打ち予測記録と評価はまだ追加していません。DBや追加サービスは導入していません。

公式仕様（2026-10-17確認）：[取得期間](https://jpx-jquants.com/en/spec/data-spec)、[レート制限](https://jpx-jquants.com/en/spec/rate-limits)、[調整計算](https://jpx-jquants.com/en/spec/eq-bars-daily/adj)、[日足](https://jpx-jquants.com/en/spec/eq-bars-daily)。

## 開発サーバーのポート競合

`pnpm dev`は3001番の使用中を検出すると次の空きAPIポートを探します。Web側も5173番から空きポートを探し、正しいAPIへproxyを設定します。コンソールに出た実際のLocal URLを使ってください。PORTとWEB_PORTで開始ポートを指定できます。既存プロセスを無断で終了する処理は追加していません。

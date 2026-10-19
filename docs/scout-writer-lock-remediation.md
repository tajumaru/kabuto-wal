# 累積精度APIのwriter lock二段階化

## 対象と保護範囲

開始時のmain / origin/mainは `5da5f65`、未コミット差分なし。以前の計測と原因は [調査記録](scout-writer-lock-investigation.md) に保存している。

製品変更は `apps/api/src/scout-accuracy-cache.ts` のみ。`bottom-scout-accuracy.ts` のキャッシュキー・累積集計・ページ選択、`bottom-scout-journal.ts` の評価ID・予測参照検証・既存評価再利用、`Store.lock` のプロセス間排他と120秒待機上限を調査し、その仕様を維持した。

予測スコア・重み・的中定義・営業日・revision選択・保存スキーマ・予測原本は変更していない。実データ、設定、秘密情報を読まず、J-Quants / MemWal / Suiに接続せず、人工fixtureとローカルのテストサーバーだけで検証した。

## 原因と変更

従来は `s.store.lock(resolve)` が全履歴の読み取り、計算、キャッシュ確認まで囲んでいた。保存0件でもroot共通writer lockを取得し、別Serviceの協調的writerが120秒でタイムアウトした。

### Phase A: 保存せず計算する

- キャッシュ検証・読み取り・原本hash検証・集計・評価の仮生成をロック外で実行する。
- 読んだファイルの内容hash、存在しなかったファイル、ディレクトリ一覧を記録する。fallbackをキャッシュするのではなく、物理readのPromiseを共有する既存仕様を維持する。
- 全入力の内容を2回、一覧を各pass前後に確認する既存 `unchanged()` を省略しない。
- 仮生成が0件ならroot writer lockを取得しない。キャッシュhit・ページ変更も同様。

### Phase B: 必要な評価だけを公開する

仮生成した評価がある場合だけ既存Store.lockを取得する。

1. 計算時の全入力hashと一覧を再検証する。
2. **すべての保存先を最初のwriteより前に確認**する。既存原本がある場合は仮生成した検証済み原本との全内容hash一致を要求する。この比較には評価ID・予測参照も含む。矛盾する原本は上書きしない。
3. 保存先照合中の変更も検出するため、保存直前に全入力hashと一覧を再検証する。
4. 不足する評価だけimmutableで保存する。記録した読み取り証拠・一覧を自分の保存分だけ更新し、保存後にも全入力・保存内容を再検証する。
5. lockを解放し、検証成功時だけキャッシュを公開する。

他Serviceが同じ評価を先に保存すると、欠損状態または一覧の変化を検出してPhase Aから再計算する。再計算では既存journalのID/hash/予測参照検証を通った原本を再利用する。評価時刻だけが異なる同じ評価でも先行原本を書き換えない。

変更検出による再試行は最大3回。重い再計算は必ずlock解放後に行う。不安定なら明確なエラーにし、失敗Promiseを残さない。保存先の内容矛盾などの恒久エラーは直ちに拒否する。

同一キーの進行中Promise共有、異なる条件の分離、cloneによる返却値分離、計算完了からのTTL、未来データ・評価期限による早期失効、異なるcutoffでの共有拒否は維持している。

## 性能測定

`scripts/benchmark-scout-writer-lock.ts` で1,000 / 5,000 / 10,000分析を実測した。各分析は最大10候補、250銘柄、日足2revision、重複する4基準日。実市場の独立標本ではなく保存・集計負荷用fixtureである。各規模で評価原本1件だけを不足させ、初回に保存した。

変更前は `5da5f65` のAPI・cacheモジュールをGitから取り出し、import先のパスだけを調整して実行した。変更後と同じfixtureで、各variantの初回前に同じ評価を除去する。共通helperは変更していない。

環境: Windows、Node v24.14.0、Intel Core i5-10400 2.90GHz、論理12CPU、RAM約31.7GiB。Node `--expose-gc --max-old-space-size=8192 --import tsx`。アプリcold、その後cache表示、page2の順。各区間1回、before→after固定順、OSキャッシュ未消去。計測中に回帰テストは実行していない。中央値・p95・統計的な性能差は未検証。

### 応答時間とwriterへの影響

単位は秒。lockはcallback内の時間で、取得・解除のFS処理を除く。APIは関数呼び出しで測定し、HTTP・ブラウザ描画・fixture準備時間を含まない。

| 分析数 | 初回API 前→後 | 初回lock内 前→後 | cache再表示 前→後 | page2 前→後 |
|---:|---:|---:|---:|---:|
| 1,000 | 31.353→40.839 | 31.345→14.765 | 5.018→5.012 | 5.159→4.967 |
| 5,000 | 136.780→167.701 | 136.773→53.693 | 18.209→18.040 | 18.215→17.773 |
| 10,000 | 263.272→326.482 | 263.263→104.539 | 34.612→34.857 | 34.534→34.516 |

変更後のcache再表示・page2はいずれもlock取得0回、保持0秒、保存0件。内容・一覧検証のread数は省略していない。初回は全規模で評価1件だけ保存した。

別Serviceから通常の `store.lock(() => store.write(...))` を開始し、既定120秒の待機上限を使用した。計算中の最初の入力readで1回、lock取得時にもう1回開始し、無関係のjobsファイルにだけ書く。変更後のcache/page2はlockがないため入力readでの1回だけ。

| 分析数 | 初回・計算中writer待機 前→後 | 初回・lock中writer待機 前→後 | 初回タイムアウト数 前→後 |
|---:|---:|---:|---:|
| 1,000 | 31.169→0.005 | 31.371→14.799 | 0/2→0/2 |
| 5,000 | 120.022→0.003 | 120.068→53.734 | 2/2→0/2 |
| 10,000 | 120.034→0.004 | 120.049→104.547 | 2/2→0/2 |

全18区間が終了コード0で完走。変更前writerは18回中4回タイムアウトし、変更後は12回中0回。変更後のcache/page2中のwriter待機はすべて約4.7〜7.5ms。変更前後のAPI応答hashは9組すべて一致した。スクリプトは変更後の保持時間120秒以上・writerタイムアウト・保存0件時のlock取得・応答不一致をエラーとして扱う。

**所定の人工データ条件で、5,000 / 10,000分析のwriterタイムアウトを解消した。初回API全体の高速化ではない。** 全入力の保存直前・保存後再検証を増やしたため、初回応答時間とread量は増えている。

### 読み取りとメモリ

入力read回数は原本・価格・カレンダー等を合わせた `Service.store.read` 呼び出し数であり、原本だけの内訳やOS物理ディスクアクセス数ではない。別writerのowner.jsonポーリングはこの回数に含まない。低水準read回数・バイト数にはポーリングも含まれ、JSONLに併記する。

| 分析数 | 初回入力read 前→後 | cache/page2入力read 前→後 | 初回FS読取量GiB 前→後 |
|---:|---:|---:|---:|
| 1,000 | 16,256→29,260 | 6,502→6,502 | 0.631→1.136 |
| 5,000 | 76,256→137,260 | 30,502→30,502 | 1.953→3.515 |
| 10,000 | 151,256→272,260 | 60,502→60,502 | 3.604→6.488 |

メモリは初回開始前にGCし、RSSを10ms間隔で観測した。単位MiB、増分であってプロセス全体の最大使用量ではない。

| 分析数 | 初回終了時RSS増分 前→後 | 初回peak RSS増分 前→後 | 初回終了時heap増分 前→後 |
|---:|---:|---:|---:|
| 1,000 | 415.1→194.2 | 509.6→287.2 | 519.6→435.7 |
| 5,000 | 855.5→67.6 | 945.5→162.8 | 1,475.7→1,463.9 |
| 10,000 | 1,197.6→−12.0 | 1,282.6→129.0 | 2,681.6→2,313.2 |

RSS増分には実行順・V8の再利用・GCの影響があり、負値もあり得る。この表からメモリ削減率を断定しない。変更後のcache/page2のpeak RSS増分は約92〜119MiB。全sampleのreadAttempts/readFiles/readBytes/directoryReads/RSS/heap/peakRSS/responseBytes/responseHashをJSONLに記録した。

今回の未追跡ログ: `node_modules/.cache/scout-writer-lock-two-phase-1792443443850.jsonl`。fixture・ログ・取り出したbaselineソース・一時設定はコミットしない。

再実行（baselineは5da5f65から取り出してimportパスだけを調整したAPIを指定）:

```powershell
rtk proxy node --expose-gc --max-old-space-size=8192 --import tsx scripts/benchmark-scout-writer-lock.ts 1000,5000,10000 BASELINE_API.ts both
```

変更後だけなら `BASELINE_API.ts both` を `- after` に変更する。

## テスト

追加・変更したテスト:

- 保存なしの計算中に別Serviceが書き込みできる。
- 保存0件の初回・キャッシュhit・ページ変更でlock取得が0回。
- 計算・再試行がロック外、保存だけロック内。
- 新規評価1件だけimmutableで保存し、既存原本bytesを維持。
- 保存直前の変更・追加・削除を検出し、最大3回で拒否。未検証の評価を保存しない。
- 複数保存先の後続に矛盾があっても、先行する評価を部分保存しない。
- 異なるService・評価時刻で同じ評価を同時仮生成しても先行原本を再利用。
- writer lock待機タイムアウト後に失敗Promiseを除去し、次の要求で再計算・保存できる。
- 保存後に既存評価原本のbytesと一覧を変更しない。

既存concurrencyテストで、Promise共有、cutoff/期限跨ぎ、TTL、fallback、入力変更、原本追加、複数Service同時保存も再確認した。修正前に新要件8件の失敗を確認し、テストを先にコミットした。対象3ファイル28件は修正後すべて成功。

初回の標準 `pnpm test` は78ファイル245件のうち243件成功、既存 `hunter-experiment-holdout` が120秒、既存 `kabumaru-agent-walk-forward` が240秒でタイムアウトした。両方を `--maxWorkers=1` で再実行すると2件成功（合計265.91秒）。対象の研究所・agent実装には精度cacheの呼び出しがなく、並列負荷の影響が疑われるが、初回の失敗は省略しない。テスト時間制限と製品コードを変えず、`pnpm run test --maxWorkers=1` で全78ファイル245件が成功した（395.36秒）。

最終チェック:

- `pnpm lint`: 成功。
- `pnpm typecheck`: 成功。
- `pnpm test`: 初回標準並列は上記2件のtimeoutで失敗。1 workerで全245件成功。
- `pnpm test:e2e`: 35件成功（1.8分）。5519 / 3019の専用fixtureサーバーで実行し、既存localhost:5173にはアクセスしていない。既存proxyで外部アクセスを遮断したため、SDKメタデータ取得失敗のconsole警告は出るが、実サービス検証ではない。
- `pnpm run build --config node_modules/.cache/vite-no-env.config.ts`: 成功。既存buildスクリプトのtypecheckとproduction bundleを実行した。秘密ファイルを読み込まないよう、一時configで既存Vite設定に `envDir:false` だけを追加した。製品のVite設定や環境ファイルは変更していない。

## 変更ファイルとコミット

- `tests/scout-writer-lock.test.ts`: 現状再現から、ロック不要・他writer成功の回帰条件へ変更。
- `tests/scout-two-phase.test.ts`: 二段階保存・取得直前の競合・タイムアウト復旧・保存先全件照合・異なる評価時刻での同時保存。
- `apps/api/src/scout-accuracy-cache.ts`: Phase Aをロック外へ移し、Phase Bの全入力・全保存先・保存後検証を追加。
- `scripts/benchmark-scout-writer-lock.ts`: 変更前後比較、計算中とlock中のwriter、cache/page2、入力read・FS read・メモリ計測、失敗条件のassert。
- `docs/scout-writer-lock-remediation.md`: この記録。

指定順のコミット:

1. `8e8608b` — `test: cover two-phase scout accuracy persistence`
2. `a89d7ed` — `refactor: move scout accuracy computation outside writer lock`
3. `f5eba59` — `fix: validate and publish immutable evaluations safely`
4. `da528f2` — `perf: benchmark scout writer lock contention`
5. `docs: record writer lock remediation results` — 本ドキュメントのコミット。

## 残存リスク

- JSONファイル群のトランザクションではない。I/Oエラーや保存後の検証失敗時に、先に保存できたimmutable評価は残る場合がある。ロールバックや削除はせず、未検証の集計を成功として返さない。
- Store.lockを使わない手動編集・非協調writerまで排他できない。内容・一覧を複数回検証するが、任意の同時編集に対するファイル群のatomic snapshot保証とは異なる。
- 保存がある場合はロック内の全入力検証が残る。測定した件数・評価1件保存の結果を、あらゆるデータ量・ディスク速度・大量評価同時生成での120秒保証とは扱わない。
- 再検証が増えるため初回APIの総応答時間・読み取り量は増え得る。writer待機の解消と総計算コストは区別する。
- 異なるService間のPhase Aは重複実行し得る。原本が頻繁に変わる環境では再試行が増え、最大3回で拒否することがある。
- root lockの公平性や他ジョブ自体の長時間占有は変更していない。複数の異なる集計が連続してlockを取得する場合の総待機時間まで120秒未満と保証するものではない。
- 実データ、別プロセスでの負荷試験、実サービス接続、実運用での長期性能は未検証。
- 大量履歴の性能値は関数呼び出しの計測であり、実HTTPの長時間リクエストや利用者端末での表示時間は未検証。初回APIの総処理時間と全入力検証のコストは残る。

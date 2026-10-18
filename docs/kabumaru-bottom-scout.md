# かぶまる自然文の底打ち探索

## Phase 1：調査と設計（2026-10-18）

起点main `9eb13e7`。status/branch/log/fetchとorigin/mainとの差分0を確認。作業中の画面共通化（BottomHunter/BottomResearch/Kabumaru各画面/main.tsx、PageTitle/StockInsights/Settings、既存E2Eの差分）は保持し、今回のコミットに含めない。

既存構成はReact/Vite、Fastify、Zod、JSON Store。かぶまるはKabumaru.tsxから/api/chatを呼びService.chatで記憶と数値根拠に回答する。底打ちの80営業日検証・RSI・EMA・MACDはbottom.ts/bottom-features.ts、全市場の固定入力・取得制限・再開はhunter-jobs.ts/hunter-index.ts、取得時点・改訂選択はsnapshot/readDerivedSeries、非重複窓と未来情報除外はcore/dejavu.tsに実装済み。MemWal SDK、削除tombstone、暗号化保存、Sui認証は既存のまま利用する。

現行bottom-rule-v1は5/20/60日平均、10条件・100点。依頼の5/25/75日・ボリンジャーと異なるため、原本・本番採点を変えず`bottom-scout-v1`として探索用に追加する。既存の指標関数・入力検証・デジャヴ検索を再利用する。既存デジャヴ予測1/5/20日は変更せず、探索用集計で5/10/20日を計算する。

自然文の意図・件数・銘柄・時点は決定的パーサーで抽出する。説明も数値根拠に限定する。最新依頼で省かれたDeepSeek追加は実施しない。外部LLMへの自由文・株価送信も追加しない。

本人用の既存認証とOrigin検証を維持する。質問のみでローカル探索を実行し、既定では追加取得・MemWal外部送信・署名を実行しない。対象は取得済み・上限付きで、全日本株を網羅したランキングと表示しない。不足時は既存の日足取得・ハンター取得の明示操作へ誘導する。実環境の.env・鍵・data原本は調査しない。実サービス接続はテストせずfixture/一時保存/SDKモックを使用する。

J-Quants公式確認：[データ範囲](https://jpx-jquants.com/ja/spec/data-spec)、[レート上限](https://jpx-jquants.com/ja/spec/rate-limits)、[個人利用・再配布FAQ](https://jpx-jquants.com/ja)。Freeは12週間遅延、毎分Free5/Light60/Standard120/Premium500。429は即時再送せず既存limiterを維持。データそのもののシェア・第三者への継続配信を追加しない。個別契約の利用許諾は利用者が確認する。

実装順：指標・採点・意図テスト → デジャヴとランキング → 会話UI → 原本・記憶・期限後評価 → 統合検査。各段階を小さくコミットする。新規DB・ライブラリ・キャラクター画像は追加しない。

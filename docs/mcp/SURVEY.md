# motion-engine MCP 化調査（Phase 1）

- repo: motion-engine
- surveyed_at: 2026-08-21T23:27:35Z
- branch: perf/v0.13-benchmark（checkout なし・コミットなし）

## 概要

VRM アバター向け手続き型モーションエンジン。`three.js`/VRM/DOM に依存しない純粋計算ライブラリで、依存ゼロ・決定論的。入力は数値と plain data、出力は `Pose ({bone:[x,y,z]} + root:{y,z,tilt,lookDown})`。毎フレーム `MotionEngine.update(dt, ctx)` を呼ぶと idle/emotion/actions を合成して springs で滑らかにした Pose を返す。single-file `index.js`(1722 行)にすべて実装。`netmahg`(3D 麻雀)で使用中。

プリミティブ: `Spring`(2 次系)、`NoiseIdle`、`EmotionPose`、`Gesture`(一発芸 18 種)、`Reach`+`solveTwoBone`(pole-vector 2ボーン IK)、`Place`(重量感のある牌の設置・5 スタイル)、`Grip`/`Pick`(指・捨て牌)、`ArmAct`(意図ベース腕演技 19 種)、`RootAct`(全身演技 17 種)、衝突補正(`projectOut`/`makeArmConstraint`)。

## 判定と理由

**decision: `library-serve`**

根拠:
- 依存ゼロ・即時終了の計算関数群で、単体で CLI を叩けば済む性質だが、**game-workspace 内で 8+ の隣接エンジンが motion-engine の Pose 形式に依存する事実上のハブ**である(boujin/habit/affect/sotai/morpho/xpbd/physio/sumi + netmahg)。
- 現状はどのエンジンも `integration/*.mjs` で直接 import して結合しており、volta catalog には 1 件も登録されていない。エージェントが discovery できない。
- 常駐プロセスの価値は薄い(起動 1 秒以内・状態なし関数がほとんど)が、Pose 形式 spec・語彙一覧・IK ソルバ・アクション再生を MCP 経由で公開すれば、エージェントがアバターモーションの組み立てを発見・実行できる。
- `skip` に倒すには依存される相手が多すぎる。`defer` ではなく `library-serve` で、新規 MCP サーバを立てて volta に参加させる価値があると判断した。

## 公開候補

| kind | name | io | 副作用 | 長時間 | maps_to |
|---|---|---|---|---|---|
| tool | `step` | `{dt, ctx} → Pose` | none | false | `MotionEngine.update` (index.js:1642) |
| tool | `play` | `{action:{type,name,...}} → {queued}` | write | false | `MotionEngine.play` (index.js:1607) |
| tool | `clear` | `{} → {cleared}` | write | false | `MotionEngine.clear` (index.js:1608) |
| tool | `solve_ik` | `{pU,pL,pH,restU,restL,target,pole?,elbow?,shoulder?} → {upperQ,lowerQ}` | none | false | `solveTwoBone` (index.js:1065) |
| tool | `grip_pose` | `{side,curl,flexSign?} → {bone:[x,y,z]}` | none | false | `gripPose` (index.js:72) |
| tool | `list_acts` | `{} → {gestures,arm_acts,root_acts,place_styles}` | none | false | `GESTURES`/`ARM_ACTS`/`ROOT_ACTS`/`PLACE_STYLES` |
| resource | `spec` | `motion://spec` | — | — | 能力の機械可読仕様 |
| resource | `guide` | `motion://guide` | — | — | 使い方 |
| resource | `pose_schema` | `motion://pose_schema` | — | — | Pose 形式と全身契約(docs/spec-motion-engine.md 相当) |
| skill | `compose_motion` | — | — | — | 他エンジンとの組み合わせ手順(locality: global) |

## 組み合わせ例

1. `sotai__plan → motion__solve_ik → xpbd__solve → motion__step` — 骨格計画→IK→物理→フレーム更新の直列
2. `affect__valence → motion__play(gesture:'recoil', gain=2.0) → motion__step` — 感情値を gain に写像してリアクション
3. `physio__breath_phase → motion__step(ctx:{pose:breathNudge})` — 生理層の変調を EmotionPose 入力に重ねる

## 依存と協調

motion-engine は **他エンジンから広く依存される入口(Pose)を提供する**ハブ。現時点で相手側に MCP 入口はない(全員 volta 未登録)。

| repo | direction | capability | exists_now |
|---|---|---|---|
| xpbd-body | depends_on | xpbd が motion の Pose を物理入力として受け取る | false |
| boujin | depends_on | `integration/motion-boujin.mjs` が Pose → solvePose | false |
| habit-engine | depends_on | `integration/habit-motion.mjs` が Pose に変調を重ねる | true(直接 import) |
| affect-engine | depends_on | anxiety で Pose を REST に引き寄せる | false |
| sotai-engine | provides_to | SotaiPlan の skeleton/joints を消費して Pose を付ける | false |
| morpho-engine | provides_to | toBodySpec が body spec を出し motion が消費 | false |
| physio-engine | depends_on | `physio-motion.mjs` / `fullstack-avatar.mjs` で結合 | false |
| sumi-engine | depends_on | Pose 形式(kinema と同じシリアライズ) | false |
| netmahg | depends_on | vendored `motion-engine.js` を 3D 麻雀本体が消費 | false |

Phase 2 で issue-hub が協調する際、上記の相手側 survey.json に既に motion-engine 依存が記録されているため、協調の種は揃っている。

## ライブラリのサーバ化

`library_serve.needed = true`

新規に実装が必要なもの:
- `/healthz`(200)
- `PORT` 環境変数・bind `0.0.0.0`
- Streamable HTTP `/mcp`
- MCP サーバ実装(tools/prompts/resources 露出)
- `volta.service.json` manifest
- systemd user unit

runtime: node
estimated_effort: M

設計上の注意: `MotionEngine` はステートフル(アクションキュー・スプリング)。MCP のステートレス呼び出しと相性が悪く、セッション単位の engine インスタンス保持か、クライアント側で状態を保持して毎フレーム送り返す設計が必要。

## リスク

- MotionEngine のステート(キュー/スプリング)と MCP ステートレスモデルの相性。`step` を毎回往復させるとレイテンシが乗る。実レンダラは import で使うため、MCP 経由 `step` はデバッグ/検証用に割り切るべき。
- IK の `geo`(pU/pL/pH/restU/restL)はホストが VRM から測定する必要があり、MCP tool 単独では完結しない(測定支援 tool か guide が要る)。
- 秘密情報・外部 API 課金・破壊的操作はなし(純粋計算ライブラリのため)。

## 持ち主への質問

1. MotionEngine のステートを MCP セッションでどう保持するか(stateful session を許容するか、クライアント側で状態を保持して毎回送るか)。
2. `step` tool はデバッグ/検証用途に割り切るか、エージェントがリアルタイム生成をドライブする想定か。
3. IK の `geo` 測定を支援する tool を motion-engine 側で持つか、別エンジン(morpho 等)に委ねるか。
4. kamishibai の vendored `ROOT_ACTS`/`arm-acts-extra.js` 退役(Roadmap #3)と MCP 化の優先順位。
5. 語彙(GESTURES/ARM_ACTS/ROOT_ACTS)の追加・チューニングを MCP 経由で受け入れるか(現状はコードに埋め込み)。

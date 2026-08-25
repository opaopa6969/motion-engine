# motion-engine MCP 化設計（Phase 2）

- repo: game-workspace/motion-engine
- branch: perf/v0.13-benchmark（共有ツリー上で作業・ブランチ切り替えなし）
- designed_at: 2026-08-22

## 1. namespace と種別

- **namespace**: `motion`（割当表 #3 より。予約語 `catalog` `probe` `skill` と衝突しない）
- **種別**: `library-serve` — 依存ゼロの純粋計算ライブラリに新規 MCP サーバを立てて volta に参加させる

## 2. tools 表

MotionEngine はステートフル（アクションキュー・スプリング）。MCP セッション単位で engine インスタンスを保持し、同一 `mcp-session-id` 内で状態が連続する設計とする。セッションが閉じれば engine は破棄される。ステートレス関数（solveTwoBone, gripPose）はセッション不要。

| name | 目的 | 入力 schema（要点） | 出力の形 | 副作用 | dry-run | job型 | 所要時間 | min_role |
|---|---|---|---|---|---|---|---|---|
| `step` | 1フレーム進めて Pose を返す（デバッグ/検証用） | `{dt:number, ctx?:{t?,phase?,pose?,poseW?,gain?}}` | `{pose:{[bone]:[x,y,z], root:{y,z,tilt,lookDown}}}` | read | — | no | <10ms | MEMBER |
| `play` | アクションをキューに積む | `{action:{type:'gesture'\|'reach'\|'place'\|'pick'\|'armAct'\|'rootAct'\|'grip', name:string, params?:object}}` | `{queued:true, actions_in_queue:number}` | write | — | no | <10ms | MEMBER |
| `clear` | アクションキューを空にする | `{}` | `{cleared:true}` | write | — | no | <10ms | MEMBER |
| `solve_ik` | 2ボーンIKを解く（ステートレス） | `{pU:[x,y,z], pL:[x,y,z], pH:[x,y,z], restU:[x,y,z], restL:[x,y,z], target:[x,y,z], pole?:[x,y,z], elbow?:[x,y,z], shoulder?:[x,y,z]}` | `{upperQ:[x,y,z,w], lowerQ:[x,y,z,w]}` | none | — | no | <10ms | MEMBER |
| `grip_pose` | 指の grip Pose を生成（ステートレス） | `{side:'left'\|'right', curl:number, flexSign?:number}` | `{bone:[x,y,z]}` （15 bone） | none | — | no | <10ms | MEMBER |
| `list_acts` | アクション語彙を一覧 | `{}` | `{gestures:string[], arm_acts:string[], root_acts:string[], place_styles:string[]}` | none | — | no | <10ms | VIEWER |

設計判断:
- `step` はデバッグ/検証用途に割り切る（survey open_question #2）。毎フレーム MCP 往復はレイテンシが乗るため、実レンダラは引き続き import で使う。
- ステート保持: セッションID → MotionEngine インスタンスの Map。セッション切断で破棄。クライアント側で状態を持ち毎回送り返す代替も可能だが、セッション保持が自然な API になる。
- `play` の `action.type` と `name` で Gesture/Reach/Place/Pick/ArmAct/RootAct/Grip を生成。`params` は各クラスのコンストラクタ引数。
- `solve_ik` と `grip_pose` はステートレス純粋関数なのでセッション不要。セッションが無くても呼べる。
- `list_acts` は VIEWER でも参照可能（語彙の発見）。
- 壊す系・外部課金なし（純粋計算ライブラリのため dry-run/confirm 不要）。

## 3. resources 表

| uri | 内容 | mime |
|---|---|---|
| `motion://spec` | 能力の機械可読仕様（tools/list から自動生成 + compositions/depends_on 手書き） | application/json |
| `motion://guide` | 使い方ガイド（MCP 経由の基本的なフロー・ステートモデル・制約） | text/markdown |
| `motion://pose_schema` | Pose 形式と全身契約の参照（bone 名一覧・root チャネル・座標系） | application/json |

## 4. prompts / skills

| 名前 | 種別 | 用途 | locality |
|---|---|---|---|
| `compose_motion` | skill | motion-engine を他エンジンと組み合わせる手順（Pose 形式の受け渡し・IK→物理→フレーム更新のフロー） | global |

skill は `docs/skills/compose_motion/SKILL.md`（volta-mcp 形式 frontmatter 付き）と resource `skill://compose_motion` で配信。

## 5. 組み合わせ例

1. **骨格計画→IK→物理→フレーム更新**: `sotai__plan → motion__solve_ik → xpbd__solve → motion__step` — sotai が skeleton/joints を計画し、motion が IK で関節を解き、xpbd が物理を解き、motion がフレームを進める。Pose がデータとして直列に渡る。
2. **感情→リアクション**: `affect__valence → motion__play(action:{type:'gesture', name:'recoil', params:{gain:2.0}}) → motion__step` — affect の感情値を gain に写像してリアクションジェスチャーを生成。
3. **生理→変調重畳**: `physio__breath_phase → motion__step(ctx:{pose:breathNudge, poseW:0.3})` — 生理層の呼吸変調を EmotionPose 入力に重ねてフレームを進める。

## 6. 依存と協調（issue-hub で合意を取るもの）

motion-engine は **他エンジンから広く依存される Pose 形式の入口を提供するハブ**。現時点で相手側に MCP 入口はない（全員 volta 未登録）。協調 issue で入口の提供を通知し、入出力形式（Pose JSON）を暫定仕様として共有する。

| 相手 repo | direction | 依存する入口 | 合意したいこと |
|---|---|---|---|
| xpbd-body | provides_to（xpbd が motion の Pose を消費） | `motion__step` の Pose 出力形式 | Pose JSON の受け渡し形式（暫定） |
| boujin | provides_to | `motion__step` の Pose 出力 | 同上 |
| habit-engine | provides_to | `motion__step` / `motion__play` | Pose 変調の重ね方 |
| affect-engine | provides_to | `motion__play` の gain 連動 | valence → gain マッピング |
| sotai-engine | depends_on（motion が sotai の plan を消費） | `sotai__plan` の出力 | skeleton/joints → Pose の変換（暫定） |
| morpho-engine | depends_on（motion が morpho の body spec を消費） | `morpho__toBodySpec` の出力 | body spec → IK geo の変換（暫定） |
| physio-engine | provides_to | `motion__step` の ctx.pose | breath 変調の Pose 重畳形式 |
| sumi-engine | provides_to | Pose シリアライズ形式 | Pose 互換性の確認 |
| netmahg | provides_to | vendored motion-engine.js | MCP 化後の連携方針 |

入出力の暫定仕様（Pose JSON）:
```json
{
  "bone": { "head": [x,y,z], "spine": [x,y,z], ... },
  "root": { "y": 0, "z": 0, "tilt": 0, "lookDown": 0 }
}
```
bone 名は VRM 正規化空間の Euler [x,y,z]（ラジアン）。root は全身チャネル。

## 7. 非対応にした候補と理由

Phase 1 からの差分なし。survey の全 capability を tools/resources として公開する。語彙の追加・チューニングを MCP 経由で受け入れるかは open_question（現状はコード埋め込みのため、MCP 経由の追加は非対応）。

## 8. 参加方法

- **manifest**: `volta.service.json`（root）
- **id**: `motion-engine`
- **hostname**: `motion-engine.unlaxer.org`
- **port**: 9201（割当表 #3。machine_ports で空き確認済み）
- **host**: 192.168.1.50（prod）
- **runtime**: systemd（node）
- **auth**: minRole:MEMBER
- **health_check**: /healthz
- **mcp**: enabled, path=/mcp, namespace=motion, min_role=MEMBER, timeoutMs=110000

## 9. テスト方針

e2e テスト（`mcp/test.mjs`）:
1. サーバ起動（PORT=0 または一時ポート）
2. `GET /healthz` → 200, `{ok:true, name, version}`
3. MCP Client で `initialize` → `tools/list` → 6 tools が見える
4. `list_acts` → gestures/arm_acts/root_acts/place_styles が返る
5. `solve_ik` → upperQ/lowerQ が返る
6. `grip_pose` → 15 bone の Pose が返る
7. `play` → `{queued:true}` → `step` → Pose が返る（セッション内で状態連続）
8. `clear` → `{cleared:true}`
9. resources: `motion://spec` / `motion://guide` / `motion://pose_schema` が読める
10. セッション分離: 別セッションで play しても混ざらない

CI は現状 `node test.mjs`（既存テスト）のみ。`mcp/test.mjs` を追加し、`npm test` に含める。

---
name: compose_motion
description: motion-engine を他の game-workspace エンジンと組み合わせてアバターモーションを組立つ手順。Pose 形式の受け渡し・IK→物理→フレーム更新のフロー。
volta:
  version: 1
  namespace: motion
  locality: global
  applies_when: repo が game-workspace/* または motion-engine の Pose を消費するプロジェクト
  requires: []
  min_role: MEMBER
  export: true
---

# compose_motion — motion-engine と他エンジンの組み合わせ

## 目的

motion-engine は VRM アバターの Pose（bone Euler + root チャネル）を生成する手続き型モーションエンジン。game-workspace 内の 8+ のエンジン（boujin/habit/affect/sotai/morpho/xpbd/physio/sumi）がこの Pose 形式に依存するハブ。

この skill は、motion-engine の MCP 入口（`motion__*`）を他エンジンの入口と有機的に組み合わせるフローを示す。

## Pose 形式

```json
{
  "bone": { "head": [x,y,z], "spine": [x,y,z], ... },
  "root": { "y": 0, "z": 0, "tilt": 0, "lookDown": 0 }
}
```

- bone 値は VRM 正規化空間の Euler [x,y,z]（ラジアン）
- 全 bone 名は `motion://pose_schema` resource で取得（42 bone）
- root は全身チャネル（オプション）

## フロー 1: 骨格計画 → IK → 物理 → フレーム更新

```
sotai__plan → motion__solve_ik → xpbd__solve → motion__step
```

1. `sotai__plan` で skeleton/joints の計画を取得
2. `motion__solve_ik` に upper/lower/hand 位置と target を渡して IK を解く（upperQ, lowerQ）
3. `xpbd__solve` で物理を解く
4. `motion__step(dt, ctx)` で1フレーム進めて Pose を得る

## フロー 2: 感情 → リアクション

```
affect__valence → motion__play(action:{type:gesture, name:recoil, params:{gain:2.0}}) → motion__step
```

1. `affect__valence` で感情値を取得
2. 感情値を `gain` に写射して `motion__play` で gesture をキューに積む
3. `motion__step` でフレームを進めてリアクション Pose を得る

## フロー 3: 生理変調の重畳

```
physio__breath_phase → motion__step(ctx:{pose:breathNudge, poseW:0.3})
```

1. `physio__breath_phase` で呼吸周期を取得
2. `motion__step` の `ctx.pose` に呼吸変調を Pose として渡し、`ctx.poseW` で重みを指定

## ステートモデル

- `motion__play` と `motion__step` は MCP セッション内で状態連続（セッションID → MotionEngine インスタンス）
- `motion__solve_ik` と `motion__grip_pose` はステートレス純粋関数（セッション不要）
- `motion__list_acts` で語彙を発見（gestures / arm_acts / root_acts / place_styles）

## 注意

- `motion__step` はデバッグ/検証用。実レンダラは直接 import で使う（MCP 往復のレイテンシが乗るため）
- IK の geo（pU/pL/pH/restU/restL）はホストが VRM から測定する必要がある
- 語彙の追加・チューニングは現在コード埋め込み（MCP 経由の動的追加は非対応）

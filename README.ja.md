[English](./README.md) · **日本語**

# motion-engine

> VRM アバター向けの手続き型ヒューマンモーションエンジン — **モーションキャプチャなしで自然な身体動作を。**

固定クリップを再生する方式(硬く反復的に見え、実際のシーンに適応できない)の代わりに、このエンジンは少数のプリミティブを組み合わせて**毎フレームその場でポーズを合成**する。**pure** である: `three.js` / VRM / DOM の import なし、依存ゼロ、決定論的。入力はただの数値とコマンドで、出力はプレーンデータの **Pose**(`{ boneName: [x, y, z] }`)であり、レンダラがこれを VRM のボーンに適用する。レンダラ非依存なので **headless** で動作し、Node でユニットテストされている。

```js
import { MotionEngine, Gesture, Reach } from 'motion-engine';

const engine = new MotionEngine();           // アバター1体につき1つ
engine.play(new Gesture('fistPump'));         // 一発芸ジェスチャ

// 毎フレーム:
const pose = engine.update(dt, { t, phase, pose: emotionPose, poseW });
for (const bone in pose) {
  const node = vrm.humanoid.getNormalizedBoneNode(bone);
  if (node) node.rotation.set(pose[bone][0], pose[bone][1], pose[bone][2]);
}
vrm.update(dt);
```

## Why

`minimal primitives × combinatorial expressiveness`(最小限のプリミティブ × 組み合わせによる表現力)。モーキャプなしで自然に見える動きは、層を成す一握りの構成要素から生まれる:

| primitive | what it buys |
|---|---|
| **`Spring`**(2次系ダイナミクス) | イーズ / 予備動作 / 行き過ぎ / 整定がタダで手に入る — 「サイン波でメカメカしい」感じを消す |
| **NoiseIdle**(非通約な正弦波) | 呼吸・体重移動・微細なドリフト — 静止した体を生きたもの・非反復にする |
| **EmotionPose** | 感情レイヤーのマイクロポーズ。エンベロープで重み付け |
| **`Gesture`** | 名前付きの一発芸ジェスチャ。idle の上に上書きでなく**重ねる** |
| **`Reach` + `solveTwoBone`** | 解析的な2ボーン **IK**。手が実際のワールド座標の点に届く — 固定クリップにはできないこと |
| **`Place`**(v0.2) | 重さを感じさせる「牌を置く」アクション: 予備動作 → 体幹/肩の先導 + 重力アーク → 接触(手首スナップ + 整定沈み込み) → 滞留 → 離す。スタイルプリセットにより、同じ意図が そっと置く / ねじ込む / ピシッ / なかなか離さない として読める — 捨て牌が身体言語の手がかりになる |
| **`Grip` + `Pick`**(v0.5) | 指。`Grip` は開閉エンベロープ、`Pick` は捨て牌の一連動作をまるごと1つのモーションとして扱う — 自分の手の中へ reach → 指が牌を掴んで閉じる → 川の上を重力アークで払い出す → 指が開いて離す → 引く。腕 IK + 体幹 + 指のカールを一体で駆動 |

すべての寄与は1つのボーンごとのターゲットバッファに合成され、バネがその結果を滑らかにする(先導→ラグのチェーンがオーバーラップ = 重さを生む)。合成後の**制約パス**が衝突補正の継ぎ目になる。

## API

- `new MotionEngine()` → `update(dt, ctx)` が Pose を返す。`play(action)`、`syncFrom(pose)`、`addConstraint(fn)`。`ctx.gain`(v0.4, デフォルト 1, 0.2–2.5 にクランプ)は一発芸ジェスチャの振幅をスケールする — キャラごとの大袈裟さ。
- `new Gesture(name, dur?, env?)` — `'tsumogiri' | 'headScratch' | 'fistPump' | 'slump'` と(v0.3)`'recoil' | 'crossArms' | 'nod' | 'shrug' | 'lean' | 'smirkTilt'`。`env`(v0.8)は予備動作/follow-through を調整する(`{windup, follow, anticipate, overshoot}`; `{windup:0}` = 素のベル型)。
- `swingEnv(p, opts?)`(v0.8) — 予備動作+follow-through エンベロープ(逆方向への windup → スイング → rest を通り過ぎて整定)。ジェスチャ/捨て牌の「溜め」を支える再利用可能なプリミティブ。`Place`/`Pick` は `opts.anticipate`(溜めの深さ、デフォルト 0.3)を取る。
- `new Reach(side, geo, target, dur?, opts?)` — IK reach。`geo = { pU, pL, pH, restU, restL }` はホストがリグから測定して渡す。`opts.pole`(v0.6)— **肘**が押し出される親フレーム方向(着席時の reach なら下後方); デフォルトはリグ本来の rest 曲げ。
- `new Place(side, geo, target, opts?)` — v0.2 の重さを考慮した設置。`geo` は `restW`(手首)+ `pole` も取る。`opts.style` ∈ `PLACE_STYLES`(`gentle`/`snap`/`linger`/`jam`/`timid`)。`{ arc, lead, snap, twist, dwell, release, sink, pole, wristAim }` のいずれかで上書き可能。肩と手首も駆動する。
- `new Grip(side, opts?)` —(v0.5)独立した指の開閉。`opts = { dur, keys:[[p,curl],…], flexSign, base, span }`; curl 0 = 開, 1 = 握り。`keys` は smoothstep 補間の制御点。
- `new Pick(side, geo, opts)` —(v0.5)捨て牌全体を1つのタイムラインで: 自分の手の中へ reach → 指が閉じる → 払い出す → 指が開く → 引く。`opts = { grab:[x,y,z], place:[x,y,z], dur?, style?, flexSign?, …Place の上書き }`; `grab`/`place` は上腕の親ローカルフレームでのターゲット。牌のメッシュを運ぶため、ホスト側が毎フレーム手のボーンを追従させる。
- `gripPose(side, curl, opts?)` → `{ bone:[x,y,z] }` — grip 量に対する指の Euler。`opts.flexSign`(±1)は逆方向に曲がるリグ向けに curl 方向を全体反転する。
- `solveTwoBone(pU, pL, pH, restU, restL, target, opts?)` → `{ upperQ, lowerQ }` — 純解析的な**ポールベクトル** IK(v0.6)。`opts.pole` は肘の位置を明示的に(余弦定理で)決めるので、target がスイープしても最短弧まかせで裏返ることなく一貫して追従する。到達可能シェル上で厳密な IK∘FK 恒等。`opts.elbow = [min,max]` は肘の内角をクランプする(opt-in の関節制限)。
- `DEFAULT_BODY`(v0.6)— 推奨 `BodyProfile`(`{ elbow:[0.35,2.95] }`)。`elbow` を `Reach`/`Place`/`Pick` の opts に spread して関節制限を有効化する。
- **collision**(v0.7): reach する手を障害物(テーブル・牌の壁・川の牌・相手の手・自分の胴体)の外に保つ。コライダーは IK ターゲットフレームでのプレーンデータ — `{shape:'plane',n,o}` / `{shape:'sphere',c,r}` / `{shape:'capsule',a,b,r}`(それぞれ独自の `margin` を追加可能)。使い方は2通り、両方重ねてよい:
  - **goal-clamp** — `opts.colliders`(配列 or フレームごとの `()=>array`)を `Reach`/`Place`/`Pick` に渡すと、手のゴールが毎フレーム各コライダーの外側に投影されるので、手が表面上に乗る/沿って滑る。ホスト側の配線不要で安価。
  - **post-pose** — `engine.addConstraint(makeArmConstraint({ side, geo, colliders, margin }))` はバネ後のポーズを FK し、手を再 IK で押し出す — goal-clamp では取れない残差(バネがゴールにラグして、スイング中にコーナーを突っ切ってしまうケース)を捕まえる。
  - `projectOut(point, colliders, margin?, passes?)` — その裏側にある純粋な投影処理。ホスト側での利用のために export。
- `fkHand(pU, pL, pH, upperQ, lowerQ)` — 順運動学(IK の往復チェック)。
- ヘルパー: `Spring`、`MANAGED`、`REST`、`FINGER_BONES`、`GESTURE_DUR`、`qFromEulerXYZ`、`qToEulerXYZ`(Euler は three.js の `'XYZ'` 順)。

## CDN 経由で使う(ビルド不要)

```html
<script type="importmap">
{ "imports": { "motion-engine": "https://cdn.jsdelivr.net/gh/opaopa6969/motion-engine@v0.1.0/index.js" } }
</script>
```

## テスト

```sh
node test.mjs     # or: npm test
```

Headless: 決定論的な pose ストリーム、バネの安定性、ジェスチャの整定、`IK ∘ FK = identity`(ソルバが手を target に着地させる)を検証。

## Status

[netmahg](https://github.com/opaopa6969/netmahg)(3D 麻雀)で使用中。スコープ: 着席状態の上半身アクション。**v0.3** は一発芸ジェスチャセットを拡充(recoil / crossArms / nod / shrug / lean / smirkTilt)し、リアクションや仕草が身体言語として読めるようにした。**v0.4** は `ctx.gain` を追加 — アバターごとのリアクション振幅(大袈裟さ)をホストが性格から与えることで、*同じ*ジェスチャがキャラによって控えめなひるみにも全力のスラップスティックな仰け反りにも読める(recoil 自体もそれに合わせて強化)。**v0.6** は IK コアを**ポールベクトル・ソルバ**に書き直した: 肘が最短弧まかせでドリフトする代わりに明示的に配置され、reach 中の「不自然な肘の裏返り」をなくす — 厳密な IK∘FK 恒等は維持したまま。

**v0.6** はまた、腕チェーンのスムージングを Euler 3軸を独立にバネさせる代わりに**向き空間**(`QuatSpring`)で行うようにした — 3軸は大きなスイングで結合/ジンバルしジャダーとして現れるため、SO(3) 上のバネが目標クォータニオンを最短経路で追うことで、reach が滑らかにスイングする(有界ジャーク、テスト済み)。そして `BodyProfile` の継ぎ目を opt-in の**肘関節制限**(`DEFAULT_BODY.elbow`)で埋めた — reach が解剖学的に破綻した過伸展/過屈曲のポーズに達する前に止まるようになった。

**v0.7** は**衝突補正**を追加(`addConstraint` の継ぎ目がついに埋まった): reach する手をテーブル・牌の壁・川に捨てられた牌・他プレイヤーの手・アバター自身の胴体といった任意の障害物の外に保つ。コライダーはホスト側がプレーンデータで渡す。2層構成: アクションに対する安価なフレームごとの**goal-clamp**(`opts.colliders`)と、バネのラグによる貫通を捕まえる頑健な**post-pose 再 IK** 制約(`makeArmConstraint`)。

**v0.8** は**予備動作 + follow-through** を追加 — 生のサインベルに欠けていた2つのアニメーション原則。体は動く前に GATHER(溜め)、整定する前に OVERSHOOT(行き過ぎ)するようになる: 一発芸ジェスチャは `swingEnv`(逆方向への windup → スイング → rest を通り過ぎて整定)を使い、`Place`/`Pick` は reach の前に手を後ろへ溜める(`opts.anticipate`、デフォルト 0.3; 0 で opt-out)。エンベロープは1つの調整可能プリミティブなので、同じつまみが後でリアル(小)からアニメ的誇張(大)までダイヤルする — 「誇張」半分のゴールに向けた継ぎ目。

**v0.9** は**肩コーン関節制限**(`opts.shoulder`、`DEFAULT_BODY.shoulder`)を追加 — 上腕は rest から解剖学的なコーンを超えてスイングできなくなる — そして衝突制約を**腕全体**に拡張した: `makeArmConstraint` は今や指先だけでなく FOREARM セグメント(肘→手)もコライダーから持ち上げるので、体をまたいでスイングする腕が胴体カプセルの上に乗る(自己衝突。xpbd-body と対になるプレーンデータの経路)。**v0.9.1** は `QuatSpring` に**大きなフレームギャップのサブステップ処理**を追加 — 落ちたフレームや低速(~5fps)の headless レンダリングでも、剛性項が目標を飛び越えて腕を反転させることがなくなった(エンジン内スクリーンショット QA で発見)。60fps ではちょうど1ステップなので、通常再生はバイト一致。

Roadmap(次): (1) 置いた牌がテーブル上で水平になるような**手首のワールドレベリング**(リグ固有 — エンジン内でチューニング)。(2) ホスト配線: `render3d` から実際の牌/壁/胴体のコライダーと測定済みの肘ポールを与え、importmap を新しいタグに更新し、視覚的にチューニングする(ゲーム側の統合)。

## License

MIT

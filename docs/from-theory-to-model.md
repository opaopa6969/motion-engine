# 理論から engine/model へ — motion-engine 設計書

対象読者: 実装できる人。「2次系ダイナミクス・非通約な正弦波の重ね合わせ・少数プリミティブの層状合成」という理論を、どうやって `index.js` の具体コードに落としているかを、現実装に即して書く。絵に描いた餅ではなく、いま動いているコードの設計根拠。

理論の3本柱と、それを担う実装:

| 理論 | 実装 |
|---|---|
| 2次系ダイナミクス(バネ-ダンパ) | `Spring` / `QuatSpring` |
| 非通約な正弦波の重ね合わせ | `noise()` / `NoiseIdle` |
| 少数プリミティブの層状合成 | `TargetBuffer` + `MotionEngine.update` のパイプライン |

前提となる設計制約は README のとおり: **pure / 依存ゼロ / three.js・VRM・DOM を import しない / 決定論的(`Math.random` 禁止)/ headless で単体テスト可能**。出力は plain-data な Pose `{ boneName: [x,y,z] }`(ラジアン, 正規化 VRM ローカル空間, three.js の `'XYZ'` Euler 順)。ホスト側レンダラがこれをボーンに適用する。

---

## 1. 2次系 → Spring の離散更新式

理論は「目標に向かう2次系(質量-バネ-ダンパ)を積分すると、加速・行き過ぎ(overshoot)・整定(settle)がタダで出る」。これを sin ベタ打ちの代わりに全ボーンに敷く。

### スカラ版 `Spring`

パラメータは3つ:

- `f` — 固有周波数(Hz的)。大きいほどキビキビ。
- `zeta` — 減衰比。`1` で臨界制動(行き過ぎなし)、`<1` で弾む。
- `r` — レスポンス。`0` で素直、`>0` で先読み、`<0` で怠い追従。

内部係数(`setParams`):

```
w  = 2π f
k1 = zeta / (π f)          // 速度の減衰項
k2 = 1 / w²                // 慣性項
k3 = (r zeta) / w          // 目標速度の先読み
```

更新式は semi-implicit(準陰的)積分。目標 `x` の速度を差分で推定し、`k2` に**安定化クランプ**をかけてから2次系を1ステップ進める:

```
xd = (x - this.x) / dt                      // 目標速度の推定
k2 = max(k2, 1.1·(dt²/4 + dt·k1/2))         // 大きな dt でも発散させない下限
y  += dt · yd
yd += dt·(x + k3·xd - y - k1·yd) / k2
```

`k2` のクランプがキモ。タブ復帰などで `dt` が跳ねても、慣性項の下限を `dt` に応じて引き上げることで積分が爆発しない。テストは「100秒の dt スパイクを食わせても NaN/発散しない」ことを確認している。

### 向き版 `QuatSpring`(v0.6)

腕チェーン(shoulder→upperArm→lowerArm→hand)だけは、**Euler 3軸を独立にバネ追従させると軸が結合/ジンバルして「カクッ」と暴れる**。そこで SO(3) 上の2次系にする:

1. 目標クォータニオン `qT` と現在 `q` の**測地線誤差**を回転ベクトルに落とす: `e = log(qT · conj(q))`(最短経路, `|角| ≤ π`)。
2. 角速度 `w` に臨界制動バネ(`kp = wn²`, `kd = 2·zeta·wn`)。減衰項を semi-implicit にして無条件安定に: `w = (w + h·kp·e) / (1 + h·kd)`。
3. `q = normalize(exp(w·h) · q)` で積分。

**サブステップ(v0.9.1)**: 1フレームの `dt` を `1/60` 刻みに割って回す。5fps のような大きなギャップでも `kp·e·h` が小さく保たれ、剛性項が目標を飛び越えて腕が反転するのを防ぐ。60fps ではちょうど1ステップなので通常再生はバイト一致(退行なし)。巨大ギャップは先に `0.25s` にクランプ。

### どのボーンをどっちで smoothing するか

- `QUAT_SMOOTH`(腕チェーンの8ボーン)→ `QuatSpring`
- それ以外(体幹ピッチ, 頭ドリフト, 単軸の指カール)→ 軸ごとの `Spring`×3

周波数はリード→ラグの**チェーン**として設計(`SPRING_F`): 近位を速く(shoulder 3.0)遠位を遅く(hand 1.9)。目標が動くと shoulder→hand へ遅れて波及し、この**オーバーラップが「重さ」の第一の手がかり**になる。指は軽く速い(4.2)。

---

## 2. 非通約周波数の選び方 → noise / NoiseIdle

理論は「割り切れない周期の正弦波を足すと二度と同じ形にならない」。実装 `noise(t, seed)`:

```js
sin(t·0.91 + seed)·0.6 + sin(t·1.73 + seed·1.7)·0.3 + sin(t·2.39 + seed·2.3)·0.1
```

選び方の指針:

- **周波数比を有理数近似から外す**。`0.91 / 1.73 / 2.39` は互いに単純な整数比でない。比が単純だと共通周期が短く、目に見えてループする。
- **振幅は減衰列**(`0.6 / 0.3 / 0.1`)。低周波を主成分に、高周波を微細な揺らぎに。合計 `1.0`。
- **`seed` で各チャンネルを脱相関**。同じ `noise` を頭の3軸・両腕に使い回すが `seed` を変える(頭: 1.3/4.1/7.7、腕: 2.2/5.6)ので、関節がロックステップで動かない。
- **`Math.random` は使わない**。乱数だと決定論が壊れテストできない。正弦波の重ね合わせだけで「滑らか・非反復・軽量・決定論的」を全部満たす。

`NoiseIdle` は常時オンの「生きた rest」: 体幹の呼吸(`sin(t·1.5)` ≒ 0.24Hz)、頭のドリフト、肩の微小な体重移動。**振幅は小さく**(揺れて見えたら失敗、狙いは「彫像でない」だけ)。状態を持たず `ctx.t + ctx.phase` から純関数的に計算する。

---

## 3. 層状合成 → TargetBuffer と合成順序・重み

理論は「少数プリミティブを層で重ねる」。実装の核は `TargetBuffer`: 毎フレームの**ターゲット姿勢アキュムレータ**。2つの書き込みモード:

- `add(bone, [dx,dy,dz], w)` — rest 上への**加算オフセット**(idle・emotion・gesture)。層は上書きせず**足し合わせる**。
- `set(bone, e)` — **ハード上書き**(IK 系: Reach/Place/Pick/ArmAct)。`overridden` 集合に記録し、以降の `add` はそのボーンを無視する(IK が勝つ)。

`MANAGED` の各ボーンは毎フレーム `base(bone)`(= `REST` を敷く)から始まり、以下の順で合成される(`MotionEngine.update`):

```
rest(base) → NoiseIdle → EmotionPose → actions[] → (spring smoothing) → constraints[]
```

**合成順序と重みの根拠**:

1. **idle / emotion は加算**(生存感と感情は常に下地として乗る)。感情層は envelope 重み `ctx.poseW` でスケール。
2. **gesture も加算**で idle の上に「重なる」(昔は腕を上書きしていて呼吸が消えた)。振幅は `ctx.gain`(0.2–2.5 にクランプ)= キャラ別の「大袈裟さ」。各軸を `±2 rad` にクランプして、gain がバネを吹っ飛ばさないようにする。
3. **IK アクションは `set`**。手先の到達点は加算では表現できない(関節角の足し算では特定の世界座標に手を置けない)ので、ここだけ最後勝ちの上書き。
4. **spring smoothing** が最後にターゲットを追う。ここで初めて緩急・overshoot・チェーンのラグが出る。**合成は理想ターゲットを組み、smoothing が物理を与える**、という役割分担。
5. **constraints[]**(post-pose)は smoothing 後に走る。バネのラグで手先がゴールを追い切れず障害物に食い込む残差を、FK→再IK で押し出す継ぎ目(`makeArmConstraint`)。

---

## 4. データ構造

### Pose(出力)

```
{ [boneName]: [x, y, z] }   // Euler ラジアン, three.js 'XYZ' 順, 正規化 VRM ローカル
```

`MANAGED` に列挙されたボーンのみ。VRM が持たないボーン(clavicle は任意, 指関節が少ない手など)はレンダラ側で `getNormalizedBoneNode → null` として単に落ちるので、フルセットを列挙して安全。

### rig geometry(IK の入力)

IK 系は upper-arm の**親ローカル座標**で全て受け取る(エンジンを three-free に保つため、ホストが1度だけ測って渡す):

```
geo = { pU, pL, pH,          // shoulder位置 / elbowオフセット / wristオフセット
        restU, restL,        // upper/lower の rest ローカル回転(Euler)
        restW?, pole?,       // wrist rest / elbポール方向
        basis? }             // ArmAct 用 {out, up, front} 単位ベクトル
```

`DEFAULT_BODY` は推奨 `BodyProfile`(`elbow:[0.35,2.95]`, `shoulder:2.0`)。opt-in の関節制限としてアクション opts に spread する。

### プリミティブ(アクション)

各アクションは `apply(buf, ctx)` を持ち `t += ctx.dt` で自走、`p = t/dur ≥ 1` で `done` を立てる共通形。`MotionEngine.update` が `done` を毎フレーム filter する。

- **`Gesture`** — 名前付き一発芸。`GESTURES[name](e, p)` が bone デルタを返し、`swingEnv` の envelope `e` を掛けて `buf.add`。
- **`ArmAct`(v0.11)** — 意図で演技する。関節角デルタでなく「手の目標 + ポール + wrist + curl」を rig 非依存の**腕長単位 × basis**で指定し、`solveTwoBone` で関節を解く(肘の裏返り解消)。
- **`Reach` / `Place` / `Pick`** — IK 到達 / 重み付き設置 / 掴んで運んで置く一連。`solveTwoBone` を毎フレーム解いて `set`。
- **`Grip`** — 指の開閉 envelope。制御点 `keys=[[p,curl],…]` を smoothstep 補間。
- **`Spring` / `QuatSpring`** — smoothing 部品(アクションでなく engine が保持)。

### anticipation/follow-through: `swingEnv`(v0.8)

生の sin ベルに欠けていた「溜め」と「行き過ぎ」を1つの調整可能プリミティブに:

```
0 →(windup, 逆方向)→ −anticipate →(main swing)→ +1 →(settle)→ −overshoot → 0
```

`windup/follow` は溜め/follow に使う寿命の割合、`anticipate/overshoot` はその深さ。**同じつまみが後で「リアル(小)↔アニメ的誇張(大)」をダイヤルする継ぎ目**。屈曲主体のジェスチャ(逆反りが出る)は `GESTURE_ENV` で負フェーズを opt-out。

### IK ソルバ `solveTwoBone`(v0.6)

純解析的な**ポールベクトル**2ボーン IK。肘を「shoulder→target 線とポールが張る平面内」に余弦定理で**明示的に**置くので、target が動いても肘がポール側で一貫追従する(最短弧まかせの裏返りを排除)。各ボーンを rest 方向から解方向へ最小twistでスイングするので、**IK∘FK が到達可能シェル上で厳密に恒等**(テスト済)。opt-in で `elbow`(肘角クランプ)・`shoulder`(肩コーン制限)。

---

## 5. テスト方針

`test.mjs` を `node test.mjs`(= `npm test`)で回す。**ブラウザも three.js も要らない**のが設計上の主張。効いている観点:

1. **決定論** — 同一入力で pose ストリームがバイト一致(`Math.random` 不在の証明)。
2. **well-formed** — 全フレームで `MANAGED` 各ボーンが有限の `[x,y,z]`。
3. **idle が生きている** — 頭が実際にドリフトする(`>0.01`)が暴れない(`<0.3` に有界)。
4. **一発芸の整定** — gesture がピークに達し、その後 rest に `<0.08` まで戻る。
5. **バネの安定性** — 巨大 dt スパイクで NaN/発散しない。
6. **感情の反映** — `poseW` でスケールした micro-pose が頭に出る。
7. **IK∘FK = 恒等** — ソルバが手を target に正確に着地させる(到達可能シェル上)。

新しいプリミティブを足すときの原則: **(a) headless で駆動できる**(`apply(buf, ctx)` は数値と plain-data だけ)、**(b) 決定論**(乱数禁止、時刻は `ctx.t/phase` から)、**(c) 不変条件を assert**(整定する/有界/IK が target に乗る/バネが発散しない)。この3点を満たせば、既存パイプラインに再構成なしで挿さる。

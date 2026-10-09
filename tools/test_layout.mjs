/**
 * layout.js の純関数テスト（FR-4 / 6.3 / 6.4 / 6.5 / 6.7 / 6.9）
 *
 *   node tools/test_layout.mjs
 *
 * layout.js は @minecraft/server を import していないが rng.js は import している。
 * @minecraft/server は型定義だけのパッケージで Node からは解決できないので、
 * ESM の resolve フックで最小スタブへ差し替える。layout.js / rng.js は一切書き換えない。
 * seed は getSeed()（world に触る）を通さず、テストから直接渡す。
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import { register } from "node:module";

const STUB =
  "data:text/javascript," +
  encodeURIComponent(
    "export const world = { getDynamicProperty: () => undefined, setDynamicProperty: () => {} };\n" +
      "export const system = {};\n",
  );

register(
  "data:text/javascript," +
    encodeURIComponent(
      "const STUB = " +
        JSON.stringify(STUB) +
        ";\n" +
        "export function resolve(specifier, context, next) {\n" +
        "  if (specifier === '@minecraft/server') return { url: STUB, shortCircuit: true };\n" +
        "  return next(specifier, context);\n" +
        "}\n",
    ),
  import.meta.url,
);

const scripts = new URL("../BackroomsBP/scripts/", import.meta.url);
const layout = await import(new URL("layout.js", scripts).href);
const config = await import(new URL("config.js", scripts).href);
const rng = await import(new URL("rng.js", scripts).href);

const { hash32, hashRange, SALT } = rng;
const { TUNING: T, TPC, LM_SPEC } = config;
const {
  cellOf,
  isHome,
  variantOf,
  landmarkCovering,
  wallMask,
  wallCoverage,
  invalidateCache,
  V_BIG,
  V_DENSE,
  V_DARK,
  V_NORMAL,
  V_HOME,
} = layout;

const SEED = 0x5eed1234 | 0;
const SEED2 = -998877 | 0;

let passed = 0;
const failures = [];
/** 1件落ちても残りの計測結果が見えるよう、最初の失敗で止めずに集める */
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log("  ok  " + name);
  } catch (e) {
    failures.push({ name, message: e.message });
    console.log("  NG  " + name + "\n      " + e.message);
  }
}

// ---------------------------------------------------------------------------
// 1. 決定論性（FR-4）
// ---------------------------------------------------------------------------
console.log("1. 決定論性 (FR-4)");

check("同じ seed・同じセルなら wallMask が常に同一", () => {
  for (let i = 0; i < 300; i++) {
    const cx = ((i * 37) % 120) - 60;
    const cz = ((i * 91) % 120) - 60;
    const a = wallMask(cx, cz, SEED);
    // 別 seed / 別セルを挟んでもキャッシュに引きずられないこと
    wallMask(cx + 1, cz - 3, SEED2);
    const b = wallMask(cx, cz, SEED);
    invalidateCache();
    const c = wallMask(cx, cz, SEED);
    assert.deepEqual(Array.from(a), Array.from(b), `(${cx},${cz}) 2回目が一致しない`);
    assert.deepEqual(Array.from(a), Array.from(c), `(${cx},${cz}) キャッシュ破棄後に一致しない`);
  }
});

check("seed が変われば結果も変わる（テスト自体が空振りでないこと）", () => {
  let diff = 0;
  for (let cx = 1; cx <= 40; cx++) {
    const a = Array.from(wallMask(cx, 7, SEED));
    const b = Array.from(wallMask(cx, 7, SEED2));
    if (a.join() !== b.join()) diff++;
  }
  assert.ok(diff > 30, `seed 違いで差が出たセルが ${diff}/40 しかない`);
});

// ---------------------------------------------------------------------------
// 2. セル境界で壁が連続する（6.3）
//
//    6.3 のセグメント定義をテスト側で独立に組み立て、layout.wallMask が
//    そのグローバル場をセルで切り出したものになっていることを確かめる。
//    セグメント本数・バリアント判定は layout の公開関数を使い、
//    重複させるのは「線分をタイルへ展開する」幾何だけに留める。
// ---------------------------------------------------------------------------
console.log("2. セル境界の連続性 (6.3)");

function segmentsFrom(cx, cz, seed) {
  if (isHome(cx, cz)) return [];
  const lm = landmarkCovering(cx, cz, seed);
  if (lm && !lm.normalWalls) return [];

  const v = variantOf(cx, cz, seed);
  let n;
  if (v === V_BIG) n = hashRange(cx, cz, SALT.COUNT, seed, T.BIG_COUNT_MIN, T.BIG_COUNT_MAX);
  else if (v === V_DENSE) n = hashRange(cx, cz, SALT.COUNT, seed, T.DENSE_COUNT_MIN, T.DENSE_COUNT_MAX);
  else n = hashRange(cx, cz, SALT.COUNT, seed, T.SEGMENT_COUNT_MIN, T.SEGMENT_COUNT_MAX);

  const gx0 = cx * TPC;
  const gz0 = cz * TPC;
  const segs = [];
  for (let i = 0; i < n; i++) {
    const tx = hash32(cx, cz, SALT.TX + i, seed) % TPC;
    const tz = hash32(cx, cz, SALT.TZ + i, seed) % TPC;
    const dir = hash32(cx, cz, SALT.DIR + i, seed) % 2;
    const len = hashRange(cx, cz, SALT.LEN + i, seed, T.SEGMENT_LEN_MIN, T.SEGMENT_LEN_MAX);
    const tiles = [];
    for (let k = 0; k < len; k++) {
      tiles.push([gx0 + tx + (dir === 0 ? k : 0), gz0 + tz + (dir === 1 ? k : 0)]);
    }
    segs.push(tiles);
  }
  return segs;
}

const R0 = -12;
const R1 = 12;

check("wallMask の壁の有無はグローバルなセグメント場をセルで切り出したものと完全に一致する", () => {
  const field = new Set();
  for (let cz = R0 - 1; cz <= R1 + 1; cz++) {
    for (let cx = R0 - 1; cx <= R1 + 1; cx++) {
      for (const seg of segmentsFrom(cx, cz, SEED)) {
        for (const [gx, gz] of seg) field.add(gx + ":" + gz);
      }
    }
  }
  for (let cz = R0; cz <= R1; cz++) {
    for (let cx = R0; cx <= R1; cx++) {
      const mask = wallMask(cx, cz, SEED);
      const lm = landmarkCovering(cx, cz, SEED);
      // 拠点・水区画・階段は全0。構造を持つランドマーク（巨大空間の柱・廊下・柱の広間・小部屋）は 8 で見る
      if (lm && !lm.normalWalls && lm.kind !== config.LM_WATER && lm.kind !== config.LM_STAIRS) continue;
      const structural = isHome(cx, cz) || (lm && !lm.normalWalls);
      for (let tz = 0; tz < TPC; tz++) {
        for (let tx = 0; tx < TPC; tx++) {
          const expect = structural ? 0 : field.has(cx * TPC + tx + ":" + (cz * TPC + tz)) ? 1 : 0;
          // 値は壁の形（設計書 3.1）。ここでは 0 でないか（壁があるか）だけを見る
          assert.equal(
            mask[tz * TPC + tx] !== 0 ? 1 : 0,
            expect,
            `セル(${cx},${cz}) タイル(${tx},${tz}) が食い違う`,
          );
        }
      }
    }
  }
});

check("セル境界をまたぐセグメントは、両側のセルの wallMask に途切れず現れる", () => {
  let crossing = 0;
  let checkedTiles = 0;
  for (let cz = R0; cz < R1; cz++) {
    for (let cx = R0; cx < R1; cx++) {
      for (const seg of segmentsFrom(cx, cz, SEED)) {
        const cells = new Set(seg.map(([gx, gz]) => Math.floor(gx / TPC) + "," + Math.floor(gz / TPC)));
        if (cells.size < 2) continue;
        crossing++;
        for (const [gx, gz] of seg) {
          const ocx = Math.floor(gx / TPC);
          const ocz = Math.floor(gz / TPC);
          // 拠点セルと固有構造ランドマークは壁を受け付けない側なので対象外（6.7 / 6.9）
          const olm = landmarkCovering(ocx, ocz, SEED);
          if (isHome(ocx, ocz) || (olm && !olm.normalWalls)) continue;
          const mask = wallMask(ocx, ocz, SEED);
          const tx = gx - ocx * TPC;
          const tz = gz - ocz * TPC;
          assert.notEqual(
            mask[tz * TPC + tx],
            0,
            `セグメントが(${ocx},${ocz})側で欠けている: global tile (${gx},${gz})`,
          );
          checkedTiles++;
        }
      }
    }
  }
  assert.ok(crossing > 100, `境界をまたぐセグメントが ${crossing} 本しかなく検証にならない`);
  console.log(`      境界をまたぐセグメント ${crossing} 本 / タイル ${checkedTiles} 枚を照合`);
});

// ---------------------------------------------------------------------------
// 3. 拠点セル（FR-13 / 6.9 / 15章）
// ---------------------------------------------------------------------------
console.log("3. 拠点セル (FR-13)");

check("拠点セル (0,0) の wallMask は全0・被覆率0", () => {
  for (const seed of [SEED, SEED2, 0, 1, -1]) {
    const mask = wallMask(config.HOME_CX, config.HOME_CZ, seed);
    assert.equal(Array.from(mask).reduce((a, b) => a + b, 0), 0, `seed ${seed} で壁が出ている`);
    assert.equal(wallCoverage(config.HOME_CX, config.HOME_CZ, seed), 0);
  }
  assert.equal(variantOf(config.HOME_CX, config.HOME_CZ, SEED), V_HOME);
  assert.equal(landmarkCovering(config.HOME_CX, config.HOME_CZ, SEED), null);
});

check("cellOf は負の座標でも切り下げる（6.1）", () => {
  assert.deepEqual(cellOf(0, 0), { cx: 0, cz: 0 });
  assert.deepEqual(cellOf(15.9, 15.9), { cx: 0, cz: 0 });
  assert.deepEqual(cellOf(-1, -1), { cx: -1, cz: -1 });
  assert.deepEqual(cellOf(-16, -17), { cx: -1, cz: -2 });
  assert.ok(isHome(0, 0) && !isHome(1, 0) && !isHome(0, -1));
});

// ---------------------------------------------------------------------------
// 4. 壁被覆率（6.4: 目標 25〜35%）
// ---------------------------------------------------------------------------
console.log("4. 壁被覆率 (6.4)");

let coverageReport = "";
check("通常セルの壁被覆率の平均が 25〜35%", () => {
  // 一列に並んだセルだと偏るので、原点まわりの 12x12 セルから2次元に拾う
  const samples = [];
  for (let cz = -6; samples.length < 100 && cz < 6; cz++) {
    for (let cx = -6; samples.length < 100 && cx < 6; cx++) {
      if (variantOf(cx, cz, SEED) !== V_NORMAL) continue;
      if (landmarkCovering(cx, cz, SEED)) continue;
      samples.push(wallCoverage(cx, cz, SEED));
    }
  }
  assert.equal(samples.length, 100);
  const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
  const min = Math.min(...samples);
  const max = Math.max(...samples);
  coverageReport = `平均 ${avg.toFixed(1)}% / 最小 ${min}% / 最大 ${max}%（通常セル100件）`;
  console.log("      " + coverageReport);
  assert.ok(avg >= 25 && avg <= 35, `平均被覆率が目標外: ${avg.toFixed(1)}%`);
});

check("大部屋は通常セルより薄く、密集区画は濃い（6.5 の効果が出ている）", () => {
  const avgOf = (variant) => {
    const s = [];
    for (let cz = 0; s.length < 40 && cz < 400; cz++) {
      for (let cx = 0; s.length < 40 && cx < 400; cx++) {
        if (variantOf(cx, cz, SEED) !== variant) continue;
        if (landmarkCovering(cx, cz, SEED)) continue;
        s.push(wallCoverage(cx, cz, SEED));
      }
    }
    return s.reduce((a, b) => a + b, 0) / s.length;
  };
  const big = avgOf(V_BIG);
  const normal = avgOf(V_NORMAL);
  const dense = avgOf(V_DENSE);
  console.log(
    `      大部屋 ${big.toFixed(1)}% < 標準 ${normal.toFixed(1)}% < 密集 ${dense.toFixed(1)}%`,
  );
  assert.ok(big < normal, "大部屋が標準より濃い");
  assert.ok(dense > normal, "密集区画が標準より薄い");
});

// ---------------------------------------------------------------------------
// 5. ランドマークの占有範囲（6.7）
// ---------------------------------------------------------------------------
console.log("5. ランドマークの占有範囲 (6.7)");

check("ランドマークが返るとき、占有範囲の全セルが同じ原点・同じ種別を返す", () => {
  let found = 0;
  const S0 = -90;
  const S1 = 90;
  for (let cz = S0; cz <= S1; cz++) {
    for (let cx = S0; cx <= S1; cx++) {
      const lm = landmarkCovering(cx, cz, SEED);
      if (!lm) continue;
      assert.ok(cx >= lm.ox && cx < lm.ox + lm.w, `(${cx},${cz}) が占有範囲の外`);
      assert.ok(cz >= lm.oz && cz < lm.oz + lm.h, `(${cx},${cz}) が占有範囲の外`);
      // 向き rot は 0 か 1。1 は廊下だけで、そのとき w/h が入れ替わる（設計書 3.2）
      assert.ok(lm.rot === 0 || (lm.rot === 1 && lm.kind === config.LM_CORRIDOR), `kind ${lm.kind} の rot が ${lm.rot}`);
      const spec = LM_SPEC[lm.kind];
      assert.deepEqual(
        { w: lm.w, h: lm.h, normalWalls: lm.normalWalls, ceilY: lm.ceilY },
        {
          w: lm.rot ? spec.h : spec.w,
          h: lm.rot ? spec.w : spec.h,
          normalWalls: spec.normalWalls,
          ceilY: spec.ceilY,
        },
        `kind ${lm.kind} の仕様が LM_SPEC と食い違う`,
      );
      if (cx !== lm.ox || cz !== lm.oz) continue;
      found++;
      // 原点から見た占有範囲が1セルも欠けていないこと（欠けると水区画の囲いが破れる）
      for (let dz = 0; dz < lm.h; dz++) {
        for (let dx = 0; dx < lm.w; dx++) {
          const other = landmarkCovering(lm.ox + dx, lm.oz + dz, SEED);
          assert.ok(other, `占有セル(${lm.ox + dx},${lm.oz + dz}) が null を返す`);
          assert.equal(other.ox, lm.ox);
          assert.equal(other.oz, lm.oz);
          assert.equal(other.kind, lm.kind);
        }
      }
    }
  }
  console.log(`      ${(S1 - S0 + 1) ** 2} セル中 ランドマーク ${found} 個の占有範囲を全数照合`);
  assert.ok(found > 40, `ランドマークが ${found} 個しか出ず検証にならない`);
});

check("ランドマークどうしが重ならない", () => {
  const owner = new Map();
  for (let cz = -60; cz <= 60; cz++) {
    for (let cx = -60; cx <= 60; cx++) {
      const lm = landmarkCovering(cx, cz, SEED);
      if (!lm) continue;
      const k = cx + "," + cz;
      const o = lm.ox + "," + lm.oz;
      if (owner.has(k)) assert.equal(owner.get(k), o, `(${cx},${cz}) が2つの原点に属する`);
      owner.set(k, o);
    }
  }
});

// ---------------------------------------------------------------------------
// 6. バリアントの出現率（6.5: 大部屋5% / 密集7% / 暗区画4%）
// ---------------------------------------------------------------------------
console.log("6. バリアント出現率 (6.5)");

check("大部屋・密集区画・暗区画が 6.5 の確率どおりに出る", () => {
  const N = 200;
  const count = { [V_BIG]: 0, [V_DENSE]: 0, [V_DARK]: 0, [V_NORMAL]: 0, [V_HOME]: 0 };
  let total = 0;
  for (let cz = -N; cz < N; cz++) {
    for (let cx = -N; cx < N; cx++) {
      if (isHome(cx, cz)) continue;
      count[variantOf(cx, cz, SEED)]++;
      total++;
    }
  }
  const pct = (v) => (count[v] / total) * 100;
  console.log(
    `      大部屋 ${pct(V_BIG).toFixed(2)}% / 密集 ${pct(V_DENSE).toFixed(2)}%` +
      ` / 暗区画 ${pct(V_DARK).toFixed(2)}% / 標準 ${pct(V_NORMAL).toFixed(2)}%（${total} セル）`,
  );
  const near = (actual, target, tol, label) =>
    assert.ok(Math.abs(actual - target) <= tol, `${label}: ${actual.toFixed(2)}% (目標 ${target}%)`);
  near(pct(V_BIG), 5, 0.6, "大部屋");
  near(pct(V_DENSE), 7, 0.6, "密集区画");
  near(pct(V_DARK), 4, 0.6, "暗区画");
  near(pct(V_NORMAL), 84, 1.0, "標準");
  assert.equal(count[V_HOME], 0);
});

check("暗区画は照明が0個（6.5 / 6.6）", () => {
  let dark = 0;
  for (let cz = 0; cz < 60 && dark < 20; cz++) {
    for (let cx = 0; cx < 60 && dark < 20; cx++) {
      if (variantOf(cx, cz, SEED) !== V_DARK) continue;
      if (landmarkCovering(cx, cz, SEED)?.kind === config.LM_MANILA) continue; // マニラルームは暗くしない（12 で見る）
      assert.equal(layout.lightBlocks(cx, cz, SEED).length, 0, `(${cx},${cz}) に照明がある`);
      dark++;
    }
  }
  assert.equal(dark, 20);
});

// ---------------------------------------------------------------------------
// 7. 壁の形（設計書 3.1）
// ---------------------------------------------------------------------------
console.log("7. 壁の形 (設計書 3.1)");
const { W_NONE, W_FULL, W_LOW, W_GAP, W_DOOR } = config;

check("wallMask の値は 0..4 で、4 種類の形がすべて出る", () => {
  const seen = new Set();
  for (let cz = -30; cz < 30; cz++) for (let cx = -30; cx < 30; cx++) {
    for (const v of wallMask(cx, cz, SEED)) {
      assert.ok(v >= W_NONE && v <= W_DOOR, `(${cx},${cz}) に値 ${v}`);
      seen.add(v);
    }
  }
  for (const v of [W_FULL, W_LOW, W_GAP, W_DOOR]) assert.ok(seen.has(v), `形 ${v} が1つも出ない`);
});

check("wallMask の形は、形つきのグローバルなセグメント場をセルで切り出したものと一致する（境目で食い違わない）", () => {
  // セグメントの形は持ち主のセルの hash で決まるので、隣のセルに伸びた部分も同じ値になるはず。
  // テスト側でセグメント場を形つきで組み立て、各セルの wallMask と全タイル照合する
  const STRENGTH = [0, 4, 2, 3, 1]; // 添字が値。FULL > GAP > LOW > DOOR > NONE
  const field = new Map();
  for (let cz = R0 - 1; cz <= R1 + 1; cz++) for (let cx = R0 - 1; cx <= R1 + 1; cx++) {
    segmentsFrom(cx, cz, SEED).forEach((seg, i) => {
      const style = layout.segmentStyle(cx, cz, i, seg.length, SEED);
      const door = style === W_DOOR ? 1 + (hash32(cx, cz, SALT.WALL_DOOR + i, SEED) % (seg.length - 2)) : -1;
      seg.forEach(([gx, gz], k) => {
        const v = style === W_DOOR ? (k === door ? W_DOOR : W_FULL) : style;
        const key = gx + ":" + gz;
        if (STRENGTH[v] > STRENGTH[field.get(key) ?? 0]) field.set(key, v);
      });
    });
  }
  let crossing = 0;
  for (let cz = R0; cz <= R1; cz++) for (let cx = R0; cx <= R1; cx++) {
    const lm = landmarkCovering(cx, cz, SEED);
    if (isHome(cx, cz) || (lm && !lm.normalWalls)) continue;
    const mask = wallMask(cx, cz, SEED);
    for (let tz = 0; tz < TPC; tz++) for (let tx = 0; tx < TPC; tx++) {
      const want = field.get(cx * TPC + tx + ":" + (cz * TPC + tz)) ?? 0;
      assert.equal(mask[tz * TPC + tx], want, `セル(${cx},${cz}) タイル(${tx},${tz})`);
      if (want && (tx === 0 || tx === TPC - 1)) crossing++;
    }
  }
  assert.ok(crossing > 100, `境目の列の壁が ${crossing} 枚しかなく検証にならない`);
});

// ---------------------------------------------------------------------------
// 8. 新しいランドマーク（設計書 3.2）
// ---------------------------------------------------------------------------
console.log("8. 新しいランドマーク (設計書 3.2)");
const { LM_CORRIDOR, LM_PILLARS, LM_ROOMS, LM_ATRIUM } = config;

function findLandmarks(kind, want, R = 200) {
  const out = [];
  for (let cz = -R; cz <= R && out.length < want; cz++)
    for (let cx = -R; cx <= R && out.length < want; cx++) {
      const lm = landmarkCovering(cx, cz, SEED);
      if (lm && lm.kind === kind && lm.ox === cx && lm.oz === cz) out.push(lm);
    }
  return out;
}
/** ランドマーク全体のタイル格子（ローカル座標）を wallMask から組み立てる */
function landmarkGrid(lm) {
  const W = lm.w * TPC, H = lm.h * TPC;
  const g = new Uint8Array(W * H);
  for (let dz = 0; dz < lm.h; dz++) for (let dx = 0; dx < lm.w; dx++) {
    const m = wallMask(lm.ox + dx, lm.oz + dz, SEED);
    for (let tz = 0; tz < TPC; tz++) for (let tx = 0; tx < TPC; tx++)
      g[(dz * TPC + tz) * W + dx * TPC + tx] = m[tz * TPC + tx];
  }
  return { g, W, H };
}

check("小部屋: 全16室が外周の入口からたどり着ける", () => {
  const list = findLandmarks(LM_ROOMS, 30);
  assert.ok(list.length >= 20, `小部屋の区画が ${list.length} 個しか見つからない`);
  for (const lm of list) {
    const { g, W, H } = landmarkGrid(lm);
    // 外周の値0のタイルから塗りつぶし
    const seen = new Uint8Array(W * H);
    const q = [];
    for (let x = 0; x < W; x++) for (const z of [0, H - 1]) if (!g[z * W + x]) { seen[z * W + x] = 1; q.push([x, z]); }
    for (let z = 0; z < H; z++) for (const x of [0, W - 1]) if (!g[z * W + x] && !seen[z * W + x]) { seen[z * W + x] = 1; q.push([x, z]); }
    while (q.length) {
      const [x, z] = q.pop();
      for (const [ax, az] of [[1,0],[-1,0],[0,1],[0,-1]]) {
        const nx = x + ax, nz = z + az;
        if (nx < 0 || nz < 0 || nx >= W || nz >= H) continue;
        const k = nz * W + nx;
        if (seen[k] || g[k]) continue;
        seen[k] = 1; q.push([nx, nz]);
      }
    }
    const inner = [1, 5, 9, 13];
    for (const rz of inner) for (const rx of inner)
      assert.ok(seen[rz * W + rx], `小部屋(${lm.ox},${lm.oz}) の部屋 (${rx},${rz}) に入れない`);
  }
});

check("小部屋: 入口のうち少なくとも1つは外から入れる（外側の隣のタイルが通れる）", () => {
  const MID = [2, 6, 10, 13];
  /** 外側のタイル（グローバルタイル座標）が通れるか。構造を持つランドマーク・水区画・階段の中は塞がっているとみなす */
  const outsideOpen = (gx, gz) => {
    const cx = Math.floor(gx / TPC), cz = Math.floor(gz / TPC);
    const lm = landmarkCovering(cx, cz, SEED);
    if (lm && !lm.normalWalls) return false;
    const v = wallMask(cx, cz, SEED)[(gz - cz * TPC) * TPC + (gx - cx * TPC)];
    return v === W_NONE || v === W_LOW || v === W_DOOR;
  };
  const list = findLandmarks(LM_ROOMS, Infinity, 300);
  // v0.5.0 で LM_KINDS が 8 → 9（穴が増えた）になり、小部屋の割合が 1/8 → 1/9 に減った。この seed・範囲で実測 247 区画
  assert.ok(list.length > 200, `小部屋の区画が ${list.length} 個しか見つからない`);
  let sealed = 0;
  for (const lm of list) {
    const { g, W, H } = landmarkGrid(lm);
    const gx0 = lm.ox * TPC, gz0 = lm.oz * TPC;
    // 外周の4辺 x 4部屋 = 入口の候補16か所: [内側のローカルタイル x, z, 外側のグローバルタイル x, z]
    const cands = [];
    for (const m of MID) {
      cands.push([m, 0, gx0 + m, gz0 - 1]);
      cands.push([W - 1, m, gx0 + W, gz0 + m]);
      cands.push([m, H - 1, gx0 + m, gz0 + H]);
      cands.push([0, m, gx0 - 1, gz0 + m]);
    }
    const gates = cands.filter(([x, z]) => g[z * W + x] === 0);
    assert.ok(gates.length >= 2 && gates.length <= 4, `小部屋(${lm.ox},${lm.oz}) の入口が ${gates.length} か所`);
    // 16 か所とも外が壁の区画は直しようがない。数だけ出す
    if (!cands.some(([, , ox, oz]) => outsideOpen(ox, oz))) { sealed++; continue; }
    assert.ok(gates.some(([, , ox, oz]) => outsideOpen(ox, oz)), `小部屋(${lm.ox},${lm.oz}) の入口が全部外から塞がっている`);
  }
  console.log(`      小部屋 ${list.length} 区画を照合。候補16か所とも外が壁の区画 ${sealed}`);
});

check("柱の広間: 柱は lx%3==1 && lz%3==1 のタイルだけで、値は天井までの壁", () => {
  const list = findLandmarks(LM_PILLARS, 20);
  assert.ok(list.length >= 10);
  for (const lm of list) {
    const { g, W, H } = landmarkGrid(lm);
    for (let z = 0; z < H; z++) for (let x = 0; x < W; x++) {
      assert.equal(g[z * W + x], x % 3 === 1 && z % 3 === 1 ? W_FULL : W_NONE, `柱の広間(${lm.ox},${lm.oz}) タイル(${x},${z})`);
    }
  }
});

check("廊下: 脇道は1〜2本で、通路から外周まで値0で抜けている（途中で止まった穴は無い）", () => {
  const list = findLandmarks(LM_CORRIDOR, 20);
  assert.ok(list.length >= 10);
  for (const lm of list) {
    const { g, W, H } = landmarkGrid(lm);
    const long = lm.rot ? H : W;
    const at = (l, c) => g[lm.rot ? l * W + c : c * W + l];
    let sides = 0;
    for (let l = 0; l < long; l++) {
      for (const cols of [[0, 1, 2], [5, 6, 7]]) {
        const vals = cols.map((c) => at(l, c));
        const open = vals.filter((v) => v === W_NONE).length;
        assert.ok(vals.every((v) => v === W_NONE || v === W_FULL), `廊下(${lm.ox},${lm.oz}) 長手 ${l} に値 ${vals}`);
        assert.ok(open === 0 || open === 3, `廊下(${lm.ox},${lm.oz}) の脇道 ${l} が外周まで抜けていない`);
        if (open === 3) {
          sides++;
          assert.ok(l >= 4 && l < 20, `廊下(${lm.ox},${lm.oz}) の脇道が端に寄りすぎ（${l}）`);
        }
      }
    }
    assert.ok(sides >= 1 && sides <= 2, `廊下(${lm.ox},${lm.oz}) の脇道が ${sides} 本`);
  }
});

check("廊下: 通路が全長にわたって幅4ブロックで開いていて、両端が外へ抜けている", () => {
  const list = findLandmarks(LM_CORRIDOR, 20);
  assert.ok(list.length >= 10);
  for (const lm of list) {
    const { g, W, H } = landmarkGrid(lm);
    const long = lm.rot ? H : W;
    for (let i = 0; i < long; i++) for (const c of [3, 4]) {
      const k = lm.rot ? i * W + c : c * W + i;
      assert.equal(g[k], 0, `廊下(${lm.ox},${lm.oz}) の通路 ${i},${c} が塞がっている`);
    }
  }
});

check("遺留品と出口のドアは値0のタイルにだけ置かれる（柱・部屋の壁の上に置かれない）", () => {
  let n = 0;
  for (let cz = -120; cz <= 120; cz++) for (let cx = -120; cx <= 120; cx++) {
    const m = wallMask(cx, cz, SEED);
    for (const it of [layout.relicAt(cx, cz, SEED), layout.exitAt(cx, cz, SEED)]) {
      if (!it || it.tx === undefined) continue;
      n++;
      assert.equal(m[it.tz * TPC + it.tx], 0, `(${cx},${cz}) のタイル (${it.tx},${it.tz}) は値 ${m[it.tz * TPC + it.tx]}`);
    }
  }
  assert.ok(n > 500, `遺留品と出口が ${n} 個しかない`);
});

// ---------------------------------------------------------------------------
// 9. 小物の配置（設計書 3.3）
// ---------------------------------------------------------------------------
console.log("9. 小物の配置 (設計書 3.3)");
const FACING_BACK = { east: [-1, 0], west: [1, 0], south: [0, -1], north: [0, 1] }; // 表の反対（背中側）
const WALL_DECOR = new Set([config.B_OUTLET, config.B_SWITCH, config.B_EXIT_SIGN]);

check("小物は判定点・拠点・壁の中に置かれず、壁の小物は壁を背にしている", () => {
  let wall = 0, floor = 0, ceil = 0;
  for (let cz = -40; cz <= 40; cz++) for (let cx = -40; cx <= 40; cx++) {
    const list = layout.decorAt(cx, cz, SEED);
    if (isHome(cx, cz)) { assert.equal(list.length, 0, "拠点に小物がある"); continue; }
    const m = wallMask(cx, cz, SEED);
    const cols = new Set();
    // 天井と床の小物も値0のタイルの上下だけ（設計書 3.6）。天井は蛍光灯の位置を避け、同じブロックに2つ置かない
    const lit = new Set(layout.lightBlocks(cx, cz, SEED).map((l) => l.bx + "," + l.bz));
    const surfaces = new Set();
    for (const d of list) {
      assert.ok(d.bx >= 0 && d.bx < 16 && d.bz >= 0 && d.bz < 16, `(${cx},${cz}) の範囲外 ${d.bx},${d.bz}`);
      if (!WALL_DECOR.has(d.id)) {
        assert.equal(m[(d.bz >> 1) * TPC + (d.bx >> 1)], 0, `(${cx},${cz}) ${d.id} が壁のタイルの上下にある`);
        const at = d.bx + "," + d.y + "," + d.bz;
        assert.ok(!surfaces.has(at), `(${cx},${cz}) ${at} に小物が2つ`);
        surfaces.add(at);
      }
      if (d.y === config.Y_FLOOR) {
        floor++;
        assert.ok(!(d.bx === 8 && d.bz === 8), `(${cx},${cz}) の判定点に ${d.id}`);
        continue;
      }
      if (!WALL_DECOR.has(d.id)) {
        ceil++;
        assert.ok(!lit.has(d.bx + "," + d.bz), `(${cx},${cz}) 蛍光灯の位置に ${d.id}`);
        continue;
      }
      wall++;
      const tx = d.bx >> 1, tz = d.bz >> 1;
      assert.equal(m[tz * TPC + tx], 0, `(${cx},${cz}) 壁の小物が壁のタイルの中にある`);
      const [bx, bz] = FACING_BACK[d.states["minecraft:cardinal_direction"]];
      assert.ok(tx + bx >= 0 && tx + bx < TPC && tz + bz >= 0 && tz + bz < TPC, `(${cx},${cz}) 背中側の壁がセルの外`);
      const back = m[(tz + bz) * TPC + (tx + bx)];
      assert.ok(back === config.W_FULL || back === config.W_GAP, `(${cx},${cz}) ${d.id} の背中側が値 ${back}`);
      const col = d.bx + "," + d.bz;
      assert.ok(!cols.has(col), `(${cx},${cz}) 同じ列に小物が2つ`);
      cols.add(col);
    }
  }
  console.log(`      壁 ${wall} / 天井 ${ceil} / 床 ${floor}`);
  assert.ok(wall > 1000 && ceil > 5000 && floor > 1000, "小物が少なすぎる（空振り）");
});

check("壁の小物は遺留品と出口のドアのタイルに置かれない（遺留品か出口のある全セル）", () => {
  let n = 0;
  for (let cz = -150; cz <= 150; cz++) for (let cx = -150; cx <= 150; cx++) {
    if (isHome(cx, cz)) continue;
    const busy = [layout.relicAt(cx, cz, SEED), layout.exitAt(cx, cz, SEED)].filter((it) => it && it.tx !== undefined);
    if (busy.length === 0) continue;
    for (const d of layout.decorAt(cx, cz, SEED)) {
      if (!WALL_DECOR.has(d.id)) continue;
      n++;
      for (const it of busy) {
        assert.ok(!((d.bx >> 1) === it.tx && (d.bz >> 1) === it.tz), `(${cx},${cz}) タイル (${it.tx},${it.tz}) に ${d.id}`);
      }
    }
  }
  console.log(`      遺留品か出口のあるセルの壁の小物 ${n} 個を照合`);
  assert.ok(n > 1000, `照合できた壁の小物が ${n} 個しかない`);
});

check("蛍光灯の種類: 拠点は全部 normal、他は flicker と dead がおよそ1割ずつ", () => {
  for (const l of layout.lightBlocks(0, 0, SEED)) assert.equal(l.kind, "normal");
  const c = { normal: 0, flicker: 0, dead: 0, manila: 0 };
  for (let cz = 1; cz < 60; cz++) for (let cx = 1; cx < 60; cx++) for (const l of layout.lightBlocks(cx, cz, SEED)) c[l.kind]++;
  const total = c.normal + c.flicker + c.dead;
  const pct = (k) => (c[k] / total) * 100;
  assert.ok(Math.abs(pct("flicker") - 10) < 2 && Math.abs(pct("dead") - 10) < 2, JSON.stringify(c));
});

// ---------------------------------------------------------------------------
// 10. 遺留品の追加（設計書 3.4）
// ---------------------------------------------------------------------------
console.log("10. 遺留品の追加 (設計書 3.4)");
check("7種の遺留品がすべて出て、落書きは壁を背にした1〜3枚", () => {
  const kinds = new Set();
  let graffiti = 0;
  for (let cz = -150; cz <= 150; cz++) for (let cx = -150; cx <= 150; cx++) {
    const r = layout.relicAt(cx, cz, SEED);
    if (!r) continue;
    kinds.add(r.kind);
    if (r.kind !== config.RELIC_GRAFFITI) continue;
    graffiti++;
    assert.ok(r.spots.length >= 1 && r.spots.length <= 3);
    const m = wallMask(cx, cz, SEED);
    const cols = new Set();
    for (const s of r.spots) {
      const tx = s.bx >> 1, tz = s.bz >> 1;
      assert.equal(m[tz * TPC + tx], 0);
      assert.ok(Math.max(Math.abs(tx - r.tx), Math.abs(tz - r.tz)) <= 3, "遺留品から遠すぎる");
      // 壁の小物と同じく、背中側のセル内のタイルが値1か3
      assert.equal(s.y, config.Y_AIR_MIN + 1);
      const [bx, bz] = FACING_BACK[s.states["minecraft:cardinal_direction"]];
      assert.ok(tx + bx >= 0 && tx + bx < TPC && tz + bz >= 0 && tz + bz < TPC, `(${cx},${cz}) 落書きの背中側がセルの外`);
      const back = m[(tz + bz) * TPC + (tx + bx)];
      assert.ok(back === config.W_FULL || back === config.W_GAP, `(${cx},${cz}) 落書きの背中側が値 ${back}`);
      const design = s.states["backrooms:design"];
      assert.ok(Number.isInteger(design) && design >= 0 && design <= 5, `図柄 ${design}`);
      assert.ok(!cols.has(s.bx + "," + s.bz), `(${cx},${cz}) 落書きが同じ列に2枚`);
      cols.add(s.bx + "," + s.bz);
    }
    // 壁の小物は落書きの列にも遺留品のタイルにも置かれない
    for (const d of layout.decorAt(cx, cz, SEED)) {
      if (!WALL_DECOR.has(d.id)) continue;
      assert.ok(!cols.has(d.bx + "," + d.bz), `(${cx},${cz}) 落書きの列に ${d.id}`);
      assert.ok(!((d.bx >> 1) === r.tx && (d.bz >> 1) === r.tz), `(${cx},${cz}) 遺留品のタイルに ${d.id}`);
    }
  }
  for (let k = 0; k < config.RELIC_KINDS; k++) assert.ok(kinds.has(k), `遺留品 ${k} が出ない`);
  assert.ok(graffiti > 10);
});

// ---------------------------------------------------------------------------
// 11. 状態名の突き合わせ（最終レビューで足した）
//
// これまでは目視と使い捨ての調査でしか確かめていなかった、layout.js が組み立てる
// states がブロック側（BackroomsBP/blocks/*.json）の宣言と一致していることを機械で確かめる。
// ブロックが受け付ける状態は description.states（キーと値の一覧）と、
// traits の enabled_states（cardinal_direction は north/east/south/west の4値固定）から集める。
// ---------------------------------------------------------------------------
console.log("11. 状態名の突き合わせ（最終レビューで足した）");

const CARDINAL_VALUES = new Set(["north", "east", "south", "west"]);

/** BackroomsBP/blocks/*.json を読み、identifier -> Map(状態名 -> { type, values: Set }) を組み立てる */
function loadBlockStates() {
  const dir = new URL("../BackroomsBP/blocks/", import.meta.url);
  const out = new Map();
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const j = JSON.parse(fs.readFileSync(new URL(name, dir), "utf8"));
    const desc = j["minecraft:block"]?.description;
    if (!desc?.identifier) continue;
    const states = new Map();
    for (const [k, vals] of Object.entries(desc.states || {})) {
      states.set(k, { type: typeof vals[0], values: new Set(vals) });
    }
    for (const trait of Object.values(desc.traits || {})) {
      for (const s of trait.enabled_states || []) {
        if (s === "minecraft:cardinal_direction") states.set(s, { type: "string", values: CARDINAL_VALUES });
      }
    }
    out.set(desc.identifier, states);
  }
  return out;
}

/** id に states を置いたとき、すべてのキー・型・値がブロック側の宣言どおりであることを確かめる */
function assertStatesMatch(id, states, blockStates, label) {
  const allowed = blockStates.get(id);
  assert.ok(allowed, `${label}: id ${id} が BackroomsBP/blocks に無い`);
  for (const [k, v] of Object.entries(states || {})) {
    const spec = allowed.get(k);
    assert.ok(spec, `${label}: ${id} は状態 ${k} を受け付けない`);
    assert.equal(typeof v, spec.type, `${label}: ${id} の ${k} の型が違う（${typeof v} だが ${spec.type} のはず）`);
    assert.ok(spec.values.has(v), `${label}: ${id} の ${k}=${JSON.stringify(v)} は許可された値でない`);
  }
}

check("decorAt / relicAt(...).spots / lightBlocks の flicker phase が、置く先のブロックの宣言と一致する", () => {
  const blockStates = loadBlockStates();
  const R = 60;
  let n = 0;
  for (let cz = -R; cz <= R; cz++) {
    for (let cx = -R; cx <= R; cx++) {
      for (const d of layout.decorAt(cx, cz, SEED)) {
        if (!d.states) continue;
        assertStatesMatch(d.id, d.states, blockStates, `decorAt(${cx},${cz})`);
        n++;
      }
      const relic = layout.relicAt(cx, cz, SEED);
      for (const s of relic?.spots ?? []) {
        assertStatesMatch(config.B_GRAFFITI, s.states, blockStates, `relicAt(${cx},${cz}).spots`);
        n++;
      }
      for (const l of layout.lightBlocks(cx, cz, SEED)) {
        if (l.kind !== "flicker") continue;
        assertStatesMatch(config.B_LIGHT_FLICKER, { [config.S_PHASE]: l.phase }, blockStates, `lightBlocks(${cx},${cz})`);
        n++;
      }
    }
  }
  assert.ok(n > 500, `状態つきの要素が ${n} 個しかなく検証にならない`);
});

// ---------------------------------------------------------------------------
// 12. マニラルーム（v0.4.0・INTERFACES.md 8.2）
// ---------------------------------------------------------------------------
console.log("12. マニラルーム (INTERFACES.md 8.2)");
const { LM_MANILA } = config;
const manilas = findLandmarks(LM_MANILA, Infinity, 150);
/** セル内のブロック (bx, bz) が部屋の中（ブロック 4..11） */
const inRoom = (bx, bz) => bx >= 4 && bx <= 11 && bz >= 4 && bz <= 11;

check("マニラルームは 1x1 セルで、ある程度の数が出る", () => {
  console.log(`      301x301 セル中 ${manilas.length} 部屋`);
  assert.ok(manilas.length >= 30, `マニラルームが ${manilas.length} 個しか見つからない`);
  for (const lm of manilas) assert.ok(lm.w === 1 && lm.h === 1 && !lm.normalWalls, `(${lm.ox},${lm.oz}) の大きさ ${lm.w}x${lm.h}`);
});

check("壁はタイル 1 と 6 の環で、戸口は角でない1タイルだけ。中と回廊には壁が無く、戸口の内と外は通れる", () => {
  const sides = new Set();
  for (const lm of manilas) {
    const m = wallMask(lm.ox, lm.oz, SEED);
    const doors = [];
    for (let tz = 0; tz < TPC; tz++) for (let tx = 0; tx < TPC; tx++) {
      const v = m[tz * TPC + tx];
      const ring = Math.max(Math.abs(tx - 3.5), Math.abs(tz - 3.5)) === 2.5;
      if (!ring) {
        assert.equal(v, W_NONE, `(${lm.ox},${lm.oz}) タイル (${tx},${tz}) に値 ${v}`);
        continue;
      }
      if (v === W_DOOR) doors.push([tx, tz]);
      else assert.equal(v, W_FULL, `(${lm.ox},${lm.oz}) 環のタイル (${tx},${tz}) が値 ${v}`);
    }
    assert.equal(doors.length, 1, `(${lm.ox},${lm.oz}) の戸口が ${doors.length} か所`);
    const [tx, tz] = doors[0];
    const onX = tx === 1 || tx === 6;
    const onZ = tz === 1 || tz === 6;
    assert.ok(onX !== onZ, `(${lm.ox},${lm.oz}) の戸口 (${tx},${tz}) が角にある`);
    // 戸口の外（回廊）と内（部屋）の隣のタイル
    const [ox, oz, ix, iz] = onX ? [tx === 1 ? 0 : 7, tz, tx === 1 ? 2 : 5, tz] : [tx, tz === 1 ? 0 : 7, tx, tz === 1 ? 2 : 5];
    assert.equal(m[oz * TPC + ox], W_NONE, `(${lm.ox},${lm.oz}) 戸口の外が塞がっている`);
    assert.equal(m[iz * TPC + ix], W_NONE, `(${lm.ox},${lm.oz}) 戸口の内が塞がっている`);
    sides.add(onX ? (tx === 1 ? "-X" : "+X") : tz === 1 ? "-Z" : "+Z");
  }
  assert.equal(sides.size, 4, `戸口の辺が ${[...sides]} にしか出ない`);
});

check("部屋の中は橙色の電灯が中央に1つだけで、蛍光灯は回廊にだけある", () => {
  for (const lm of manilas) {
    const lights = layout.lightBlocks(lm.ox, lm.oz, SEED);
    const inside = lights.filter((l) => inRoom(l.bx, l.bz));
    assert.equal(inside.length, 1, `(${lm.ox},${lm.oz}) 部屋の中の照明が ${inside.length} 個`);
    assert.deepEqual(inside[0], { bx: 8, bz: 8, kind: "manila" }, `(${lm.ox},${lm.oz}) 部屋の中の照明`);
    const m = wallMask(lm.ox, lm.oz, SEED);
    const outside = lights.filter((l) => !inRoom(l.bx, l.bz));
    assert.ok(outside.length > 0, `(${lm.ox},${lm.oz}) 回廊に蛍光灯が無い`);
    for (const l of outside) {
      assert.notEqual(l.kind, "manila", `(${lm.ox},${lm.oz}) 回廊に橙色の電灯`);
      assert.equal(m[(l.bz >> 1) * TPC + (l.bx >> 1)], W_NONE, `(${lm.ox},${lm.oz}) 蛍光灯 ${l.bx},${l.bz} が壁の上`);
    }
  }
  // マニラルーム以外には橙色の電灯が出ない
  for (let cz = -40; cz <= 40; cz++) for (let cx = -40; cx <= 40; cx++) {
    if (landmarkCovering(cx, cz, SEED)?.kind === LM_MANILA) continue;
    for (const l of layout.lightBlocks(cx, cz, SEED)) assert.notEqual(l.kind, "manila", `(${cx},${cz}) に橙色の電灯`);
  }
});

check("小物は部屋の中の壁の足元のコンセント1つだけで、部屋の中を向いている", () => {
  const facings = new Set();
  for (const lm of manilas) {
    const list = layout.decorAt(lm.ox, lm.oz, SEED);
    assert.equal(list.length, 1, `(${lm.ox},${lm.oz}) の小物が ${list.length} 個`);
    const [d] = list;
    assert.equal(d.id, config.B_OUTLET);
    assert.equal(d.y, config.Y_AIR_MIN);
    assert.ok(inRoom(d.bx, d.bz), `(${lm.ox},${lm.oz}) コンセント ${d.bx},${d.bz} が部屋の外`);
    // 背中側の隣のブロックが環の内側の列（3 か 12）で、そこは W_FULL のタイル
    const [bx, bz] = FACING_BACK[d.states[config.S_FACING]];
    const wx = d.bx + bx, wz = d.bz + bz;
    assert.ok(!inRoom(wx, wz) && (wx === 3 || wx === 12 || wz === 3 || wz === 12), `(${lm.ox},${lm.oz}) コンセントの背中 ${wx},${wz}`);
    assert.equal(wallMask(lm.ox, lm.oz, SEED)[(wz >> 1) * TPC + (wx >> 1)], W_FULL);
    facings.add(d.states[config.S_FACING]);
  }
  assert.equal(facings.size, 4, `コンセントの向きが ${[...facings]} にしか出ない`);
});

check("遺留品と出口のドアは置かれず、安全地帯で、暗区画にならない（出現率を 1 にして全セルを抽選に当てて確かめる）", () => {
  // 既定の出現率では、マニラルームの原点が遺留品の抽選に当たることがこの seed では無い（salt 間の相関）ので空振りになる
  const saved = { RELIC_RATE: T.RELIC_RATE, EXIT_RATE: T.EXIT_RATE };
  config.setTuning("RELIC_RATE", 1);
  config.setTuning("EXIT_RATE", 1);
  try {
    for (const lm of manilas) {
      assert.equal(layout.relicAt(lm.ox, lm.oz, SEED), null, `(${lm.ox},${lm.oz}) に遺留品`);
      assert.equal(layout.exitAt(lm.ox, lm.oz, SEED), null, `(${lm.ox},${lm.oz}) に出口`);
      assert.equal(layout.isSafeCell(lm.ox, lm.oz, SEED), true, `(${lm.ox},${lm.oz}) が安全地帯でない`);
      assert.equal(layout.isDarkCell(lm.ox, lm.oz, SEED), false, `(${lm.ox},${lm.oz}) が暗区画`);
    }
    // 空振りでないこと: 同じ設定で、通常セルには遺留品も出口も置かれる
    let placed = 0;
    for (let cx = 1; cx <= 20; cx++) if (!landmarkCovering(cx, 5, SEED) && layout.relicAt(cx, 5, SEED) && layout.exitAt(cx, 5, SEED)) placed++;
    assert.ok(placed > 10, `出現率 1 でも通常セルに遺留品と出口が ${placed} 個しか置かれない`);
  } finally {
    for (const [k, v] of Object.entries(saved)) config.setTuning(k, v);
  }
  assert.ok(manilas.some((lm) => variantOf(lm.ox, lm.oz, SEED) === V_DARK), "暗区画バリアントの上のマニラルームが無く検証にならない");
});

check("inManilaRoom は部屋の中（ブロック 4..11）だけ true。戸口・環・回廊・他のセルは false", () => {
  const neg = manilas.find((lm) => lm.ox < 0 && lm.oz < 0);
  assert.ok(neg, "負の座標のマニラルームが無い");
  for (const lm of [manilas[0], neg]) {
    for (let bz = 0; bz < 16; bz++) for (let bx = 0; bx < 16; bx++) {
      const x = lm.ox * 16 + bx + 0.7;
      const z = lm.oz * 16 + bz + 0.2;
      assert.equal(layout.inManilaRoom(x, z, SEED), inRoom(bx, bz), `(${lm.ox},${lm.oz}) ブロック ${bx},${bz}`);
    }
  }
  // マニラルーム以外のセルでは、同じブロック 4..11 でも false
  for (let cx = -30; cx <= 30; cx++) {
    if (landmarkCovering(cx, 3, SEED)?.kind === LM_MANILA) continue;
    assert.equal(layout.inManilaRoom(cx * 16 + 8.5, 3 * 16 + 8.5, SEED), false, `(${cx},3) が部屋の中になっている`);
  }
  assert.equal(layout.inManilaRoom(8.5, 8.5, SEED), false, "拠点が部屋の中になっている");
});

// ---------------------------------------------------------------------------
// 13. 穴と findLandmark（v0.5.0・INTERFACES.md 9.3）
// ---------------------------------------------------------------------------
console.log("13. 穴と findLandmark (INTERFACES.md 9.3)");
const { LM_PIT } = config;
const pits = findLandmarks(LM_PIT, Infinity, 150);

check("穴は 1x1 セル・通常の壁つきで、ある程度の数が出て、ほとんどのセルに穴が開く", () => {
  const holes = pits.filter((lm) => layout.pitAt(lm.ox, lm.oz, SEED));
  console.log(`      301x301 セル中 ${pits.length} セル、うち穴が開くもの ${holes.length}（候補が無く普通のセルになるもの ${pits.length - holes.length}）`);
  assert.ok(pits.length >= 30, `穴のセルが ${pits.length} 個しか見つからない`);
  for (const lm of pits) assert.ok(lm.w === 1 && lm.h === 1 && lm.normalWalls, `(${lm.ox},${lm.oz}) の形`);
  assert.ok(holes.length >= pits.length * 0.95, "穴の開かない穴のセルが多すぎる");
});

check("穴は 4x4 ブロック（2x2 タイル）で、全部壁の無いタイルの上、判定点 (8,8) を含まない。決定論的", () => {
  const spots = new Set();
  for (const lm of pits) {
    const h = layout.pitAt(lm.ox, lm.oz, SEED);
    if (!h) continue;
    assert.deepEqual(layout.pitAt(lm.ox, lm.oz, SEED), h);
    assert.ok(h.bx % 2 === 0 && h.bz % 2 === 0 && h.bx >= 0 && h.bz >= 0 && h.bx + 4 <= 16 && h.bz + 4 <= 16, `(${lm.ox},${lm.oz}) ${h.bx},${h.bz}`);
    assert.ok(!(h.bx <= 8 && 8 < h.bx + 4 && h.bz <= 8 && 8 < h.bz + 4), `(${lm.ox},${lm.oz}) の穴が判定点を含む`);
    const m = wallMask(lm.ox, lm.oz, SEED);
    for (let z = 0; z < 4; z++) for (let x = 0; x < 4; x++) {
      assert.equal(m[((h.bz + z) >> 1) * TPC + ((h.bx + x) >> 1)], W_NONE, `(${lm.ox},${lm.oz}) 穴が壁の下`);
    }
    spots.add(h.bx + "," + h.bz);
  }
  assert.ok(spots.size >= 10, `穴の位置が ${spots.size} 通りしか無い`);
  // 穴のセル以外は null
  for (let cx = -30; cx <= 30; cx++) {
    if (landmarkCovering(cx, 7, SEED)?.kind === LM_PIT) continue;
    assert.equal(layout.pitAt(cx, 7, SEED), null, `(${cx},7) に穴`);
  }
});

check("穴のセルの床の小物は穴の中に無く、縁が汚れている。遺留品と出口は置かれない", () => {
  let rim = 0;
  const saved = { RELIC_RATE: T.RELIC_RATE, EXIT_RATE: T.EXIT_RATE };
  config.setTuning("RELIC_RATE", 1);
  config.setTuning("EXIT_RATE", 1);
  try {
    for (const lm of pits) {
      const h = layout.pitAt(lm.ox, lm.oz, SEED);
      if (!h) continue;
      assert.equal(layout.relicAt(lm.ox, lm.oz, SEED), null, `(${lm.ox},${lm.oz}) に遺留品`);
      assert.equal(layout.exitAt(lm.ox, lm.oz, SEED), null, `(${lm.ox},${lm.oz}) に出口`);
      for (const d of layout.decorAt(lm.ox, lm.oz, SEED)) {
        if (d.y !== config.Y_FLOOR) continue;
        const inHole = d.bx >= h.bx && d.bx < h.bx + 4 && d.bz >= h.bz && d.bz < h.bz + 4;
        assert.ok(!inHole, `(${lm.ox},${lm.oz}) 穴の中に ${d.id}`);
        if (d.id === config.B_FLOOR_STAINED && d.bx >= h.bx - 1 && d.bx <= h.bx + 4 && d.bz >= h.bz - 1 && d.bz <= h.bz + 4) rim++;
      }
    }
  } finally {
    for (const [k, v] of Object.entries(saved)) config.setTuning(k, v);
  }
  assert.ok(rim > pits.length * 2, `穴の縁のシミが ${rim} 個しかない`);
});

check("findLandmark は半径内で最も近い原点を返す（総当たりと一致）。無ければ null", () => {
  const { LM_MANILA } = config;
  /** 総当たり: 半径内の全セルで、原点が (ox, oz) に一致する kind のランドマーク */
  const brute = (cx, cz, kind, r) => {
    let best = null;
    let bestD = Infinity;
    for (let oz = cz - r; oz <= cz + r; oz++) for (let ox = cx - r; ox <= cx + r; ox++) {
      const lm = landmarkCovering(ox, oz, SEED);
      if (!lm || lm.kind !== kind || lm.ox !== ox || lm.oz !== oz) continue;
      const d = Math.hypot(ox - cx, oz - cz);
      if (d < bestD) { bestD = d; best = { ox, oz }; }
    }
    return { best, bestD };
  };
  let n = 0;
  for (const [cx, cz] of [[0, 0], [37, -12], [-80, 55], [5, 120]]) {
    for (const kind of [LM_MANILA, LM_PIT, LM_ROOMS, LM_ATRIUM]) {
      const got = layout.findLandmark(cx, cz, kind, SEED, 20);
      const want = brute(cx, cz, kind, 20);
      if (want.best === null) { assert.equal(got, null); continue; }
      n++;
      assert.ok(got, `(${cx},${cz}) 種類 ${kind} が見つからない`);
      // 同じ距離の原点が複数あるときはどれでもよい
      assert.equal(Math.hypot(got.ox - cx, got.oz - cz), want.bestD, `(${cx},${cz}) 種類 ${kind}: ${JSON.stringify(got)} / ${JSON.stringify(want.best)}`);
      const lm = landmarkCovering(got.ox, got.oz, SEED);
      assert.ok(lm && lm.kind === kind && lm.ox === got.ox && lm.oz === got.oz);
    }
  }
  assert.ok(n >= 12, `照合できたのが ${n} 件`);
  assert.equal(layout.findLandmark(0, 0, LM_MANILA, SEED, 0), null, "半径 0 の拠点セルで見つかった");
  // 半径 48（長く歩くとマニラルーム）で、どこからでもほぼ見つかる
  let miss = 0;
  for (let i = 0; i < 20; i++) if (!layout.findLandmark(i * 97 - 900, i * 61 - 600, LM_MANILA, SEED, 48)) miss++;
  assert.equal(miss, 0, `半径 48 でマニラルームが見つからない場所が ${miss} か所`);
});

console.log(`\n成功 ${passed} 件 / 失敗 ${failures.length} 件`);
console.log(`壁被覆率: ${coverageReport}`);
for (const f of failures) console.log(`  NG  ${f.name}: ${f.message}`);
if (failures.length > 0) process.exitCode = 1;

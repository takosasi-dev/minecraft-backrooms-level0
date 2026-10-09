/**
 * layout1.js（Level 1）の純関数テスト（INTERFACES.md 9.2）
 *
 *   node tools/test_layout1.mjs
 *
 * test_layout.mjs と同じく、rng.js が import する @minecraft/server を ESM の resolve フックで最小スタブへ差し替える。
 * layout1.js / rng.js / config.js は書き換えない。seed はテストから直接渡す。
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
const L = await import(new URL("layout1.js", scripts).href);
const config = await import(new URL("config.js", scripts).href);

const { TUNING: T, TPC, TILE, CELL, W_NONE, W_DOOR, W_LOW, Y1_AIR_MAX, Y1_CEIL, L1_SPAWN, L1_HOME_CX, L1_HOME_CZ } = config;
const { tiles1, kind1, isSolid1, T_STAIR, T_REBAR, K_HOME, K_STAIRS, K_HALL, K_CORRIDOR, K_ROOM, STAIR1 } = L;

const SEED = 0x5eed1234 | 0;
const SEED2 = -998877 | 0;
const DIM_TOP = 31; // dimension/level1.json の min_y 0 + height_range 32 - 1

let passed = 0;
const failures = [];
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

const passable = (v) => v === W_NONE || v === W_DOOR || v === W_LOW || v === T_STAIR;
const R = 12; // 検査する範囲（セル）。-R..R
const cells = [];
for (let cz = -R; cz <= R; cz++) for (let cx = -R; cx <= R; cx++) cells.push([cx, cz]);
const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

// ---------------------------------------------------------------------------
console.log("1. 決定論性");
check("同じ入力なら同じ結果（呼ぶ順番を変えても）。seed が違えば変わる", () => {
  const snap = (cx, cz, seed) =>
    JSON.stringify([
      Array.from(tiles1(cx, cz, seed)),
      L.lightBlocks1(cx, cz, seed),
      L.puddles1(cx, cz, seed),
      L.crateAt1(cx, cz, seed),
      L.graffiti1(cx, cz, seed),
      L.stairsUpAt1(cx, cz, seed),
      L.maxY1(cx, cz, seed),
      L.describeCell1(cx, cz, seed),
    ]);
  const a = cells.map(([cx, cz]) => snap(cx, cz, SEED));
  const b = cells.slice().reverse().map(([cx, cz]) => snap(cx, cz, SEED)).reverse();
  assert.deepEqual(a, b);
  const c = cells.map(([cx, cz]) => snap(cx, cz, SEED2));
  const same = a.filter((s, i) => s === c[i]).length;
  assert.ok(same < cells.length / 10, `seed を変えても ${same} セルが同じ`);
});

check("layout1.js は @minecraft/server を import せず、layout1 / generator1 に Math.random と runInterval が無い", () => {
  const src1 = fs.readFileSync(new URL("layout1.js", scripts), "utf8");
  const src2 = fs.readFileSync(new URL("generator1.js", scripts), "utf8");
  assert.ok(!/from\s+["']@minecraft\/server["']/.test(src1), "layout1.js が @minecraft/server を import している");
  for (const [n, s] of [["layout1.js", src1], ["generator1.js", src2]]) {
    assert.ok(!/Math\.random/.test(s), `${n} に Math.random`);
    assert.ok(!/runInterval/.test(s), `${n} に runInterval`);
  }
});

// ---------------------------------------------------------------------------
console.log("2. 境目");
check("境目に接する帯（行・列 7、拠点以外は 1 も）に何も建てない = 戸口の両側が必ず通路", () => {
  for (const [cx, cz] of cells) {
    const g = tiles1(cx, cz, SEED);
    const home = kind1(cx, cz, SEED) === K_HOME;
    for (let k = 1; k < TPC; k++) {
      for (const [tx, tz] of [[7, k], [k, 7], ...(home ? [] : [[1, k], [k, 1]])]) {
        const v = g[tz * TPC + tx];
        assert.equal(v, W_NONE, `(${cx},${cz}) タイル ${tx},${tz} = ${v}`);
      }
    }
  }
});

check("壁のある境目は1本の線（持ち主のセルだけが描き、戸口 L1_DOOR_MIN..MAX 個）、開いた境目は柱だけ", () => {
  let walled = 0;
  let open = 0;
  for (const [cx, cz] of cells) {
    const k = kind1(cx, cz, SEED);
    if (k === K_HOME) continue; // 拠点の行 0 は階段室の北の壁。境目は開いていて、隣の帯は上の検査で空いている
    const g = tiles1(cx, cz, SEED);
    for (const [ox, oz, pick] of [
      [0, -1, (i) => g[i]],
      [-1, 0, (i) => g[i * TPC]],
    ]) {
      const other = kind1(cx + ox, cz + oz, SEED);
      const line = [];
      for (let i = 1; i < TPC; i++) line.push(pick(i));
      if (other === K_HOME || (k === K_HALL && other === K_HALL)) {
        open++;
        line.forEach((v, i) => assert.equal(isSolid1(v), i + 1 === 4, `(${cx},${cz}) 開いた境目の ${i + 1}`));
      } else {
        walled++;
        const doors = line.filter((v) => v === W_DOOR).length;
        assert.ok(line.every((v) => isSolid1(v) || v === W_DOOR), `(${cx},${cz}) 境目の線が欠けている`);
        assert.ok(doors >= T.L1_DOOR_MIN && doors <= T.L1_DOOR_MAX, `(${cx},${cz}) 戸口 ${doors}`);
      }
    }
    assert.ok(isSolid1(g[0]), `(${cx},${cz}) 角が柱になっていない`);
  }
  assert.ok(walled > 100 && open > 100, `壁 ${walled} / 開き ${open}`);
});

// ---------------------------------------------------------------------------
console.log("3. 閉じ込めない");
check("どのセルからも東西南北の隣へ直接抜けられ、範囲の通れるタイルは着地点から全部行ける", () => {
  const N = (2 * R + 1) * TPC;
  const grid = new Uint8Array(N * N);
  const idx = (gx, gz) => (gz + R * TPC) * N + (gx + R * TPC);
  for (const [cx, cz] of cells) {
    const g = tiles1(cx, cz, SEED);
    for (let i = 0; i < 64; i++) grid[idx(cx * TPC + (i % TPC), cz * TPC + Math.floor(i / TPC))] = passable(g[i]) ? 1 : 0;
  }
  const pass = (gx, gz) => grid[idx(gx, gz)] === 1;
  // 東の境目（隣の列 0）と南の境目（隣の行 0）を、両側の帯ごと通れる場所があるか
  for (const [cx, cz] of cells) {
    if (cx === R || cz === R) continue;
    let east = false;
    let south = false;
    for (let k = 0; k < TPC; k++) {
      const ex = (cx + 1) * TPC;
      if (pass(ex - 1, cz * TPC + k) && pass(ex, cz * TPC + k) && pass(ex + 1, cz * TPC + k)) east = true;
      const sz = (cz + 1) * TPC;
      if (pass(cx * TPC + k, sz - 1) && pass(cx * TPC + k, sz) && pass(cx * TPC + k, sz + 1)) south = true;
    }
    assert.ok(east, `(${cx},${cz}) から東へ抜けられない`);
    assert.ok(south, `(${cx},${cz}) から南へ抜けられない`);
  }
  const seen = new Uint8Array(N * N);
  const start = idx(L1_HOME_CX * TPC + 4, L1_HOME_CZ * TPC + 4);
  assert.equal(grid[start], 1, "拠点の着地点のタイルが通れない");
  const stack = [start];
  seen[start] = 1;
  let reached = 0;
  while (stack.length) {
    const p = stack.pop();
    reached++;
    const x = p % N;
    const z = (p - x) / N;
    for (const [dx, dz] of DIRS) {
      const nx = x + dx;
      const nz = z + dz;
      if (nx < 0 || nz < 0 || nx >= N || nz >= N) continue;
      const q = nz * N + nx;
      if (grid[q] && !seen[q]) {
        seen[q] = 1;
        stack.push(q);
      }
    }
  }
  const total = grid.reduce((a, b) => a + b, 0);
  assert.equal(reached, total, `着地点から ${total - reached} タイルに行けない`);
});

check("セルの中の通れるタイルはセルの中だけでもひとつながり（部屋・廊下・階段室が帯へ口を開けている）", () => {
  const byKind = {};
  for (const [cx, cz] of cells) {
    const g = tiles1(cx, cz, SEED);
    const k = kind1(cx, cz, SEED);
    const open = [];
    for (let i = 0; i < 64; i++) if (passable(g[i])) open.push(i);
    const seen = new Set([open[0]]);
    const st = [open[0]];
    while (st.length) {
      const p = st.pop();
      const x = p % TPC;
      const z = (p - x) / TPC;
      for (const [dx, dz] of DIRS) {
        const nx = x + dx;
        const nz = z + dz;
        if (nx < 0 || nz < 0 || nx >= TPC || nz >= TPC) continue;
        const q = nz * TPC + nx;
        if (passable(g[q]) && !seen.has(q)) {
          seen.add(q);
          st.push(q);
        }
      }
    }
    assert.equal(seen.size, open.length, `(${cx},${cz}) ${k} の中で分かれている`);
    byKind[k] = (byKind[k] ?? 0) + 1;
  }
  for (const k of [K_HOME, K_STAIRS, K_HALL, K_CORRIDOR, K_ROOM]) assert.ok(byKind[k] > 0, `${k} が1つも無い`);
});

// ---------------------------------------------------------------------------
console.log("4. 拠点と上り階段");
check("拠点: 階段がある・着地点は何も無いタイル・箱と絵が無い・着地点から段が見える・真上に蛍光灯", () => {
  const cx = L1_HOME_CX;
  const cz = L1_HOME_CZ;
  const tx = Math.floor((Math.floor(L1_SPAWN.x) - cx * CELL) / TILE);
  const tz = Math.floor((Math.floor(L1_SPAWN.z) - cz * CELL) / TILE);
  for (const seed of [SEED, SEED2, 1, 2, 3]) {
    assert.equal(L.hasStairs1(cx, cz, seed), true);
    assert.ok(L.stairsUpAt1(cx, cz, seed));
    const g = tiles1(cx, cz, seed);
    assert.equal(g[tz * TPC + tx], W_NONE, "着地点のタイル");
    assert.equal(L.crateAt1(cx, cz, seed), null, "拠点に箱");
    assert.equal(L.graffiti1(cx, cz, seed).length, 0, "拠点に絵");
    let z = tz - 1;
    while (z >= 0 && g[z * TPC + tx] !== T_STAIR) {
      assert.ok(!isSolid1(g[z * TPC + tx]), `着地点と段の間に壁 (${tx},${z})`);
      z--;
    }
    assert.ok(z >= 0, "着地点の北に段が無い");
    assert.ok(L.lightBlocks1(cx, cz, seed).some((l) => Math.floor(l.bx / TILE) === tx && Math.floor(l.bz / TILE) === tz), "着地点の真上が暗い");
  }
});

check("stairsUpAt1 の箱は段の上（天井の高さの段と踊り場の床の上）で下は壁が支える。maxY1 は箱の上を含む", () => {
  let n = 0;
  for (const [cx, cz] of cells) {
    const up = L.stairsUpAt1(cx, cz, SEED);
    assert.equal(up !== null, L.hasStairs1(cx, cz, SEED));
    if (!up) {
      assert.equal(L.maxY1(cx, cz, SEED), Y1_AIR_MAX);
      continue;
    }
    n++;
    const g = tiles1(cx, cz, SEED);
    assert.equal(up.y, Y1_CEIL + 1, "踊り場の足の高さ");
    assert.ok(up.x0 <= up.x1 && up.z0 <= up.z1);
    assert.ok(L.maxY1(cx, cz, SEED) >= up.y, "maxY1 が踊り場より低い");
    assert.ok(L.maxY1(cx, cz, SEED) < STAIR1.ROOF_Y && STAIR1.ROOF_Y <= DIM_TOP, "ふたの高さ");
    for (let z = up.z0; z <= up.z1; z++) {
      const lz = z - cz * CELL;
      assert.ok(lz >= 0 && lz < CELL);
      for (let x = up.x0; x <= up.x1; x++) {
        const lx = x - cx * CELL;
        assert.ok(isSolid1(g[Math.floor(lz / TILE) * TPC + Math.floor(lx / TILE)]), `箱の下が壁でない (${lx},${lz})`);
      }
      const before = up.x0 - cx * CELL - 1;
      assert.equal(g[Math.floor(lz / TILE) * TPC + Math.floor(before / TILE)], T_STAIR, "箱の手前が段でない");
    }
    // 最後の段（高さ Y1_AIR_MAX）の次の列が箱の x0
    assert.equal(up.x0 - cx * CELL, STAIR1.STEP_X0 + (Y1_AIR_MAX - 1) + 1);
  }
  assert.ok(n > 0, "階段のセルが無い");
});

// ---------------------------------------------------------------------------
console.log("5. 小物");
check("判定点は水たまりにならない・蛍光灯は壁と段の上に付かない・絵は壁に貼る・箱は何も無いタイル", () => {
  for (const [cx, cz] of cells) {
    const g = tiles1(cx, cz, SEED);
    const t = (bx, bz) => g[Math.floor(bz / TILE) * TPC + Math.floor(bx / TILE)];
    for (const p of L.puddles1(cx, cz, SEED)) {
      assert.ok(!(p.bx === CELL / 2 && p.bz === CELL / 2), `(${cx},${cz}) 判定点が水たまり`);
      assert.ok(p.bx >= 0 && p.bx < CELL && p.bz >= 0 && p.bz < CELL);
    }
    const lights = L.lightBlocks1(cx, cz, SEED);
    assert.equal(lights.length % 2, 0, "管は2ブロック");
    for (const l of lights) assert.ok(!isSolid1(t(l.bx, l.bz)) && t(l.bx, l.bz) !== T_STAIR, `(${cx},${cz}) 壁か段の上に蛍光灯`);
    for (const s of L.graffiti1(cx, cz, SEED)) {
      assert.equal(t(s.bx, s.bz), W_NONE);
      const d = { south: [0, -1], north: [0, 1], east: [-1, 0], west: [1, 0] }[s.facing];
      const wx = s.bx + d[0];
      const wz = s.bz + d[1];
      assert.ok(wx >= 0 && wx < CELL && wz >= 0 && wz < CELL && isSolid1(t(wx, wz)), `(${cx},${cz}) 絵の裏が壁でない`);
      assert.ok(s.design >= 0 && s.design < 6);
    }
    const c = L.crateAt1(cx, cz, SEED);
    if (c) assert.equal(t(c.x - cx * CELL, c.z - cz * CELL), W_NONE, `(${cx},${cz}) 箱の場所`);
  }
});

check("describeCell1 は日本語と ASCII だけ", () => {
  for (const [cx, cz] of cells.slice(0, 200)) {
    for (const line of L.describeCell1(cx, cz, SEED)) {
      assert.ok(/^[\x20-\x7e぀-ヿ一-鿿]*$/.test(line), `記号が混じっている: ${line}`);
    }
  }
});

// ---------------------------------------------------------------------------
console.log("6. 出現率（TUNING の L1_ に沿う）");
const stats = {};
check("種類・階段・箱・蛍光灯・水たまり・鉄筋が TUNING に沿う（100x100 セル）", () => {
  const S = 50;
  let n = 0;
  let stairs = 0;
  let crate = 0;
  const kinds = {};
  let lightTiles = 0;
  let lightEligible = 0;
  let puddleCells = 0;
  let solid = 0;
  let rebar = 0;
  for (let cz = -S; cz < S; cz++) {
    for (let cx = -S; cx < S; cx++) {
      if (cx === L1_HOME_CX && cz === L1_HOME_CZ) continue;
      n++;
      const k = kind1(cx, cz, SEED);
      kinds[k] = (kinds[k] ?? 0) + 1;
      if (k === K_STAIRS) stairs++;
      if (L.crateAt1(cx, cz, SEED)) crate++;
      const g = tiles1(cx, cz, SEED);
      const sw = L.stairwell1(cx, cz, SEED);
      for (let i = 0; i < 64; i++) {
        const tx = i % TPC;
        const tz = (i - tx) / TPC;
        if (isSolid1(g[i])) {
          solid++;
          if (g[i] === T_REBAR) rebar++;
          continue;
        }
        if (sw && tx >= 2 && tx <= 6 && tz >= sw.r0 && tz <= sw.r0 + 3) continue;
        lightEligible++;
      }
      lightTiles += L.lightBlocks1(cx, cz, SEED).length / 2;
      if (L.puddles1(cx, cz, SEED).length > 0) puddleCells++;
    }
  }
  const near = (got, want, tol, label) => assert.ok(Math.abs(got - want) <= want * tol, `${label}: ${got.toFixed(4)}（期待 ${want.toFixed(4)}）`);
  near(stairs / n, 1 / T.L1_STAIRS_RATE, 0.25, "上り階段");
  near(crate / n, 1 / T.L1_CRATE_RATE, 0.15, "物資の箱");
  const rest = n - stairs;
  near(kinds[K_HALL] / rest, T.L1_HALL_RATE / 100, 0.08, "広間");
  near(kinds[K_CORRIDOR] / rest, T.L1_CORRIDOR_RATE / 100, 0.1, "廊下");
  near(kinds[K_ROOM] / rest, (100 - T.L1_HALL_RATE - T.L1_CORRIDOR_RATE) / 100, 0.1, "部屋");
  near(lightTiles / lightEligible, T.L1_LIGHT_RATE / 100, 0.08, "蛍光灯");
  near(rebar / solid, T.L1_REBAR_RATE / 100, 0.08, "鉄筋");
  // 水たまりの数は 0..L1_PUDDLE_MAX の一様 → 1つ以上あるセルは MAX/(MAX+1)
  near(puddleCells / n, T.L1_PUDDLE_MAX / (T.L1_PUDDLE_MAX + 1), 0.08, "水たまりのあるセル");
  Object.assign(stats, { n, crate, kinds, light: lightTiles / lightEligible, rebar: rebar / solid, puddle: puddleCells / n });
});

check("setTuning で率を変えるとすぐ効く（L1_STAIRS_RATE 1 で全部階段、L1_CRATE_RATE 1 で拠点以外に全部箱）", () => {
  const saved = { L1_STAIRS_RATE: T.L1_STAIRS_RATE, L1_CRATE_RATE: T.L1_CRATE_RATE };
  try {
    config.setTuning("L1_STAIRS_RATE", 1);
    config.setTuning("L1_CRATE_RATE", 1);
    for (let cx = 1; cx <= 30; cx++) {
      assert.equal(kind1(cx, 3, SEED), K_STAIRS);
      assert.ok(L.crateAt1(cx, 3, SEED));
    }
  } finally {
    for (const [k, v] of Object.entries(saved)) config.setTuning(k, v);
  }
});

console.log(`\n成功 ${passed} 件 / 失敗 ${failures.length} 件`);
if (stats.n) {
  const pct = (k) => (((stats.kinds[k] ?? 0) / stats.n) * 100).toFixed(1);
  console.log(
    `実測（${stats.n} セル）: 広間 ${pct(K_HALL)}% / 廊下 ${pct(K_CORRIDOR)}% / 部屋 ${pct(K_ROOM)}% / 階段 ${pct(K_STAIRS)}% / ` +
      `箱 ${((stats.crate / stats.n) * 100).toFixed(1)}% / 水たまりのあるセル ${(stats.puddle * 100).toFixed(1)}% / ` +
      `蛍光灯（タイル） ${(stats.light * 100).toFixed(1)}% / 鉄筋（壁タイル） ${(stats.rebar * 100).toFixed(1)}%`,
  );
}
for (const f of failures) console.log(`  NG  ${f.name}: ${f.message}`);
if (failures.length > 0) process.exitCode = 1;

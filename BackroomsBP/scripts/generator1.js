/**
 * Level 1 のセル生成（INTERFACES.md 9.2）
 *
 * Level 1 でブロックを置く唯一の場所。「どこに何があるか」は layout1.js に聞き、ここでは位置を決めない。
 * 物資の箱の中身だけはここで hash32 から決める（relics.js の物資チェストと同じ扱い。地形生成用でない乱数も使わない = 15章）。
 *
 * 完了マーカー（7.3）は generator.js と同じ: 床の fill は判定点 (cx*16+8, 0, cz*16+8) を外し、
 * すべて書き終えた最後にそこへ B1_FLOOR を置く。途中で例外が出たら次の周期で作り直される。
 * resolvePerm / placeBlock は generator.js から export されていないので、同じ作法でここに書く（generator.js は触らない）
 */

import { BlockPermutation, BlockVolume, ItemStack } from "@minecraft/server";
import {
  B1_WALL,
  B1_FLOOR,
  B1_CEIL,
  B1_LIGHT,
  B1_REBAR,
  B1_PUDDLE,
  B_GRAFFITI,
  S_FACING,
  S_DESIGN,
  I_ALMOND,
  CELL,
  TILE,
  TPC,
  Y1_FLOOR,
  Y1_AIR_MIN,
  Y1_AIR_MAX,
  Y1_CEIL,
  W_FULL,
  W_LOW,
  W_DOOR,
} from "./config.js";
import { tiles1, stairwell1, lightBlocks1, puddles1, crateAt1, graffiti1, STAIR1, T_REBAR } from "./layout1.js";
import { hash32, SALT } from "./rng.js";

/** 未ロードチャンクは無視して続行する（7.4）。fillBlocks には必ずこれを渡す */
const FILL_OPT = { ignoreChunkBoundErrors: true };
const AIR = "minecraft:air";
/** コンクリートの階段の代わり（バニラの階段でよい = 9.2）。灰色の石で打ちっぱなしに寄せる */
const STAIR = "minecraft:polished_andesite_stairs";
/** +X 方向へ上る段の向き（generator.js の STAIR_DIR_PLUS_X と同じ値）。実機で逆に見えたらここだけ 1 にする */
const STAIR_DIR_PLUS_X = 0;
const BARREL = "minecraft:barrel";

/** fillBlocks の薄いラッパ。runCommand('fill') は使わない（15章） */
function fill(dim, x0, y0, z0, x1, y1, z1, block) {
  dim.fillBlocks(new BlockVolume({ x: x0, y: y0, z: z0 }, { x: x1, y: y1, z: z1 }), block, FILL_OPT);
}

/** generator.js の resolvePerm と同じ作法。失敗（undefined）も覚えるので警告はキーごとに1回 */
const permCache = new Map();
function resolvePerm(id, states) {
  const key = id + JSON.stringify(states ?? null);
  if (!permCache.has(key)) permCache.set(key, resolveFresh(id, states));
  return permCache.get(key);
}
function resolveFresh(id, states) {
  try {
    return BlockPermutation.resolve(id, states);
  } catch (e) {
    if (states) {
      try {
        const plain = BlockPermutation.resolve(id);
        console.warn(`[backrooms] level1 block states rejected, placed plain: ${id} (${e})`);
        return plain;
      } catch {
        /* 下の警告へ落ちる */
      }
    }
    console.warn(`[backrooms] level1 block failed ${id}: ${e}`);
    return undefined;
  }
}

/** 形が決まらないものは飛ばす。置く場所の失敗（未ロード）は投げる = 判定点が置かれず次の周期で作り直し */
function placeBlock(dim, x, y, z, id, states) {
  const perm = resolvePerm(id, states);
  if (perm) dim.setBlockPermutation({ x, y, z }, perm);
  return perm !== undefined;
}

function markerPos(cx, cz) {
  return { x: cx * CELL + CELL / 2, y: Y1_FLOOR, z: cz * CELL + CELL / 2 };
}

/** 判定点が B1_FLOOR なら生成済み。未ロード・範囲外は未生成 */
export function isCellGenerated1(dim, cx, cz) {
  try {
    const block = dim.getBlock(markerPos(cx, cz));
    return block !== undefined && block.typeId === B1_FLOOR;
  } catch {
    return false;
  }
}

/** 足元に床があり、足と頭の高さが空いている（水は入れる）柱か。着地・救出が使う */
export function standable1(dim, x, z) {
  try {
    const floor = dim.getBlock({ x, y: Y1_FLOOR, z });
    const feet = dim.getBlock({ x, y: Y1_AIR_MIN, z });
    const head = dim.getBlock({ x, y: Y1_AIR_MIN + 1, z });
    const open = (b) => b !== undefined && (b.isAir || b.isLiquid);
    return floor !== undefined && !floor.isAir && !floor.isLiquid && open(feet) && open(head);
  } catch {
    return false;
  }
}

/** 床を判定点の1ブロックだけ残して敷く（generator.js の fillFloorExcept と同じ4分割） */
function* fillFloorExcept(dim, cx, cz) {
  const x0 = cx * CELL;
  const z0 = cz * CELL;
  const x1 = x0 + CELL - 1;
  const z1 = z0 + CELL - 1;
  const mx = x0 + CELL / 2;
  const mz = z0 + CELL / 2;
  fill(dim, x0, Y1_FLOOR, z0, x1, Y1_FLOOR, mz - 1, B1_FLOOR);
  yield;
  fill(dim, x0, Y1_FLOOR, mz + 1, x1, Y1_FLOOR, z1, B1_FLOOR);
  yield;
  fill(dim, x0, Y1_FLOOR, mz, mx - 1, Y1_FLOOR, mz, B1_FLOOR);
  yield;
  fill(dim, mx + 1, Y1_FLOOR, mz, x1, Y1_FLOOR, mz, B1_FLOOR);
  yield;
}

/** タイルの値ごとの [下端, 上端, ブロック]。T_STAIR / W_NONE は置かない */
const WALL_SPAN = {
  [W_FULL]: [Y1_AIR_MIN, Y1_AIR_MAX, B1_WALL],
  [T_REBAR]: [Y1_AIR_MIN, Y1_AIR_MAX, B1_REBAR],
  [W_LOW]: [Y1_AIR_MIN, Y1_AIR_MIN, B1_WALL],
  [W_DOOR]: [Y1_AIR_MIN + 3, Y1_AIR_MAX, B1_WALL], // 戸口は高さ3の口と鴨居
};

/** 壁。横に続く同じ値のタイルは1回の fill にまとめ、壁のあった行ごとに yield（generator.js と同じ粒度） */
function* fillWalls(dim, cx, cz, g) {
  const x0 = cx * CELL;
  const z0 = cz * CELL;
  for (let tz = 0; tz < TPC; tz++) {
    let placed = false;
    for (let tx = 0; tx < TPC; ) {
      const v = g[tz * TPC + tx];
      let end = tx + 1;
      while (end < TPC && g[tz * TPC + end] === v) end++;
      const span = WALL_SPAN[v];
      if (span) {
        fill(dim, x0 + tx * TILE, span[0], z0 + tz * TILE, x0 + end * TILE - 1, span[1], z0 + tz * TILE + TILE - 1, span[2]);
        placed = true;
      }
      tx = end;
    }
    if (placed) yield;
  }
}

/**
 * 上り階段（layout1.js の STAIR1 の形）。段を +X へ Y1_AIR_MIN..Y1_AIR_MAX まで積み、天井の高さの段と踊り場の床を置く。
 * 天井に穴を開け、その上を壁とふたで囲う（踊り場の上は閉じた行き止まり。上りきると Ⓑ が Level 0 へ送る）
 */
function* buildStairs(dim, cx, cz, sw) {
  const x0 = cx * CELL;
  const za = cz * CELL + (sw.r0 + 1) * TILE; // 段の幅（Z）
  const zb = za + 2 * TILE - 1;
  const S = STAIR1;
  const stair = resolvePerm(STAIR, { weirdo_direction: STAIR_DIR_PLUS_X, upside_down_bit: false });

  fill(dim, x0 + S.HOLE_X0, Y1_CEIL, za, x0 + S.HOLE_X1, Y1_CEIL, zb, AIR); // 天井の穴
  yield;
  // 吹き抜けの囲い（天井より上）と、ふた
  fill(dim, x0 + S.SHAFT_X0, Y1_CEIL + 1, za - 1, x0 + S.SHAFT_X1, S.ROOF_Y - 1, za - 1, B1_WALL);
  fill(dim, x0 + S.SHAFT_X0, Y1_CEIL + 1, zb + 1, x0 + S.SHAFT_X1, S.ROOF_Y - 1, zb + 1, B1_WALL);
  fill(dim, x0 + S.SHAFT_X0, Y1_CEIL + 1, za, x0 + S.SHAFT_X0, S.ROOF_Y - 1, zb, B1_WALL);
  fill(dim, x0 + S.SHAFT_X1, Y1_CEIL + 1, za, x0 + S.SHAFT_X1, S.ROOF_Y - 1, zb, B1_WALL);
  yield;
  fill(dim, x0 + S.SHAFT_X0, S.ROOF_Y, za - 1, x0 + S.SHAFT_X1, S.ROOF_Y, zb + 1, B1_CEIL);
  yield;
  if (stair) {
    for (let i = 0; Y1_AIR_MIN + i <= Y1_AIR_MAX; i++) {
      const y = Y1_AIR_MIN + i;
      fill(dim, x0 + S.STEP_X0 + i, y, za, x0 + S.STEP_X0 + i, y, zb, stair);
      if (i % 2 === 1) yield;
    }
    fill(dim, x0 + S.TOP_STEP_X, Y1_CEIL, za, x0 + S.TOP_STEP_X, Y1_CEIL, zb, stair);
  }
  fill(dim, x0 + S.LANDING_X, Y1_CEIL, za, x0 + S.LANDING_X, Y1_CEIL, zb, B1_FLOOR); // 踊り場の床
  yield;
}

/** 蛍光灯と水たまり。4つごとに yield */
function* placeList(dim, cx, cz, list, y, id) {
  const x0 = cx * CELL;
  const z0 = cz * CELL;
  let n = 0;
  for (const b of list) {
    placeBlock(dim, x0 + b.bx, y, z0 + b.bz, id);
    if (++n % 4 === 0) yield;
  }
  if (n % 4 !== 0) yield;
}

function* placeGraffiti(dim, cx, cz, seed) {
  const list = graffiti1(cx, cz, seed);
  if (list.length === 0) return;
  for (const s of list) {
    placeBlock(dim, cx * CELL + s.bx, s.y, cz * CELL + s.bz, B_GRAFFITI, { [S_FACING]: s.facing, [S_DESIGN]: s.design });
  }
  yield;
}

// ---- 物資の箱（Wiki: 重要な物と無意味な物が同時に入っている）----
// 鉄やダイヤ級は入れない。名前（nameTag）はゲーム内に出るので日本語だけ
const CRATE_USEFUL = [
  { id: "minecraft:bread", min: 1, max: 4 },
  { id: "minecraft:apple", min: 1, max: 4 },
  { id: "minecraft:torch", min: 2, max: 8 },
  { id: "minecraft:paper", min: 1, max: 3, name: "包帯にする紙" },
  { id: "minecraft:redstone", min: 1, max: 2, name: "電池" },
];
const CRATE_USELESS = [
  { id: "minecraft:red_dye", min: 1, max: 3, name: "クレヨン" },
  { id: "minecraft:blue_dye", min: 1, max: 3, name: "クレヨン" },
  { id: "minecraft:yellow_dye", min: 1, max: 3, name: "クレヨン" },
  { id: "minecraft:gold_nugget", min: 1, max: 5, name: "小銭" },
  { id: "minecraft:string", min: 1, max: 2, name: "靴ひも" },
  { id: "minecraft:paper", min: 1, max: 2, name: "焼けた紙" },
];

/** startSlot から順に空きスロットへ入れる（relics.js の putItem と同じ）。アイテムが無い（パック漏れ）ときは警告して飛ばす */
function putItem(container, startSlot, entry, amount) {
  try {
    for (let i = 0; i < container.size; i++) {
      const slot = (startSlot + i) % container.size;
      if (container.getItem(slot)) continue;
      const stack = new ItemStack(entry.id, amount);
      if (entry.name) stack.nameTag = entry.name;
      container.setItem(slot, stack);
      return;
    }
  } catch (e) {
    console.warn(`[backrooms] level1 crate item failed ${entry.id}: ${e}`);
  }
}

/** プールから重複なしで n 種類を選んで入れる。乱数は (x, z) と salt の添字だけ */
function fillFrom(container, pool, n, x, z, salt, seed) {
  const left = pool.slice();
  for (let i = 0; i < n && left.length > 0; i++) {
    const v = hash32(x + i, z, salt + i, seed);
    const e = left.splice(v % left.length, 1)[0];
    putItem(container, (v >>> 8) % container.size, e, e.min + ((v >>> 16) % (e.max - e.min + 1)));
  }
}

function* placeCrate(dim, cx, cz, seed) {
  const c = crateAt1(cx, cz, seed);
  if (!c) return;
  const y = Y1_AIR_MIN;
  if (!placeBlock(dim, c.x, y, c.z, BARREL, { facing_direction: 1, open_bit: false })) return;
  yield;
  let container;
  try {
    container = dim.getBlock({ x: c.x, y, z: c.z })?.getComponent("minecraft:inventory")?.container;
  } catch (e) {
    console.warn(`[backrooms] level1 crate container failed @ ${c.x},${y},${c.z}: ${e}`);
  }
  if (!container) return;
  container.clearAll(); // 判定点を置く前に失敗して作り直すと、中身が二重に入る（最終レビュー 軽微-8）
  const v = hash32(c.x, c.z, SALT.L1_CRATE_ITEMS, seed);
  fillFrom(container, CRATE_USEFUL, 1 + (v % 2), c.x, c.z, SALT.L1_CRATE_ITEMS + 1, seed); // 1〜2種類
  fillFrom(container, CRATE_USELESS, 1 + ((v >>> 4) % 3), c.x, c.z, SALT.L1_CRATE_ITEMS + 10, seed); // 1〜3種類
  putItem(container, (v >>> 8) % container.size, { id: I_ALMOND }, 1); // アーモンドウォーターは必ず1本
  yield;
}

/** セル1つ分の生成ジョブ。system.runJob に渡す */
export function* generateCellJob1(dim, cx, cz, seed) {
  const g = tiles1(cx, cz, seed);
  yield* fillFloorExcept(dim, cx, cz);
  fill(dim, cx * CELL, Y1_CEIL, cz * CELL, cx * CELL + CELL - 1, Y1_CEIL, cz * CELL + CELL - 1, B1_CEIL);
  yield;
  yield* fillWalls(dim, cx, cz, g);
  yield* placeList(dim, cx, cz, lightBlocks1(cx, cz, seed), Y1_CEIL, B1_LIGHT);
  const sw = stairwell1(cx, cz, seed);
  if (sw) yield* buildStairs(dim, cx, cz, sw);
  yield* placeList(dim, cx, cz, puddles1(cx, cz, seed), Y1_FLOOR, B1_PUDDLE);
  yield* placeGraffiti(dim, cx, cz, seed);
  yield* placeCrate(dim, cx, cz, seed);
  dim.setBlockPermutation(markerPos(cx, cz), resolvePerm(B1_FLOOR)); // 完了マーカー（7.3）。最後に置く
}

/**
 * 床より上を air に戻す（/backrooms:regen 用）。床（Y1_FLOOR）は残す（generator.js の clearCellJob と同じ理由）。
 * 樽の中身は fillBlocks で消える（落ちない）
 */
export function* clearCellJob1(dim, cx, cz) {
  const x0 = cx * CELL;
  const z0 = cz * CELL;
  const max = dim.heightRange.max - 1; // max は上端を含まない値（最終レビュー 中-4。越えて fill すると例外でジョブが止まる）
  const slab = 8; // fillBlocks 1回を 16x16x8 = 2048 ブロックに抑える（Q-5）
  for (let y = Y1_AIR_MIN; y <= max; y += slab) {
    fill(dim, x0, y, z0, x0 + CELL - 1, Math.min(y + slab - 1, max), z0 + CELL - 1, AIR);
    yield;
  }
}

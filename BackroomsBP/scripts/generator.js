/**
 * セル生成エンジン（仕様書 6.1 / 6.7 / 7.2 / 7.3 / 7.4 / 16.1）
 *
 * ここはブロックを置く唯一の場所。「どこに何があるか」は layout.js に聞き、
 * このファイルでは乱数を引かない（壁・照明・遺留品の位置は決めない）。
 *
 * このファイルで一番壊しやすいのは完了マーカー（7.3）。
 * 床の fill は判定点 (cx*16+8, 0, cz*16+8) を必ず除外し、
 * すべて書き終えた最後に setBlockPermutation でそこへ床を置く。
 * 途中で例外が出たらマーカーは置かれず、次の周期で未生成として再検出される（自己修復）。
 */

import { BlockPermutation, BlockVolume } from "@minecraft/server";
import {
  B_CEILING,
  B_EXIT,
  B_FLOOR,
  B_LIGHT,
  B_LIGHT_FLICKER,
  B_LIGHT_DEAD,
  B_OUTLET,
  B_SWITCH,
  B_EXIT_SIGN,
  B_WALL,
  B_MANILA_WALL,
  B_MANILA_BORDER,
  B_MANILA_LIGHT,
  S_PHASE,
  CELL,
  TILE,
  TPC,
  Y_FLOOR,
  Y_AIR_MIN,
  Y_AIR_MAX,
  Y_CEIL,
  LM_ATRIUM,
  LM_WATER,
  LM_STAIRS,
  LM_MANILA,
  W_FULL,
  W_LOW,
  W_GAP,
  W_DOOR,
} from "./config.js";
import { decorAt, exitAt, landmarkCovering, lightBlocks, pitAt, relicAt, wallMask, MANILA_ROOM, PIT_SIZE } from "./layout.js";
import { hash32, SALT } from "./rng.js";
import { placeRelic } from "./relics.js";

/** 未ロードチャンクは無視して続行する（7.4）。fillBlocks には必ずこれを渡す */
const FILL_OPT = { ignoreChunkBoundErrors: true };

const AIR = "minecraft:air";
/** 水源ブロック。liquid_depth 0 が水源（6.7 水区画） */
const WATER = "minecraft:water";
/** 階段ランドマークの段（6.7）。バニラ階段でよい、と仕様書が明示している */
const STAIR = "minecraft:stone_brick_stairs";
/**
 * +X 方向へ上る段の向き。実機で向きが逆に見えたらここだけ 1 にする。
 * 逆でも段差としては登れるので致命的にはならない。
 */
const STAIR_DIR_PLUS_X = 0;

/**
 * 生成側が持つのは構造上の定数だけ。
 * 調整で触る数値（巨大空間の照明率・柱の本数など）は TUNING 側にある（FR-19 / 15章）。
 */
/** 階段ランドマークの吹き抜けのふた（天井）の Y。最上段 Y_top の頭上に余裕を取る */
const STAIRS_ROOF = 18;

let permFloor;
let permWater;
let permStair;
/** カスタムブロックはスクリプト読み込み時にはまだ解決できないので遅延させる */
function floorPerm() {
  return (permFloor ??= BlockPermutation.resolve(B_FLOOR));
}
function waterPerm() {
  return (permWater ??= BlockPermutation.resolve(WATER, { liquid_depth: 0 }));
}
function stairPerm() {
  return (permStair ??= BlockPermutation.resolve(STAIR, {
    weirdo_direction: STAIR_DIR_PLUS_X,
    upside_down_bit: false,
  }));
}

/** fillBlocks の薄いラッパ。runCommand('fill') は使わない（15章） */
function fill(dim, x0, y0, z0, x1, y1, z1, block) {
  dim.fillBlocks(new BlockVolume({ x: x0, y: y0, z: z0 }, { x: x1, y: y1, z: z1 }), block, FILL_OPT);
}

/**
 * resolvePerm の結果。キーは id と状態。状態なしに落とした結果も、解決できなかったこと（undefined）も覚えるので、
 * 状態名が食い違っていても警告はキーごとに1回で済む（全セルの全小物で1件ずつ出さない）。
 * この記憶は失敗（undefined）も対象なので、一度解決に失敗した id・状態の組は、ワールドを再読み込みするまで
 * そのセッション中ずっと置かれなくなる（resolveFresh がもう一度呼ばれることはない）。
 */
const permCache = new Map();

/**
 * ブロックの形を決める。状態で弾かれたら状態なしで置き直して警告する（relics.js の setBlock と同じ）。
 * ブロックそのものが解決できない（パックの読み込み漏れ）ときは警告して undefined
 */
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
        console.warn(`[backrooms] block states rejected, placed plain: ${id} (${e})`);
        return plain;
      } catch {
        /* 下の警告へ落ちる */
      }
    }
    console.warn(`[backrooms] block failed ${id}: ${e}`);
    return undefined;
  }
}

/**
 * 蛍光灯・小物を1つ置く。形が決まらないものは飛ばす（セルごと作り直しても直らないため）。
 * 置く場所の失敗（未ロードのチャンク）は投げる。判定点を置かずにジョブが終わり、次の周期で作り直される（7.3）
 */
function placeBlock(dim, x, y, z, id, states) {
  const perm = resolvePerm(id, states);
  if (perm) dim.setBlockPermutation({ x, y, z }, perm);
}

/** 完了マーカーの座標（7.3） */
function markerPos(cx, cz) {
  return { x: cx * CELL + CELL / 2, y: Y_FLOOR, z: cz * CELL + CELL / 2 };
}

/** 判定点が床なら生成済み。未ロード・範囲外は「未生成」とみなす（7.3 / 7.4） */
export function isCellGenerated(dim, cx, cz) {
  try {
    const block = dim.getBlock(markerPos(cx, cz));
    return block !== undefined && block.typeId === B_FLOOR;
  } catch {
    return false;
  }
}

/**
 * 足元に床があり、足と頭の高さが空いている（水は入れる）柱か。
 * 救出・テレポートの着地点（portal.js）とエンティティの出現位置（entities.js）が使う
 */
export function standable(dim, x, z) {
  try {
    const floor = dim.getBlock({ x, y: Y_FLOOR, z });
    const feet = dim.getBlock({ x, y: Y_AIR_MIN, z });
    const head = dim.getBlock({ x, y: Y_AIR_MIN + 1, z });
    const open = (b) => b !== undefined && (b.isAir || b.isLiquid);
    return floor !== undefined && !floor.isAir && !floor.isLiquid && open(feet) && open(head);
  } catch {
    return false;
  }
}

/**
 * Y=0 の床を、判定点の1ブロックだけ残して敷く（7.3）。
 * 判定点はセル中央なので、4つの矩形に分ける必要がある。
 */
function* fillFloorExcept(dim, cx, cz) {
  const x0 = cx * CELL;
  const z0 = cz * CELL;
  const x1 = x0 + CELL - 1;
  const z1 = z0 + CELL - 1;
  const mx = x0 + CELL / 2;
  const mz = z0 + CELL / 2;
  fill(dim, x0, Y_FLOOR, z0, x1, Y_FLOOR, mz - 1, B_FLOOR);
  yield;
  fill(dim, x0, Y_FLOOR, mz + 1, x1, Y_FLOOR, z1, B_FLOOR);
  yield;
  fill(dim, x0, Y_FLOOR, mz, mx - 1, Y_FLOOR, mz, B_FLOOR);
  yield;
  fill(dim, mx + 1, Y_FLOOR, mz, x1, Y_FLOOR, mz, B_FLOOR);
  yield;
}

function* fillCeiling(dim, cx, cz, y) {
  const x0 = cx * CELL;
  const z0 = cz * CELL;
  fill(dim, x0, y, z0, x0 + CELL - 1, y, z0 + CELL - 1, B_CEILING);
  yield;
}

/** 壁の形ごとの高さ [下端, 上端]（設計書 3.1）。ceil はそのセルの天井の Y */
const WALL_SPAN = {
  [W_FULL]: (ceil) => [Y_AIR_MIN, ceil - 1],
  [W_LOW]: () => [Y_AIR_MIN, Y_AIR_MIN],
  [W_GAP]: (ceil) => [Y_AIR_MIN, ceil - 2],
  [W_DOOR]: (ceil) => [Y_AIR_MIN + 3, ceil - 1],
};

/**
 * wallMask の値0でないタイルに、形ごとの高さの壁を置く。
 * 横に連続する同じ形のタイルは1回の fill にまとめる（fillBlocks の呼び出し回数と体積を抑える = Q-5）。
 */
function* fillWalls(dim, cx, cz, seed, ceil) {
  const mask = wallMask(cx, cz, seed);
  const x0 = cx * CELL;
  const z0 = cz * CELL;
  for (let tz = 0; tz < TPC; tz++) {
    let placed = false;
    for (let tx = 0; tx < TPC; ) {
      const v = mask[tz * TPC + tx];
      let end = tx + 1;
      while (end < TPC && mask[tz * TPC + end] === v) end++;
      if (v) {
        const [y0, y1] = WALL_SPAN[v](ceil);
        fill(dim, x0 + tx * TILE, y0, z0 + tz * TILE, x0 + end * TILE - 1, y1, z0 + tz * TILE + TILE - 1, B_WALL);
        placed = true;
      }
      tx = end;
    }
    if (placed) yield; // 壁のあった行ごと（7.2）
  }
}

/** 蛍光灯の種類（layout の lightBlocks の kind）ごとのブロック */
const LIGHT_ID = { normal: B_LIGHT, flicker: B_LIGHT_FLICKER, dead: B_LIGHT_DEAD, manila: B_MANILA_LIGHT };

/** 蛍光灯。yield は4つごと（1つごとだと通常セルの手数の3割を占める） */
function* placeLights(dim, cx, cz, seed, y) {
  const x0 = cx * CELL;
  const z0 = cz * CELL;
  let n = 0;
  for (const l of lightBlocks(cx, cz, seed)) {
    // 点滅する蛍光灯だけ phase 状態を付けて置く（flipbook のコマ割りをブロックごとにずらすため。最終レビューで足した）
    const states = l.kind === "flicker" ? { [S_PHASE]: l.phase } : undefined;
    placeBlock(dim, x0 + l.bx, y, z0 + l.bz, LIGHT_ID[l.kind], states);
    if (++n % 4 === 0) yield;
  }
  if (n % 4 !== 0) yield;
}

/** 壁に貼る小物。天井と床の小物とは分けてまとめて置く */
const WALL_DECOR = new Set([B_OUTLET, B_SWITCH, B_EXIT_SIGN]);

/**
 * 小物（設計書 3.3）。天井と床をまとめて置いて yield 1回、壁の小物をまとめて置いて yield 1回。
 * 高さも場所も layout が決めている（床の小物は判定点を避けてある）
 */
function* placeDecor(dim, cx, cz, seed) {
  const list = decorAt(cx, cz, seed);
  const x0 = cx * CELL;
  const z0 = cz * CELL;
  const surface = list.filter((d) => !WALL_DECOR.has(d.id));
  const wall = list.filter((d) => WALL_DECOR.has(d.id));
  for (const group of [surface, wall]) {
    if (group.length === 0) continue;
    for (const d of group) placeBlock(dim, x0 + d.bx, d.y, z0 + d.bz, d.id, d.states);
    yield;
  }
}

function placeExit(dim, cx, cz, seed) {
  const e = exitAt(cx, cz, seed);
  if (!e) return;
  dim.setBlockType({ x: cx * CELL + e.bx, y: Y_AIR_MIN, z: cz * CELL + e.bz }, B_EXIT);
}

/** 通常セル（拠点セル・暗区画ランドマークもこの同じ経路を通る） */
function* generateNormalCell(dim, cx, cz, seed) {
  yield* fillFloorExcept(dim, cx, cz);
  yield* fillCeiling(dim, cx, cz, Y_CEIL);
  yield* fillWalls(dim, cx, cz, seed, Y_CEIL);
  yield* placeLights(dim, cx, cz, seed, Y_CEIL);
  yield* placeDecor(dim, cx, cz, seed);
  placeExit(dim, cx, cz, seed);
  yield;
  const relic = relicAt(cx, cz, seed);
  if (relic) yield* placeRelic(dim, cx, cz, relic, seed);
  const pit = pitAt(cx, cz, seed);
  if (pit) {
    // 穴のランドマーク（INTERFACES.md 9.3）。床に 4x4 の穴。判定点は穴に含まれない（layout の pitAt が避けている）
    const x = cx * CELL + pit.bx;
    const z = cz * CELL + pit.bz;
    fill(dim, x, Y_FLOOR, z, x + PIT_SIZE - 1, Y_FLOOR, z + PIT_SIZE - 1, AIR);
    yield;
  }
  dim.setBlockPermutation(markerPos(cx, cz), floorPerm()); // 完了マーカー（7.3）
}

/**
 * 固有構造を持つランドマーク（巨大空間・水区画・階段・廊下・柱の広間・小部屋・マニラルーム）。
 *
 * 占有範囲を1本のジョブでまとめて書き、判定点は全セル分を最後にまとめて置く。
 * セルごとに分けて書くと、水区画の半分だけが生成された瞬間に囲いが欠けて
 * 水が未生成側へ流れ出す（6.7 が名指しで禁じている破綻）。
 * 柱・廊下・部屋の壁は wallMask が返すので、遺留品や出口より先に描く（それらを潰さない）
 */
function* generateLandmark(dim, lm, seed) {
  const cells = [];
  for (let dz = 0; dz < lm.h; dz++) {
    for (let dx = 0; dx < lm.w; dx++) cells.push([lm.ox + dx, lm.oz + dz]);
  }

  for (const [cx, cz] of cells) yield* fillFloorExcept(dim, cx, cz);
  for (const [cx, cz] of cells) yield* fillCeiling(dim, cx, cz, lm.ceilY);

  for (const [cx, cz] of cells) {
    yield* fillWalls(dim, cx, cz, seed, lm.ceilY);
    yield* placeLights(dim, cx, cz, seed, lm.ceilY);
    yield* placeDecor(dim, cx, cz, seed);
    placeExit(dim, cx, cz, seed);
    const relic = relicAt(cx, cz, seed);
    if (relic) yield* placeRelic(dim, cx, cz, relic, seed);
    yield;
  }

  // 水区画と階段の構造は照明のあと。階段は天井に開けた穴で、穴に入る照明ごと消える。
  // マニラルームの壁紙は fillWalls が立てた環の貼り替えなので、壁のあと
  if (lm.kind === LM_ATRIUM) yield* buildAtrium(dim, lm);
  else if (lm.kind === LM_WATER) yield* buildWater(dim, lm, seed);
  else if (lm.kind === LM_STAIRS) yield* buildStairs(dim, lm);
  else if (lm.kind === LM_MANILA) yield* paintManila(dim, lm, seed);

  for (const [cx, cz] of cells) dim.setBlockPermutation(markerPos(cx, cz), floorPerm()); // 7.3
}

/** 占有範囲の外周1タイル（角を除く）のタイル座標。水区画の出入口候補に使う */
function perimeterTiles(w, h) {
  const out = [];
  for (let tx = 1; tx < w - 1; tx++) {
    out.push({ tx, tz: 0 });
    out.push({ tx, tz: h - 1 });
  }
  for (let tz = 1; tz < h - 1; tz++) {
    out.push({ tx: 0, tz });
    out.push({ tx: w - 1, tz });
  }
  return out;
}

/** 占有範囲の外周1タイルを4回の fill で囲う。y0..y1 の高さ分 */
function* fillRing(dim, lm, y0, y1, block) {
  const x0 = lm.ox * CELL;
  const z0 = lm.oz * CELL;
  const x1 = x0 + lm.w * CELL - 1;
  const z1 = z0 + lm.h * CELL - 1;
  fill(dim, x0, y0, z0, x1, y1, z0 + TILE - 1, block);
  yield;
  fill(dim, x0, y0, z1 - TILE + 1, x1, y1, z1, block);
  yield;
  fill(dim, x0, y0, z0 + TILE, x0 + TILE - 1, y1, z1 - TILE, block);
  yield;
  fill(dim, x1 - TILE + 1, y0, z0 + TILE, x1, y1, z1 - TILE, block);
  yield;
}

/**
 * 巨大空間（2x2セル・6.7）。天井は Y=20。
 * 外周1タイルに Y_CEIL+1..19 の壁を立て、隣セルの天井（Y_CEIL）との段差を塞ぐ。
 * 天井より下は開けたままにして出入口とする。柱は wallMask が返すので fillWalls が立てる。
 */
function* buildAtrium(dim, lm) {
  yield* fillRing(dim, lm, Y_CEIL + 1, lm.ceilY - 1, B_WALL);
}

/**
 * 水区画（2x2セル・6.7）。
 *
 * 外周1タイルを天井までの壁で完全に囲い、出入口を2か所だけ開ける。
 * 出入口タイルには水を置かず Y=1 に床を置いて段差にする。水は段差を登れない。
 * この囲いと段差を省くと生成済み領域の床が際限なく水没する（15章が名指しで禁止）。
 */
function* buildWater(dim, lm, seed) {
  yield* fillRing(dim, lm, Y_AIR_MIN, Y_AIR_MAX, B_WALL);

  const x0 = lm.ox * CELL;
  const z0 = lm.oz * CELL;
  const ring = perimeterTiles(lm.w * TPC, lm.h * TPC);
  // 1つのハッシュから2か所を取る。必ず相異なる添字になる
  const v = hash32(lm.ox, lm.oz, SALT.WATER_GATE, seed);
  const a = v % ring.length;
  const b = (a + 1 + ((v >>> 8) % (ring.length - 1))) % ring.length;
  for (const idx of [a, b]) {
    const g = ring[idx];
    const gx = x0 + g.tx * TILE;
    const gz = z0 + g.tz * TILE;
    fill(dim, gx, Y_AIR_MIN + 1, gz, gx + TILE - 1, Y_AIR_MAX, gz + TILE - 1, AIR);
    yield;
    fill(dim, gx, Y_AIR_MIN, gz, gx + TILE - 1, Y_AIR_MIN, gz + TILE - 1, B_FLOOR);
    yield;
  }

  // 内側だけに水源。外周1タイルは壁・出入口なので水は触れない
  const x1 = x0 + lm.w * CELL - 1;
  const z1 = z0 + lm.h * CELL - 1;
  fill(dim, x0 + TILE, Y_AIR_MIN, z0 + TILE, x1 - TILE, Y_AIR_MIN, z1 - TILE, waterPerm());
  yield;
}

/**
 * 階段（1x1セル・6.7）。天井（Y_CEIL）に穴を開け、囲われた吹き抜けを +X 方向へ上る。
 * 最上段の上に立つと足元が LM_SPEC.topY（=15）。上は壁と天井で閉じた行き止まり。
 */
function* buildStairs(dim, lm) {
  const x0 = lm.ox * CELL;
  const z0 = lm.oz * CELL;
  const xa = x0 + 1;
  const xb = x0 + CELL - 2;
  const za = z0 + 6;
  const zb = z0 + 9;
  const top = lm.topY ?? 15;

  fill(dim, xa, Y_CEIL, za, xb, Y_CEIL, zb, AIR); // 天井の穴
  yield;
  fill(dim, x0, Y_CEIL + 1, za - 1, x0 + CELL - 1, STAIRS_ROOF - 1, za - 1, B_WALL);
  yield;
  fill(dim, x0, Y_CEIL + 1, zb + 1, x0 + CELL - 1, STAIRS_ROOF - 1, zb + 1, B_WALL);
  yield;
  fill(dim, x0, Y_CEIL + 1, za, x0, STAIRS_ROOF - 1, zb, B_WALL);
  yield;
  fill(dim, x0 + CELL - 1, Y_CEIL + 1, za, x0 + CELL - 1, STAIRS_ROOF - 1, zb, B_WALL);
  yield;
  fill(dim, x0, STAIRS_ROOF, za - 1, x0 + CELL - 1, STAIRS_ROOF, zb + 1, B_CEILING);
  yield;

  for (let i = 0; xa + i <= xb; i++) {
    const y = Y_AIR_MIN + i;
    if (y >= top) break; // 最上段に立ったときの足元が top になる
    fill(dim, xa + i, y, za, xa + i, y, zb, stairPerm());
    yield;
  }
}

/**
 * マニラルーム（1x1セル・INTERFACES.md 8.2）。環は fillWalls が通常の壁で立て終えている。
 * 部屋に面した内側の1列だけを壁紙に貼り替え、最上段（Y_AIR_MAX）は天井際の縁取りにする。
 * 外側の1列は通常の壁のままなので、回廊からは普通の Level 0 に見える。
 * 戸口も内側の列を鴨居の下まで塗ってしまうので、塗ったあとで鴨居の下を空け直す
 */
function* paintManila(dim, lm, seed) {
  const x0 = lm.ox * CELL;
  const z0 = lm.oz * CELL;
  const lo = MANILA_ROOM.min - 1;
  const hi = MANILA_ROOM.max + 1;
  // 内側の列の4辺 [x0, z0, x1, z1]。角も塗る（戸口の脇の面が左右どちらも壁紙になる）
  const sides = [
    [lo, lo, lo, hi],
    [hi, lo, hi, hi],
    [lo + 1, lo, hi - 1, lo],
    [lo + 1, hi, hi - 1, hi],
  ];
  for (const [xa, za, xb, zb] of sides) fill(dim, x0 + xa, Y_AIR_MIN, z0 + za, x0 + xb, Y_AIR_MAX - 1, z0 + zb, B_MANILA_WALL);
  yield;
  for (const [xa, za, xb, zb] of sides) fill(dim, x0 + xa, Y_AIR_MAX, z0 + za, x0 + xb, Y_AIR_MAX, z0 + zb, B_MANILA_BORDER);
  const d = wallMask(lm.ox, lm.oz, seed).indexOf(W_DOOR); // 戸口は環にちょうど1つ
  const dx = x0 + (d % TPC) * TILE;
  const dz = z0 + Math.floor(d / TPC) * TILE;
  fill(dim, dx, Y_AIR_MIN, dz, dx + TILE - 1, WALL_SPAN[W_DOOR](lm.ceilY)[0] - 1, dz + TILE - 1, AIR);
  yield;
}

/** セル1つ分の生成ジョブ（7.2）。system.runJob に渡す */
export function* generateCellJob(dim, cx, cz, seed) {
  const lm = landmarkCovering(cx, cz, seed);
  // 暗区画は normalWalls が true。壁も照明も通常セルと同じ扱いで正しく出る（6.7）
  if (lm && !lm.normalWalls) yield* generateLandmark(dim, lm, seed);
  else yield* generateNormalCell(dim, cx, cz, seed);
}

/**
 * セルを air に戻す（16.1）。
 * 判定点だけを air にするのでは古い壁が残って新しい壁と重なるので、床より上を全高消す。
 * 床（Y=0）は消さない。消すと、実行したプレイヤーが作り直しを待たずに足元から虚空へ落ちる。
 * 床はどのセルでも同じなので、残しても作り直した結果は変わらない（README 9節）。
 */
export function* clearCellJob(dim, cx, cz) {
  const x0 = cx * CELL;
  const z0 = cz * CELL;
  const max = dim.heightRange.max - 1; // max は上端を含まない値（最終レビュー 中-4。越えて fill すると例外でジョブが止まる）
  // 遺留品のアーマースタンドはブロックではないので fill では消えない。残すと作り直しで二重に立つ
  const stands = dim.getEntities({
    type: "minecraft:armor_stand",
    location: { x: x0, y: Y_AIR_MIN, z: z0 },
    volume: { x: CELL - 1, y: max - Y_AIR_MIN, z: CELL - 1 },
  });
  for (const stand of stands) stand.remove();
  yield;
  const slab = 8; // fillBlocks 1回を 16x16x8 = 2048 ブロックに抑える（Q-5）
  for (let y = Y_AIR_MIN; y <= max; y += slab) {
    fill(dim, x0, y, z0, x0 + CELL - 1, Math.min(y + slab - 1, max), z0 + CELL - 1, AIR);
    yield;
  }
}

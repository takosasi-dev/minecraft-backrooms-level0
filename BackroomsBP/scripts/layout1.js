/**
 * Level 1「The Habitable Zone」のレイアウト決定（INTERFACES.md 9.2）
 *
 * layout.js と同じく「どこに何があるか」だけを決める純関数の集まり。ブロックは置かない（置くのは generator1.js）。
 * @minecraft/server は import しない。同じ (cx, cz, seed) なら常に同じ答えを返す。近傍の生成状態は見ない。
 *
 * 形の決まり（閉じ込めない・境目で食い違わない を構造で保証する）:
 * - 1セル = 8x8 タイル（1タイル = 2x2 ブロック）。値は config.js の W_* と、このファイルの T_STAIR / T_REBAR
 * - セルの境目の壁は「北の辺 = 自分の行 0」「西の辺 = 自分の列 0」だけを、そのセルが描く。
 *   東と南の辺は隣のセルの持ち物なので、1本の境目を2つのセルが描くことが無い（= 食い違いようがない）
 * - 境目に接する帯（行 1・行 7・列 1・列 7）には何も建てない。どの位置に戸口を開けても両側が通路になり、
 *   帯そのものがセルを一周する通路なので、戸口どうしは必ずつながる
 * - セルの中身（広間の柱・廊下・部屋・階段室）はタイル 2..6 の芯にだけ建て、必ず帯へ口を開ける
 * - 広間どうし・拠点との境目は壁ごと開ける（柱だけ立てる）。広間が隣り合うと柱の並ぶ広い倉庫になる
 */

import { hash32, hashRange, SALT } from "./rng.js";
import {
  TUNING as T,
  CELL,
  TPC,
  TILE,
  W_NONE,
  W_FULL,
  W_LOW,
  W_DOOR,
  Y1_AIR_MIN,
  Y1_AIR_MAX,
  Y1_CEIL,
  L1_HOME_CX,
  L1_HOME_CZ,
} from "./config.js";

/** タイルの値（W_* の続き）。階段の段が載るタイル（通れる）と、鉄筋が剥き出しの壁（W_FULL と同じ高さ） */
export const T_STAIR = 5;
export const T_REBAR = 6;

/** セルの種類 */
export const K_HOME = "home";
export const K_STAIRS = "stairs";
export const K_HALL = "hall";
export const K_CORRIDOR = "corridor";
export const K_ROOM = "room";
const K_NAME = {
  [K_HOME]: "拠点",
  [K_STAIRS]: "階段室",
  [K_HALL]: "倉庫の広間",
  [K_CORRIDOR]: "廊下",
  [K_ROOM]: "普通の部屋",
};

/**
 * 階段室の形（セル内のブロック座標）。段は +X へ上る。
 * 段 i（0..7）はブロック x = STEP_X0 + i、高さ Y1_AIR_MIN + i（最後の段が Y1_AIR_MAX）。
 * その先 x = TOP_STEP_X に天井の高さ（Y1_CEIL）の段、x = LANDING_X が天井と同じ高さの踊り場の床。
 * 天井は x = HOLE_X0..HOLE_X1 に穴を開け、その上を SHAFT_X0..SHAFT_X1 の壁と ROOF_Y のふたで囲う。
 * 段の数は Y1_AIR_MAX - Y1_AIR_MIN + 1 = 8 で、タイル 2..5（ブロック 4..11）にちょうど入る。Y1_* を変えたらここも見直す
 */
export const STAIR1 = {
  STEP_X0: 2 * TILE,
  TOP_STEP_X: 6 * TILE,
  LANDING_X: 6 * TILE + 1,
  HOLE_X0: 9,
  HOLE_X1: 11,
  SHAFT_X0: 8,
  SHAFT_X1: 14,
  ROOF_Y: Y1_CEIL + 4,
};
/** 踊り場に立ったときの足の高さ */
const LANDING_FEET_Y = Y1_CEIL + 1;

export function isHome1(cx, cz) {
  return cx === L1_HOME_CX && cz === L1_HOME_CZ;
}

/** セルの種類。拠点 → 上り階段 → 広間 / 廊下 / 部屋 の順に決める */
export function kind1(cx, cz, seed) {
  if (isHome1(cx, cz)) return K_HOME;
  if (hash32(cx, cz, SALT.L1_STAIRS, seed) % T.L1_STAIRS_RATE === 0) return K_STAIRS;
  const v = hash32(cx, cz, SALT.L1_KIND, seed) % 100;
  if (v < T.L1_HALL_RATE) return K_HALL;
  if (v < T.L1_HALL_RATE + T.L1_CORRIDOR_RATE) return K_CORRIDOR;
  return K_ROOM;
}

export function hasStairs1(cx, cz, seed) {
  const k = kind1(cx, cz, seed);
  return k === K_HOME || k === K_STAIRS;
}

/**
 * 階段室の位置。r0 = 階段室の北の壁の行（段はタイル行 r0+1..r0+2）。
 * 拠点は r0 = 0 で、南の壁を腰の高さにして着地点（タイル (4,4)）から段が見えるようにする
 */
export function stairwell1(cx, cz, seed) {
  const k = kind1(cx, cz, seed);
  if (k === K_HOME) return { r0: 0, low: true };
  if (k === K_STAIRS) return { r0: 2, low: false };
  return null;
}

/** 階段室が占めるタイル（壁・段・踊り場の下）か。照明を避けるのに使う */
function inStairwell(sw, tx, tz) {
  return sw !== null && tx >= 2 && tx <= 6 && tz >= sw.r0 && tz <= sw.r0 + 3;
}

/** 境目に壁を立てない組み合わせ。広間どうしと、拠点との境目 */
function openEdge(a, b) {
  return a === K_HOME || b === K_HOME || (a === K_HALL && b === K_HALL);
}

/** 戸口の候補（辺の上のタイル位置）。0 は角、4 は開けた境目の柱の位置なので避ける */
const DOOR_SLOTS = [1, 2, 3, 5, 6, 7];

/** 辺の戸口の位置を決める（重複なし）。salt の先頭で数、+1+i で位置 */
function doorSlots(cx, cz, salt, seed, min, max, slots) {
  const pool = slots.slice();
  const n = Math.min(pool.length, hashRange(cx, cz, salt, seed, min, max));
  const out = [];
  for (let i = 0; i < n; i++) out.push(pool.splice(hash32(cx, cz, salt + 1 + i, seed) % pool.length, 1)[0]);
  return out;
}

/**
 * セルのタイル格子。長さ 64 の Uint8Array、添字は tz * 8 + tx。値は W_NONE / W_FULL / W_LOW / W_DOOR / T_STAIR / T_REBAR
 */
export function tiles1(cx, cz, seed) {
  const g = new Uint8Array(TPC * TPC);
  const kind = kind1(cx, cz, seed);
  const at = (tx, tz) => tz * TPC + tx;

  // ---- 境目（北 = 行 0、西 = 列 0）----
  const edges = [
    { other: kind1(cx, cz - 1, seed), salt: SALT.L1_DOOR_N, put: (k, v) => (g[at(k, 0)] = v) },
    { other: kind1(cx - 1, cz, seed), salt: SALT.L1_DOOR_W, put: (k, v) => (g[at(0, k)] = v) },
  ];
  for (const e of edges) {
    if (openEdge(kind, e.other)) {
      if (kind !== K_HOME) e.put(4, W_FULL); // 柱。角（0）は下で立てる
      continue;
    }
    for (let k = 1; k < TPC; k++) e.put(k, W_FULL);
    for (const k of doorSlots(cx, cz, e.salt, seed, T.L1_DOOR_MIN, T.L1_DOOR_MAX, DOOR_SLOTS)) e.put(k, W_DOOR);
  }
  if (kind !== K_HOME) g[0] = W_FULL; // 4つのセルが接する角は柱か壁の角

  // ---- 芯（タイル 2..6）----
  if (kind === K_HALL) {
    g[at(4, 4)] = W_FULL; // 柱。境目の柱（0 と 4）と合わせて 8 ブロックおきに並ぶ
  } else if (kind === K_CORRIDOR) {
    // 芯を塞いで十字の廊下だけ通す。十字の4本の腕が帯に出る
    for (let tz = 2; tz <= 6; tz++) for (let tx = 2; tx <= 6; tx++) if (tx !== 4 && tz !== 4) g[at(tx, tz)] = W_FULL;
  } else if (kind === K_ROOM) {
    // 芯の外周が部屋の壁（中は 3..5 の 6x6 ブロック）。戸口は角以外の辺の上
    const slots = [];
    for (let i = 2; i <= 6; i++) {
      for (const [tx, tz] of [[i, 2], [i, 6], [2, i], [6, i]]) g[at(tx, tz)] = W_FULL;
    }
    for (let i = 3; i <= 5; i++) slots.push(at(i, 2), at(i, 6), at(2, i), at(6, i));
    for (const s of doorSlots(cx, cz, SALT.L1_ROOM_DOOR, seed, T.L1_ROOM_DOOR_MIN, T.L1_ROOM_DOOR_MAX, slots)) g[s] = W_DOOR;
  } else {
    // 階段室。北と南の壁（r0 と r0+3）、東の壁（列 6 = 踊り場の下）、段（列 2..5）。西の端（列 1 の帯）が入口
    const sw = stairwell1(cx, cz, seed);
    const r = sw.r0;
    for (let tx = 2; tx <= 6; tx++) {
      g[at(tx, r)] = W_FULL;
      g[at(tx, r + 3)] = sw.low && tx < 6 ? W_LOW : W_FULL;
    }
    for (let tz = r + 1; tz <= r + 2; tz++) {
      for (let tx = 2; tx <= 5; tx++) g[at(tx, tz)] = T_STAIR;
      g[at(6, tz)] = W_FULL;
    }
  }

  // ---- 鉄筋の剥き出した壁（見た目だけ。高さは W_FULL と同じ）----
  for (let i = 0; i < g.length; i++) {
    if (g[i] !== W_FULL) continue;
    const gx = cx * TPC + (i % TPC);
    const gz = cz * TPC + Math.floor(i / TPC);
    if (hash32(gx, gz, SALT.L1_REBAR, seed) % 100 < T.L1_REBAR_RATE) g[i] = T_REBAR;
  }
  return g;
}

/** 壁（通れない）タイルか */
export function isSolid1(v) {
  return v === W_FULL || v === T_REBAR;
}

/** 床に何も無いタイル（W_NONE）の一覧 */
function openTiles(g) {
  const out = [];
  for (let i = 0; i < g.length; i++) if (g[i] === W_NONE) out.push({ tx: i % TPC, tz: Math.floor(i / TPC) });
  return out;
}

/**
 * 上り階段の踊り場（ワールド座標・両端含む）と足元の高さ y。階段が無いセルは null。
 * 最後の段（天井の高さの段）も含める。ここに足のブロックが入ったら Level 0 へ（Ⓑ）
 */
export function stairsUpAt1(cx, cz, seed) {
  const sw = stairwell1(cx, cz, seed);
  if (!sw) return null;
  const z0 = cz * CELL + (sw.r0 + 1) * TILE;
  return {
    x0: cx * CELL + STAIR1.TOP_STEP_X,
    z0,
    x1: cx * CELL + STAIR1.LANDING_X,
    z1: z0 + 2 * TILE - 1,
    y: LANDING_FEET_Y,
  };
}

/** そのセルで足がいてよい最も高い Y。普通は天井の下の空間の上端、階段のセルは階段の上の吹き抜けの上端 */
export function maxY1(cx, cz, seed) {
  return stairwell1(cx, cz, seed) ? STAIR1.ROOF_Y - 1 : Y1_AIR_MAX;
}

/**
 * 蛍光灯（天井 Y1_CEIL のブロック）。[{ bx, bz }]（セル内 0..15）。
 * 壁の上と階段室の上には付けない。管は2ブロックの長さで、向き（X / Z）はタイルごとに決める
 */
export function lightBlocks1(cx, cz, seed) {
  const g = tiles1(cx, cz, seed);
  const sw = stairwell1(cx, cz, seed);
  const home = isHome1(cx, cz);
  const rate = home ? T.L1_HOME_LIGHT_RATE : T.L1_LIGHT_RATE;
  const out = [];
  for (let tz = 0; tz < TPC; tz++) {
    for (let tx = 0; tx < TPC; tx++) {
      if (isSolid1(g[tz * TPC + tx]) || inStairwell(sw, tx, tz)) continue;
      const gx = cx * TPC + tx;
      const gz = cz * TPC + tz;
      const spawnTile = home && tx === 4 && tz === 4; // 拠点の着地点の真上は必ず明るい
      if (!spawnTile && hash32(gx, gz, SALT.L1_LIGHT, seed) % 100 >= rate) continue;
      const v = hash32(gx, gz, SALT.L1_LIGHT_DIR, seed);
      const off = (v >>> 1) & 1;
      if (v & 1) out.push({ bx: tx * TILE, bz: tz * TILE + off }, { bx: tx * TILE + 1, bz: tz * TILE + off });
      else out.push({ bx: tx * TILE + off, bz: tz * TILE }, { bx: tx * TILE + off, bz: tz * TILE + 1 });
    }
  }
  return out;
}

/** 判定点（7.3）のセル内ブロック。水たまりで上書きしない */
const MARKER_B = CELL / 2;

/**
 * 結露の水たまり（床 Y1_FLOOR のブロック）。[{ bx, bz }]。
 * 何も無いタイルの 2x2 を芯に、周りの 12 ブロックをハッシュのビットで足して形をばらす。判定点は必ず避ける
 */
export function puddles1(cx, cz, seed) {
  const open = openTiles(tiles1(cx, cz, seed));
  const n = hashRange(cx, cz, SALT.L1_PUDDLE, seed, 0, T.L1_PUDDLE_MAX);
  const seen = new Set();
  const out = [];
  for (let i = 0; i < n && open.length > 0; i++) {
    const v = hash32(cx, cz, SALT.L1_PUDDLE + 1 + i, seed);
    const t = open[v % open.length];
    let bit = 8;
    for (let dz = -1; dz <= 2; dz++) {
      for (let dx = -1; dx <= 2; dx++) {
        const core = dx >= 0 && dx <= 1 && dz >= 0 && dz <= 1;
        if (!core && ((v >>> bit++ % 32) & 1) === 0) continue;
        const bx = t.tx * TILE + dx;
        const bz = t.tz * TILE + dz;
        if (bx < 0 || bx >= CELL || bz < 0 || bz >= CELL) continue;
        if (bx === MARKER_B && bz === MARKER_B) continue;
        const key = bz * CELL + bx;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ bx, bz });
      }
    }
  }
  return out;
}

/** 物資の箱（樽）のセル内ブロック {bx, bz}。無ければ null。拠点には置かない */
function crateLocal(cx, cz, seed) {
  if (isHome1(cx, cz)) return null;
  if (hash32(cx, cz, SALT.L1_CRATE, seed) % T.L1_CRATE_RATE !== 0) return null;
  const open = openTiles(tiles1(cx, cz, seed));
  if (open.length === 0) return null;
  const v = hash32(cx, cz, SALT.L1_CRATE_POS, seed);
  const t = open[v % open.length];
  return { bx: t.tx * TILE + ((v >>> 16) & 1), bz: t.tz * TILE + ((v >>> 17) & 1) };
}

/** 物資の箱（樽）のワールド座標 {x, z}（足の高さ Y1_AIR_MIN に置く）。無ければ null */
export function crateAt1(cx, cz, seed) {
  const c = crateLocal(cx, cz, seed);
  return c ? { x: cx * CELL + c.bx, z: cz * CELL + c.bz } : null;
}

/** 壁のある方向 → 絵の表が向く方角（壁の反対側） */
const WALL_DIRS = [
  { dx: 0, dz: -1, facing: "south" },
  { dx: 0, dz: 1, facing: "north" },
  { dx: -1, dz: 0, facing: "east" },
  { dx: 1, dz: 0, facing: "west" },
];

/**
 * 壁の粗雑な絵（backrooms:graffiti を再利用）。[{ bx, y, bz, facing, design }]。
 * 何も無いタイルのうち、隣のタイル（セル内）が壁の面に貼る。箱と同じタイルには描かない（拠点には描かない）
 */
export function graffiti1(cx, cz, seed) {
  if (isHome1(cx, cz)) return [];
  const g = tiles1(cx, cz, seed);
  const crate = crateLocal(cx, cz, seed);
  const spots = [];
  for (const { tx, tz } of openTiles(g)) {
    if (crate && Math.floor(crate.bx / TILE) === tx && Math.floor(crate.bz / TILE) === tz) continue;
    for (const { dx, dz, facing } of WALL_DIRS) {
      const nx = tx + dx;
      const nz = tz + dz;
      if (nx < 0 || nx >= TPC || nz < 0 || nz >= TPC || !isSolid1(g[nz * TPC + nx])) continue;
      spots.push({ tx, tz, dx, dz, facing });
    }
  }
  const n = Math.min(spots.length, hashRange(cx, cz, SALT.L1_GRAFFITI, seed, 0, T.L1_GRAFFITI_MAX));
  const out = [];
  for (let i = 0; i < n; i++) {
    const v = hash32(cx, cz, SALT.L1_GRAFFITI + 1 + i, seed);
    const s = spots.splice(v % spots.length, 1)[0];
    const side = (v >>> 8) & 1; // 壁に沿ってどちらのブロックか
    // 壁に接する側のブロック列（dx/dz が -1 なら小さい側、+1 なら大きい側）
    const bx = s.dx === 0 ? s.tx * TILE + side : s.tx * TILE + (s.dx > 0 ? 1 : 0);
    const bz = s.dz === 0 ? s.tz * TILE + side : s.tz * TILE + (s.dz > 0 ? 1 : 0);
    out.push({ bx, y: Y1_AIR_MIN + 1, bz, facing: s.facing, design: (v >>> 12) % 6 });
  }
  return out;
}

/** /backrooms:dump に出す行。ゲーム内に出るので日本語と ASCII だけ */
export function describeCell1(cx, cz, seed) {
  const kind = kind1(cx, cz, seed);
  const lines = [`Level 1 セル ${cx}, ${cz}: ${K_NAME[kind]}`];
  const up = stairsUpAt1(cx, cz, seed);
  lines.push(up ? `上り階段: 踊り場 x ${up.x0}..${up.x1} z ${up.z0}..${up.z1} y ${up.y}` : "上り階段: なし");
  const crate = crateAt1(cx, cz, seed);
  lines.push(crate ? `物資の箱: ${crate.x}, ${Y1_AIR_MIN}, ${crate.z}` : "物資の箱: なし");
  lines.push(
    `蛍光灯 ${lightBlocks1(cx, cz, seed).length / 2} 本 / 水たまり ${puddles1(cx, cz, seed).length} ブロック / 壁の絵 ${graffiti1(cx, cz, seed).length} 枚 / 足の上限 y ${maxY1(cx, cz, seed)}`,
  );
  return lines;
}

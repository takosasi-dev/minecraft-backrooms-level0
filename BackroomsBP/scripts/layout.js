/**
 * レイアウト決定（仕様書 6.3 / 6.5 / 6.7 / 6.8 / 6.9 / 8.3）
 *
 * このファイルは「どこに何があるか」を決める唯一の場所であり、
 * ブロックは一切置かない（置くのは generator.js）。すべて純関数で、
 * 同じ (cx, cz, seed) なら常に同じ答えを返す = FR-4 の決定論性の実体。
 *
 * 生成順序に依存しないことが最重要。どのセルから訪れても同じ結果になるよう、
 * 近傍の「生成済みかどうか」は決して参照しない。
 */

import { hash32, hashRange, SALT } from "./rng.js";
import {
  TUNING as T,
  CELL,
  TPC,
  TILE,
  Y_FLOOR,
  Y_AIR_MIN,
  Y_CEIL,
  LM_SPEC,
  LM_ATRIUM,
  LM_DARK,
  LM_WATER,
  LM_STAIRS,
  LM_CORRIDOR,
  LM_PILLARS,
  LM_ROOMS,
  LM_MANILA,
  LM_PIT,
  LM_KINDS,
  HOME_CX,
  HOME_CZ,
  HOME_EXIT,
  W_NONE,
  W_FULL,
  W_LOW,
  W_GAP,
  W_DOOR,
  B_OUTLET,
  B_SWITCH,
  B_EXIT_SIGN,
  B_CEIL_VENT,
  B_CEIL_STAINED,
  B_CEIL_MISSING,
  B_FLOOR_STAINED,
  B_FLOOR_WET,
  S_FACING,
  S_ARROW,
  S_DESIGN,
  RELIC_OFFICE,
  RELIC_GRAFFITI,
  RELIC_KINDS,
} from "./config.js";

export const V_NORMAL = "normal";
export const V_BIG = "big";
export const V_DENSE = "dense";
export const V_DARK = "dark";
export const V_HOME = "home";

/** ワールド座標 → セル座標（6.1）。負の座標でも正しく切り下げる */
export function cellOf(x, z) {
  return { cx: Math.floor(x / 16), cz: Math.floor(z / 16) };
}

export function isHome(cx, cz) {
  return cx === HOME_CX && cz === HOME_CZ;
}

// ---- キャッシュ。seed が変わったら捨てる ----
let cacheSeed;
let lmCache = new Map();
function cacheKey(cx, cz) {
  return cx + "," + cz;
}
function ensureCache(seed) {
  if (cacheSeed !== seed) {
    cacheSeed = seed;
    lmCache = new Map();
  } else if (lmCache.size > 8192) {
    lmCache.clear();
  }
}
/** 定数を実行時に変えたとき（16.1）にキャッシュを捨てる */
export function invalidateCache() {
  cacheSeed = undefined;
  lmCache = new Map();
}

// ---- セルバリアント（6.5）----

export function variantOf(cx, cz, seed) {
  if (isHome(cx, cz)) return V_HOME;
  const v = hash32(cx, cz, SALT.VARIANT, seed) % 100;
  if (v < 5) return V_BIG;
  if (v < 12) return V_DENSE;
  if (v < 16) return V_DARK;
  return V_NORMAL;
}

// ---- ランドマーク（6.7）----

/** (cx, cz) がランドマークの原点なら、その仕様を返す */
function originAt(cx, cz, seed) {
  if (hash32(cx, cz, SALT.LM_ORIGIN, seed) % T.LANDMARK_RATE !== 0) return null;
  const kind = hash32(cx, cz, SALT.LM_KIND, seed) % LM_KINDS;
  const spec = LM_SPEC[kind];
  // 廊下だけ向きがある。rot 1 は Z 方向に長い。重なりの判定（originWins）もこの w/h で動く
  const rot = kind === LM_CORRIDOR ? hash32(cx, cz, SALT.LM_ROT, seed) % 2 : 0;
  const w = rot ? spec.h : spec.w;
  const h = rot ? spec.w : spec.h;
  // 拠点セルを含むランドマークは丸ごと無効（6.9 拠点にランドマークを置かない）
  if (HOME_CX >= cx && HOME_CX < cx + w && HOME_CZ >= cz && HOME_CZ < cz + h) return null;
  return { kind, ox: cx, oz: cz, w, h, rot, normalWalls: spec.normalWalls, ceilY: spec.ceilY, topY: spec.topY };
}

/**
 * 原点が「自分の占有範囲すべてを勝ち取れるか」を判定する（6.7 の重なり解決）。
 *
 * 仕様書は「セル座標が小さいほうを優先」と書いているが、それをセル単位で適用すると
 * ランドマークが部分的に欠ける。水区画が1セル欠けると外周の囲いが破れて水が流出する
 * （6.7 の重大な破綻）ため、欠けたランドマークは作らず丸ごと捨てる。
 * 判定は1パスで完結し再帰しないので、どのセルから評価しても同じ答えになる。
 */
function originWins(lm, seed) {
  for (let dz = 0; dz < lm.h; dz++) {
    for (let dx = 0; dx < lm.w; dx++) {
      const cx = lm.ox + dx;
      const cz = lm.oz + dz;
      for (let oz = cz - 2; oz <= cz + 2; oz++) {
        for (let ox = cx - 2; ox <= cx + 2; ox++) {
          // 自分自身、および自分よりキーが大きい原点は競合相手にならない
          if (ox > lm.ox || (ox === lm.ox && oz >= lm.oz)) continue;
          const other = originAt(ox, oz, seed);
          if (!other) continue;
          if (cx >= ox && cx < ox + other.w && cz >= oz && cz < oz + other.h) return false;
        }
      }
    }
  }
  return true;
}

/**
 * (cx, cz) から radius セル以内で最も近い kind のランドマークの原点（INTERFACES.md 9.3）。無ければ null。
 * 近さは原点セルまでのユークリッド距離。同じ距離なら先に見つけたもの（走査順が決まっているので決定論的）。
 * 自己点検と、長く歩くとマニラルームの行き先が使う
 */
export function findLandmark(cx, cz, kind, seed, radius) {
  let best = null;
  let bestD = Infinity;
  // 内側の環から順に見る。環 r のセルはどれも距離 r 以上なので、r が今の最短を超えたら打ち切れる
  for (let r = 0; r <= radius && r <= bestD; r++) {
    for (let oz = cz - r; oz <= cz + r; oz++) {
      for (let ox = cx - r; ox <= cx + r; ox++) {
        if (Math.max(Math.abs(ox - cx), Math.abs(oz - cz)) !== r) continue;
        const lm = originAt(ox, oz, seed);
        if (!lm || lm.kind !== kind || !originWins(lm, seed)) continue;
        const d = Math.hypot(ox - cx, oz - cz);
        if (d < bestD) {
          bestD = d;
          best = { ox, oz };
        }
      }
    }
  }
  return best;
}

/** (cx, cz) を覆っているランドマーク。無ければ null */
export function landmarkCovering(cx, cz, seed) {
  if (isHome(cx, cz)) return null;
  ensureCache(seed);
  const key = cacheKey(cx, cz);
  if (lmCache.has(key)) return lmCache.get(key);

  let best = null;
  for (let oz = cz - 2; oz <= cz + 2; oz++) {
    for (let ox = cx - 2; ox <= cx + 2; ox++) {
      const lm = originAt(ox, oz, seed);
      if (!lm) continue;
      if (cx < ox || cx >= ox + lm.w || cz < oz || cz >= oz + lm.h) continue;
      if (!originWins(lm, seed)) continue;
      if (!best || ox < best.ox || (ox === best.ox && oz < best.oz)) best = lm;
    }
  }
  lmCache.set(key, best);
  return best;
}

// ---- ランドマークの構造（設計書 3.2）----

/** マニラルームの壁の環（ローカルタイル。各軸共通）。中はタイル 2..5、外のタイル 0 と 7 は回廊（INTERFACES.md 8.2） */
const MANILA_RING = [1, 6];
/** マニラルームの中のブロックの範囲（セル内オフセット、両端含む）。generator は min-1 と max+1 の列を壁紙にする */
export const MANILA_ROOM = { min: (MANILA_RING[0] + 1) * TILE, max: MANILA_RING[1] * TILE - 1 };

/** 小部屋の壁の線（ローカルタイル）。各軸共通 */
const ROOM_WALLS = [0, 4, 8, 12, 15];
/** 部屋 i の中央付近のタイル（中は 1..3 / 5..7 / 9..11 / 13..14）。戸口・入口・照明の位置 */
const ROOM_MID = [2, 6, 10, 13];

/**
 * 構造を持つランドマークの、占有範囲全体のタイル格子（ローカル座標、添字 lz * W + lx、値は壁の形）。
 * 巨大空間の柱・廊下・柱の広間・小部屋・マニラルームの環。水区画と階段は generator が作るので null。
 * 占有範囲をまとめて決めてから各セルが自分の分を切り出すので、セルの境目で食い違わない
 */
function structureGrid(lm, seed) {
  const W = lm.w * TPC;
  const H = lm.h * TPC;
  const g = new Uint8Array(W * H);

  if (lm.kind === LM_ATRIUM) {
    // 柱を数本（6.7）。外周1タイルには立てない
    const n = hashRange(lm.ox, lm.oz, SALT.ATRIUM_PILLAR, seed, T.ATRIUM_PILLAR_MIN, T.ATRIUM_PILLAR_MAX);
    for (let i = 0; i < n; i++) {
      const v = hash32(lm.ox, lm.oz, SALT.ATRIUM_PILLAR + 1 + i, seed);
      g[(1 + ((v >>> 8) % (H - 2))) * W + 1 + (v % (W - 2))] = W_FULL;
    }
    return g;
  }

  if (lm.kind === LM_CORRIDOR) {
    // l = 長手（0..23）、c = 幅（0..7）。rot 1 は x と z を入れ替える
    const long = lm.rot ? H : W;
    const at = (l, c) => (lm.rot ? l * W + c : c * W + l);
    for (let l = 0; l < long; l++) {
      for (let c = 0; c < TPC; c++) if (c !== 3 && c !== 4) g[at(l, c)] = W_FULL; // 幅 3..4 が通路（全長）
    }
    // 脇道 1〜2 本。通路から片側の外周まで幅1タイルで抜ける。1つのハッシュのビットを分けて使う
    const v = hash32(lm.ox, lm.oz, SALT.CORRIDOR_SIDE, seed);
    const n = 1 + (v & 1);
    for (let i = 0; i < n; i++) {
      const b = v >>> (1 + i * 8);
      const l = 4 + (b % 16);
      for (const c of (b >>> 4) & 1 ? [5, 6, 7] : [0, 1, 2]) g[at(l, c)] = W_NONE;
    }
    return g;
  }

  if (lm.kind === LM_PILLARS) {
    // 1タイルの柱を3タイル間隔の格子に。通常の壁は無い
    for (let lz = 1; lz < H; lz += 3) for (let lx = 1; lx < W; lx += 3) g[lz * W + lx] = W_FULL;
    return g;
  }

  if (lm.kind === LM_ROOMS) {
    for (let lz = 0; lz < H; lz++) {
      for (let lx = 0; lx < W; lx++) if (ROOM_WALLS.includes(lx) || ROOM_WALLS.includes(lz)) g[lz * W + lx] = W_FULL;
    }
    // 4x4 の部屋（r = j * 4 + i）を深さ優先の全域木でつなぐ。どの部屋にも必ずたどり着ける
    const seen = new Uint8Array(16);
    const stack = [0];
    seen[0] = 1;
    let step = 0;
    while (stack.length > 0) {
      const r = stack[stack.length - 1];
      const i = r & 3;
      const j = r >> 2;
      const next = [];
      if (i > 0 && !seen[r - 1]) next.push(r - 1);
      if (i < 3 && !seen[r + 1]) next.push(r + 1);
      if (j > 0 && !seen[r - 4]) next.push(r - 4);
      if (j < 3 && !seen[r + 4]) next.push(r + 4);
      if (next.length === 0) {
        stack.pop();
        continue;
      }
      const to = next[hash32(lm.ox, lm.oz, SALT.ROOMS_MAZE + step++, seed) % next.length];
      const ti = to & 3;
      const tj = to >> 2;
      // 2部屋の間の壁の、共有する辺の中央付近の1タイルを戸口にする
      if (tj === j) g[ROOM_MID[j] * W + ROOM_WALLS[Math.max(i, ti)]] = W_NONE;
      else g[ROOM_WALLS[Math.max(j, tj)] * W + ROOM_MID[i]] = W_NONE;
      seen[to] = 1;
      stack.push(to);
    }
    // 外周の入口 2〜4 か所。候補は4辺 x 4部屋の16か所を hash の順に並べたもので、最初の4つは別々の辺
    // （辺 0 = -Z / 1 = +X / 2 = +Z / 3 = -X）。選んだ入口の外側がどれも壁なら、hash の順で最初に
    // 外から入れる候補を最後の1つと入れ替える（数は変えない）。16 か所とも外が壁ならそのまま
    const v = hash32(lm.ox, lm.oz, SALT.ROOMS_GATE, seed);
    const n = 2 + (v % 3);
    const order = [];
    for (let round = 0; round < 4; round++) {
      for (let k = 0; k < 4; k++) order.push(gateTiles(((v >>> 8) + k) & 3, ROOM_MID[((v >>> (12 + 2 * k)) + round) & 3], W, H));
    }
    const open = (t) => tileOpen(lm.ox * TPC + t.ox, lm.oz * TPC + t.oz, seed);
    const gates = order.slice(0, n);
    if (!gates.some(open)) {
      const alt = order.slice(n).find(open);
      if (alt) gates[n - 1] = alt;
    }
    for (const t of gates) g[t.lz * W + t.lx] = W_NONE;
    return g;
  }

  if (lm.kind === LM_MANILA) {
    // タイル 1 と 6 の環。戸口は角を除く1タイル（辺 0 = -Z / 1 = +X / 2 = +Z / 3 = -X、辺の上の位置 2..5）。
    // 戸口の外はセル内の回廊（タイル 0 / 7）なので必ず通れる
    const [a, b] = MANILA_RING;
    for (let t = a; t <= b; t++) g[a * W + t] = g[b * W + t] = g[t * W + a] = g[t * W + b] = W_FULL;
    const v = hash32(lm.ox, lm.oz, SALT.MANILA_DOOR, seed);
    const p = a + 1 + ((v >>> 2) % (b - a - 1));
    const side = v & 3;
    const lx = side === 1 ? b : side === 3 ? a : p;
    const lz = side === 0 ? a : side === 2 ? b : p;
    g[lz * W + lx] = W_DOOR;
    return g;
  }

  return null;
}

/**
 * 小部屋の外周の入口の候補。辺 side・部屋の中央 m の、入口のローカルタイル (lx, lz) と、
 * その外側の隣のタイル (ox, oz)（ローカル座標。占有範囲の外）
 */
function gateTiles(side, m, W, H) {
  if (side === 0) return { lx: m, lz: 0, ox: m, oz: -1 };
  if (side === 1) return { lx: W - 1, lz: m, ox: W, oz: m };
  if (side === 2) return { lx: m, lz: H - 1, ox: m, oz: H };
  return { lx: 0, lz: m, ox: -1, oz: m };
}

/**
 * グローバルタイル (gx, gz) が通れるか（値 0 / 2 / 4）。小部屋の入口の外側を見るのに使う。
 * 構造を持つランドマーク・水区画・階段の中は読まずに塞がっているとみなす（小部屋どうしの相互参照を避ける。
 * 水区画の外周の囲いは wallMask に出ない）。通常セルの wallMask は structureGrid を呼ばないので再帰しない
 */
function tileOpen(gx, gz, seed) {
  const cx = Math.floor(gx / TPC);
  const cz = Math.floor(gz / TPC);
  const lm = landmarkCovering(cx, cz, seed);
  if (lm && !lm.normalWalls) return false;
  const v = wallMask(cx, cz, seed)[(gz - cz * TPC) * TPC + gx - cx * TPC];
  return v === W_NONE || v === W_LOW || v === W_DOOR;
}

// ---- 壁セグメント（6.3）----

/**
 * セグメント i の形（設計書 3.1）。持ち主のセルの座標で引くので、隣のセルへはみ出した部分も同じ形になる。
 * W_DOOR は「戸口つきの天井までの壁」の意味で、戸口になるのは端を除く1タイルだけ（pushSegments）
 */
export function segmentStyle(cx, cz, i, len, seed) {
  const r = hash32(cx, cz, SALT.WALL_STYLE + i, seed) % 100;
  if (r < T.WALL_LOW_RATE) return W_LOW;
  if (r < T.WALL_LOW_RATE + T.WALL_GAP_RATE) return W_GAP;
  if (len >= 3 && r < T.WALL_LOW_RATE + T.WALL_GAP_RATE + T.WALL_DOOR_RATE) return W_DOOR;
  return W_FULL;
}

/** 重なったタイルは通れない形が勝つ: FULL > GAP > LOW > DOOR > NONE。添字が値 */
const STRENGTH = [0, 4, 2, 3, 1];

/**
 * セル (cx, cz) が生み出す壁セグメントのタイルを、グローバルタイル座標と形の3つ組で out に積む。
 * セグメントは最大8タイル = 1セル分なので、隣接セルまでしかはみ出さない。
 */
function pushSegments(cx, cz, seed, out) {
  if (isHome(cx, cz)) return; // 拠点セルは壁を一切出さない（6.9 / 15章）
  const lm = landmarkCovering(cx, cz, seed);
  if (lm && !lm.normalWalls) return; // ランドマークは通常の壁生成をスキップ（6.7）

  const v = variantOf(cx, cz, seed);
  let n;
  if (v === V_BIG) n = hashRange(cx, cz, SALT.COUNT, seed, T.BIG_COUNT_MIN, T.BIG_COUNT_MAX);
  else if (v === V_DENSE) n = hashRange(cx, cz, SALT.COUNT, seed, T.DENSE_COUNT_MIN, T.DENSE_COUNT_MAX);
  else n = hashRange(cx, cz, SALT.COUNT, seed, T.SEGMENT_COUNT_MIN, T.SEGMENT_COUNT_MAX);

  const gx0 = cx * TPC;
  const gz0 = cz * TPC;
  for (let i = 0; i < n; i++) {
    const tx = hash32(cx, cz, SALT.TX + i, seed) % TPC;
    const tz = hash32(cx, cz, SALT.TZ + i, seed) % TPC;
    const dir = hash32(cx, cz, SALT.DIR + i, seed) % 2;
    const len = hashRange(cx, cz, SALT.LEN + i, seed, T.SEGMENT_LEN_MIN, T.SEGMENT_LEN_MAX);
    const style = segmentStyle(cx, cz, i, len, seed);
    // 戸口つきの壁は、端を除く1タイルだけが戸口で残りは天井までの壁
    const door = style === W_DOOR ? 1 + (hash32(cx, cz, SALT.WALL_DOOR + i, seed) % (len - 2)) : -1;
    for (let k = 0; k < len; k++) {
      const v = style === W_DOOR ? (k === door ? W_DOOR : W_FULL) : style;
      out.push(gx0 + tx + (dir === 0 ? k : 0), gz0 + tz + (dir === 1 ? k : 0), v);
    }
  }
}

/**
 * セルの壁マスク。長さ 64 の Uint8Array、添字は tz * 8 + tx、値は壁の形（W_NONE..W_DOOR・設計書 3.1）。
 * 自セルを含む 3x3 の9セル分のセグメントを計算し、自セルに入るタイルだけを残す（6.3）。
 * 構造を持つランドマークは、その構造を返す（隣のセルからはみ出したセグメントは入れない）。
 */
export function wallMask(cx, cz, seed) {
  const mask = new Uint8Array(TPC * TPC);
  if (isHome(cx, cz)) return mask; // 拠点は 16x16 が完全に開けている（6.9）
  const lm = landmarkCovering(cx, cz, seed);
  if (lm && !lm.normalWalls) {
    const g = structureGrid(lm, seed);
    if (!g) return mask; // 水区画・階段の構造は generator が置く
    const W = lm.w * TPC;
    const lx0 = (cx - lm.ox) * TPC;
    const lz0 = (cz - lm.oz) * TPC;
    for (let tz = 0; tz < TPC; tz++) {
      for (let tx = 0; tx < TPC; tx++) mask[tz * TPC + tx] = g[(lz0 + tz) * W + lx0 + tx];
    }
    return mask;
  }

  const tiles = [];
  for (let dz = -1; dz <= 1; dz++) {
    for (let dx = -1; dx <= 1; dx++) pushSegments(cx + dx, cz + dz, seed, tiles);
  }
  const gx0 = cx * TPC;
  const gz0 = cz * TPC;
  for (let i = 0; i < tiles.length; i += 3) {
    const tx = tiles[i] - gx0;
    const tz = tiles[i + 1] - gz0;
    if (tx < 0 || tx >= TPC || tz < 0 || tz >= TPC) continue;
    const k = tz * TPC + tx;
    if (STRENGTH[tiles[i + 2]] > STRENGTH[mask[k]]) mask[k] = tiles[i + 2];
  }
  return mask;
}

/** 壁でない（値0の）タイルの一覧。遺留品・出口の配置に使う（6.8） */
export function freeTiles(cx, cz, seed) {
  const mask = wallMask(cx, cz, seed);
  const out = [];
  for (let tz = 0; tz < TPC; tz++) {
    for (let tx = 0; tx < TPC; tx++) if (mask[tz * TPC + tx] === W_NONE) out.push({ tx, tz });
  }
  return out;
}

/** 壁被覆率（%）。値0でないタイルの割合。6.4 の密度調整とダンプコマンドで使う */
export function wallCoverage(cx, cz, seed) {
  const mask = wallMask(cx, cz, seed);
  let n = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i] !== W_NONE) n++;
  return Math.round((n / mask.length) * 100);
}

// ---- 照明（6.6）----

/** 蛍光灯が1つも無いセルか。暗区画バリアント（6.5）と暗区画ランドマーク（6.7）。スマイラーの縄張り */
export function isDarkCell(cx, cz, seed) {
  const lm = landmarkCovering(cx, cz, seed);
  // マニラルームは暗区画バリアントの上でも暗くしない。部屋の電灯がこのランドマークの本体で、安全地帯でもある（INTERFACES.md 8.2）
  if (lm !== null && lm.kind === LM_MANILA) return false;
  if (variantOf(cx, cz, seed) === V_DARK) return true;
  return lm !== null && lm.kind === LM_DARK;
}

/** 住人が出ない・入ると消える安全地帯のセルか。拠点と、マニラルームのセル（INTERFACES.md 8章） */
export function isSafeCell(cx, cz, seed) {
  if (isHome(cx, cz)) return true;
  const lm = landmarkCovering(cx, cz, seed);
  return lm !== null && lm.kind === LM_MANILA;
}

/** ブロック列 (x, z)（ワールド座標）がマニラルームの部屋の中（環の内側 8x8）か。戸口・壁・回廊は外（INTERFACES.md 8.2） */
export function inManilaRoom(x, z, seed) {
  const { cx, cz } = cellOf(x, z);
  const lm = landmarkCovering(cx, cz, seed);
  if (!lm || lm.kind !== LM_MANILA) return false;
  const bx = Math.floor(x) - cx * CELL;
  const bz = Math.floor(z) - cz * CELL;
  return bx >= MANILA_ROOM.min && bx <= MANILA_ROOM.max && bz >= MANILA_ROOM.min && bz <= MANILA_ROOM.max;
}

/** 穴の大きさ（ブロック）。2x2 タイル（INTERFACES.md 9.3） */
export const PIT_SIZE = 4;

/**
 * 穴のランドマークの穴の位置 { bx, bz }（セル内オフセット、穴は bx..bx+3 / bz..bz+3）。穴のセルでなければ null。
 * 候補は 2x2 タイルがすべて壁の無いタイルで、セル中央の判定点 (8, 8) のタイル (4, 4) を含まない場所。SALT.PIT_POS で1つ選ぶ。
 * 候補が無ければ null（そのセルは穴の無い普通のセルになる。test_layout.mjs で割合を出している）
 */
export function pitAt(cx, cz, seed) {
  const lm = landmarkCovering(cx, cz, seed);
  if (!lm || lm.kind !== LM_PIT) return null;
  const mask = wallMask(cx, cz, seed);
  const mid = CELL / 2 / TILE;
  const cands = [];
  for (let tz = 0; tz < TPC - 1; tz++) {
    for (let tx = 0; tx < TPC - 1; tx++) {
      if ((tx === mid || tx + 1 === mid) && (tz === mid || tz + 1 === mid)) continue;
      const k = tz * TPC + tx;
      if (mask[k] || mask[k + 1] || mask[k + TPC] || mask[k + TPC + 1]) continue;
      cands.push({ bx: tx * TILE, bz: tz * TILE });
    }
  }
  if (cands.length === 0) return null;
  return cands[hash32(cx, cz, SALT.PIT_POS, seed) % cands.length];
}

/**
 * 構造を持つランドマークの照明（設計書 3.2）。ハッシュではなく規則正しく並べる。
 * 返すのはセル内のブロック {bx, bz}。巨大空間・水区画・階段は null（通常と同じハッシュの照明）。
 * kind を持つ要素は種類が決まっている照明（マニラルームの電灯）で、ハッシュで種類を引かない
 * @returns {{ bx: number, bz: number, kind?: string }[] | null}
 */
function structureLights(lm, cx, cz) {
  /** @type {[number, number, string?][]} */
  const pts = []; // ランドマーク内のブロック座標 [x, z, 種類]
  if (lm.kind === LM_CORRIDOR) {
    // 通路（幅のタイル 3..4 = ブロック 6..9）の中央線に 4 ブロックおき
    const long = (lm.rot ? lm.h : lm.w) * CELL;
    for (let l = 2; l < long; l += 4) pts.push(lm.rot ? [7, l] : [l, 7]);
  } else if (lm.kind === LM_PILLARS) {
    // 柱（タイル 1, 4, 7..）の格子の間。タイル 2, 5, 8.. の (0,0) ブロック
    for (let lz = 2; lz < lm.h * TPC; lz += 3) for (let lx = 2; lx < lm.w * TPC; lx += 3) pts.push([lx * TILE, lz * TILE]);
  } else if (lm.kind === LM_ROOMS) {
    for (const mz of ROOM_MID) for (const mx of ROOM_MID) pts.push([mx * TILE + 1, mz * TILE + 1]); // 各部屋の中央
  } else if (lm.kind === LM_MANILA) {
    // 回廊（タイル 0 / 7）の内側の列の四隅と各辺の中央に蛍光灯。部屋の中は天井の中央に橙色の電灯1つだけ
    for (const a of [1, CELL - 2]) pts.push([a, 1], [a, CELL - 2], [CELL / 2, a], [a, CELL / 2]);
    pts.push([CELL / 2, CELL / 2, "manila"]);
  } else {
    return null;
  }
  const x0 = (cx - lm.ox) * CELL;
  const z0 = (cz - lm.oz) * CELL;
  return pts
    .filter(([x, z]) => x >= x0 && x < x0 + CELL && z >= z0 && z < z0 + CELL)
    .map(([x, z, kind]) => ({ bx: x - x0, bz: z - z0, kind }));
}

/** 蛍光灯の種類（設計書 3.3）。ワールドのブロック座標で引く。拠点は呼ばない（全部 normal） */
function lightKind(x, z, seed) {
  const r = hash32(x, z, SALT.LIGHT_KIND, seed) % 100;
  if (r < T.LIGHT_FLICKER_RATE) return "flicker";
  if (r < T.LIGHT_FLICKER_RATE + T.LIGHT_DEAD_RATE) return "dead";
  return "normal";
}

/**
 * 蛍光灯を置くブロックの一覧 [{ bx, bz, kind, phase? }]。bx/bz はセル内ブロックオフセット（0..15）、
 * kind は "normal" | "flicker" | "dead" | "manila"。暗区画（6.5 / 6.7）では空配列。巨大空間の天井は照明率を下げる（6.7）。
 * kind が "flicker" の要素だけ phase（0..2）を持つ。flipbook は全ブロック共通の時計で動くので、
 * コマ割りを3通り（flipbook_textures.json）に分けてブロックごとにずらす（最終レビューで足した）。
 * "manila" はマニラルームの部屋の中の電灯（B_MANILA_LIGHT）で、1部屋に1つだけ。点滅も切れもしない（v0.4.0）。
 */
export function lightBlocks(cx, cz, seed) {
  if (isDarkCell(cx, cz, seed)) return [];
  const v = variantOf(cx, cz, seed);
  const lm = landmarkCovering(cx, cz, seed);
  let out = lm ? structureLights(lm, cx, cz) : null;

  if (!out) {
    const rate = lm && lm.kind === LM_ATRIUM ? T.ATRIUM_LIGHT_RATE : v === V_HOME ? T.HOME_LIGHT_RATE : T.LIGHT_RATE;
    out = [];
    const gx0 = cx * TPC;
    const gz0 = cz * TPC;
    for (let tz = 0; tz < TPC; tz++) {
      for (let tx = 0; tx < TPC; tx++) {
        if (hash32(gx0 + tx, gz0 + tz, SALT.LIGHT, seed) % 100 >= rate) continue;
        // タイルの4ブロックのうち1つだけを蛍光灯にする（6.6）
        const sub = hash32(gx0 + tx, gz0 + tz, SALT.LIGHT_SUB, seed) % 4;
        out.push({ bx: tx * TILE + (sub & 1), bz: tz * TILE + (sub >> 1) });
      }
    }
  }
  // 拠点は明るく清潔なまま（6.9）。点滅も切れた灯りも置かない
  return out.map(({ bx, bz, kind: fixed }) => {
    if (fixed) return { bx, bz, kind: fixed }; // マニラルームの電灯
    if (v === V_HOME) return { bx, bz, kind: "normal" };
    const kind = lightKind(cx * CELL + bx, cz * CELL + bz, seed);
    if (kind !== "flicker") return { bx, bz, kind };
    // LIGHT_KIND とは別の salt で引く（同じ salt だと kind と phase が相関してしまう）
    const phase = hash32(cx * CELL + bx, cz * CELL + bz, SALT.LIGHT_PHASE, seed) % 3;
    return { bx, bz, kind, phase };
  });
}

// ---- 出口ドア（8.3）----

/**
 * 遺留品と出口のドアを置いてよいランドマーク（6.8 / 8.3 / 設計書 3.2）。
 * 廊下・暗区画・水区画・階段には置かない。マニラルームも置かない（部屋そのものが出口 = INTERFACES.md 8.2）。
 * 穴も置かない（穴そのものが Level 1 への出口で、置き場が穴と重なりうる = 9.3）
 */
const HOLDS_ITEMS = [LM_ATRIUM, LM_PILLARS, LM_ROOMS];

/**
 * 遺留品と出口のドアの置き場の候補。値0のタイルのうち、小部屋の壁の線の上（戸口と入口）は除く。
 * 戸口は1タイルしかないので、机やベッドで塞ぐとその先の部屋に入れなくなる
 */
function itemTiles(cx, cz, seed, lm) {
  const free = freeTiles(cx, cz, seed);
  if (!lm || lm.kind !== LM_ROOMS) return free;
  const lx0 = (cx - lm.ox) * TPC;
  const lz0 = (cz - lm.oz) * TPC;
  return free.filter((t) => !ROOM_WALLS.includes(lx0 + t.tx) && !ROOM_WALLS.includes(lz0 + t.tz));
}

/** 出口ドアの位置。bx/bz はセル内ブロックオフセット */
export function exitAt(cx, cz, seed) {
  if (isHome(cx, cz)) return { bx: HOME_EXIT.x, bz: HOME_EXIT.z, home: true }; // 拠点には必ず1つ（6.9）
  if (hash32(cx, cz, SALT.EXIT, seed) % T.EXIT_RATE !== 0) return null;
  const lm = landmarkCovering(cx, cz, seed);
  if (lm && !HOLDS_ITEMS.includes(lm.kind)) return null;
  const free = itemTiles(cx, cz, seed, lm);
  if (free.length === 0) return null;
  const t = free[hash32(cx, cz, SALT.EXIT_POS, seed) % free.length];
  return { bx: t.tx * TILE, bz: t.tz * TILE, tx: t.tx, tz: t.tz };
}

// ---- 遺留品（6.8）----

/**
 * 遺留品 { kind, bx, bz, tx, tz, spots? }。bx/bz は遺留品のタイル（2x2 ブロック）の角のセル内オフセット。
 * 落書き（RELIC_GRAFFITI）のときだけ spots: [{ bx, y, bz, states }]（1〜GRAFFITI_MAX 枚）
 */
export function relicAt(cx, cz, seed) {
  if (isHome(cx, cz)) return null; // 拠点には配置しない（6.9）
  if (hash32(cx, cz, SALT.RELIC, seed) % T.RELIC_RATE !== 0) return null;
  const lm = landmarkCovering(cx, cz, seed);
  if (lm && !HOLDS_ITEMS.includes(lm.kind)) return null;

  const ex = exitAt(cx, cz, seed);
  let free = itemTiles(cx, cz, seed, lm);
  if (ex && ex.tx !== undefined) free = free.filter((t) => t.tx !== ex.tx || t.tz !== ex.tz);
  if (free.length === 0) return null;

  const t = free[hash32(cx, cz, SALT.RELIC_POS, seed) % free.length];
  const relic = {
    kind: hash32(cx, cz, SALT.RELIC_KIND, seed) % RELIC_KINDS,
    bx: t.tx * TILE,
    bz: t.tz * TILE,
    tx: t.tx,
    tz: t.tz,
  };
  if (relic.kind !== RELIC_GRAFFITI) return relic;

  // 壁の落書き（設計書 3.4）。遺留品のタイルから3タイル以内の、壁を背にできる場所に置く。
  // 遺留品のタイル自体には何も置かないので、そこに貼ってもよい。出口のドアのタイルは避ける
  const skip = (tx, tz) =>
    Math.max(Math.abs(tx - t.tx), Math.abs(tz - t.tz)) > 3 || (ex && ex.tx === tx && ex.tz === tz);
  const near = wallSpots(wallMask(cx, cz, seed), skip);
  const used = new Set();
  const spots = [];
  const n = hashRange(cx, cz, SALT.RELIC_GRAFFITI, seed, T.GRAFFITI_MIN, T.GRAFFITI_MAX);
  for (let i = 0; i < n; i++) {
    const v = hash32(cx, cz, SALT.RELIC_GRAFFITI + 1 + i, seed);
    const s = takeWallSpot(near, v, used);
    if (!s) break;
    spots.push({ bx: s.bx, y: Y_AIR_MIN + 1, bz: s.bz, states: { [S_FACING]: s.facing, [S_DESIGN]: (v >>> 20) % 6 } });
  }
  if (spots.length > 0) relic.spots = spots;
  else relic.kind = RELIC_OFFICE; // 貼れる壁が無い。事務机にする
  return relic;
}

// ---- 小物（設計書 3.3）----

/** 壁のある側ごとの、背中側のタイルへのずれと表の向き。表は壁と反対を向く（INTERFACES 7.2） */
const WALL_SIDES = [
  { dx: -1, dz: 0, facing: "east" },
  { dx: 1, dz: 0, facing: "west" },
  { dx: 0, dz: -1, facing: "south" },
  { dx: 0, dz: 1, facing: "north" },
];

/**
 * 壁を背にできる場所の候補 [{ tx, tz, side }]。値0のタイルの辺のうち、セル内で隣り合うタイルが
 * 値1か3（天井まで・天井に届かない壁）のもの。腰の高さの壁と戸口の鴨居には貼らない。skip(tx, tz) が真のタイルは除く
 */
function wallSpots(mask, skip) {
  const out = [];
  for (let tz = 0; tz < TPC; tz++) {
    for (let tx = 0; tx < TPC; tx++) {
      if (mask[tz * TPC + tx] !== W_NONE || skip(tx, tz)) continue;
      for (const side of WALL_SIDES) {
        const bx = tx + side.dx;
        const bz = tz + side.dz;
        if (bx < 0 || bz < 0 || bx >= TPC || bz >= TPC) continue;
        const back = mask[bz * TPC + bx];
        if (back === W_FULL || back === W_GAP) out.push({ tx, tz, side });
      }
    }
  }
  return out;
}

/**
 * 候補から1か所取り、ブロックの列 { bx, bz, facing } を返す。v はハッシュ。
 * 列はタイルの壁に面した側で、壁沿いの2ブロックのどちらかを v で選ぶ。
 * used（bz * CELL + bx）にある列は避けて次の候補へ進む（同じ列に2つ置かない）。取れなければ null
 */
function takeWallSpot(spots, v, used) {
  const s = (v >>> 16) & 1;
  for (let j = 0; j < spots.length; j++) {
    const { tx, tz, side } = spots[(v + j) % spots.length];
    const bx = tx * TILE + (side.dx ? (side.dx > 0 ? 1 : 0) : s);
    const bz = tz * TILE + (side.dz ? (side.dz > 0 ? 1 : 0) : s);
    if (used.has(bz * CELL + bx)) continue;
    used.add(bz * CELL + bx);
    return { bx, bz, facing: side.facing };
  }
  return null;
}

/** 候補のブロック（bz * CELL + bx）から1つ取る。used にあるものは避けて次へ。取れなければ -1 */
function takeBlock(cands, v, used) {
  for (let j = 0; j < cands.length; j++) {
    const b = cands[(v + j) % cands.length];
    if (used.has(b)) continue;
    used.add(b);
    return b;
  }
  return -1;
}

/**
 * セルの小物 [{ id, bx, y, bz, states? }]。bx/bz はセル内オフセット（0..15）。
 * states は BlockPermutation.resolve(id, states) にそのまま渡せる形。
 * 拠点・水区画・階段では空配列（拠点は清潔なまま、水区画と階段は構造を壊さない）
 */
export function decorAt(cx, cz, seed) {
  if (isHome(cx, cz)) return [];
  const lm = landmarkCovering(cx, cz, seed);
  if (lm && (lm.kind === LM_WATER || lm.kind === LM_STAIRS)) return [];

  const mask = wallMask(cx, cz, seed);
  // マニラルーム: 部屋の中の壁の足元にコンセントを1つだけ（Wiki の写真）。回廊も含めて天井・床の小物は置かない（INTERFACES.md 8.2）
  if (lm && lm.kind === LM_MANILA) {
    const [a, b] = MANILA_RING;
    const spots = wallSpots(mask, (tx, tz) => tx <= a || tx >= b || tz <= a || tz >= b);
    const s = takeWallSpot(spots, hash32(cx, cz, SALT.MANILA_DECOR, seed), new Set());
    return s ? [{ id: B_OUTLET, bx: s.bx, y: Y_AIR_MIN, bz: s.bz, states: { [S_FACING]: s.facing } }] : [];
  }
  /** @type {{ id: string, bx: number, y: number, bz: number, states?: Record<string, string | number> }[]} */
  const out = [];
  const h = (salt, i) => hash32(cx, cz, salt + i, seed);

  // 天井と床の小物は値0のタイルの上下だけ（壁の中では見えない）
  const open = [];
  for (let b = 0; b < CELL * CELL; b++) if (mask[(b >> 5) * TPC + ((b & 15) >> 1)] === W_NONE) open.push(b);

  // ---- 天井。蛍光灯の位置は避ける ----
  const ceilY = lm ? lm.ceilY : Y_CEIL;
  const ceilUsed = new Set(lightBlocks(cx, cz, seed).map((l) => l.bz * CELL + l.bx));
  const ceilIds = [];
  const vents = hashRange(cx, cz, SALT.DECOR_CEIL, seed, T.CEIL_VENT_MIN, T.CEIL_VENT_MAX);
  for (let i = 0; i < vents; i++) ceilIds.push(B_CEIL_VENT);
  for (let i = h(SALT.DECOR_CEIL, 1) % (T.CEIL_STAIN_MAX + 1); i > 0; i--) ceilIds.push(B_CEIL_STAINED);
  if (h(SALT.DECOR_CEIL, 2) % T.CEIL_MISSING_RATE === 0) ceilIds.push(B_CEIL_MISSING);
  ceilIds.forEach((id, i) => {
    const b = takeBlock(open, h(SALT.DECOR_CEIL, 3 + i), ceilUsed);
    if (b >= 0) out.push({ id, bx: b & 15, y: ceilY, bz: b >> 4 });
  });

  // ---- 床。判定点（7.3）は床のまま ----
  const floorUsed = new Set([(CELL / 2) * CELL + CELL / 2]);
  // 穴のセルは穴の中に床の小物を置かない（generator が穴を空けるので置いても消える）
  const pit = lm && lm.kind === LM_PIT ? pitAt(cx, cz, seed) : null;
  if (pit) for (let z = 0; z < PIT_SIZE; z++) for (let x = 0; x < PIT_SIZE; x++) floorUsed.add((pit.bz + z) * CELL + pit.bx + x);
  if (h(SALT.DECOR_FLOOR, 0) % T.FLOOR_WET_RATE === 0) {
    // 濡れたカーペット。2x2〜4x4 タイルの広がり
    const v = h(SALT.DECOR_FLOOR, 1);
    const w = 2 + (v % 3);
    const d = 2 + ((v >>> 4) % 3);
    const tx0 = (v >>> 8) % (TPC - w + 1);
    const tz0 = (v >>> 12) % (TPC - d + 1);
    for (const b of open) {
      const tx = (b & 15) >> 1;
      const tz = b >> 5;
      if (tx < tx0 || tx >= tx0 + w || tz < tz0 || tz >= tz0 + d || floorUsed.has(b)) continue;
      floorUsed.add(b);
      out.push({ id: B_FLOOR_WET, bx: b & 15, y: Y_FLOOR, bz: b >> 4 });
    }
  }
  for (let i = 0, n = h(SALT.DECOR_FLOOR, 2) % (T.FLOOR_STAIN_MAX + 1); i < n; i++) {
    const b = takeBlock(open, h(SALT.DECOR_FLOOR, 3 + i), floorUsed);
    if (b >= 0) out.push({ id: B_FLOOR_STAINED, bx: b & 15, y: Y_FLOOR, bz: b >> 4 });
  }
  if (pit) {
    // 穴の縁の汚れ（INTERFACES.md 9.3）。穴を囲む1ブロック幅のうち、壁の無いタイルの上をハッシュで半分ほど
    for (const b of open) {
      const bx = b & 15;
      const bz = b >> 4;
      if (bx < pit.bx - 1 || bx > pit.bx + PIT_SIZE || bz < pit.bz - 1 || bz > pit.bz + PIT_SIZE || floorUsed.has(b)) continue;
      if (hash32(cx * CELL + bx, cz * CELL + bz, SALT.PIT_POS, seed) & 1) continue;
      floorUsed.add(b);
      out.push({ id: B_FLOOR_STAINED, bx, y: Y_FLOOR, bz });
    }
  }

  // ---- 壁。遺留品と出口のドアのタイル、落書きの列は避ける ----
  const relic = relicAt(cx, cz, seed);
  const exit = exitAt(cx, cz, seed);
  const busy = (tx, tz) => (relic && relic.tx === tx && relic.tz === tz) || (exit && exit.tx === tx && exit.tz === tz);
  const spots = wallSpots(mask, busy);
  const wallUsed = new Set((relic?.spots ?? []).map((s) => s.bz * CELL + s.bx));
  const wallItems = [];
  for (let i = h(SALT.DECOR_WALL, 0) % (T.DECOR_OUTLET_MAX + 1); i > 0; i--) wallItems.push({ id: B_OUTLET, y: Y_AIR_MIN });
  for (let i = h(SALT.DECOR_WALL, 1) % (T.DECOR_SWITCH_MAX + 1); i > 0; i--) wallItems.push({ id: B_SWITCH, y: Y_AIR_MIN + 1 });
  // 誘導灯の矢印はでたらめ（出口と関係ない）。暗区画には置かない
  const sign = hash32(cx, cz, SALT.DECOR_EXIT_SIGN, seed);
  if (sign % T.EXIT_SIGN_RATE === 0 && !isDarkCell(cx, cz, seed)) {
    wallItems.push({ id: B_EXIT_SIGN, y: Y_CEIL - 2, arrow: (sign >>> 8) % 3 });
  }
  wallItems.forEach((it, i) => {
    const s = takeWallSpot(spots, h(SALT.DECOR_WALL, 2 + i), wallUsed);
    if (!s) return;
    const states = { [S_FACING]: s.facing };
    if (it.arrow !== undefined) states[S_ARROW] = it.arrow;
    out.push({ id: it.id, bx: s.bx, y: it.y, bz: s.bz, states });
  });
  return out;
}

// ---- ダンプ用（16.1 の生成状態ダンプ）----

export function describeCell(cx, cz, seed) {
  const lm = landmarkCovering(cx, cz, seed);
  return {
    cx,
    cz,
    variant: variantOf(cx, cz, seed),
    landmark: lm ? { kind: lm.kind, ox: lm.ox, oz: lm.oz, w: lm.w, h: lm.h, rot: lm.rot } : null,
    coverage: wallCoverage(cx, cz, seed),
    lights: lightBlocks(cx, cz, seed).length,
    exit: exitAt(cx, cz, seed),
    relic: relicAt(cx, cz, seed),
  };
}

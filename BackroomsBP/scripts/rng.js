/**
 * 決定論的乱数（仕様書 6.2）
 *
 * Math.random() は地形生成に使用禁止（15章）。FR-4 の決定論性はここが支える。
 */

import { world } from "@minecraft/server";
import { DP_SEED } from "./config.js";

/** 32bit 整数ハッシュ（splitmix 系）。同じ入力なら常に同じ値を返す */
export function hash32(x, z, salt, seed) {
  let h =
    (seed ^ Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(z | 0, 0x165667b1) ^ Math.imul(salt | 0, 0x9e3779b9)) | 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/** 範囲 [min, max]（両端含む）の整数を決定論的に返す */
export function hashRange(x, z, salt, seed, min, max) {
  return min + (hash32(x, z, salt, seed) % (max - min + 1));
}

/**
 * salt の割り当て。用途ごとに分ける（6.2）。
 * 添字付きのもの（TX/TZ/DIR/LEN）は i を足すため、間隔を空けてある。
 */
export const SALT = {
  COUNT: 1,
  VARIANT: 2,
  LIGHT: 3,
  LIGHT_SUB: 4,
  LM_ORIGIN: 5,
  LM_KIND: 6,
  RELIC: 7,
  RELIC_KIND: 8,
  RELIC_POS: 9,
  EXIT: 10,
  EXIT_POS: 11,
  SIGN_TEXT: 12,
  CHEST: 13,
  GEAR: 14,
  WATER_GATE: 15,
  ENTITY: 50, // entities.js。生成ではないので tick を混ぜて引く（17〜 は ATRIUM_PILLAR + i が使う）
  ATRIUM_PILLAR: 16,
  // v0.3.0（設計書 3章）。17〜22 は ATRIUM_PILLAR + 1 + i、50 は ENTITY が使う
  LM_ROT: 30,
  CORRIDOR_SIDE: 31,
  ROOMS_GATE: 33,
  LIGHT_KIND: 34,
  LIGHT_PHASE: 35, // 点滅のコマ割りの種類（0..2）。最終レビューで足した
  DECOR_EXIT_SIGN: 38,
  RELIC_OFFICE: 39,
  RELIC_DIARY: 40,
  MANILA_DOOR: 41, // マニラルームの戸口の辺と位置（v0.4.0）
  MANILA_DECOR: 42, // マニラルームの中のコンセントの位置（v0.4.0）
  PIT_POS: 43, // Level 0 の穴の位置（v0.5.0・担当Ⓑ）
  // v0.5.0 の Level 1 は担当Ⓐが L1_ で始まる名前で足す。単独の値は 60〜79、+i の範囲は 2000〜2999
  L1_KIND: 60, // セルの種類
  L1_STAIRS: 61, // 上り階段のセルか
  L1_CRATE: 62, // 物資の箱があるか
  L1_CRATE_POS: 63, // 箱の場所
  L1_LIGHT: 64, // 蛍光灯（全体のタイル座標で引く）
  L1_LIGHT_DIR: 65, // 蛍光灯の向きとずれ（全体のタイル座標で引く）
  L1_REBAR: 66, // 鉄筋の壁（全体のタイル座標で引く）
  L1_CRATE_ITEMS: 2000, // +i（箱の中身。ワールド座標で引く）
  L1_DOOR_N: 2100, // +i（北の境目の戸口。先頭は数）
  L1_DOOR_W: 2200, // +i（西の境目の戸口。先頭は数）
  L1_ROOM_DOOR: 2300, // +i（普通の部屋の戸口。先頭は数）
  L1_PUDDLE: 2400, // +i（水たまり。先頭は数）
  L1_GRAFFITI: 2500, // +i（壁の絵。先頭は数）
  TX: 100, // +i
  TZ: 200, // +i
  DIR: 300, // +i
  LEN: 400, // +i
  WALL_STYLE: 500, // +i
  WALL_DOOR: 600, // +i
  ROOMS_MAZE: 700, // +step（小部屋の全域木。最大15手）
  DECOR_WALL: 1000, // +i（壁の小物の数と場所）
  DECOR_CEIL: 1100, // +i（天井の小物）
  DECOR_FLOOR: 1200, // +i（床の小物）
  RELIC_GRAFFITI: 1300, // +i（落書きの枚数と場所と図柄）
};

let cachedSeed;

/** ワールドの seed。初回のみ生成して dynamic property に保存する（6.2 / 10章） */
export function getSeed() {
  if (cachedSeed !== undefined) return cachedSeed;
  let s = world.getDynamicProperty(DP_SEED);
  if (typeof s !== "number") {
    // 保存時の一度きりだけは Math.random() を使う。これは地形生成ではなく seed の採番
    s = (Math.floor(Math.random() * 0xffffffff) ^ Date.now()) | 0;
    world.setDynamicProperty(DP_SEED, s);
  }
  cachedSeed = s | 0;
  return cachedSeed;
}

/** テスト・デバッグ用に seed を差し替える */
export function setSeed(s) {
  cachedSeed = s | 0;
  world.setDynamicProperty(DP_SEED, cachedSeed);
}

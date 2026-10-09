/**
 * 自己点検(INTERFACES.md 9.4・README 7節)
 *
 * 実機に持っていく前にまだ1回も実機で動かせていないので、README 7節の宿題のうち
 * ゲームの中から自動で確かめられる分だけを `/backrooms:selftest` でまとめて確かめる。
 * 住人の見た目・動き・音・小物の向きなど「見て確かめる」ものはここでは扱えない(README 7節のまま)。
 *
 * 10項目それぞれ1行でチャットへ(player.sendMessage)と console.warn の両方に出す。
 * 1項目の中に複数の事実(例: ブロックが5種取れるか)があるときは、その項目の行の中で
 * 短くまとめる(項目をまたいで2行にはしない)。最後に集計を1行足す。
 *
 * 印はここ1か所(MARK)だけ。豆腐になったら差し替える。
 */

import { BlockTypes, EntityDamageCause, EntityTypes, ItemStack, ItemTypes, world } from "@minecraft/server";
import * as CONFIG from "./config.js";
import {
  DIM_ID,
  DIM1_ID,
  E_HOUND,
  E_SHADOW,
  E_SMILER,
  FOG1_PHASES,
  FOG_PHASES,
  I_ALMOND,
  I_NOCLIP,
  LM_ATRIUM,
  LM_CORRIDOR,
  LM_DARK,
  LM_KINDS,
  LM_MANILA,
  LM_PILLARS,
  LM_PIT,
  LM_ROOMS,
  LM_STAIRS,
  LM_WATER,
  TUNING,
  Y_AIR_MIN,
} from "./config.js";
import { getSeed } from "./rng.js";
import { cellOf, findLandmark, isSafeCell, pitAt } from "./layout.js";
import { hasStairs1 } from "./layout1.js";
import { isCellGenerated, standable } from "./generator.js";
import { isCellGenerated1 } from "./generator1.js";
import { getStatus } from "./scheduler.js";
import { applyFog, isInBackrooms, isInLevel0, isInLevel1, removeFog, walkedDistance } from "./portal.js";

/**
 * 印はここ1か所だけ。OK/NG/-- の3つ。○/×/－ は JIS X 0208 にあるが
 * tools/validate.cjs の表示文字チェック(実機で確かめた記号だけを許す許可リスト)に無く、
 * 豆腐になる恐れがあるので最初から ASCII にしてある(INTERFACES.md 9.4)。
 */
const MARK = { OK: "OK", NG: "NG", NA: "--" };

const LM_NAMES = {
  [LM_ATRIUM]: "巨大空間",
  [LM_DARK]: "暗区画",
  [LM_WATER]: "水区画",
  [LM_STAIRS]: "階段",
  [LM_CORRIDOR]: "長い廊下",
  [LM_PILLARS]: "柱の広間",
  [LM_ROOMS]: "小部屋の区画",
  [LM_MANILA]: "マニラルーム",
  [LM_PIT]: "穴",
};

/** 8. 近くの目印を探す半径(セル数) */
const LANDMARK_SEARCH_RADIUS = 64;
const STAIRS_SEARCH_RADIUS = 32;
/** 4. エンティティを出す場所を探す距離の範囲(ブロック) */
const ENTITY_SPOT_MIN_R = 3;
const ENTITY_SPOT_MAX_R = 8;
/** 4. ハウンドの slowness 確認で付ける長さ(tick)。確認後すぐ消すのでごく短くてよい */
const HOUND_TEST_SLOWNESS_TICKS = 20;
/** 4. スマイラーの攻撃確認で使うダメージ量 */
const SMILER_TEST_DAMAGE = 4;
/** 5. 霧の push/remove 確認だけに使う一時タグ。本番の霧(FOG_TAG)のスタックには触れない */
const FOG_TEST_TAG = "backrooms:selftest_fog";

function markFor(pass) {
  if (pass === null || pass === undefined) return MARK.NA;
  return pass ? MARK.OK : MARK.NG;
}

/**
 * 実機でしか分からない項目を、できるだけ自動で確かめる(INTERFACES.md 9.4 の10項目)。
 * `/backrooms:selftest` から呼ばれる。ワールドを壊さない・ブロックを置きっぱなしにしない・
 * エンティティを残さない(呼び出しは commands.js から system.run() の中で行われる)。
 * 各項目は必ず1つの { pass, text } を返す(例外が出ても catch してエラーとして扱う)ので、
 * 出力は常に10行 + 集計の1行になる。
 */
export async function runSelfTest(player) {
  const checks = [
    testDimensions,
    testBlocks,
    testItems,
    testEntities,
    testFog,
    testBrightness,
    testGeneration,
    testLandmarks,
    testWalked,
    testBetaApi,
  ];
  const results = checks.map((fn) => {
    try {
      return fn(player);
    } catch (e) {
      return { pass: false, text: `確認中にエラー(${e})` };
    }
  });
  report(player, results);
}

// ---- 1. ディメンション ----

function testDimensions() {
  const parts = [];
  let pass = true;
  for (const [id, name] of [
    [DIM_ID, "Level 0"],
    [DIM1_ID, "Level 1"],
  ]) {
    let ok;
    try {
      world.getDimension(id);
      ok = true;
    } catch {
      ok = false;
    }
    pass = pass && ok;
    parts.push(`${name} ${markFor(ok)}`);
  }
  return { pass, text: `ディメンション: ${parts.join(" / ")}` };
}

// ---- 2. ブロック ----

/** config.js の B_ / B1_ で始まる backrooms: の識別子を全部集める(新しいブロックを足しても直さなくてよい) */
function backroomsBlockIds() {
  return Object.entries(CONFIG)
    .filter(([k, v]) => (k.startsWith("B_") || k.startsWith("B1_")) && typeof v === "string" && v.startsWith("backrooms:"))
    .map(([, v]) => /** @type {string} */ (v));
}

function testBlocks() {
  const ids = backroomsBlockIds();
  const missing = ids.filter((id) => !BlockTypes.get(id));
  const pass = missing.length === 0;
  return {
    pass,
    text:
      `ブロック: backrooms: の ${ids.length} 種が BlockTypes.get で取れる ${markFor(pass)}` +
      (missing.length ? ` (取れない: ${missing.join(", ")})` : ""),
  };
}

// ---- 3. アイテム ----

function testItems() {
  const noclip = !!ItemTypes.get(I_NOCLIP);
  const almond = !!ItemTypes.get(I_ALMOND);
  let food = false;
  try {
    food = !!new ItemStack(I_ALMOND).getComponent("minecraft:food");
  } catch {
    food = false;
  }
  const pass = noclip && almond && food;
  return {
    pass,
    text:
      `アイテム: ノークリップ ${markFor(noclip)} / アーモンドウォーター ${markFor(almond)}` +
      ` / minecraft:food の部品 ${markFor(food)}`,
  };
}

// ---- 4. エンティティ ----

/** プレイヤーの足元から離れた、安全地帯でない生成済みの柱を探す。見つからなければ undefined */
function findEntityTestSpot(dim, loc, seed) {
  const x0 = Math.floor(loc.x);
  const z0 = Math.floor(loc.z);
  for (let r = ENTITY_SPOT_MIN_R; r <= ENTITY_SPOT_MAX_R; r++) {
    for (const [dx, dz] of [
      [r, 0],
      [-r, 0],
      [0, r],
      [0, -r],
    ]) {
      const x = x0 + dx;
      const z = z0 + dz;
      const { cx, cz } = cellOf(x, z);
      if (isSafeCell(cx, cz, seed) || !isCellGenerated(dim, cx, cz) || !standable(dim, x, z)) continue;
      return { x: x + 0.5, y: Y_AIR_MIN, z: z + 0.5 };
    }
  }
  return undefined;
}

function testEntities(player) {
  const names = { [E_SHADOW]: "フェイスリング", [E_HOUND]: "ハウンド", [E_SMILER]: "スマイラー" };
  const missing = Object.keys(names).filter((id) => !EntityTypes.get(id));
  let pass = missing.length === 0;
  const parts = [
    `3種 EntityTypes.get ${markFor(pass)}` + (missing.length ? ` (無い: ${missing.map((id) => names[id]).join(",")})` : ""),
  ];

  if (!isInLevel0(player)) {
    parts.push("挙動確認 -- (Level 0 の外)");
    return { pass, text: `エンティティ: ${parts.join(" / ")}` };
  }

  let seed;
  try {
    seed = getSeed();
  } catch {
    seed = undefined;
  }
  const dim = player.dimension;
  const spot = seed === undefined ? undefined : findEntityTestSpot(dim, player.location, seed);
  if (!spot) {
    parts.push("挙動確認 -- (出せる場所が無い)");
    return { pass, text: `エンティティ: ${parts.join(" / ")}` };
  }

  // ハウンド: slowness 255 が実際に付くか(見つめ返しの判定そのものは実機でしか確かめられない。README 7節)
  let hound;
  try {
    hound = dim.spawnEntity(E_HOUND, spot);
    hound.addEffect("slowness", HOUND_TEST_SLOWNESS_TICKS, { amplifier: 255, showParticles: false });
    const eff = hound.getEffect("slowness");
    const ok = !!eff && eff.amplifier === 255;
    pass = pass && ok;
    parts.push(`ハウンド slowness255 を API が受け付ける ${markFor(ok)} (見つめ返しの判定は目で確かめる)`); // 最終レビュー 軽微-5
  } catch (e) {
    pass = false;
    parts.push(`ハウンド確認エラー(${e})`);
  } finally {
    if (hound) {
      try {
        hound.remove();
      } catch {
        /* 既に消えていた */
      }
    }
  }

  // スマイラー: 通常攻撃は通らず、火は通るか(entities/smiler.json の damage_sensor。README 7節「物理攻撃は効かない」)
  let smiler;
  try {
    smiler = dim.spawnEntity(E_SMILER, spot);
    const hitByAttack = smiler.applyDamage(SMILER_TEST_DAMAGE, { cause: EntityDamageCause.entityAttack });
    const hitByFire = smiler.applyDamage(SMILER_TEST_DAMAGE, { cause: EntityDamageCause.fire });
    const okAttack = !hitByAttack;
    const okFire = !!hitByFire;
    pass = pass && okAttack && okFire;
    parts.push(`スマイラー entityAttack無効 ${markFor(okAttack)} / fire有効 ${markFor(okFire)}`);
  } catch (e) {
    pass = false;
    parts.push(`スマイラー確認エラー(${e})`);
  } finally {
    if (smiler) {
      try {
        smiler.remove();
      } catch {
        /* 既に消えていた */
      }
    }
  }

  return { pass, text: `エンティティ: ${parts.join(" / ")}` };
}

// ---- 5. 霧 ----

function testFog(player) {
  const ids = [...new Set([...FOG_PHASES.map(([, id]) => id), ...FOG1_PHASES.map(([, id]) => id)])];
  let ok = true;
  for (const id of ids) {
    try {
      player.fogSettings.push(id, FOG_TEST_TAG);
    } catch (e) {
      ok = false;
      console.warn(`[backrooms] selftest fog ${id} failed: ${e}`);
    } finally {
      // push が通って remove が投げても点検用の霧を残さない（セーブをまたいで残る = 最終レビュー 軽微-4）
      try {
        player.fogSettings.remove(FOG_TEST_TAG);
      } catch (e) {
        ok = false;
        console.warn(`[backrooms] selftest fog ${id} remove failed: ${e}`);
      }
    }
  }

  // 15章: フォグの解除処理を省略しない。自己点検の前に掛かっていた霧へ戻す
  try {
    if (isInBackrooms(player)) applyFog(player);
    else removeFog(player);
  } catch {
    /* 退出済み等。次の接触・次の周期で portal.js がかけ直す */
  }

  return { pass: ok, text: `霧: FOG_PHASES / FOG1_PHASES の ${ids.length} 種が push / remove できる ${markFor(ok)}` };
}

// ---- 6. 明るさ ----

function testBrightness(player) {
  if (!isInBackrooms(player)) {
    return { pass: null, text: "明るさ: Level 0 / Level 1 の外なので確認できない" };
  }
  try {
    const dim = player.dimension;
    const eye = player.getHeadLocation();
    const sky = dim.getSkyLightLevel(eye);
    const block = dim.getLightLevel(eye);
    return {
      pass: sky === 0,
      text: `明るさ: 頭の位置の空の光 ${sky} ${markFor(sky === 0)}(0が正常)、ブロックの光 ${block}`,
    };
  } catch (e) {
    return { pass: false, text: `明るさ: 確認できない(${e})` };
  }
}

// ---- 7. 生成 ----

function safeStatus() {
  try {
    return getStatus() ?? { queueLength: 0, jobRunning: false, currentCell: null };
  } catch {
    return { queueLength: 0, jobRunning: false, currentCell: null };
  }
}

function testGeneration(player) {
  const status = safeStatus();
  const statusText = `スケジューラ キュー${status.queueLength} ジョブ${status.jobRunning ? "実行中" : "停止"} 対象${status.currentCell ?? "なし"}`;

  let label;
  let check;
  if (isInLevel0(player)) {
    label = "Level 0";
    check = isCellGenerated;
  } else if (isInLevel1(player)) {
    label = "Level 1";
    check = isCellGenerated1;
  } else {
    return { pass: null, text: `生成: Level 0 / Level 1 の外なので周りのセルは確認できない (${statusText})` };
  }

  try {
    const dim = player.dimension;
    const { cx, cz } = cellOf(player.location.x, player.location.z);
    let done = 0;
    let total = 0;
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        total++;
        if (check(dim, cx + dx, cz + dz)) done++;
      }
    }
    const pass = done === total;
    return {
      pass,
      text: `生成: ${label} 現在セルと周り8セル ${done}/${total} が生成済み ${markFor(pass)} (${statusText})`,
    };
  } catch (e) {
    return { pass: false, text: `生成: 確認できない(${e}) (${statusText})` };
  }
}

// ---- 8. 近くの目印 ----

/** (cx0,cz0) から外側へリング状に探し、predicate(cx,cz) が真になる最初のセルを返す。無ければ null */
function nearestCell(cx0, cz0, radius, predicate) {
  if (predicate(cx0, cz0)) return { cx: cx0, cz: cz0 };
  for (let r = 1; r <= radius; r++) {
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        if (predicate(cx0 + dx, cz0 + dz)) return { cx: cx0 + dx, cz: cz0 + dz };
      }
    }
  }
  return null;
}

function testLandmarks(player) {
  let seed;
  try {
    seed = getSeed();
  } catch {
    seed = undefined;
  }
  if (seed === undefined) return { pass: false, text: "目印: seed が読めない" };

  if (isInLevel0(player)) {
    try {
      const { cx, cz } = cellOf(player.location.x, player.location.z);
      const parts = [];
      for (let kind = 0; kind < LM_KINDS; kind++) {
        const found = findLandmark(cx, cz, kind, seed, LANDMARK_SEARCH_RADIUS);
        let where = found ? `${found.ox},${found.oz}` : "無し";
        if (found && kind === LM_PIT) {
          // 穴は原点のセルでも、壁の無い場所が無ければ開かない（最終レビュー 軽微-6）。開いていれば穴のブロック座標を出す（そのまま tp できる）
          const pit = pitAt(found.ox, found.oz, seed);
          where = pit ? `x ${found.ox * CONFIG.CELL + pit.bx + 2} z ${found.oz * CONFIG.CELL + pit.bz + 2}` : `${where} (穴は開いていない)`;
        }
        parts.push(`${LM_NAMES[kind] ?? kind} ${where}`);
      }
      return { pass: true, text: `目印: ${parts.join(" / ")}` };
    } catch (e) {
      return { pass: false, text: `目印: 確認できない(${e})` };
    }
  }

  if (isInLevel1(player)) {
    try {
      const { cx, cz } = cellOf(player.location.x, player.location.z);
      const at = nearestCell(cx, cz, STAIRS_SEARCH_RADIUS, (x, z) => hasStairs1(x, z, seed));
      return {
        pass: true,
        text: `目印: 最寄りの上り階段 ${at ? `${at.cx},${at.cz}` : `半径${STAIRS_SEARCH_RADIUS}セル以内に無し`}`,
      };
    } catch (e) {
      return { pass: false, text: `目印: 確認できない(${e})` };
    }
  }

  return { pass: null, text: "目印: Level 0 / Level 1 の外なので確認できない" };
}

// ---- 9. 歩いた距離 ----

function testWalked(player) {
  let walked = 0;
  try {
    walked = Math.floor(walkedDistance(player)); // 保存は間引いているので portal.js が持っている値を読む
  } catch {
    /* 読めなければ 0 のまま */
  }
  return { pass: true, text: `歩いた距離: ${walked} / ${TUNING.MANILA_WALK_BLOCKS} ブロック (backrooms:walked)` };
}

// ---- 10. Beta APIs ----

function testBetaApi() {
  return {
    pass: true,
    text: "Beta APIs: スクリプトが動作している。実験的機能のベータ API が OFF でこれが出ていれば不要",
  };
}

// ---- 出力 ----

function tell(player, message) {
  try {
    player.sendMessage(message);
  } catch {
    /* 退出済み */
  }
}

function report(player, results) {
  let ok = 0;
  let ng = 0;
  let na = 0;
  results.forEach((r, i) => {
    const mark = markFor(r.pass);
    if (mark === MARK.OK) ok++;
    else if (mark === MARK.NG) ng++;
    else na++;
    const line = `${mark} ${i + 1}. ${r.text}`;
    tell(player, line);
    console.warn(`[backrooms] selftest ${line}`);
  });
  const summary = `自己点検 集計: OK${ok} NG${ng} --${na} (全${results.length}項目)`;
  tell(player, summary);
  console.warn(`[backrooms] selftest ${summary}`);
}

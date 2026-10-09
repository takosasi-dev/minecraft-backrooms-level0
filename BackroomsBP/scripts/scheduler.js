/**
 * 生成スケジューラ（仕様書 7.1 / 7.2 / 10章 / 16.4・v0.5.0 で Level 1 も = INTERFACES.md 9.3）
 *
 * アドオン全体で許された runInterval 2本のうちの1本。ここが唯一のタイマー。
 * セル単位・ブロック単位・プレイヤー単位のタイマーは作らない（15章）。
 * 過去に別アドオンで per-block タイマーがワールドリロード後に全滅した事故がある。
 *
 * 各周期でやること:
 *   1. Level 0 と Level 1 のプレイヤーを列挙（誰もいなければキューを空にして戻る = 16.4）
 *   2. 全員の周囲 GEN_RADIUS セルの未生成セルを集め、進行方向優先でキューを作り直す（7.1）。
 *      キューの要素はディメンションを持つ。2つの階層のセルが1本のキューに混ざって並ぶ
 *   3. ジョブが走っていなければ1本だけ起動する。ジョブはキューが空になるまで順に生成する（階層をまたいでも1本）
 *   0. 足元のセルが未生成なら、ジョブを待たずにその場で生成する（Q-10 の最後の砦）
 *   4. 出口ドアの接触判定・マニラルームの滞在・歩いた距離・上り階段・穴・外へ出た人の救出を portal.js に相乗りさせる（Q-11）
 *   5. エンティティの出現と消滅を entities.js に相乗りさせる（Level 0 だけ）
 *
 * キューを周期ごとに作り直すのは、前の周期の並びの後ろに足していくと、新しく視界に
 * 入ってきた進行方向のセルが古い横方向のセルの後ろで待たされるため。
 * ジョブを1セルごとに終わらせないのは、次のセルが次の周期（0.5秒後）まで始まらず、
 * 端末がどれだけ速くても毎秒2セルで頭打ちになるため。斜めに走る1人・別方向へ走る2人の
 * どちらにも追いつけず虚空に落ちる（tools/test_scheduler.mjs で再現できる）。
 */

import { system, world, GameMode } from "@minecraft/server";
import { DIM_ID, DIM1_ID, TICK_INTERVAL, TUNING } from "./config.js";
import { cellOf } from "./layout.js";
import { getSeed } from "./rng.js";
import { generateCellJob, isCellGenerated } from "./generator.js";
import { generateCellJob1, isCellGenerated1 } from "./generator1.js";
import { checkExitContact, checkManilaStay, checkStairsUp, keepInBounds, trackWalk } from "./portal.js";
import { updateEntities } from "./entities.js";

/**
 * 次の周期（0.5秒後）までに踏み込みうる距離（ブロック）。
 * スプリント 5.6 m/s で 2.8 ブロック、スプリントジャンプの約 7 m/s で 3.5 ブロック
 */
const FOOTING_REACH = 4;

/** 生成待ちのセル [dim, cx, cz]。先頭ほど優先度が高い。周期ごとに作り直す（7.1） */
let queue = [];

let intervalId;
/** 同時に走らせるジョブは1本まで（7.2）。Level 0 と Level 1 で共用 */
let running = false;
let currentCell = null;

const key = (dim, cx, cz) => dim.id + "@" + cx + "," + cz;

/** ディメンションの id で generator.js / generator1.js を選ぶ */
const isLevel1 = (dim) => dim.id === DIM1_ID;
const isGenerated = (dim, cx, cz) => (isLevel1(dim) ? isCellGenerated1(dim, cx, cz) : isCellGenerated(dim, cx, cz));
const cellJob = (dim, cx, cz, seed) => (isLevel1(dim) ? generateCellJob1(dim, cx, cz, seed) : generateCellJob(dim, cx, cz, seed));

/** ディメンションとそこにいるプレイヤー。未登録（Level 1 の JSON もスクリプト登録も効いていない）なら空 */
function playersIn(id) {
  try {
    const dim = world.getDimension(id);
    return { dim, players: dim.getPlayers() };
  } catch {
    return { dim: undefined, players: [] };
  }
}

/**
 * キューが空になるまで先頭から1セルずつ生成するジョブ（7.2）。
 * ジョブは常に1本で、1イテレーションの粒度は generator.js / generator1.js のまま変わらない（FR-6）。
 * 途中で tick() がキューを差し替えても、次のセルからは新しい並びで拾う。
 */
function* drain() {
  try {
    while (queue.length > 0) {
      const [dim, cx, cz] = queue.shift();
      // 並べた後に生成済みになっていることがある（ランドマークは占有範囲をまとめて書く）
      if (isGenerated(dim, cx, cz)) continue;
      currentCell = key(dim, cx, cz);
      try {
        yield* cellJob(dim, cx, cz, getSeed());
      } catch (e) {
        // 判定点は最後に置くので、失敗したセルは次の周期で未生成として拾い直される（7.3）。
        // ここでジョブごと止めると、失敗し続けるセルが先頭にある限り他のセルが生成されない
        console.warn(`[backrooms] generate failed at ${currentCell}: ${e}`);
      }
    }
  } finally {
    running = false;
    currentCell = null;
  }
}

/**
 * プレイヤー周囲の未生成セルを found に集める。進行方向にあるセルほど点が高い（7.1）。
 * 背後は虚空でも視界に入らない。複数人の範囲が重なったセルは高いほうの点を取る。
 */
function scan(dim, player, found) {
  const here = cellOf(player.location.x, player.location.z);
  const v = player.getVelocity();
  const speed = Math.hypot(v.x, v.z);
  const ux = speed > 0.05 ? v.x / speed : 0;
  const uz = speed > 0.05 ? v.z / speed : 0;
  const r = TUNING.GEN_RADIUS;

  for (let dz = -r; dz <= r; dz++) {
    for (let dx = -r; dx <= r; dx++) {
      const cx = here.cx + dx;
      const cz = here.cz + dz;
      const dist = Math.hypot(dx, dz);
      const forward = dist === 0 ? 1 : (dx * ux + dz * uz) / dist;
      const score = forward * 2 - dist;
      const seen = found.get(key(dim, cx, cz));
      if (seen) {
        seen.score = Math.max(seen.score, score);
        continue;
      }
      if (isGenerated(dim, cx, cz)) continue;
      found.set(key(dim, cx, cz), { dim, cx, cz, score });
    }
  }
}

/**
 * 生成が追いつかなかったときの最後の砦（Q-10）。
 * 足元から FOOTING_REACH の範囲にかかるセルが未生成なら、ジョブを待たずにその場で生成する
 * （8.2 の入場時と同じ同期生成）。範囲は1セルより狭いので、四隅を見れば掛かるセルを全部拾える。
 * ホストの処理が足りないときにしか働かず、普段は判定点を最大4つ読むだけで終わる。
 * 働いた周期はその分だけ重くなる（落ちるよりはよい）。
 */
function guardFooting(dim, player) {
  // クリエイティブとスペクテイターは落ちても飛べる。飛び回るたびに同期生成でホストを止めない
  const mode = player.getGameMode();
  if (mode === GameMode.Creative || mode === GameMode.Spectator) return;
  const { x, z } = player.location;
  for (const ox of [-FOOTING_REACH, FOOTING_REACH]) {
    for (const oz of [-FOOTING_REACH, FOOTING_REACH]) {
      const { cx, cz } = cellOf(x + ox, z + oz);
      try {
        forceGenerateCell(dim, cx, cz, getSeed());
      } catch (e) {
        console.warn(`[backrooms] footing generate failed at ${cx},${cz}: ${e}`);
      }
    }
  }
}

function tick() {
  const l0 = playersIn(DIM_ID);
  const l1 = playersIn(DIM1_ID);
  const levels = [l0, l1].filter((l) => l.players.length > 0);
  for (const { dim, players } of levels) for (const p of players) guardFooting(dim, p); // 足元が先
  const found = new Map();
  for (const { dim, players } of levels) for (const p of players) scan(dim, p, found);
  queue = [...found.values()].sort((a, b) => b.score - a.score).map((f) => [f.dim, f.cx, f.cz]);
  // 誰も Level 0 / Level 1 にいなければキューは空になり、走っているジョブも今のセルで止まる（16.4）
  if (levels.length === 0) return;

  if (!running && queue.length > 0) {
    running = true; // runJob がその場で回りきっても取りこぼさないよう先に立てる
    system.runJob(drain());
  }

  // 出口ドアの接触（Q-11 / 8.3）と、外へ出た人の救出。判定も転送も portal.js の
  // 責務なので返り値は使わない。ここが投げても生成が止まらないよう周期の最後に置く。
  // 救出は guardFooting の後に見る。足元のセルが書き終わってから「天井の上か」を判定するため。
  // マニラルームに居続けた時間と歩いた距離もここで数える（周期ごとに1人1回呼ぶ前提で数えている = INTERFACES.md 8.2 / 9.3）。
  // 穴に落ちた人の Level 1 行きは keepInBounds の中で救出より先に見る
  for (const p of l0.players) {
    checkExitContact(p);
    checkManilaStay(p);
    trackWalk(p);
    keepInBounds(p);
  }
  for (const p of l1.players) {
    checkStairsUp(p);
    keepInBounds(p);
  }

  // エンティティも周期の最後。ここが投げても生成と救出は済んでいる。Level 0 だけ（9.2 で Level 1 には出さない）
  if (l0.players.length === 0) return;
  try {
    updateEntities(l0.dim, l0.players);
  } catch (e) {
    console.warn(`[backrooms] entities failed: ${e}`);
  }
}

/** runInterval はこの1本だけ（7.1 / 15章） */
export function startScheduler() {
  if (intervalId !== undefined) return;
  intervalId = system.runInterval(tick, TICK_INTERVAL);
}

export function getStatus() {
  return { queueLength: queue.length, jobRunning: running, currentCell };
}

/**
 * 初回入場の同期生成（8.2）。ジョブに回さずその場で回しきる。
 * dim.id で Level 0（generator.js）と Level 1（generator1.js）を選ぶ（INTERFACES.md 9.3）
 */
export function forceGenerateCell(dim, cx, cz, seed) {
  if (isGenerated(dim, cx, cz)) return;
  const job = cellJob(dim, cx, cz, seed);
  while (!job.next().done) {
    /* 到着先が虚空のままテレポートするのを防ぐため、ここだけは分散させない */
  }
}

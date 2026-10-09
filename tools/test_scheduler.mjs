/**
 * 生成スケジューラが走るプレイヤーに追いつくか（仕様書 7.1 / 7.2 / FR-3 / Q-10）と、
 * Level 0 の外へ出た人の救出（portal.js の keepInBounds）
 *
 *   node tools/test_scheduler.mjs
 *
 * 実物の scheduler.js / portal.js / generator.js / layout.js / relics.js をそのまま動かし、
 * @minecraft/server だけを「床と判定点だけを覚える偽ワールド」に差し替える。
 * runInterval と runJob は自前の時計で 1tick ずつ回す。
 *
 * runJob が1tickに進められる yield 数（BUDGET）は実機の性能で決まり、ここでは分からない。
 * 仕様書 Q-10 の最悪ケース（1tick 1 yield）から、1セルを1tickで書き終える速さまで振って表に出す。
 *
 * 合否:
 *   - どの速さでも足元が虚空にならない（遅いホストでは足元の同期生成が肩代わりする）
 *   - 速い端末なら、何人がどの向きに走っても霧の内側に虚空が入らず、同期生成も要らない。
 *     ここが落ちるなら、端末の速さと関係なくスケジューラ自体が生成量に天井を作っている
 */

import assert from "node:assert/strict";
import fs from "node:fs";
import { register } from "node:module";

const STUB_SRC = `
const sim = () => globalThis.__sim;
/** 購読されたハンドラを名前で覚える（portal.js のイベントを直接叩いて確かめる） */
const subs = (globalThis.__subs = {});
const signal = (name) => ({ subscribe: (cb) => { subs[name] = cb; return cb; }, unsubscribe: () => {} });
export const world = {
  getDynamicProperty: () => 20260921,
  setDynamicProperty: () => {},
  getDimension: (id) => {
    const d = sim().dims[id];
    if (!d) throw new Error('dimension not registered: ' + id);
    return d;
  },
  getDefaultSpawnLocation: () => ({ x: 0, y: 64, z: 0 }),
  getDifficulty: () => 'Normal',
  tickingAreaManager: { hasCapacity: () => true, createTickingArea: async () => {}, removeTickingArea: () => {} },
  afterEvents: new Proxy({}, { get: (_, k) => signal('after.' + String(k)) }),
  beforeEvents: new Proxy({}, { get: (_, k) => signal('before.' + String(k)) }),
};
export const system = {
  runInterval: (cb, ticks) => { sim().timers.push({ cb, ticks }); return sim().timers.length; },
  runJob: (job) => { sim().jobs.push(job); return sim().jobs.length; },
  run: (cb) => { cb(); return 0; },
  runTimeout: (cb) => { cb(); return 0; },
  waitTicks: async () => {},
  beforeEvents: { startup: signal('startup') },
};
export class BlockVolume { constructor(from, to) { this.from = from; this.to = to; } }
export const BlockPermutation = { resolve: (id, states) => ({ type: { id }, states }) };
export class ItemStack { constructor(id, amount) { this.typeId = id; this.amount = amount ?? 1; } getComponent() { return undefined; } }
export const EquipmentSlot = { Head: 'Head', Chest: 'Chest', Legs: 'Legs', Feet: 'Feet', Mainhand: 'Mainhand', Offhand: 'Offhand' };
export const WeatherType = { Clear: 'Clear', Rain: 'Rain', Thunder: 'Thunder' };
export const GameMode = { Survival: 'Survival', Creative: 'Creative', Adventure: 'Adventure', Spectator: 'Spectator' };
export const EntityInitializationCause = { Born: 'Born', Event: 'Event', Loaded: 'Loaded', Spawned: 'Spawned', Transformed: 'Transformed' };
export const Difficulty = { Peaceful: 'Peaceful', Easy: 'Easy', Normal: 'Normal', Hard: 'Hard' };
`;

/**
 * 担当Ⓐの generator1.js がまだ無いときだけ使う仮の Level 1 生成（INTERFACES.md 9.2 の形だけ真似る）。
 * 床を判定点を除いて敷き、何回か yield して、最後に判定点を置く。実物ができたら実物が読まれる
 */
const FAKE_G1_SRC = `
import { BlockPermutation, BlockVolume } from '@minecraft/server';
const FLOOR1 = 'backrooms:l1_floor';
const marker = (cx, cz) => ({ x: cx * 16 + 8, y: 0, z: cz * 16 + 8 });
export function isCellGenerated1(dim, cx, cz) {
  try { return dim.getBlock(marker(cx, cz))?.typeId === FLOOR1; } catch { return false; }
}
export function* generateCellJob1(dim, cx, cz) {
  const x0 = cx * 16, z0 = cz * 16;
  const fill = (a, b, c, d) => dim.fillBlocks(new BlockVolume({ x: a, y: 0, z: b }, { x: c, y: 0, z: d }), FLOOR1, {});
  fill(x0, z0, x0 + 15, z0 + 7); yield;
  fill(x0, z0 + 9, x0 + 15, z0 + 15); yield;
  fill(x0, z0 + 8, x0 + 7, z0 + 8); yield;
  fill(x0 + 9, z0 + 8, x0 + 15, z0 + 8);
  for (let i = 0; i < 20; i++) yield;
  dim.setBlockPermutation(marker(cx, cz), BlockPermutation.resolve(FLOOR1));
}
export function* clearCellJob1() {}
export function standable1(dim, x, z) {
  try {
    const f = dim.getBlock({ x, y: 0, z }), a = dim.getBlock({ x, y: 1, z }), b = dim.getBlock({ x, y: 2, z });
    return f !== undefined && !f.isAir && a?.isAir && b?.isAir;
  } catch { return false; }
}
`;
const G1_REAL = fs.existsSync(new URL("../BackroomsBP/scripts/generator1.js", import.meta.url));
const FAKE_G1 = G1_REAL ? "" : "data:text/javascript," + encodeURIComponent(FAKE_G1_SRC);

const STUB = "data:text/javascript," + encodeURIComponent(STUB_SRC);
register(
  "data:text/javascript," +
    encodeURIComponent(
      "const STUB = " +
        JSON.stringify(STUB) +
        ";\nconst FAKE_G1 = " +
        JSON.stringify(FAKE_G1) +
        ";\nexport function resolve(s, c, n) { if (s === '@minecraft/server') return { url: STUB, shortCircuit: true };" +
        " if (FAKE_G1 && s === './generator1.js') return { url: FAKE_G1, shortCircuit: true }; return n(s, c); }\n",
    ),
  import.meta.url,
);
if (!G1_REAL) console.log("（generator1.js がまだ無いので、仮の Level 1 生成で回す）\n");

const SCRIPTS = new URL("../BackroomsBP/scripts/", import.meta.url);
const SCHEDULER = new URL("scheduler.js", SCRIPTS).href;
const { Y_CEIL, setTuning } = await import(new URL("config.js", SCRIPTS).href);
// エンティティは tools/test_entities.mjs が見る。ここでは出さない（生成の速さだけを測る）
for (const k of ["SHADOW_CHANCE", "HOUND_CHANCE", "SMILER_CHANCE"]) setTuning(k, 0);
const SEED = 20260921;
const FLOOR = "backrooms:floor";
/** フォグが視界を完全に塞ぐ距離（7.5）。これより近くに床の無いセルがあれば虚空が見える */
const FOG_END = 24;
/** スプリントの速さ（ブロック/秒） */
const SPRINT = 5.6;
/** 到着から走り出すまで。暗転が明けるまで約2秒（8.1） */
const START = 40;

const mod16 = (v) => ((v % 16) + 16) % 16;
const cellKey = (x, z) => `${Math.floor(x / 16)},${Math.floor(z / 16)}`;

/**
 * 床（Y=0）・判定点・天井の高さだけを覚える偽ディメンション。
 * 壁は置いても覚えない。救出の着地点のテスト用に solid へ手で壁を足せる
 */
function makeDimension(id = DIM0, floorId = FLOOR) {
  const floor = new Set();
  const done = new Set();
  const solid = new Set();
  const block = (typeId) => ({ typeId, isAir: typeId === "minecraft:air", isLiquid: false, getComponent: () => undefined });
  const AIR = block("minecraft:air");
  const GROUND = block(floorId);
  const WALL = block("backrooms:wall");
  const isMarker = (p) => p.y === 0 && mod16(p.x) === 8 && mod16(p.z) === 8;
  const isFloor = (b) => b === floorId || b?.type?.id === floorId;
  return {
    id,
    floor,
    done,
    solid,
    players: [],
    getPlayers() {
      return this.players;
    },
    getBlock(p) {
      if (solid.has(`${p.x},${p.y},${p.z}`)) return WALL;
      if (p.y !== 0) return AIR;
      if (isMarker(p)) return done.has(cellKey(p.x, p.z)) ? GROUND : AIR;
      return floor.has(cellKey(p.x, p.z)) ? GROUND : AIR;
    },
    /** 生成済みセルの一番上は天井。未生成の柱には何も無い */
    getTopmostBlock: (p) => (floor.has(cellKey(p.x, p.z)) ? { location: { x: p.x, y: Y_CEIL, z: p.z } } : undefined),
    fillBlocks(volume, b) {
      if (!isFloor(b) || volume.from.y > 0 || volume.to.y < 0) return;
      for (let cx = Math.floor(volume.from.x / 16); cx <= Math.floor(volume.to.x / 16); cx++) {
        for (let cz = Math.floor(volume.from.z / 16); cz <= Math.floor(volume.to.z / 16); cz++) {
          floor.add(`${cx},${cz}`);
        }
      }
    },
    setBlockType(p, b) {
      if (isMarker(p) && isFloor(b)) done.add(cellKey(p.x, p.z));
    },
    setBlockPermutation(p, perm) {
      if (isMarker(p) && isFloor(perm)) done.add(cellKey(p.x, p.z));
    },
    setWeather() {},
    spawnEntity: () => ({ getComponent: () => undefined, remove() {} }),
    getEntities: () => [],
  };
}

const DIM0 = "backrooms:level0";
const DIM1 = "backrooms:level1";
const FLOOR1 = "backrooms:l1_floor";

/** 偽ワールドの差し替え。オーバーワールドは戻り先（exitLevel0）のためだけにある */
function useSim(d0 = makeDimension(), d1 = makeDimension(DIM1, FLOOR1)) {
  const over = makeDimension("minecraft:overworld", "minecraft:grass_block");
  globalThis.__sim = { dims: { [DIM0]: d0, [DIM1]: d1, [over.id]: over }, timers: [], jobs: [] };
  return globalThis.__sim;
}

function makePlayer(id, dimension, headingDeg = 0, mode = "Survival") {
  const rad = (headingDeg * Math.PI) / 180;
  const vx = (Math.cos(rad) * SPRINT) / 20;
  const vz = (Math.sin(rad) * SPRINT) / 20;
  const fog = { tags: [], pushed: [], removed: 0 };
  const dp = new Map();
  const p = {
    id,
    dimension,
    location: { x: 8.5, y: 1, z: 8.5 },
    moving: false,
    teleports: [],
    /** teleport ごとの行き先のディメンション id */
    dims: [],
    bars: [],
    fog,
    dp,
    stopped: 0,
    fogSettings: {
      getTags: () => fog.tags,
      push(f, tag) {
        fog.pushed.push(f);
        fog.tags.push(tag);
      },
      remove(tag) {
        fog.removed++;
        fog.tags = fog.tags.filter((t) => t !== tag);
      },
    },
    camera: { fade() {} },
    onScreenDisplay: { setActionBar: (t) => p.bars.push(t) },
    getDynamicProperty: (k) => dp.get(k),
    setDynamicProperty: (k, v) => dp.set(k, v),
    getGameMode: () => mode,
    getVelocity() {
      return this.moving ? { x: vx, y: 0, z: vz } : { x: 0, y: 0, z: 0 };
    },
    playSound: () => ({ stop: () => p.stopped++ }),
    teleport(location, opts) {
      this.teleports.push(location);
      this.dims.push(opts?.dimension?.id);
      if (opts?.dimension) this.dimension = opts.dimension;
      this.location = { ...location };
    },
    step() {
      this.location.x += vx;
      this.location.z += vz;
    },
  };
  return p;
}

/** プレイヤーから一番近い「床の無いセル」までの水平距離。0 なら足元が虚空 */
function leadOf(dimension, player) {
  const { x, z } = player.location;
  const pcx = Math.floor(x / 16);
  const pcz = Math.floor(z / 16);
  let best = Infinity;
  for (let dz = -3; dz <= 3; dz++) {
    for (let dx = -3; dx <= 3; dx++) {
      const cx = pcx + dx;
      const cz = pcz + dz;
      if (dimension.floor.has(`${cx},${cz}`)) continue;
      const nx = Math.max(cx * 16, Math.min(x, cx * 16 + 16));
      const nz = Math.max(cz * 16, Math.min(z, cz * 16 + 16));
      best = Math.min(best, Math.hypot(x - nx, z - nz));
    }
  }
  return best;
}

let runNo = 0;

/** 1通り走らせる。scheduler.js はモジュール状態を持つので毎回別インスタンスで読み込む */
async function simulate(scenario, budget) {
  const dims = [makeDimension(), makeDimension(DIM1, FLOOR1)];
  const sim = useSim(...dims);
  const sched = await import(`${SCHEDULER}?run=${runNo++}`);

  // 初回入場と同じく、拠点の周囲 3x3 は同期で生成済み（8.2）。levels は各プレイヤーの階層（0 / 1、省略は全員 Level 0）
  const levels = scenario.levels ?? scenario.headings.map(() => 0);
  for (const lv of new Set(levels)) {
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) sched.forceGenerateCell(dims[lv], dx, dz, SEED);
    }
  }
  const players = scenario.headings.map((h, i) => makePlayer(`p${i}`, dims[levels[i]], h));
  for (const d of dims) d.players = players.filter((p) => p.dimension === d);
  sched.startScheduler();
  assert.equal(sim.timers.length, 1, "スケジューラのタイマーが1本でない");
  const [{ cb: tick, ticks: every }] = sim.timers;
  const jobs = sim.jobs;
  const doneCount = () => dims[0].done.size + dims[1].done.size;

  const out = { fell: null, sawVoid: null, urgent: 0, maxJobs: 0 };
  for (let t = 0; t < START + scenario.seconds * 20; t++) {
    if (t % every === 0) {
      // 周期の中で書き終わったセルは、ジョブを待たずに足元を同期生成した分
      const before = doneCount();
      tick();
      out.urgent += doneCount() - before;
      out.maxJobs = Math.max(out.maxJobs, jobs.length);
    }
    for (let left = budget; left > 0 && jobs.length > 0; left--) {
      try {
        if (jobs[0].next().done) jobs.shift();
      } catch {
        jobs.shift(); // 実機でもジョブ内の例外はそのジョブを終わらせる
      }
    }
    if (t < START) continue;
    for (const p of players) {
      p.moving = true;
      p.step();
      const lead = leadOf(p.dimension, p);
      const sec = (t - START) / 20;
      if (lead < FOG_END && out.sawVoid === null) out.sawVoid = sec;
      if (lead === 0 && out.fell === null) out.fell = sec;
    }
  }
  return out;
}

const SCENARIOS = [
  { name: "1人 軸に沿って直進", headings: [0], seconds: 90 },
  { name: "1人 斜めに直進", headings: [45], seconds: 90 },
  { name: "2人 逆方向へ斜め", headings: [45, 225], seconds: 90 },
  { name: "4人 四方へ斜め", headings: [45, 135, 225, 315], seconds: 90 },
  // v0.5.0: 2つの階層のセルが1本のキュー・1本のジョブに混ざる（INTERFACES.md 9.3）
  { name: "2人 Level 0 と Level 1 に1人ずつ", headings: [45, 225], levels: [0, 1], seconds: 90 },
  { name: "4人 Level 0 と Level 1 に2人ずつ", headings: [45, 135, 225, 315], levels: [0, 1, 0, 1], seconds: 90 },
];
/** 1tick に runJob が進められる yield 数。1 は仕様書 Q-10 の最悪ケース、64 は1セルを1tickで書き終える速さ */
const BUDGETS = [1, 2, 4, 8, 64];
const FAST = 64;

function fmt(r) {
  const urgent = r.urgent > 0 ? `・同期生成${r.urgent}` : "";
  if (r.fell !== null) return `${r.fell.toFixed(0)}秒で落下${urgent}`;
  if (r.sawVoid !== null) return `霧の内側に虚空${urgent}`;
  return `ok${urgent}`;
}

console.log("1. 生成が追いつくか");
console.log(`   スプリント ${SPRINT} ブロック/秒で90秒（約500ブロック）走る。列は runJob が1tickに回せる yield 数\n`);
console.log(["", ...BUDGETS.map((b) => `yield ${b}/tick`)].join("\t"));

const fell = [];
const slowOnFast = [];
const multiJobs = [];
for (const s of SCENARIOS) {
  const row = [s.name];
  for (const b of BUDGETS) {
    const r = await simulate(s, b);
    row.push(fmt(r));
    if (r.fell !== null) fell.push(`${s.name} / yield ${b}: ${fmt(r)}`);
    if (b === FAST && (r.sawVoid !== null || r.urgent > 0)) slowOnFast.push(`${s.name}: ${fmt(r)}`);
    if (r.maxJobs > 1) multiJobs.push(`${s.name} / yield ${b}: ${r.maxJobs} 本`);
  }
  console.log(row.join("\t"));
}
console.log("");

assert.deepEqual(multiJobs, [], "ジョブが同時に2本以上走った（7.2 / INTERFACES.md 9.3: 階層をまたいでも全体で1本）");
console.log("  ok  Level 0 と Level 1 が混ざってもジョブは同時に1本・タイマーは1本");

assert.deepEqual(fell, [], "足元が虚空になった。足元の同期生成（scheduler.js の guardFooting）が効いていない");
console.log("  ok  どの速さでも足元は虚空にならない（遅いホストでは足元の同期生成が肩代わりする）");
assert.deepEqual(
  slowOnFast,
  [],
  "速い端末でも生成が追いつかない。スケジューラが生成量に天井を作っている（端末を速くしても直らない）",
);
console.log(`  ok  yield ${FAST}/tick なら4人が四方へ走っても霧の内側に虚空が入らず、同期生成も要らない`);

// ---- 2. 救出（portal.js の keepInBounds）----
console.log("\n2. Level 0 の外へ出た人の救出");

const portal = await import(new URL("portal.js", SCRIPTS).href);
const settle = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};

async function rescue(setup, dimension = makeDimension()) {
  useSim(dimension.id === DIM1 ? undefined : dimension, dimension.id === DIM1 ? dimension : undefined);
  const player = setup(dimension);
  portal.keepInBounds(player);
  portal.keepInBounds(player); // 次の周期が転送完了前に来ても二重に積まない
  await settle();
  return player;
}

{
  const p = await rescue((d) => {
    const p = makePlayer("fall", d);
    p.location = { x: 40.3, y: -3, z: 7.8 };
    return p;
  });
  assert.equal(p.teleports.length, 1, `落下中の救出が ${p.teleports.length} 回`);
  assert.deepEqual(p.teleports[0], { x: 40.5, y: 1, z: 7.5 }, "落ちた柱の床の上へ戻っていない");
  console.log("  ok  床の下へ落ちた人は、落ちた柱の床の上へ1回だけ戻される（着地先のセルは先に生成）");
}

{
  const p = await rescue((d) => {
    d.floor.add("2,0"); // 生成済みで、一番上が天井
    const p = makePlayer("roof", d);
    p.location = { x: 40.3, y: Y_CEIL + 1, z: 7.8 };
    return p;
  });
  assert.equal(p.teleports.length, 1, "天井の上に出た人が戻されていない");
  assert.equal(p.teleports[0].y, 1);
  console.log("  ok  天井の上に出た人は床の上へ戻される（コーラスフルーツで起きる）");
}

{
  const p = await rescue((d) => {
    d.solid.add("40,1,7");
    d.solid.add("40,2,7");
    const p = makePlayer("wall", d);
    p.location = { x: 40.3, y: -3, z: 7.8 };
    return p;
  });
  const { x, z } = p.teleports[0] ?? {};
  assert.ok(!(x === 40.5 && z === 7.5), "着地点が壁の中のまま");
  assert.ok(Math.abs(x - 40.5) <= 1 && Math.abs(z - 7.5) <= 1, `着地点が遠すぎる: ${x},${z}`);
  console.log(`  ok  落ちた柱が壁なら隣の空いた柱へ下ろす（${x - 0.5},${z - 0.5}）`);
}

{
  const inside = await rescue((d) => {
    d.floor.add("0,0");
    return makePlayer("inside", d);
  });
  const creative = await rescue((d) => {
    const p = makePlayer("creative", d, 0, "Creative");
    p.location = { x: 40.3, y: -3, z: 7.8 };
    return p;
  });
  assert.equal(inside.teleports.length, 0, "床の上に立っている人を動かした");
  assert.equal(creative.teleports.length, 0, "クリエイティブで飛んでいる人を動かした");
  console.log("  ok  床の上の人とクリエイティブの人は動かさない");
}

// ---- 3. 1セルあたりの生成の手数（設計書 0章 / 3.5）----
//
// runJob は yield ごとに区切って進むので、yield 数がそのままジョブの手数になる。
// 小物を足しても手数が増えすぎないこと（増えると 1. の表の遅い端末の列が悪化する）
console.log("\n3. 1セルあたりの生成の手数（generator の yield 数）");
{
  const generator = await import(new URL("generator.js", SCRIPTS).href);
  const layout = await import(new URL("layout.js", SCRIPTS).href);
  /** 基準を測ったとき（v0.2.0・2026-09-27）と同じ seed と範囲 */
  const YIELD_SEED = 0x5eed1234 | 0;
  const BASE = { avg: 23.6, median: 23, max: 38 };
  /** 設計書 0章: 通常セルの平均の増加は +3 以内 */
  const LIMIT = BASE.avg + 3;
  const dimension = makeDimension();
  const yieldsOf = (cx, cz) => {
    const job = generator.generateCellJob(dimension, cx, cz, YIELD_SEED);
    let n = 0;
    while (!job.next().done) n++;
    return n;
  };

  const counts = [];
  for (let cz = -20; cz < 20; cz++) {
    for (let cx = -20; cx < 20; cx++) {
      if (layout.isHome(cx, cz) || layout.landmarkCovering(cx, cz, YIELD_SEED)) continue;
      counts.push(yieldsOf(cx, cz));
    }
  }
  counts.sort((a, b) => a - b);
  const avg = counts.reduce((a, b) => a + b, 0) / counts.length;
  const median = counts[counts.length >> 1];
  const max = counts[counts.length - 1];
  console.log(`   通常セル ${counts.length} 件（拠点・ランドマーク以外、40x40 セル）\n`);
  console.log(["", "平均", "中央値", "最大"].join("\t"));
  console.log(["基準 v0.2.0", BASE.avg, BASE.median, BASE.max].join("\t"));
  console.log(["今", avg.toFixed(1), median, max].join("\t"));

  // ランドマークは1個まるごと（暗区画は通常セルと同じ経路なので占有範囲のセルの合計）。assert はしない
  const NAMES = ["巨大空間", "暗区画", "水区画", "階段", "廊下", "柱の広間", "小部屋", "マニラルーム", "穴"];
  const perKind = NAMES.map(() => []);
  for (let cz = -150; cz <= 150; cz++) {
    for (let cx = -150; cx <= 150; cx++) {
      const lm = layout.landmarkCovering(cx, cz, YIELD_SEED);
      if (!lm || lm.ox !== cx || lm.oz !== cz || perKind[lm.kind].length >= 5) continue;
      let n = 0;
      if (lm.normalWalls) {
        for (let dz = 0; dz < lm.h; dz++) for (let dx = 0; dx < lm.w; dx++) n += yieldsOf(cx + dx, cz + dz);
      } else {
        n = yieldsOf(cx, cz); // 占有範囲を1本のジョブでまとめて書く
      }
      perKind[lm.kind].push({ n, cells: lm.w * lm.h });
    }
  }
  console.log("\n" + ["ランドマーク", "個数", "1個あたり", "1セルあたり"].join("\t"));
  NAMES.forEach((name, k) => {
    const list = perKind[k];
    if (list.length === 0) return console.log([name, 0, "-", "-"].join("\t"));
    const per = list.reduce((a, b) => a + b.n, 0) / list.length;
    const perCell = list.reduce((a, b) => a + b.n / b.cells, 0) / list.length;
    console.log([name, list.length, per.toFixed(1), perCell.toFixed(1)].join("\t"));
  });
  console.log("");

  assert.ok(avg <= LIMIT, `通常セルの yield 数の平均 ${avg.toFixed(1)} が上限 ${LIMIT} を超えた。yield を行・種類ごとにまとめ直す`);
  console.log(`  ok  通常セルの平均 ${avg.toFixed(1)} は上限 ${LIMIT}（基準 ${BASE.avg} + 3）以内`);
}

// ---- 4. マニラルームの生成（INTERFACES.md 8.2）----
//
// 偽ワールドに、このセルの中に置かれたブロックを全部覚えさせて、壁紙の貼り方・戸口・電灯・判定点を見る
console.log("\n4. マニラルームの生成");
{
  const generator = await import(new URL("generator.js", SCRIPTS).href);
  const layout = await import(new URL("layout.js", SCRIPTS).href);
  const cfg = await import(new URL("config.js", SCRIPTS).href);
  const MSEED = 0x5eed1234 | 0;
  const rooms = [];
  for (let cz = -80; cz <= 80 && rooms.length < 8; cz++) {
    for (let cx = -80; cx <= 80 && rooms.length < 8; cx++) {
      const lm = layout.landmarkCovering(cx, cz, MSEED);
      if (lm && lm.kind === cfg.LM_MANILA && lm.ox === cx && lm.oz === cz) rooms.push(lm);
    }
  }
  assert.ok(rooms.length === 8, `マニラルームが ${rooms.length} 個しか見つからない`);

  const counts = [];
  for (const lm of rooms) {
    const x0 = lm.ox * 16;
    const z0 = lm.oz * 16;
    const dimension = makeDimension();
    const blocks = new Map(); // "bx,y,bz"（セル内）-> id
    const put = (x, y, z, id) => blocks.set(`${x - x0},${y},${z - z0}`, id);
    const fill = dimension.fillBlocks;
    dimension.fillBlocks = (v, b) => {
      for (let x = v.from.x; x <= v.to.x; x++)
        for (let y = v.from.y; y <= v.to.y; y++) for (let z = v.from.z; z <= v.to.z; z++) put(x, y, z, typeof b === "string" ? b : b.type.id);
      return fill(v, b);
    };
    const set = dimension.setBlockPermutation;
    let last;
    dimension.setBlockPermutation = (p, perm) => {
      put(p.x, p.y, p.z, perm.type.id);
      last = p;
      return set(p, perm);
    };
    const job = generator.generateCellJob(dimension, lm.ox, lm.oz, MSEED);
    let n = 0;
    while (!job.next().done) n++;
    counts.push(n);

    const at = (bx, y, bz) => blocks.get(`${bx},${y},${bz}`) ?? "minecraft:air";
    const tag = `(${lm.ox},${lm.oz})`;
    assert.deepEqual(last, { x: x0 + 8, y: cfg.Y_FLOOR, z: z0 + 8 }, `${tag} 最後に置いたのが判定点でない`);
    assert.ok(dimension.done.has(`${lm.ox},${lm.oz}`), `${tag} 判定点が床でない`);

    const d = layout.wallMask(lm.ox, lm.oz, MSEED).indexOf(cfg.W_DOOR);
    const door = (bx, bz) => bx >> 1 === d % 8 && bz >> 1 === Math.floor(d / 8);
    let outlets = 0;
    let lights = 0;
    for (let bz = 0; bz < 16; bz++) {
      for (let bx = 0; bx < 16; bx++) {
        if (at(bx, cfg.Y_CEIL, bz) === cfg.B_MANILA_LIGHT) lights++;
        const ring = Math.max(Math.abs(bx - 7.5), Math.abs(bz - 7.5)); // 4.5 = 内側の列 / 5.5 = 外側の列
        for (let y = cfg.Y_AIR_MIN; y <= cfg.Y_AIR_MAX; y++) {
          const id = at(bx, y, bz);
          const where = `${tag} ブロック ${bx},${y},${bz}`;
          if (ring < 4) {
            if (id === cfg.B_OUTLET && y === cfg.Y_AIR_MIN) outlets++;
            else assert.equal(id, "minecraft:air", `${where}（部屋の中）`);
          } else if (ring === 4.5 || ring === 5.5) {
            // 戸口は鴨居（Y_AIR_MIN+3 から上）の下が空いている
            const want =
              door(bx, bz) && y < cfg.Y_AIR_MIN + 3
                ? "minecraft:air"
                : ring === 5.5
                  ? cfg.B_WALL
                  : y === cfg.Y_AIR_MAX
                    ? cfg.B_MANILA_BORDER
                    : cfg.B_MANILA_WALL;
            assert.equal(id, want, where);
          }
        }
      }
    }
    assert.equal(outlets, 1, `${tag} コンセントが ${outlets} 個`);
    assert.equal(lights, 1, `${tag} 橙色の電灯が ${lights} 個`);
    assert.equal(at(8, cfg.Y_CEIL, 8), cfg.B_MANILA_LIGHT, `${tag} 電灯が部屋の中央に無い`);
  }
  const avg = counts.reduce((a, b) => a + b, 0) / counts.length;
  console.log(`   ${rooms.length} 部屋の yield 数: 平均 ${avg.toFixed(1)} / 最大 ${Math.max(...counts)}`);
  // 通常セルの最大（基準 38）を超えないこと。超えるなら壁紙の fill の yield をまとめ直す
  assert.ok(Math.max(...counts) <= 38, `マニラルームの yield 数 ${Math.max(...counts)} が多すぎる`);
  console.log("  ok  壁紙は内側の列だけ（外側は通常の壁）、最上段は縁取り、戸口は鴨居の下が空き、電灯は中央に1つ、判定点は最後");
}

// ---- 5. マニラルームに居続けると帰れる（portal.js の checkManilaStay）----
console.log("\n5. マニラルームに居続けると帰れる");
{
  const layout = await import(new URL("layout.js", SCRIPTS).href);
  const cfg = await import(new URL("config.js", SCRIPTS).href);
  let lm = null;
  for (let cz = -80; cz <= 80 && !lm; cz++) {
    for (let cx = -80; cx <= 80 && !lm; cx++) {
      const c = layout.landmarkCovering(cx, cz, SEED); // portal.js は getSeed() = 偽ワールドの SEED で引く
      if (c && c.kind === cfg.LM_MANILA) lm = c;
    }
  }
  assert.ok(lm, "マニラルームが見つからない");
  const room = { x: lm.ox * 16 + 5.5, y: 1, z: lm.oz * 16 + 10.5 };
  const hall = { x: lm.ox * 16 + 0.5, y: 1, z: lm.oz * 16 + 10.5 }; // 回廊
  const periods = (cfg.TUNING.MANILA_STAY_SECONDS * 20) / cfg.TICK_INTERVAL;

  function visitor(id, mode) {
    const dimension = makeDimension();
    useSim(dimension);
    const p = makePlayer(id, dimension, 0, mode);
    p.location = { ...room };
    p.bars = [];
    p.fades = 0;
    p.onScreenDisplay = { setActionBar: (t) => p.bars.push(t) };
    p.camera = { fade: () => p.fades++ };
    p.getDynamicProperty = () => undefined; // 戻り先は未保存 = ワールドスポーン
    return p;
  }

  const p = visitor("manila");
  for (let i = 0; i < periods - 1; i++) portal.checkManilaStay(p);
  assert.equal(p.fades, 0, "時間になる前に帰された");
  assert.deepEqual(p.bars, ["なぜか、ここは落ち着く。", "壁紙の向こうで、誰かがささやいている気がする。"]);
  p.location = { ...hall };
  portal.checkManilaStay(p); // 部屋を出たら数え直し
  p.location = { ...room };
  for (let i = 0; i < periods - 1; i++) portal.checkManilaStay(p);
  assert.equal(p.fades, 0, "部屋を出ても数え直していない");
  assert.equal(p.bars.length, 4, "数え直したあと一言が出ていない");
  portal.checkManilaStay(p);
  assert.equal(p.fades, 1, `${cfg.TUNING.MANILA_STAY_SECONDS} 秒居続けても帰されない`);

  const spectator = visitor("spectator", "Spectator");
  for (let i = 0; i < periods * 2; i++) portal.checkManilaStay(spectator);
  assert.equal(spectator.fades + spectator.bars.length, 0, "スペクテイターを数えた");
  console.log(`  ok  ${cfg.TUNING.MANILA_STAY_SECONDS} 秒居続けると帰され、1/3 と 2/3 で一言。部屋を出たら数え直し、スペクテイターは数えない`);
}

// ---- 6. Level 1 とのつなぎ込み（INTERFACES.md 9.3・portal.js）----
console.log("\n6. Level 1 とのつなぎ込み");
{
  const layout = await import(new URL("layout.js", SCRIPTS).href);
  const layout1 = await import(new URL("layout1.js", SCRIPTS).href);
  const cfg = await import(new URL("config.js", SCRIPTS).href);
  const FOG0 = cfg.FOG_PHASES[0][1]; // 偽ワールドは getTimeOfDay が無いので昼の霧
  const FOG1 = cfg.FOG1_PHASES[0][1];

  // 6-1. 穴に落ちると Level 1 の拠点へ。戻り先は上書きしない
  assert.equal(layout.pitAt(2, 0, SEED), null, "2. の救出のテストのセルが穴になっている（テストの前提が崩れた）");
  let pit = null;
  for (let cz = -60; cz <= 60 && !pit; cz++) {
    for (let cx = -60; cx <= 60 && !pit; cx++) {
      const h = layout.pitAt(cx, cz, SEED);
      if (h) pit = { cx, cz, ...h };
    }
  }
  assert.ok(pit, "穴のセルが見つからない");
  {
    const d0 = makeDimension();
    const d1 = makeDimension(DIM1, FLOOR1);
    useSim(d0, d1);
    const p = makePlayer("pit", d0);
    p.dp.set(cfg.DP_ENTRY, "saved");
    p.location = { x: pit.cx * 16 + pit.bx + 1.5, y: -2, z: pit.cz * 16 + pit.bz + 1.5 };
    portal.keepInBounds(p);
    portal.keepInBounds(p); // 次の周期が転送完了前に来ても二重に積まない
    await settle();
    assert.equal(p.teleports.length, 1, `穴に落ちた人の転送が ${p.teleports.length} 回`);
    assert.deepEqual(p.teleports[0], cfg.L1_SPAWN, "Level 1 の着地点でない");
    assert.equal(p.dims[0], DIM1, "Level 1 へ送られていない");
    assert.equal(p.dp.get(cfg.DP_ENTRY), "saved", "穴から落ちたときに戻り先を上書きした");
    assert.ok(d1.done.has("0,0"), "Level 1 の拠点セルを先に生成していない");
    assert.equal(p.fog.pushed.at(-1), FOG1, "Level 1 の霧になっていない");
    console.log(`  ok  穴 (${pit.cx},${pit.cz}) に落ちた人は Level 1 の拠点へ1回だけ送られ、霧が Level 1 のものになる（戻り先はそのまま）`);
  }
  // 6-1b. 穴の縁から横へ流れても Level 1 へ（最終レビュー 中-2）。穴から十分離れた床の下は今までどおり救出
  {
    const d0 = makeDimension();
    const d1 = makeDimension(DIM1, FLOOR1);
    useSim(d0, d1);
    const drift = makePlayer("pitDrift", d0);
    drift.location = { x: pit.cx * 16 + pit.bx - 3 + 0.5, y: -3, z: pit.cz * 16 + pit.bz + 1.5 }; // 穴の西の縁から3ブロック外
    portal.keepInBounds(drift);
    await settle();
    assert.equal(drift.dims[0], DIM1, "穴の縁から流れた人を Level 1 へ送っていない");
  }
  {
    const d0 = makeDimension();
    const d1 = makeDimension(DIM1, FLOOR1);
    useSim(d0, d1);
    const far = makePlayer("pitFar", d0);
    far.location = { x: pit.cx * 16 + pit.bx - 12 + 0.5, y: -3, z: pit.cz * 16 + pit.bz + 1.5 }; // 穴から12ブロック外
    portal.keepInBounds(far);
    await settle();
    assert.notEqual(far.dims[0], DIM1, "穴から離れた床の下の人まで Level 1 へ送った");
    console.log("  ok  穴の縁から3ブロック流れても Level 1 へ、12ブロック離れた床の下は Level 0 の中で救出");
  }

  // 6-2. Level 1 の上り階段を上りきると Level 0 の拠点へ
  {
    const b = layout1.stairsUpAt1(cfg.L1_HOME_CX, cfg.L1_HOME_CZ, SEED);
    assert.ok(b, "Level 1 の拠点セルに上り階段が無い");
    const d0 = makeDimension();
    const d1 = makeDimension(DIM1, FLOOR1);
    useSim(d0, d1);
    const p = makePlayer("stairs", d1);
    p.dp.set(cfg.DP_ENTRY, "saved");
    p.location = { x: b.x1 + 0.5, y: b.y, z: b.z0 + 0.5 };
    const below = makePlayer("below", d1);
    below.location = { x: b.x1 + 0.5, y: b.y - 2, z: b.z0 + 0.5 };
    const spawn = makePlayer("spawn1", d1);
    spawn.location = { ...cfg.L1_SPAWN };
    for (const q of [p, below, spawn]) {
      portal.checkStairsUp(q);
      portal.checkStairsUp(q);
    }
    await settle();
    assert.equal(p.teleports.length, 1, `踊り場の人の転送が ${p.teleports.length} 回`);
    assert.deepEqual(p.teleports[0], cfg.HOME_SPAWN, "Level 0 の拠点の着地点でない");
    assert.equal(p.dims[0], DIM0);
    assert.equal(p.dp.get(cfg.DP_ENTRY), "saved", "上り階段で戻り先を上書きした");
    assert.ok(d0.done.has("0,0"), "Level 0 の拠点セルを先に生成していない");
    assert.equal(p.fog.pushed.at(-1), FOG0, "Level 0 の霧に戻っていない");
    assert.equal(below.teleports.length + spawn.teleports.length, 0, "踊り場でない人を送った");
    console.log("  ok  上り階段の踊り場に入った人だけ Level 0 の拠点へ送られる（戻り先はそのまま、階段の途中と着地点では送らない）");
  }

  // 6-3. Level 1 の救出（床の下・maxY1 より上）
  {
    const fall = await rescue((d) => {
      const p = makePlayer("fall1", d);
      p.location = { x: 40.3, y: -3, z: 7.8 };
      return p;
    }, makeDimension(DIM1, FLOOR1));
    assert.equal(fall.teleports.length, 1, `Level 1 の落下の救出が ${fall.teleports.length} 回`);
    assert.equal(fall.dims[0], DIM1, "Level 1 の中で救出していない");
    assert.deepEqual(fall.teleports[0], { x: 40.5, y: 1, z: 7.5 });
    const top = layout1.maxY1(2, 0, SEED);
    const roof = await rescue((d) => {
      const p = makePlayer("roof1", d);
      p.location = { x: 40.3, y: top + 2, z: 7.8 };
      return p;
    }, makeDimension(DIM1, FLOOR1));
    const high = await rescue((d) => {
      const p = makePlayer("high1", d);
      p.location = { x: 40.3, y: top, z: 7.8 };
      return p;
    }, makeDimension(DIM1, FLOOR1));
    assert.equal(roof.teleports.length, 1, "Level 1 の天井の上の人が戻されていない");
    assert.equal(high.teleports.length, 0, "Level 1 の天井の下の人を動かした");
    console.log(`  ok  Level 1 でも床の下と天井の上（maxY1 ${top} + 1 より上）の人は Level 1 の床の上へ戻される`);
  }

  // 6-4. 長く歩くとマニラルーム
  {
    const saved = cfg.TUNING.MANILA_WALK_BLOCKS;
    setTuning("MANILA_WALK_BLOCKS", 100);
    try {
      const d0 = makeDimension();
      useSim(d0);
      const w = makePlayer("walker", d0);
      const c = makePlayer("walkerC", d0, 0, "Creative");
      const walked = () => portal.walkedDistance(w); // 保存は 32 ブロックごとに間引くので、portal が持っている値を読む
      const move = (dx) => {
        for (const q of [w, c]) {
          q.location = { ...q.location, x: q.location.x + dx };
          portal.trackWalk(q);
        }
      };
      move(0);
      for (let i = 0; i < 10; i++) move(4);
      assert.ok(Math.abs(walked() - 40) < 1e-9, `10回 4 ブロック歩いて ${walked()}`);
      move(50); // 1周期で 8 ブロックを超える移動はテレポートとみなす
      assert.ok(Math.abs(walked() - 40) < 1e-9, `テレポートを歩いた距離に数えた（${walked()}）`);
      for (let i = 0; i < 20 && w.teleports.length === 0; i++) {
        move(4);
        await settle();
      }
      assert.equal(c.dp.size, 0, "クリエイティブの人の距離を数えた");
      assert.equal(w.teleports.length, 1, "100 ブロック歩いてもマニラルームへ移されない");
      const to = w.teleports[0];
      assert.ok(layout.inManilaRoom(to.x, to.z, SEED), `移された先 ${to.x},${to.z} がマニラルームの部屋の中でない`);
      assert.equal(walked(), 0, "移したあと距離を 0 に戻していない");
      assert.deepEqual(w.bars, ["気づくと、見覚えのない部屋にいた。"]);
      // 部屋に入ったら 0 に戻す
      w.dp.set("backrooms:walked", 55);
      portal.trackWalk(w);
      assert.equal(walked(), 0, "マニラルームに入っても距離を 0 に戻していない");
      assert.equal(w.dp.get("backrooms:walked"), 0, "マニラルームに入っても保存した距離を 0 に戻していない");
      console.log(`  ok  延べ 100 ブロック歩くと近くのマニラルーム (${Math.floor(to.x / 16)},${Math.floor(to.z / 16)}) の中へ移され、距離は 0 に（テレポートとクリエイティブは数えない）`);
    } finally {
      setTuning("MANILA_WALK_BLOCKS", saved);
    }
  }

  // 6-5. 地図・霧とハム音の付け外し・Level 1 からの脱出
  {
    portal.registerPortalEvents();
    const subs = globalThis.__subs;
    const d0 = makeDimension();
    const d1 = makeDimension(DIM1, FLOOR1);
    const sim = useSim(d0, d1);
    const over = sim.dims["minecraft:overworld"];

    const use = (p, typeId) => {
      const ev = { itemStack: { typeId }, source: p, cancel: false };
      subs["before.itemUse"](ev);
      return ev.cancel;
    };
    const m0 = makePlayer("map0", d0);
    const m1 = makePlayer("map1", d1);
    const mo = makePlayer("mapO", over);
    assert.equal(use(m0, "minecraft:empty_map"), true, "Level 0 で白紙の地図を使えた");
    assert.equal(use(m1, "minecraft:empty_map"), true, "Level 1 で白紙の地図を使えた");
    assert.equal(use(mo, "minecraft:empty_map"), false, "外で白紙の地図を止めた");
    assert.equal(use(m0, "minecraft:bread"), false, "地図でない物を止めた");
    assert.deepEqual(m1.bars, ["線がどこにもつながらない。"]);
    console.log("  ok  白紙の地図は Level 0 / Level 1 でだけ取り消され、アクションバーに一言");

    const change = (p, d) => {
      p.dimension = d;
      subs["after.playerDimensionChange"]({ player: p, toDimension: d });
    };
    const mv = makePlayer("mover", over);
    change(mv, d0);
    assert.equal(mv.fog.pushed.at(-1), FOG0);
    change(mv, d1);
    assert.equal(mv.fog.pushed.at(-1), FOG1, "Level 1 に移っても霧が Level 1 のものにならない");
    assert.deepEqual(mv.fog.tags, ["backrooms"], "霧が積み重なった / 外れた");
    assert.equal(mv.stopped, 0, "Level 0 から Level 1 へ移っただけでハム音を止めた");
    change(mv, d0);
    assert.equal(mv.fog.pushed.at(-1), FOG0);
    assert.equal(mv.stopped, 0);
    change(mv, over);
    assert.deepEqual(mv.fog.tags, [], "外へ出たのに霧が残った");
    assert.equal(mv.stopped, 1, "外へ出たのにハム音を止めていない");
    console.log("  ok  Level 0 と Level 1 の間では霧を差し替えるだけでハム音は止めず、外へ出たら両方外す");

    const lv = makePlayer("leave1", d1);
    lv.dp.set(cfg.DP_ENTRY, JSON.stringify({ x: 1, y: 70, z: 2, d: "minecraft:overworld" }));
    portal.applyFog(lv);
    portal.exitLevel0(lv);
    assert.deepEqual(lv.teleports[0], { x: 1, y: 70, z: 2 }, "Level 1 から戻り先へ帰されていない");
    assert.equal(lv.dims[0], "minecraft:overworld");
    assert.deepEqual(lv.fog.tags, [], "Level 1 から帰ったのに霧が残った");
    const bad = makePlayer("leave1b", d1);
    bad.dp.set(cfg.DP_ENTRY, JSON.stringify({ x: 1, y: 5, z: 2, d: DIM1 }));
    portal.exitLevel0(bad);
    assert.equal(bad.dims[0], "minecraft:overworld", "戻り先が Level 1 の中のまま（ワールドスポーンへ落ちない）");
    console.log("  ok  exitLevel0 は Level 1 の人も戻り先へ帰し、霧を外す（戻り先が Level 0 / 1 の中ならワールドスポーン）");
  }
}

console.log("\n全部通過。");

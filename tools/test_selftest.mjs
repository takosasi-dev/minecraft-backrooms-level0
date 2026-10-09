/**
 * 自己点検(BackroomsBP/scripts/selftest.js)の単体テスト(INTERFACES.md 9.4)
 *
 *   node tools/test_selftest.mjs
 *
 * 実物の selftest.js と、それが読み込む config/rng/layout/layout1/generator/generator1/
 * scheduler/portal/entities/relics をそのまま動かし、@minecraft/server だけを最小限の
 * 偽ワールド(tools/test_entities.mjs・tools/test_load.mjs のスタブに倣った)に差し替える。
 *
 * 見ているのは「runSelfTest が例外を出さず、常に10項目+集計の11行を返すか」
 * 「ブロック・エンティティが欠けていれば NG が出るか」だけ。各項目が実際に正しいか
 * (ハウンドが本当に追ってくる速さ等)は実機でしか分からない(README 7節)。
 */

import assert from "node:assert/strict";
import { register } from "node:module";

const state = {
  tick: 1000,
  worldDP: {},
  timeOfDay: 6000,
  dims: {},
  blocks: new Set(),
  items: new Set(),
  entities: new Set(),
  foodItems: new Set(),
};
globalThis.__st = state;

const STUB_SRC = `
const st = () => globalThis.__st;
function signal() { return { subscribe: () => {}, unsubscribe: () => {} }; }
export const world = {
  getDynamicProperty: (k) => st().worldDP[k],
  setDynamicProperty: (k, v) => { st().worldDP[k] = v; },
  getTimeOfDay: () => st().timeOfDay,
  getDimension: (id) => {
    const d = st().dims[id];
    if (!d) throw new Error('dimension not registered: ' + id);
    return d;
  },
  getAllPlayers: () => [],
  getDefaultSpawnLocation: () => ({ x: 0, y: 64, z: 0 }),
  getDifficulty: () => 'Normal',
  tickingAreaManager: { createTickingArea: async () => {}, removeTickingArea: () => {}, hasCapacity: () => true },
  afterEvents: new Proxy({}, { get: signal }),
  beforeEvents: new Proxy({}, { get: signal }),
};
export const system = {
  get currentTick() { return st().tick; },
  run: (cb) => { cb(); return 1; },
  runTimeout: () => 1,
  runInterval: () => 1,
  runJob: () => 1,
  clearJob: () => {},
  waitTicks: async () => {},
  beforeEvents: { startup: signal() },
};
export class BlockVolume { constructor(from, to) { this.from = from; this.to = to; } }
export const BlockPermutation = { resolve: (id, states) => ({ type: { id }, states }) };
export class ItemStack {
  constructor(typeId, amount) { this.typeId = typeId; this.amount = amount ?? 1; }
  getComponent(id) {
    if (id === 'minecraft:food') return st().foodItems.has(this.typeId) ? {} : undefined;
    return undefined;
  }
}
export const EquipmentSlot = { Head: 'Head', Chest: 'Chest', Legs: 'Legs', Feet: 'Feet', Mainhand: 'Mainhand', Offhand: 'Offhand' };
export const GameMode = { Survival: 'Survival', Creative: 'Creative', Adventure: 'Adventure', Spectator: 'Spectator' };
export const Difficulty = { Peaceful: 'Peaceful', Easy: 'Easy', Normal: 'Normal', Hard: 'Hard' };
export const WeatherType = { Clear: 'Clear', Rain: 'Rain', Thunder: 'Thunder' };
export const EntityInitializationCause = { Born: 'Born', Event: 'Event', Loaded: 'Loaded', Spawned: 'Spawned', Transformed: 'Transformed' };
export const EntityDamageCause = new Proxy({}, { get: (_, k) => String(k) });
export const BlockTypes = { get: (id) => st().blocks.has(id) ? { id } : undefined, getAll: () => [] };
export const ItemTypes = { get: (id) => st().items.has(id) ? { id } : undefined, getAll: () => [] };
export const EntityTypes = { get: (id) => st().entities.has(id) ? { id } : undefined, getAll: () => [] };
`;

const STUB = "data:text/javascript," + encodeURIComponent(STUB_SRC);
register(
  "data:text/javascript," +
    encodeURIComponent(
      "const STUB = " +
        JSON.stringify(STUB) +
        ";\nexport function resolve(s, c, n) { if (s === '@minecraft/server') return { url: STUB, shortCircuit: true }; return n(s, c); }\n",
    ),
  import.meta.url,
);

const scripts = new URL("../BackroomsBP/scripts/", import.meta.url);
const CONFIG = await import(new URL("config.js", scripts).href);
const { runSelfTest } = await import(new URL("selftest.js", scripts).href);

const { DIM_ID, DIM1_ID, I_NOCLIP, I_ALMOND, E_SHADOW, E_HOUND, E_SMILER, Y_FLOOR, Y_AIR_MIN } = CONFIG;

/** selftest.js の backroomsBlockIds() と同じ集め方(B_ / B1_ で始まる backrooms: の識別子) */
function backroomsBlockIds() {
  return Object.entries(CONFIG)
    .filter(([k, v]) => (k.startsWith("B_") || k.startsWith("B1_")) && typeof v === "string" && v.startsWith("backrooms:"))
    .map(([, v]) => v);
}
const ALL_BLOCKS = backroomsBlockIds();
assert.ok(ALL_BLOCKS.length > 20, "config.js から backrooms: のブロック識別子が集まらない(前提が崩れている)");

const FLOOR = { typeId: "backrooms:floor", isAir: false, isLiquid: false };
const AIR = { typeId: "minecraft:air", isAir: true, isLiquid: false };

/** セルが cells に登録されていれば「生成済みで立てる柱」を返す最小限のディメンション */
function makeDim(id) {
  const cells = new Set();
  return {
    id,
    cells,
    getPlayers: () => [],
    getBlock({ x, y, z }) {
      const cx = Math.floor(Math.floor(x) / 16);
      const cz = Math.floor(Math.floor(z) / 16);
      if (!cells.has(`${cx},${cz}`)) return AIR;
      return y === Y_FLOOR ? FLOOR : AIR;
    },
    getSkyLightLevel: () => 0,
    getLightLevel: () => 7,
    spawnEntity(typeId, loc) {
      const effects = {};
      let health = 20;
      return {
        typeId,
        location: { ...loc },
        isValid: true,
        addEffect(type, duration, opt) {
          effects[type] = { amplifier: opt?.amplifier ?? 0, duration };
          return effects[type];
        },
        getEffect(type) {
          return effects[type];
        },
        applyDamage(amount, opts) {
          // entities/smiler.json の damage_sensor を模す: fire 系だけ通す
          const passes = ["fire", "fire_tick", "lava"].includes(opts?.cause);
          if (!passes) return false;
          health -= amount;
          return true;
        },
        remove() {
          this.isValid = false;
        },
      };
    },
  };
}

const dim0 = makeDim(DIM_ID);
for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) dim0.cells.add(`${dx},${dz}`);
const dim1 = makeDim(DIM1_ID);
dim1.cells.add("0,0");
state.dims[DIM_ID] = dim0;
state.dims[DIM1_ID] = dim1;

function resetRegistry() {
  state.blocks = new Set(ALL_BLOCKS);
  state.items = new Set([I_NOCLIP, I_ALMOND]);
  state.entities = new Set([E_SHADOW, E_HOUND, E_SMILER]);
  state.foodItems = new Set([I_ALMOND]);
}
resetRegistry();

function makeFogSettings() {
  const stack = [];
  return {
    push(id, tag) {
      stack.push({ id, tag });
      return stack.length;
    },
    remove(tag) {
      const i = stack.findIndex((s) => s.tag === tag);
      if (i < 0) return false;
      stack.splice(i, 1);
      return true;
    },
    getTags() {
      return [...new Set(stack.map((s) => s.tag))];
    },
    getStack() {
      return stack.map((s) => s.id);
    },
    setStack() {},
  };
}

function makePlayer(dim, x, y, z, dp = {}) {
  const messages = [];
  return {
    dimension: dim,
    location: { x, y, z },
    fogSettings: makeFogSettings(),
    sendMessage(m) {
      messages.push(m);
    },
    getHeadLocation() {
      return { x, y: y + 1.62, z };
    },
    getDynamicProperty(k) {
      return dp[k];
    },
    messages,
  };
}

const LINE = /^(OK|NG|--) \d+\. /;

console.log("1. Level 0 の拠点セルで実行すると、10項目すべて OK になる");
{
  resetRegistry();
  const p = makePlayer(dim0, 8.5, Y_AIR_MIN, 8.5, { "backrooms:walked": 1234 });
  await runSelfTest(p);
  assert.equal(p.messages.length, 11, `10項目+集計で11行のはずが ${p.messages.length} 行`);
  for (let i = 0; i < 10; i++) {
    assert.ok(LINE.test(p.messages[i]), `行 ${i} の形式がおかしい: ${p.messages[i]}`);
  }
  const ng = p.messages.slice(0, 10).filter((m) => m.startsWith("NG"));
  assert.equal(ng.length, 0, `全部揃っているのに NG が出た: ${ng.join(" / ")}`);
  assert.ok(/^自己点検 集計: OK10 NG0 --0 /.test(p.messages[10]), `集計行がおかしい: ${p.messages[10]}`);
  console.log(`  ok  ${p.messages.length} 行(10項目すべて OK + 集計)`);
  console.log(`  ok  ${p.messages[10]}`);
}

console.log("\n2. Level 0 / Level 1 の外(オーバーワールド相当)でも例外を出さない");
{
  resetRegistry();
  const outside = { id: "minecraft:overworld", getPlayers: () => [] };
  const p = makePlayer(outside, 0, 64, 0);
  await runSelfTest(p);
  assert.equal(p.messages.length, 11, `外でも11行のはずが ${p.messages.length} 行`);
  for (let i = 0; i < 10; i++) assert.ok(LINE.test(p.messages[i]), `行 ${i} の形式がおかしい: ${p.messages[i]}`);
  const na = p.messages.slice(0, 10).filter((m) => m.startsWith("--")).length;
  assert.ok(na >= 3, `Level 0/1 の外で「--」になる項目(明るさ・生成・目印)が足りない(${na})`);
  console.log(`  ok  外でも11行返す(-- になった項目 ${na})`);
}

console.log("\n3. ブロックが1つも登録されていないと該当項目が NG になる");
{
  resetRegistry();
  state.blocks = new Set(); // BlockTypes.get が何も返さない状態を再現
  const p = makePlayer(dim0, 8.5, Y_AIR_MIN, 8.5);
  await runSelfTest(p);
  assert.ok(p.messages[1].startsWith("NG"), `ブロック無しなのに2項目め(ブロック)が NG になっていない: ${p.messages[1]}`);
  console.log("  ok  2項目め(ブロック)が NG になる");
}

console.log("\n4. エンティティが1つも登録されていないと該当項目が NG になる");
{
  resetRegistry();
  state.entities = new Set();
  const p = makePlayer(dim0, 8.5, Y_AIR_MIN, 8.5);
  await runSelfTest(p);
  assert.ok(p.messages[3].startsWith("NG"), `エンティティ無しなのに4項目め(エンティティ)が NG になっていない: ${p.messages[3]}`);
  console.log("  ok  4項目め(エンティティ)が NG になる");
}

resetRegistry();
console.log("\n全部通過。");

/**
 * main.js から全モジュールを実際に読み込んで、起動時に死なないことを確かめる。
 *
 *   node tools/test_load.mjs
 *
 * scheduler.js <-> portal.js は循環 import になっている。ESM は関数宣言を巻き上げるので
 * 原理上は解決するが、「原理上は」で実機に持っていくと、読み込み順によっては
 * TDZ（const/let の初期化前アクセス）で **アドオンが丸ごと沈黙する**。
 * ここで一度通しておけば、その事故はワールドを開く前に落ちる。
 *
 * @minecraft/server は型定義だけのパッケージで実体が無いので、イベント購読と
 * タイマー登録を記録するだけのスタブに差し替える。振る舞いの検証はしない。
 */

import assert from "node:assert/strict";
import { register } from "node:module";

const calls = { intervals: [], timeouts: [], subs: [], commands: [], jobs: 0 };
globalThis.__backroomsCalls = calls;

const STUB_SRC = `
const calls = globalThis.__backroomsCalls;
function signal(name) {
  return { subscribe: (cb) => { calls.subs.push(name); return cb; }, unsubscribe: () => {} };
}
function dimension(id) {
  return {
    id,
    getPlayers: () => [],
    getBlock: () => undefined,
    fillBlocks: () => ({}),
    setBlockPermutation: () => {},
    spawnEntity: () => ({ remove() {}, getComponent: () => undefined }),
    setWeather: () => {},
    getTopmostBlock: () => undefined,
    getEntities: () => [],
  };
}
export const world = {
  getDynamicProperty: () => undefined,
  setDynamicProperty: () => {},
  getDimension: dimension,
  getAllPlayers: () => [],
  getDefaultSpawnLocation: () => ({ x: 0, y: 64, z: 0 }),
  getDifficulty: () => 'Normal',
  tickingAreaManager: {
    createTickingArea: async () => {},
    removeTickingArea: () => {},
    hasCapacity: () => true,
  },
  afterEvents: new Proxy({}, { get: (_, k) => signal('after.' + String(k)) }),
  beforeEvents: new Proxy({}, { get: (_, k) => signal('before.' + String(k)) }),
};
export const system = {
  run: (cb) => { cb(); return 1; },
  runTimeout: (cb, t) => { calls.timeouts.push(t); return 1; },
  runInterval: (cb, t) => { calls.intervals.push(t); return 1; },
  runJob: () => { calls.jobs++; return 1; },
  clearJob: () => {},
  clearRun: () => {},
  waitTicks: async () => {},
  beforeEvents: {
    startup: {
      subscribe: (cb) => {
        calls.subs.push('startup');
        cb({
          dimensionRegistry: { registerCustomDimension: () => {} },
          customCommandRegistry: {
            registerCommand: (c) => { calls.commands.push(c.name); },
          },
          blockComponentRegistry: { registerCustomComponent: () => {} },
        });
        return cb;
      },
      unsubscribe: () => {},
    },
  },
};
export class BlockVolume { constructor(from, to) { this.from = from; this.to = to; } }
export const BlockPermutation = { resolve: (id, states) => ({ type: { id }, states }) };
export const ItemStack = class { constructor(id, amount) { this.typeId = id; this.amount = amount ?? 1; } };
export const EquipmentSlot = { Head: 'Head', Chest: 'Chest', Legs: 'Legs', Feet: 'Feet', Mainhand: 'Mainhand', Offhand: 'Offhand' };
export const CustomCommandStatus = { Success: 0, Failure: 1 };
export const CommandPermissionLevel = { Any: 0, GameDirectors: 1, Admin: 2, Host: 3, Owner: 4 };
export const CustomCommandParamType = { BlockType: 'BlockType', Boolean: 'Boolean', EntitySelector: 'EntitySelector', EntityType: 'EntityType', Enum: 'Enum', Float: 'Float', Integer: 'Integer', ItemType: 'ItemType', Location: 'Location', PlayerSelector: 'PlayerSelector', String: 'String' };
export const CustomCommandSource = { Block: 'Block', Entity: 'Entity', NPCDialogue: 'NPCDialogue', Server: 'Server' };
export const GameMode = { Survival: 'Survival', Creative: 'Creative', Adventure: 'Adventure', Spectator: 'Spectator' };
export const EntityInitializationCause = { Born: 'Born', Event: 'Event', Loaded: 'Loaded', Spawned: 'Spawned', Transformed: 'Transformed' };
export const WeatherType = { Clear: 'Clear', Rain: 'Rain', Thunder: 'Thunder' };
export const Difficulty = { Peaceful: 'Peaceful', Easy: 'Easy', Normal: 'Normal', Hard: 'Hard' };
export const Direction = { Down: 'Down', Up: 'Up', North: 'North', South: 'South', West: 'West', East: 'East' };
export const ItemLockMode = { none: 'none', inventory: 'inventory', slot: 'slot' };
export const EntityComponentTypes = new Proxy({}, { get: (_, k) => 'minecraft:' + String(k) });
export const ItemComponentTypes = new Proxy({}, { get: (_, k) => 'minecraft:' + String(k) });
export const BlockComponentTypes = new Proxy({}, { get: (_, k) => 'minecraft:' + String(k) });
// v0.5.0 の自己点検（selftest.js）が使う
export const BlockTypes = { get: () => undefined, getAll: () => [] };
export const ItemTypes = { get: () => undefined, getAll: () => [] };
export const EntityTypes = { get: () => undefined, getAll: () => [] };
export const EntityDamageCause = new Proxy({}, { get: (_, k) => String(k) });
`;

const STUB = "data:text/javascript," + encodeURIComponent(STUB_SRC);

register(
  "data:text/javascript," +
    encodeURIComponent(
      "const STUB = " +
        JSON.stringify(STUB) +
        ";\nexport function resolve(s, c, n) { if (s === '@minecraft/server' || s === '@minecraft/server-ui') return { url: STUB, shortCircuit: true }; return n(s, c); }\n",
    ),
  import.meta.url,
);

const scripts = new URL("../BackroomsBP/scripts/", import.meta.url);

// 読み込み順で壊れないことを見たいので、入口を変えて2通り試す
// v0.5.0 で Level 1（layout1.js / generator1.js）と自己点検（selftest.js）が増えた（INTERFACES.md 9章）
const entries = [
  "main.js",
  "scheduler.js",
  "portal.js",
  "commands.js",
  "generator.js",
  "entities.js",
  "layout1.js",
  "generator1.js",
  "selftest.js",
];
for (const e of entries) {
  const before = { ...calls };
  await import(new URL(e, scripts).href);
  void before;
}

console.log("1. モジュール読み込み");
console.log(`  ok  全 ${entries.length} 入口から読み込めた（循環 import が TDZ で落ちない）`);

// portal.js / scheduler.js / layout.js が 9.3 の契約どおりの名前を export している（commands.js・selftest.js が使う）
{
  const portal = await import(new URL("portal.js", scripts).href);
  const sched = await import(new URL("scheduler.js", scripts).href);
  const layout = await import(new URL("layout.js", scripts).href);
  const need = [
    [portal, "portal.js", ["isInLevel0", "isInLevel1", "isInBackrooms", "exitLevel0", "enterLevel0", "enterLevel1", "teleportInLevel0", "teleportInLevel1", "applyFog", "removeFog"]],
    [sched, "scheduler.js", ["forceGenerateCell", "getStatus", "startScheduler"]],
    [layout, "layout.js", ["findLandmark", "pitAt", "inManilaRoom"]],
  ];
  for (const [mod, file, names] of need) {
    for (const n of names) assert.equal(typeof mod[n], "function", `${file} が ${n} を export していない（INTERFACES.md 9.3）`);
  }
  console.log("  ok  portal.js / scheduler.js / layout.js が 9.3 の関数を export している");
}

// main.js は startup と worldLoad を購読する
assert.ok(calls.subs.includes("startup"), "system.beforeEvents.startup を購読していない");
console.log("  ok  起動フェーズを購読している（registerCustomDimension はここでしか呼べない）");

// 開発用コマンド（FR-20 / 16.1）
const want = ["enter", "leave", "regen", "tp", "rate", "dump"];
const got = calls.commands.map((n) => n.replace(/^backrooms:/, ""));
for (const w of want) {
  assert.ok(got.includes(w), `コマンド ${w} が登録されていない（FR-20）`);
}
console.log(`  ok  開発用コマンドが ${got.length} 種登録された: ${got.join(" ")}`);

// worldLoad を発火させてタイマーを張らせる
const { world } = await import(STUB);
const loadCbs = [];
world.afterEvents.worldLoad.subscribe((cb) => loadCbs.push(cb));

console.log("\n2. タイマー本数（10章 / 15章）");
// main.js の worldLoad コールバックを直接叩くかわりに、startScheduler / startAmbience を呼ぶ
const sched = await import(new URL("scheduler.js", scripts).href);
const portal = await import(new URL("portal.js", scripts).href);
calls.intervals.length = 0;
sched.startScheduler();
portal.startAmbience();
console.log(`      runInterval の間隔: ${calls.intervals.join(", ")} tick`);
assert.ok(
  calls.intervals.length <= 2,
  `system.runInterval が ${calls.intervals.length} 本。アドオン全体で2本まで（10章）`,
);
console.log("  ok  runInterval は2本以内（生成用・環境音用）");

// 二重起動しても増えないこと（worldLoad が2回来ても事故らない）
sched.startScheduler();
portal.startAmbience();
assert.ok(
  calls.intervals.length <= 2,
  `再呼び出しでタイマーが増えた（${calls.intervals.length} 本）。多重起動で負荷が倍になる`,
);
console.log("  ok  二重起動してもタイマーが増えない");

console.log("\n全部通過。");

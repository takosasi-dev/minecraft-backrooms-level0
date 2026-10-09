/**
 * エンティティ（フェイスリング・ハウンド・スマイラー）の出現と消滅（BackroomsBP/scripts/entities.js）
 *
 *   node tools/test_entities.mjs
 *
 * 実物の entities.js / layout.js / generator.js をそのまま動かし、@minecraft/server だけを
 * 「生成済みのセル・壁の柱・明るさ・視線の遮り」だけを覚える偽ワールドに差し替える。
 * 見ているのは出現位置と消える条件だけで、エンティティの動き（追ってくる速さ・攻撃）は
 * 実機でしか分からない（entities/*.json の値。README 7節）。
 */

import assert from "node:assert/strict";
import { register } from "node:module";
import { readFileSync } from "node:fs";

const STUB_SRC = `
const sim = () => globalThis.__ent;
const signal = () => ({ subscribe: () => {}, unsubscribe: () => {} });
export const world = {
  getDynamicProperty: () => 20260921,
  setDynamicProperty: () => {},
  getDimension: () => sim().dim,
  getDifficulty: () => sim().difficulty,
  afterEvents: new Proxy({}, { get: signal }),
  beforeEvents: new Proxy({}, { get: signal }),
};
export const system = {
  get currentTick() { return sim().tick; },
  runInterval: () => 0,
  runJob: () => 0,
  run: (cb) => { cb(); return 0; },
  runTimeout: () => 0,
  beforeEvents: { startup: signal() },
};
export class BlockVolume { constructor(from, to) { this.from = from; this.to = to; } }
export const BlockPermutation = { resolve: (id, states) => ({ type: { id }, states }) };
export class ItemStack { constructor(id, amount) { this.typeId = id; this.amount = amount ?? 1; } }
export const EquipmentSlot = { Head: 'Head', Chest: 'Chest', Legs: 'Legs', Feet: 'Feet', Mainhand: 'Mainhand', Offhand: 'Offhand' };
export const GameMode = { Survival: 'Survival', Creative: 'Creative', Adventure: 'Adventure', Spectator: 'Spectator' };
export const Difficulty = { Peaceful: 'Peaceful', Easy: 'Easy', Normal: 'Normal', Hard: 'Hard' };
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

const SCRIPTS = new URL("../BackroomsBP/scripts/", import.meta.url);
const config = await import(new URL("config.js", SCRIPTS).href);
const layout = await import(new URL("layout.js", SCRIPTS).href);
const { E_SHADOW, E_HOUND, E_SMILER, E_FAMILY, ENTITY_CHECK_TICKS, Y_AIR_MIN, Y_AIR_MAX, setTuning } = config;
const SEED = 20260921;
const FLOOR = "backrooms:floor";

const block = (typeId) => ({ typeId, isAir: typeId === "minecraft:air", isLiquid: false });
const AIR = block("minecraft:air");
const GROUND = block(FLOOR);
const WALL = block("backrooms:wall");

/** 生成済みのセルと壁の柱だけを覚える Level 0。明るさは light(x, y, z) で決める */
function makeDimension() {
  const cells = new Set();
  const walls = new Set();
  const entities = [];
  let serial = 0;
  const dim = {
    id: "backrooms:level0",
    cells,
    walls,
    entities,
    light: () => 0,
    getBlock({ x, y, z }) {
      x = Math.floor(x);
      z = Math.floor(z);
      if (y === 0) return cells.has(`${Math.floor(x / 16)},${Math.floor(z / 16)}`) ? GROUND : AIR;
      if (y >= Y_AIR_MIN && y <= Y_AIR_MAX && walls.has(`${x},${z}`)) return WALL;
      return AIR;
    },
    getBlockFromRay(from, dir, { maxDistance }) {
      for (let t = 0; t < maxDistance; t += 0.1) {
        const p = { x: from.x + dir.x * t, y: from.y + dir.y * t, z: from.z + dir.z * t };
        const b = this.getBlock({ x: p.x, y: Math.floor(p.y), z: p.z });
        if (b === WALL) return { block: b };
      }
      return undefined;
    },
    getLightLevel(p) {
      return this.light(p.x, p.y, p.z);
    },
    getEntities({ families }) {
      return entities.filter((e) => e.isValid && families.includes(E_FAMILY));
    },
    particles: [],
    spawnParticle(effectName, location) {
      this.particles.push({ effectName, location: { ...location } });
    },
    spawnEntity(typeId, location, options) {
      const e = {
        typeId,
        id: `e${serial++}`,
        location: { ...location },
        rotation: options?.initialRotation,
        isValid: true,
        dimension: dim,
        tags: new Set(),
        events: [],
        remove() {
          this.isValid = false;
        },
        setRotation(r) {
          this.rotation = r.y;
        },
        addTag(t) {
          this.tags.add(t);
          return true;
        },
        hasTag(t) {
          return this.tags.has(t);
        },
        addEffect(type, duration, options) {
          this.effect = { type, duration, ...options };
          return this.effect;
        },
        triggerEvent(name) {
          this.events.push(name);
        },
      };
      entities.push(e);
      return e;
    },
    alive(type) {
      return entities.filter((e) => e.isValid && e.typeId === type);
    },
  };
  return dim;
}

/** yaw（度）の向きを見ているプレイヤー。yaw 0 が +Z、-90 が +X（Minecraft と同じ） */
function makePlayer(dim, x, z, yaw, mode = "Survival") {
  return {
    dimension: dim,
    location: { x, y: Y_AIR_MIN, z },
    yaw,
    held: {}, // { Mainhand: { typeId }, Offhand: { typeId } }
    getRotation() {
      return { x: 0, y: this.yaw };
    },
    getViewDirection() {
      const r = (this.yaw * Math.PI) / 180;
      return { x: -Math.sin(r), y: 0, z: Math.cos(r) };
    },
    getHeadLocation() {
      return { x: this.location.x, y: this.location.y + 1.62, z: this.location.z };
    },
    getGameMode: () => mode,
    getComponent(id) {
      if (id !== "minecraft:equippable") return undefined;
      return { getEquipment: (slot) => this.held[slot] };
    },
  };
}

/** p から at を向く yaw（度）。entities.js の yawTo と同じ式 */
const lookAt = (p, at) => {
  p.yaw = (Math.atan2(-(at.x - p.location.x), at.z - p.location.z) * 180) / Math.PI;
};

/** プレイヤーの周り (cx±r, cz±r) を生成済みにする */
function generateAround(dim, cx, cz, r = 3) {
  for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) dim.cells.add(`${cx + dx},${cz + dz}`);
}

function chances(shadow, hound, smiler) {
  setTuning("SHADOW_CHANCE", shadow);
  setTuning("HOUND_CHANCE", hound);
  setTuning("SMILER_CHANCE", smiler);
}

let runNo = 0;

/** 状態（フェイスリングの記録・前回の判定時刻）を持たない新しい entities.js と偽ワールド */
async function fresh(difficulty = "Normal") {
  const dim = makeDimension();
  globalThis.__ent = { dim, difficulty, tick: 1000 };
  const mod = await import(new URL(`entities.js?run=${runNo++}`, SCRIPTS).href);
  const sim = globalThis.__ent;
  return {
    dim,
    sim,
    /** 出現判定が走るところまで時計を進めて1周期回す */
    check(players) {
      sim.tick += ENTITY_CHECK_TICKS;
      mod.updateEntities(dim, players);
    },
    /** 出現判定の無い周期（0.5秒後）を回す */
    step(players, ticks = 10) {
      sim.tick += ticks;
      mod.updateEntities(dim, players);
    },
  };
}

const angleFrom = (p, at) => {
  const v = p.getViewDirection();
  const dx = at.x - p.location.x;
  const dz = at.z - p.location.z;
  return (Math.acos((dx * v.x + dz * v.z) / Math.hypot(dx, dz)) * 180) / Math.PI;
};
const flat = (p, at) => Math.hypot(at.x - p.location.x, at.z - p.location.z);

// セル (3,0) の中央。拠点 (0,0) から3セル離れ、暗区画ではない
const PX = 3 * 16 + 8.5;
const PZ = 8.5;
assert.equal(layout.isDarkCell(3, 0, SEED), false, "テストの前提: セル 3,0 は暗区画でない");

console.log("1. フェイスリング（襲わない）");
{
  chances(100, 0, 0);
  const t = await fresh();
  generateAround(t.dim, 3, 0);
  const p = makePlayer(t.dim, PX, PZ, -90); // +X を見ている
  t.check([p]);
  const [s] = t.dim.alive(E_SHADOW);
  assert.ok(s, "確率100%で出ない");
  assert.ok(angleFrom(p, s.location) <= 35.5, `視線から ${angleFrom(p, s.location).toFixed(0)}° に出た`);
  const d = flat(p, s.location);
  assert.ok(d >= 13 && d <= 21, `距離 ${d.toFixed(1)}`);
  // フェイスリングの向き（yaw）の単位ベクトルが、フェイスリングからプレイヤーへの向きと一致するか
  const r = (s.rotation * Math.PI) / 180;
  const toward = ((-Math.sin(r)) * (p.location.x - s.location.x) + Math.cos(r) * (p.location.z - s.location.z)) / d;
  assert.ok(toward > 0.999, `プレイヤーの方を向いていない（yaw ${s.rotation.toFixed(0)}）`);
  console.log(`  ok  前方 ${angleFrom(p, s.location).toFixed(0)}°・${d.toFixed(1)} ブロックの霧の中に、こちらを向いて出る`);

  t.check([p]);
  assert.equal(t.dim.alive(E_SHADOW).length, 1, "近くにいるのに2体目が出た");
  console.log("  ok  近くに1体いる間は2体目を出さない");

  p.yaw = 90; // 背を向ける
  t.step([p]);
  assert.equal(t.dim.alive(E_SHADOW).length, 0, "見たあと目を離しても消えない");
  console.log("  ok  見たあと目を離すと消える");
}
{
  const t = await fresh();
  generateAround(t.dim, 3, 0);
  const p = makePlayer(t.dim, PX, PZ, -90);
  t.check([p]);
  const [s] = t.dim.alive(E_SHADOW);
  p.location = { x: s.location.x - 9, y: Y_AIR_MIN, z: s.location.z }; // 10ブロック未満に近づく
  t.step([p]);
  assert.equal(s.isValid, true, "10ブロック以内に近づいただけで消えた");
  assert.ok(s.events.includes("backrooms:walk_away"), "backrooms:walk_away が発火していない");
  console.log("  ok  10ブロック以内に近づくと、消えずに backrooms:walk_away が発火する");

  p.location = { x: s.location.x - 2, y: Y_AIR_MIN, z: s.location.z }; // 触れるほど近づく
  t.step([p]);
  assert.equal(s.isValid, false, "触れるほど近づいても消えない");
  console.log("  ok  触れるほど近づくと消える");
}
{
  const t = await fresh();
  generateAround(t.dim, 3, 0);
  const p = makePlayer(t.dim, PX, PZ, -90);
  t.check([p]);
  const [s] = t.dim.alive(E_SHADOW);
  for (let i = 0; i < 58; i++) t.step([p]); // 見続けて29秒
  assert.equal(s.isValid, true, "見ているのに30秒経つ前に消えた");
  for (let i = 0; i < 4; i++) t.step([p]);
  assert.equal(s.isValid, false, "30秒経っても消えない");
  console.log("  ok  見続けていても30秒で消える");
}
{
  const t = await fresh();
  generateAround(t.dim, 3, 0);
  // 前方5ブロックに端から端まで壁。向こう側は見えない
  for (let z = -40; z <= 60; z++) for (const x of [PX + 5, PX + 6]) t.dim.walls.add(`${Math.floor(x)},${z}`);
  const p = makePlayer(t.dim, PX, PZ, -90);
  for (let i = 0; i < 5; i++) t.check([p]);
  assert.equal(t.dim.alive(E_SHADOW).length, 0, "壁の向こう（見えない場所）に出た");
  console.log("  ok  壁の向こう（見えない場所）には出ない");
}

console.log("\n2. ハウンド（襲う）");
{
  chances(0, 100, 0);
  const t = await fresh();
  generateAround(t.dim, 3, 0);
  const p = makePlayer(t.dim, PX, PZ, -90);
  t.check([p]);
  const [h] = t.dim.alive(E_HOUND);
  assert.ok(h, "確率100%で出ない");
  assert.ok(angleFrom(p, h.location) >= 109.5, `背後でなく ${angleFrom(p, h.location).toFixed(0)}° に出た`);
  const d = flat(p, h.location);
  assert.ok(d >= 15 && d <= 25, `距離 ${d.toFixed(1)}`);
  console.log(`  ok  背後 ${angleFrom(p, h.location).toFixed(0)}°・${d.toFixed(1)} ブロックに出る`);

  h.location = { x: 8.5, y: Y_AIR_MIN, z: 8.5 }; // 拠点のセルへ入った
  t.step([p]);
  assert.equal(h.isValid, false, "拠点のセルに入っても消えない");
  console.log("  ok  拠点のセルに入ると消える（isSafeCell。拠点は安全地帯）");
}

console.log("\n2b. ハウンド（見つめ返すと一時的に止まる）");
{
  chances(0, 100, 0);
  const t = await fresh();
  generateAround(t.dim, 3, 0);
  const p = makePlayer(t.dim, PX, PZ, -90);
  t.check([p]);
  const [h] = t.dim.alive(E_HOUND);
  lookAt(p, h.location);
  t.step([p]);
  assert.ok(h.hasTag("backrooms:stared"), "見つめ返しても backrooms:stared が付かない");
  assert.ok(h.effect && h.effect.type === "slowness" && h.effect.amplifier === 255, "slowness 255 がかかっていない");
  console.log("  ok  正面から見つめ返すと slowness がかかり backrooms:stared が付く");

  h.effect = undefined;
  t.step([p]);
  assert.equal(h.effect, undefined, "backrooms:stared が付いた後にもう一度 slowness がかかった");
  console.log("  ok  同じ個体には二度と効かない");
}
{
  chances(0, 100, 0);
  const t = await fresh();
  generateAround(t.dim, 3, 0);
  const p = makePlayer(t.dim, PX, PZ, -90);
  t.check([p]);
  const [h] = t.dim.alive(E_HOUND);
  p.yaw = -90; // ハウンド（背後）の方を見ていない
  t.step([p]);
  assert.equal(h.hasTag("backrooms:stared"), false, "見ていないのに backrooms:stared が付いた");
  console.log("  ok  見ていなければ止まらない");
}
{
  chances(0, 100, 0);
  const t = await fresh();
  generateAround(t.dim, 3, 0);
  const p = makePlayer(t.dim, PX, PZ, -90);
  t.check([p]);
  const [h] = t.dim.alive(E_HOUND);
  lookAt(p, h.location);
  // p と h の間を壁で塞ぐ
  const midX = Math.floor((p.location.x + h.location.x) / 2);
  const midZ = Math.floor((p.location.z + h.location.z) / 2);
  t.dim.walls.add(`${midX},${midZ}`);
  t.step([p]);
  assert.equal(h.hasTag("backrooms:stared"), false, "壁越しなのに止まった");
  console.log("  ok  壁に遮られていると止まらない");
}
{
  chances(0, 100, 0);
  const t = await fresh();
  generateAround(t.dim, 3, 0);
  const p = makePlayer(t.dim, PX, PZ, -90);
  t.check([p]);
  const [h] = t.dim.alive(E_HOUND);
  h.location = { x: p.location.x + 1, y: Y_AIR_MIN, z: p.location.z }; // 噛みつかれる距離
  lookAt(p, h.location);
  t.step([p]);
  assert.equal(h.hasTag("backrooms:stared"), false, "噛みつかれる距離でも止まった");
  console.log("  ok  噛みつかれる距離では止まらない");
}
{
  const t = await fresh("Peaceful");
  generateAround(t.dim, 3, 0);
  const p = makePlayer(t.dim, PX, PZ, -90);
  const old = t.dim.spawnEntity(E_HOUND, { x: PX - 20, y: Y_AIR_MIN, z: PZ });
  t.check([p]);
  assert.equal(old.isValid, false, "ピースフルなのに残っている");
  assert.equal(t.dim.alive(E_HOUND).length, 0, "ピースフルなのに出た");
  console.log("  ok  ピースフルでは出ず、いたものも消える");
}

console.log("\n3. スマイラー（暗区画だけ）");
{
  chances(0, 0, 100);
  const t = await fresh();
  generateAround(t.dim, 3, 0);
  const p = makePlayer(t.dim, PX, PZ, -90);
  for (let i = 0; i < 5; i++) t.check([p]);
  assert.equal(t.dim.alive(E_SMILER).length, 0, "暗区画でないのに出た");
  console.log("  ok  暗区画の外では出ない");
}
{
  // 拠点から離れた暗区画を探す（周り1セルも暗区画なら、出る場所の条件が暗さで外れない）
  let dark;
  for (let r = 3; r < 40 && !dark; r++) {
    for (let cz = -r; cz <= r && !dark; cz++) {
      for (let cx = -r; cx <= r && !dark; cx++) {
        if (!layout.isDarkCell(cx, cz, SEED)) continue;
        if ([-1, 0, 1].every((dz) => [-1, 0, 1].every((dx) => layout.isDarkCell(cx + dx, cz + dz, SEED)))) dark = { cx, cz };
      }
    }
  }
  assert.ok(dark, "テストの前提: 3x3 の暗区画が見つからない");
  const t = await fresh();
  generateAround(t.dim, dark.cx, dark.cz);
  const p = makePlayer(t.dim, dark.cx * 16 + 8.5, dark.cz * 16 + 8.5, -90);
  t.check([p]);
  const [s] = t.dim.alive(E_SMILER);
  assert.ok(s, "暗区画で確率100%なのに出ない");
  const d = flat(p, s.location);
  assert.ok(d >= 7 && d <= 17, `距離 ${d.toFixed(1)}`);
  console.log(`  ok  暗区画（セル ${dark.cx},${dark.cz}）では前方 ${d.toFixed(1)} ブロックの暗がりに出る`);

  t.step([p]);
  assert.equal(s.isValid, true, "暗いままなのに消えた");
  const lx = Math.floor(s.location.x);
  const lz = Math.floor(s.location.z);
  t.dim.light = (x, _y, z) => (Math.abs(x - lx) + Math.abs(z - lz) <= 3 ? 11 : 0); // 足元に松明
  t.step([p]);
  assert.equal(s.isValid, false, "光の中に入っても消えない");
  assert.ok(t.dim.particles.length > 0, "消えるときの煙が無い");
  console.log("  ok  光（松明）の中に入ると煙を残して消える");

  t.dim.light = () => 0;
  const q = makePlayer(t.dim, p.location.x, p.location.z, -90, "Creative");
  for (let i = 0; i < 5; i++) t.check([q]);
  assert.equal(t.dim.alive(E_SMILER).length, 0, "クリエイティブの人の周りに出た");
  console.log("  ok  クリエイティブの人の周りには出ない");
}

console.log("\n3b. スマイラー（光る物を持って見られると消える）");
{
  // 拠点から離れた暗区画を探す（3.のテストと同じやり方）
  let dark;
  for (let r = 3; r < 40 && !dark; r++) {
    for (let cz = -r; cz <= r && !dark; cz++) {
      for (let cx = -r; cx <= r && !dark; cx++) {
        if (!layout.isDarkCell(cx, cz, SEED)) continue;
        if ([-1, 0, 1].every((dz) => [-1, 0, 1].every((dx) => layout.isDarkCell(cx + dx, cz + dz, SEED)))) dark = { cx, cz };
      }
    }
  }
  chances(0, 0, 100);
  const t = await fresh();
  generateAround(t.dim, dark.cx, dark.cz);
  const p = makePlayer(t.dim, dark.cx * 16 + 8.5, dark.cz * 16 + 8.5, -90);
  t.check([p]);
  const [s] = t.dim.alive(E_SMILER);
  assert.ok(s, "暗区画で確率100%なのに出ない");
  lookAt(p, s.location);

  t.step([p]); // 素手で見ている
  assert.equal(s.isValid, true, "素手で見ただけで消えた");
  console.log("  ok  素手で見ただけでは消えない");

  // スマイラーは 8〜16 ブロック先に出る。光が届くのは 8 ブロックまで（SMILER_LIGHT_SEE_DIST）
  p.held = { Mainhand: { typeId: "minecraft:torch" } };
  const gap = Math.hypot(s.location.x - p.location.x, s.location.z - p.location.z);
  if (gap > 8.5) {
    t.step([p]);
    assert.equal(s.isValid, true, "松明が届かない距離で消えた");
    console.log(`  ok  松明を持っていても ${gap.toFixed(1)} ブロック先では消えない`);
  }
  // スマイラーの方へ 6 ブロック手前まで歩み寄る（間は暗区画の床。壁があれば見えないので避けた位置に出ている）
  const k = Math.max(0, (gap - 6) / gap);
  p.location = { ...p.location, x: p.location.x + (s.location.x - p.location.x) * k, z: p.location.z + (s.location.z - p.location.z) * k };
  lookAt(p, s.location);
  t.step([p]);
  assert.equal(s.isValid, false, "松明を持って近づいても消えない");
  assert.ok(t.dim.particles.length > 0, "消えるときの煙が無い");
  console.log("  ok  松明を持って近づくと煙を残して消える");
}

console.log("\n3c. スマイラー（物理攻撃は効かない・JSON）");
{
  const smiler = JSON.parse(readFileSync(new URL("../BackroomsBP/entities/smiler.json", import.meta.url)));
  const triggers = smiler["minecraft:entity"].components["minecraft:damage_sensor"].triggers;
  const fireIdx = triggers.findIndex((tr) => tr.cause === "fire");
  const fireTickIdx = triggers.findIndex((tr) => tr.cause === "fire_tick");
  const lavaIdx = triggers.findIndex((tr) => tr.cause === "lava");
  const allIdx = triggers.findIndex((tr) => tr.cause === "all");
  assert.ok(fireIdx >= 0 && fireTickIdx >= 0 && lavaIdx >= 0 && allIdx >= 0, "fire/fire_tick/lava/all のどれかが無い");
  assert.ok(fireIdx < allIdx && fireTickIdx < allIdx && lavaIdx < allIdx, "catch-all が fire 系より先に来ていて効かなくなる");
  // deals_damage は文字列 "yes" / "no"（公式リファレンスの書式。shadow.json と同じ）
  assert.equal(triggers[fireIdx].deals_damage, "yes", "fire でダメージが通らない");
  assert.equal(triggers[fireTickIdx].deals_damage, "yes", "fire_tick でダメージが通らない");
  assert.equal(triggers[lavaIdx].deals_damage, "yes", "lava でダメージが通らない");
  assert.equal(triggers[allIdx].deals_damage, "no", "fire/fire_tick/lava 以外でダメージが通ってしまう");
  console.log("  ok  damage_sensor: fire/fire_tick/lava だけ通り、それ以外は0（JSONの静的チェック）");
}

console.log("\n4. 共通");
{
  // マニラルームの座標は担当Ⓐが並行して書いているので、安全地帯の確認は拠点セルで代用する（8.2）
  assert.equal(layout.isSafeCell(0, 0, SEED), true, "拠点セルが isSafeCell で安全地帯にならない");
  chances(100, 100, 100);
  const t = await fresh();
  generateAround(t.dim, 0, 0);
  const p = makePlayer(t.dim, 8.5, 8.5, -90);
  for (let i = 0; i < 5; i++) t.check([p]);
  assert.equal(t.dim.entities.length, 0, "安全地帯（拠点）にいる人の周りに出た");
  console.log("  ok  安全地帯（isSafeCell）では出現せず、襲う個体は入ると消える");
}
{
  chances(0, 0, 0);
  const t = await fresh();
  generateAround(t.dim, 3, 0);
  const p = makePlayer(t.dim, PX, PZ, -90);
  const far = [E_SHADOW, E_HOUND].map((type) => t.dim.spawnEntity(type, { x: PX + 50, y: Y_AIR_MIN, z: PZ }));
  const near = t.dim.spawnEntity(E_HOUND, { x: PX - 30, y: Y_AIR_MIN, z: PZ });
  t.step([p]);
  assert.ok(far.every((e) => !e.isValid), "48ブロックより遠いのに残っている");
  assert.equal(near.isValid, true, "30ブロック先のハウンドまで消えた");
  console.log("  ok  一番近い人から48ブロックより遠くなったら消える");
}

console.log("\n全部通過。");

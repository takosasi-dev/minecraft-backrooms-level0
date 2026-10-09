/**
 * Level 0 のエンティティ（フェイスリング・ハウンド・スマイラー）の出現と消滅
 * フェイスリングの ID は、最初に「人影」として作ったときの backrooms:shadow（E_SHADOW）のまま
 *
 * 仕様書は1章・15章でエンティティを「出さない」と確定していたが、依頼者の判断で足した（2026-09-27）。
 * 出すのはこのスクリプトだけで、spawn_rules は置いていない。バニラの自然湧きに任せないのは、
 * 湧く場所（生成済みで床のある柱・暗区画・拠点の外）と数を Level 0 の構造に合わせて決めたいから。
 *
 *   フェイスリング 襲わない。顔の無い人が霧の向こうに立ってこちらを向いている。近づかれると背を向けて歩き去り、
 *              触れるほど近づく・見たあと目を離す・時間切れのいずれかで消える（v0.4.0・英語 Wiki）
 *   ハウンド   襲う。背後の霧の中から出て追ってくる。スプリントなら振り切れる速さ（entities/hound.json）。
 *              見つめ返すと一時的に止まる。同じ個体には一度しか効かない（v0.4.0・日本語 Wiki）
 *   スマイラー 襲う。暗区画にだけ出る光る笑顔。物理攻撃は効かない・弱点は光と火（v0.4.0・英語 Wiki）。
 *              その場の明るさが上がる・光る物を持った人に見られると、煙を残して消える
 *
 * 襲う2体はピースフルでは出ず、既にいるものも消える。安全地帯（拠点・マニラルーム。isSafeCell）に
 * 入っても消える（v0.4.0・INTERFACES.md 8.3）。
 *
 * 専用タイマーは作らない。scheduler.js のグローバルタイマー（0.5秒）から毎周期呼ばれ（15章）、
 *   - 毎周期: 消える条件を見る
 *   - ENTITY_CHECK_TICKS ごと: プレイヤー1人ずつ TUNING の確率で出現を試みる
 *
 * 乱数に Math.random は使わない（validate.cjs が rng.js 以外での使用を止める）。
 * 生成と違って決定論である必要は無いので、hash32 に現在の tick と引いた回数を混ぜる。
 */

import { system, world, Difficulty, GameMode, EquipmentSlot } from "@minecraft/server";
import { E_FAMILY, E_HOUND, E_SHADOW, E_SMILER, ENTITY_CHECK_TICKS, TUNING, Y_AIR_MIN } from "./config.js";
import { cellOf, isDarkCell, isSafeCell } from "./layout.js";
import { getSeed, hash32, SALT } from "./rng.js";
import { isCellGenerated, standable } from "./generator.js";

/** 一番近いプレイヤーがこれより遠くなったら消す。フォグが閉じる距離（24）の倍 */
const DESPAWN_DIST = 48;
/** この距離に同じ種類がいる間は、その種類を新しく出さない */
const NEAR_DIST = 48;
/** 出現位置を探す試行回数。壁・未生成・暗さの条件で外れた分は次の判定に回す */
const SPAWN_TRIES = 12;

/** フェイスリング: 霧が濃くなり始める距離（10）より近づかれたら、消えずに歩き去り始める（v0.4.0） */
const SHADOW_VANISH_NEAR = 10;
/** フェイスリング: これより近づかれたら（触れるほど）消える */
const SHADOW_TOUCH_DIST = 3;
/** フェイスリング: 歩き去り始めてから、これだけ経てば消える（時間切れの保険。10秒） */
const SHADOW_LEAVE_TIMEOUT_TICKS = 200;
/** フェイスリングを立ち去らせる BP イベント（component_groups backrooms:leaving を足す。INTERFACES.md 8.3） */
const E_WALK_AWAY_EVENT = "backrooms:walk_away";
/** フェイスリング: 見られていてもいなくても、これだけ経てば消える（30秒） */
const SHADOW_LIFE_TICKS = 600;
/** 視線の中心からこの角度以内で、壁に遮られていなければ「見た」 */
const SEEN_COS = Math.cos((35 * Math.PI) / 180);
/** この角度より外なら「目を離した」。画面の外に出ている */
const AWAY_COS = Math.cos((70 * Math.PI) / 180);
/** スマイラー: いる場所の明るさがこれを超えたら消える。松明を1本置けば周囲で超える */
const SMILER_LIGHT_MAX = 3;
/** 視線の判定に使う高さ。プレイヤーの目とほぼ同じで、壁の上を越えて見えることが無い */
const EYE_LEVEL = Y_AIR_MIN + 1.6;

/** ハウンド: 見つめ返してくる角度の狭さ。フェイスリングの「見た」判定（35度）より狭く取り、頭をはっきり見ている場合だけにする */
const HOUND_STARE_COS = Math.cos((15 * Math.PI) / 180);
/** ハウンド: この距離の範囲でだけ「見つめ合い」を判定する */
const HOUND_STARE_RANGE = 20;
/** ハウンド: これより近い（噛みつかれている間）は判定しない */
const HOUND_STARE_MIN_DIST = 3;
/** ハウンド: 見つめ返す先＝頭の高さの近似（四つん這いの姿勢。collision_box の高さ1.1より低い） */
const HOUND_HEAD_Y = 0.9;
/** ハウンドを一度だけ止めるタグ。同じ個体には二度と効かない（日本語 Wiki） */
const HOUND_STARE_TAG = "backrooms:stared";
/** 見つめ返されたハウンドが止まる長さ（tick）。3秒 */
const HOUND_STARE_TICKS = 60;

/** スマイラー: これを手に持って見ていると消える（英語 Wiki: 弱点は光と火）。種類を増やすならここだけ */
const SMILER_LIGHT_ITEMS = [
  "minecraft:torch",
  "minecraft:soul_torch",
  "minecraft:redstone_torch",
  "minecraft:lantern",
  "minecraft:soul_lantern",
  "minecraft:glowstone",
  "minecraft:sea_lantern",
  "minecraft:shroomlight",
  "minecraft:lit_pumpkin", // ジャック・オー・ランタン（Bedrock の識別子は lit_pumpkin）
  "minecraft:ochre_froglight",
  "minecraft:verdant_froglight",
  "minecraft:pearlescent_froglight",
];
/**
 * スマイラー: 光る物を持った人が遮られずにこの距離まで来ると消える。
 * スマイラーは 8〜16 ブロック先に出るので、16 だと出た次の周期に消えて姿がほぼ見えない。
 * 8 なら笑みが近づいてきて、光に触れたところで怯んで消える
 */
const SMILER_LIGHT_SEE_DIST = 8;
/** 消えるときに残す一瞬の煙（スマイラー用） */
const SMOKE_PARTICLE = "minecraft:basic_smoke_particle"; // 実在を確認できたバニラの煙（wiki.bedrock.dev）

/** 出現位置の決め方。arc はプレイヤーの向きからの角度（度） */
const SPAWN = {
  // 前方の霧の中。10〜24 で霧が濃くなるので、輪郭だけが見える距離
  [E_SHADOW]: { arc: { center: 0, half: 35 }, min: 14, max: 20, visible: true },
  // 背後の霧の中。背後なので画面には入らない（壁の有無は問わない。問うと大部屋に出なくなる）
  [E_HOUND]: { arc: { center: 180, half: 70 }, min: 16, max: 24 },
  // 前方の暗がり。暗区画は蛍光灯が無いので、霧より先に暗さで見えにくい
  [E_SMILER]: { arc: { center: 0, half: 60 }, min: 8, max: 16, visible: true, dark: true },
};

/** フェイスリング id -> { born: 出た tick, seen: 一度でも見られたか } */
const shadows = new Map();
let lastCheck;
let draws = 0;

const RAD = Math.PI / 180;
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

function rand() {
  return hash32(system.currentTick, draws++, SALT.ENTITY, getSeed()) / 0x100000000;
}

/** yaw（度）の向きの水平単位ベクトル。Minecraft は yaw 0 が +Z、90 が -X */
function facing(yaw) {
  return { x: -Math.sin(yaw * RAD), z: Math.cos(yaw * RAD) };
}

/** from から to を向く yaw（度） */
function yawTo(from, to) {
  return Math.atan2(-(to.x - from.x), to.z - from.z) / RAD;
}

/** point がプレイヤーの視線の中心からどれだけ外れているか（cos）。1 が真正面 */
function viewCos(player, point) {
  const eye = player.getHeadLocation();
  const v = player.getViewDirection();
  const dx = point.x - eye.x;
  const dy = point.y - eye.y;
  const dz = point.z - eye.z;
  const d = Math.hypot(dx, dy, dz);
  return d < 1e-6 ? 1 : (dx * v.x + dy * v.y + dz * v.z) / d;
}

/** プレイヤーの目から point まで、壁に遮られずに見通せるか */
function lineOfSight(player, point) {
  const eye = player.getHeadLocation();
  const dx = point.x - eye.x;
  const dy = point.y - eye.y;
  const dz = point.z - eye.z;
  const d = Math.hypot(dx, dy, dz);
  if (d < 1e-6) return true;
  try {
    return player.dimension.getBlockFromRay(eye, { x: dx / d, y: dy / d, z: dz / d }, { maxDistance: d }) === undefined;
  } catch {
    return false; // 未ロードの先は見えないことにする
  }
}

/** その場所の明るさ。読めなければ明るいとみなす（スマイラーは出さない・消す側に倒す） */
function lightAt(dim, p) {
  try {
    return dim.getLightLevel({ x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) });
  } catch {
    return 15;
  }
}

function vanish(entity) {
  try {
    shadows.delete(entity.id);
    entity.remove();
  } catch {
    /* 既に消えていた */
  }
}

/** 消える前に小さな煙を残す（スマイラー用） */
function vanishWithSmoke(entity) {
  try {
    entity.dimension.spawnParticle(SMOKE_PARTICLE, { ...entity.location, y: entity.location.y + 1 });
  } catch {
    /* 未ロード等は無視。消えること自体は続行する */
  }
  vanish(entity);
}

/** プレイヤーがメインハンドかオフハンドに光る物を持っているか（スマイラーの弱点） */
function holdingLight(player) {
  const eq = player.getComponent("minecraft:equippable");
  if (!eq) return false;
  const main = eq.getEquipment(EquipmentSlot.Mainhand);
  if (main && SMILER_LIGHT_ITEMS.includes(main.typeId)) return true;
  const off = eq.getEquipment(EquipmentSlot.Offhand);
  return !!off && SMILER_LIGHT_ITEMS.includes(off.typeId);
}

/** 光る物を持った人が近くから見ているか（英語 Wiki: 光に晒されると怯む） */
function smilerSeenWithLight(entity, players) {
  return players.some(
    // 足元（床の上端と同じ高さ）を狙うと床のブロックに当たって見えない扱いになるので、胸の高さを狙う
    (p) =>
      holdingLight(p) &&
      dist(p.location, entity.location) <= SMILER_LIGHT_SEE_DIST &&
      lineOfSight(p, { ...entity.location, y: entity.location.y + 1 }),
  );
}

/** ハウンドが見つめ返されているか。タグが付いていたら二度と判定しない（同じ個体には一度だけ） */
function staredAt(entity, players) {
  if (entity.hasTag(HOUND_STARE_TAG)) return false;
  const head = { ...entity.location, y: entity.location.y + HOUND_HEAD_Y };
  return players.some((p) => {
    const d = dist(p.location, entity.location);
    return (
      d >= HOUND_STARE_MIN_DIST && d <= HOUND_STARE_RANGE && viewCos(p, head) >= HOUND_STARE_COS && lineOfSight(p, head)
    );
  });
}

// ---- 出現 ----

/** 出現させる柱を探す。見つからなければ undefined（この回は出さない） */
function findSpot(dim, player, rule, seed) {
  const loc = player.location;
  const yaw = player.getRotation().y;
  for (let i = 0; i < SPAWN_TRIES; i++) {
    const dir = facing(yaw + rule.arc.center + (rand() * 2 - 1) * rule.arc.half);
    const d = rule.min + rand() * (rule.max - rule.min);
    const x = Math.floor(loc.x + dir.x * d);
    const z = Math.floor(loc.z + dir.z * d);
    const { cx, cz } = cellOf(x, z);
    if (isSafeCell(cx, cz, seed) || !isCellGenerated(dim, cx, cz) || !standable(dim, x, z)) continue;
    const at = { x: x + 0.5, y: Y_AIR_MIN, z: z + 0.5 };
    // 出た瞬間に光の中で消えないよう、消える明るさより1段暗いところに出す
    if (rule.dark && (!isDarkCell(cx, cz, seed) || lightAt(dim, at) >= SMILER_LIGHT_MAX)) continue;
    if (rule.visible && !lineOfSight(player, { ...at, y: EYE_LEVEL })) continue;
    return at;
  }
  return undefined;
}

/** プレイヤー1人の周りで、TUNING の確率で出現を試みる。出したものは alive に足す */
function spawnAround(dim, player, alive, hostile, seed) {
  const mode = player.getGameMode();
  // 飛び回る管理者の周りには出さない（足元の同期生成と同じ扱い）。確かめるなら /summon
  if (mode === GameMode.Creative || mode === GameMode.Spectator) return;
  const loc = player.location;
  const { cx, cz } = cellOf(loc.x, loc.z);
  if (isSafeCell(cx, cz, seed)) return; // 拠点・マニラルームは安全地帯（ガイドブック3節・INTERFACES.md 8.3）

  const plan = [
    [E_SHADOW, TUNING.SHADOW_CHANCE, true],
    [E_HOUND, TUNING.HOUND_CHANCE, hostile],
    [E_SMILER, TUNING.SMILER_CHANCE, hostile && isDarkCell(cx, cz, seed)],
  ];
  for (const [type, chance, allowed] of plan) {
    if (!allowed) continue;
    if (alive.some((e) => e.typeId === type && dist(e.location, loc) < NEAR_DIST)) continue;
    if (rand() * 100 >= chance) continue;
    const at = findSpot(dim, player, SPAWN[type], seed);
    if (!at) continue;
    try {
      alive.push(dim.spawnEntity(type, at, { initialRotation: yawTo(at, loc) }));
    } catch (e) {
      console.warn(`[backrooms] spawn ${type} failed: ${e}`);
    }
  }
}

// ---- 消滅 ----

/**
 * フェイスリング。近づかれすぎたら歩き去り始める（それまでは一番近い人を向く）。
 * 消えるのは、触れるほど近づく・見たあと目を離す・時間切れ・歩き去ってからの時間切れ、のいずれか（v0.4.0）
 */
function keepShadow(entity, loc, players, nearest, nearestDist, now) {
  let s = shadows.get(entity.id);
  if (!s) shadows.set(entity.id, (s = { born: now, seen: false, leaving: false, leftAt: 0 }));
  if (nearestDist < SHADOW_TOUCH_DIST) return vanish(entity); // 触れるほど近づかれた
  if (now - s.born > SHADOW_LIFE_TICKS) return vanish(entity); // 寿命
  if (s.leaving && now - s.leftAt > SHADOW_LEAVE_TIMEOUT_TICKS) return vanish(entity); // 歩き去ってからの時間切れ

  const head = { ...loc, y: EYE_LEVEL };
  if (players.some((p) => viewCos(p, head) >= SEEN_COS && lineOfSight(p, head))) s.seen = true;
  else if (s.seen && players.every((p) => viewCos(p, head) < AWAY_COS)) return vanish(entity);

  if (!s.leaving && nearestDist < SHADOW_VANISH_NEAR) {
    s.leaving = true;
    s.leftAt = now;
    entity.triggerEvent(E_WALK_AWAY_EVENT); // component_groups backrooms:leaving を足す（移動・回避行動）
  }
  // 歩き去っている間は、逃げる方向を自分で決めさせる（プレイヤーの方を向かせない）
  if (!s.leaving) entity.setRotation({ x: 0, y: yawTo(loc, nearest.location) });
}

function maintain(entity, players, hostile, seed, now) {
  const loc = entity.location;
  let nearest;
  let nearestDist = Infinity;
  for (const p of players) {
    const d = dist(p.location, loc);
    if (d < nearestDist) {
      nearest = p;
      nearestDist = d;
    }
  }
  if (nearestDist > DESPAWN_DIST) return vanish(entity);
  if (entity.typeId === E_SHADOW) return keepShadow(entity, loc, players, nearest, nearestDist, now);

  // ここから下は襲う2体
  const { cx, cz } = cellOf(loc.x, loc.z);
  if (!hostile || isSafeCell(cx, cz, seed)) return vanish(entity);

  if (entity.typeId === E_HOUND) {
    if (staredAt(entity, players)) {
      entity.addEffect("slowness", HOUND_STARE_TICKS, { amplifier: 255, showParticles: false });
      entity.addTag(HOUND_STARE_TAG); // 同じ個体には二度と効かない
    }
    return;
  }
  if (entity.typeId === E_SMILER) {
    if (lightAt(entity.dimension, loc) > SMILER_LIGHT_MAX) return vanishWithSmoke(entity);
    if (smilerSeenWithLight(entity, players)) return vanishWithSmoke(entity);
  }
}

/**
 * scheduler.js のグローバルタイマーから、Level 0 にプレイヤーがいる周期だけ呼ばれる。
 * players は Level 0 のプレイヤー（1人以上）
 */
export function updateEntities(dim, players) {
  const now = system.currentTick;
  const hostile = world.getDifficulty() !== Difficulty.Peaceful;
  const seed = getSeed();
  const all = dim.getEntities({ families: [E_FAMILY] });
  for (const entity of all) {
    try {
      maintain(entity, players, hostile, seed, now);
    } catch (e) {
      console.warn(`[backrooms] entity update failed: ${e}`);
    }
  }
  const alive = all.filter((e) => e.isValid);
  // 倒された・/kill されたフェイスリングの記録を捨てる
  if (shadows.size > 0) {
    const ids = new Set(alive.map((e) => e.id));
    for (const id of shadows.keys()) if (!ids.has(id)) shadows.delete(id);
  }

  if (lastCheck !== undefined && now - lastCheck < ENTITY_CHECK_TICKS) return;
  lastCheck = now;
  for (const p of players) {
    try {
      spawnAround(dim, p, alive, hostile, seed);
    } catch (e) {
      console.warn(`[backrooms] entity spawn failed: ${e}`);
    }
  }
}

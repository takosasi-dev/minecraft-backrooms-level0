/**
 * 侵入・脱出導線と雰囲気演出（仕様書 8.1 / 8.2 / 8.3 / 8.4 / 9.1 / 9.2 / FR-21）
 *
 * ここが守らなければならない要点:
 *   - テレポート前の await createTickingArea を省略しない。省略すると虚空に落ちる（15章）
 *   - 使い終わった ticking area は必ず削除する。残すとチャンク割当を食い潰す
 *   - フォグの解除を省略しない。フォグ設定はワールドセーブをまたいで永続する（9.1 / 11章）
 *   - ノークリップアイテムを消費する。しないと1個で無限に入れる（Q-15）
 *   - Level 0 ではベッドで寝させない。ディメンション単位で判定する（FR-21 / 6.8）
 *   - Level 0 の外（床の下の虚空・天井の上）に出た人は床の上へ戻す。バニラのモンスターは湧いたら消す
 *   - v0.5.0: 上の演出と決まりは Level 1 にも同じく効かせる。Level 0 の穴 → Level 1、Level 1 の上り階段 → Level 0（INTERFACES.md 9.3）。
 *     2つの階層の間の移動では霧（階層ごとに差し替え）とハム音を外さず、戻り先も上書きしない
 *   - runInterval はこのファイルで1本だけ（環境音用）。生成用の1本は scheduler.js（15章）
 *
 * 足音・ジャンプスケア・突発音・視界妨害は足さない（15章）。
 * 鳴っているのは蛍光灯のハム音だけで、それが Level 0 の正しい音環境。
 * エンティティは依頼者の判断で足した（2026-09-27）。出すのも消すのも entities.js で、ここは触らない。
 * 3体とも鳴き声・足音の音声は付けていない。
 */

import { system, world, EntityInitializationCause, GameMode, ItemStack, WeatherType } from "@minecraft/server";
import {
  CELL,
  DIM_ID,
  DIM1_ID,
  B_EXIT,
  I_NOCLIP,
  FOG_PHASES,
  FOG1_PHASES,
  FOG_TAG,
  L1_HOME_CX,
  L1_HOME_CZ,
  L1_SPAWN,
  LM_MANILA,
  Y1_FLOOR,
  Y1_AIR_MIN,
  SND_HUM,
  DP_ENTRY,
  HOME_CX,
  HOME_CZ,
  HOME_SPAWN,
  HUM_REPLAY_TICKS,
  HUM_VOLUME,
  FADE,
  FADE_HOLD_TICKS,
  TICK_INTERVAL,
  TUNING,
  Y_FLOOR,
  Y_AIR_MIN,
  Y_AIR_MAX,
} from "./config.js";
import { getSeed } from "./rng.js";
import { cellOf, findLandmark, inManilaRoom, pitAt } from "./layout.js";
import { maxY1, stairsUpAt1 } from "./layout1.js";
import { standable } from "./generator.js";
import { standable1 } from "./generator1.js";
import { forceGenerateCell } from "./scheduler.js";

const OVERWORLD_ID = "minecraft:overworld";
const PLAYER_TYPE = "minecraft:player";
const BAT_TYPE = "minecraft:bat";
const EMPTY_MAP = "minecraft:empty_map";

/** Backrooms の階層（v0.5.0 で Level 1 が増えた = INTERFACES.md 9.3）。ここにいる間は霧・ハム音・ベッド禁止などが効く */
const LEVELS = [DIM_ID, DIM1_ID];

/** 階層ごとの拠点（入場の着地）と霧 */
const HOMES = {
  [DIM_ID]: { cx: HOME_CX, cz: HOME_CZ, spawn: HOME_SPAWN, fog: FOG_PHASES },
  [DIM1_ID]: { cx: L1_HOME_CX, cz: L1_HOME_CZ, spawn: L1_SPAWN, fog: FOG1_PHASES },
};

/** 長く歩いた距離（プレイヤーの動的プロパティ・INTERFACES.md 9.3） */
const DP_WALKED = "backrooms:walked";
/** 1周期でこれより長い移動はテレポートとみなして数えない（ブロック） */
const WALK_STEP_MAX = 8;
/** 長く歩いたときにマニラルームを探す半径（セル） */
const WALK_SEARCH = 48;
const WALK_LINE = "気づくと、見覚えのない部屋にいた。";
const MAP_LINE = "線がどこにもつながらない。";

/** 着地点を探す範囲（ブロック）。壁は2ブロック厚なので、これだけあれば空いた柱がまず見つかる */
const LANDING_SEARCH = 4;

/** 到着用 ticking area の識別子。転送は直列化するので1つで足りる（8.2） */
const ARRIVAL_AREA = "backrooms:arrival";
/** 到着周辺のロード範囲。Y=20 は巨大空間が隣に来た場合のため（8.2） */
const ARRIVAL_SPAN = 24;
const ARRIVAL_TOP = 20;

/** 出口ドアの接触判定で見る水平4近傍（8.3 / Q-11） */
const NEIGHBORS = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

let ambienceHandle;
let eventsBound = false;

/** 転送処理中のプレイヤー id。フェード中の二重起動を防ぐ */
const transit = new Set();
/** 救出を待っているプレイヤー id。転送は直列キューなので、待つ間に次の周期が来ても積み増さない */
const rescuing = new Set();
/** プレイヤー id -> 直近のハム音。退出時に止める（8.3） */
const humOf = new Map();
/** プレイヤー id -> マニラルームの中に続けて居る tick 数。部屋を出たら・Level 0 を出たら消す（INTERFACES.md 8.2） */
const manilaStay = new Map();

/** マニラルームに居続けたとき、1/3 と 2/3 の時点でアクションバーに出す一言（音は付けない = 15章） */
const MANILA_LINES = ["なぜか、ここは落ち着く。", "壁紙の向こうで、誰かがささやいている気がする。"];

/**
 * 転送の直列化キュー。
 * 複数プレイヤーが同時に入ると ticking area の識別子が衝突し、
 * 片方が「作成を待たずにテレポート」してしまう。順番に流して防ぐ。
 */
let transferChain = Promise.resolve();

// ---- 基本 ----

function dimIdOf(entity) {
  try {
    return entity.dimension.id;
  } catch {
    return undefined;
  }
}

export function isInLevel0(player) {
  return dimIdOf(player) === DIM_ID;
}

export function isInLevel1(player) {
  return dimIdOf(player) === DIM1_ID;
}

/** Level 0 か Level 1 にいる */
export function isInBackrooms(player) {
  return LEVELS.includes(dimIdOf(player));
}

function idOf(entity) {
  try {
    return entity.id;
  } catch {
    return undefined;
  }
}

/** Level 0 と Level 1 にいるプレイヤー。未登録の階層は飛ばす */
function backroomsPlayers() {
  const out = [];
  for (const id of LEVELS) {
    try {
      out.push(...world.getDimension(id).getPlayers());
    } catch {
      /* ディメンション未登録 */
    }
  }
  return out;
}

// ---- フォグ（9.1）----

/** プレイヤー id -> 今かけている霧。時刻が変わったら差し替える（v0.5.0・config.js の FOG_PHASES） */
const fogOf = new Map();

/** 今の時刻に合う霧（phases = FOG_PHASES か FOG1_PHASES の、その時刻以前で最後の段） */
function fogForNow(phases) {
  let t = 0;
  try {
    t = world.getTimeOfDay();
  } catch {
    /* 読めなければ昼の霧 */
  }
  let id = phases[0][1];
  for (const [from, fog] of phases) if (t >= from) id = fog;
  return id;
}

/**
 * 霧をかける。時刻に合う霧が既にかかっていれば何もしない（呼ぶたびに積まない = 16段の上限）。
 * 霧は階層で選ぶ（Level 1 は FOG1_PHASES）。dimId はテレポート直後など player.dimension がまだ古いときに渡す
 */
export function applyFog(player, dimId = dimIdOf(player)) {
  const want = fogForNow((HOMES[dimId] ?? HOMES[DIM_ID]).fog);
  try {
    const tagged = player.fogSettings.getTags().includes(FOG_TAG);
    if (tagged && fogOf.get(idOf(player)) === want) return;
    if (tagged) player.fogSettings.remove(FOG_TAG);
    player.fogSettings.push(want, FOG_TAG);
    fogOf.set(idOf(player), want);
  } catch (e) {
    console.warn(`[backrooms] fog push failed: ${e}`);
  }
}

export function removeFog(player) {
  fogOf.delete(idOf(player));
  try {
    player.fogSettings.remove(FOG_TAG);
  } catch (e) {
    console.warn(`[backrooms] fog remove failed: ${e}`);
  }
}

// ---- 環境音（9.2 / FR-8）----

function playHum(player) {
  const id = idOf(player);
  if (id === undefined) return;
  try {
    humOf.set(id, player.playSound(SND_HUM, { volume: HUM_VOLUME }));
  } catch (e) {
    console.warn(`[backrooms] hum failed: ${e}`);
  }
}

/** まだ鳴っていなければ鳴らす。入場直後の無音を避けるため */
function ensureHum(player) {
  const id = idOf(player);
  if (id === undefined || humOf.has(id)) return;
  playHum(player);
}

function stopHum(id) {
  if (id === undefined) return;
  const sound = humOf.get(id);
  humOf.delete(id);
  if (!sound) return;
  try {
    sound.stop();
  } catch {
    /* 既に鳴り終わっている場合。無視してよい */
  }
}

/** 天候は常時 Clear（4.3 / 9.3）。専用タイマーは作らず環境音のタイマーに相乗りする */
function keepWeatherClear() {
  for (const id of LEVELS) {
    try {
      world.getDimension(id).setWeather(WeatherType.Clear, 1000000);
    } catch {
      /* ディメンション未登録時。次の周期で通る */
    }
  }
}

/**
 * 環境音のタイマー。アドオン全体で2本目・最後の1本（15章）。
 * プレイヤーごとのタイマーは作らない。Level 0 にも Level 1 にも誰もいなければ何もしない（16.4）。
 */
export function startAmbience() {
  if (ambienceHandle !== undefined) return;
  keepWeatherClear();
  ambienceHandle = system.runInterval(() => {
    const players = backroomsPlayers();
    if (players.length === 0) return;
    keepWeatherClear();
    // 素材長より短い間隔で重ねて鳴らし、継ぎ目をクロスフェードで隠す（9.2）
    for (const player of players) {
      playHum(player);
      applyFog(player); // 時刻に合わせて霧を差し替える（9.5秒ごとで足りる。タイマーは増やさない）
    }
  }, HUM_REPLAY_TICKS);
}

// ---- 戻り先（8.1 / 8.3）----

function saveEntry(player) {
  try {
    const loc = player.location;
    player.setDynamicProperty(
      DP_ENTRY,
      JSON.stringify({ x: loc.x, y: loc.y, z: loc.z, d: player.dimension.id }),
    );
  } catch (e) {
    console.warn(`[backrooms] entry save failed: ${e}`);
  }
}

/** ワールドスポーン。既定スポーンの Y が未指定（極端な値）のときは地表を拾う */
function overworldSpawn() {
  const dimension = world.getDimension(OVERWORLD_ID);
  const spawn = world.getDefaultSpawnLocation();
  let y = spawn.y;
  if (!Number.isFinite(y) || y > 320 || y < -64) {
    let top;
    try {
      top = dimension.getTopmostBlock({ x: spawn.x, z: spawn.z });
    } catch {
      top = undefined;
    }
    y = top ? top.location.y + 1 : 64;
  }
  return { location: { x: spawn.x, y, z: spawn.z }, dimension };
}

/** 戻り先。未保存・Level 0 / Level 1 内が保存されていた場合はワールドスポーン（8.3） */
function readEntry(player) {
  try {
    const raw = player.getDynamicProperty(DP_ENTRY);
    if (typeof raw === "string") {
      const saved = JSON.parse(raw);
      if (
        saved &&
        typeof saved.d === "string" &&
        !LEVELS.includes(saved.d) &&
        Number.isFinite(saved.x) &&
        Number.isFinite(saved.y) &&
        Number.isFinite(saved.z)
      ) {
        return {
          location: { x: saved.x, y: saved.y, z: saved.z },
          dimension: world.getDimension(saved.d),
        };
      }
    }
  } catch (e) {
    console.warn(`[backrooms] entry read failed: ${e}`);
  }
  return overworldSpawn();
}

/** 死亡後のリスポーン先（8.4）。ベッドがあればそこ、無ければワールドスポーン */
function respawnTarget(player) {
  try {
    const point = player.getSpawnPoint();
    if (point && !LEVELS.includes(point.dimension.id)) {
      return { location: { x: point.x, y: point.y, z: point.z }, dimension: point.dimension };
    }
  } catch {
    /* 未設定。ワールドスポーンへ落ちる */
  }
  return overworldSpawn();
}

// ---- 到着先の確保（8.2）----

function arrivalOptions(dimension, x, z) {
  const cx = Math.floor(x);
  const cz = Math.floor(z);
  return {
    dimension,
    from: { x: cx - ARRIVAL_SPAN, y: 0, z: cz - ARRIVAL_SPAN },
    to: { x: cx + ARRIVAL_SPAN, y: ARRIVAL_TOP, z: cz + ARRIVAL_SPAN },
  };
}

/**
 * 到着先チャンクをロードしてから body() を実行する。
 * await を省略すると、まだブロックが書かれていない場所へ出て虚空に落ちる（15章）。
 */
async function withArrivalArea(dimension, x, z, body) {
  const options = arrivalOptions(dimension, x, z);
  if (!world.tickingAreaManager.hasCapacity(options)) {
    // 他アドオンが ticking area を使い切っている（Q-7 / 16.4）。
    // ここで諦めるのが正しい。ロードを待たずに飛ばすと虚空に落ちる
    throw new Error("ticking area capacity is full");
  }
  await world.tickingAreaManager.createTickingArea(ARRIVAL_AREA, options);
  try {
    body();
  } finally {
    try {
      world.tickingAreaManager.removeTickingArea(ARRIVAL_AREA);
    } catch (e) {
      console.warn(`[backrooms] ticking area remove failed: ${e}`);
    }
  }
}

/** 未生成ならジョブに回さず同期生成する（8.2）。初回入場では必ずここを通る */
function ensureGenerated(dimension, cx, cz) {
  try {
    // 生成済みなら何もしない。階層（generator.js / generator1.js）は forceGenerateCell が dimension.id で選ぶ
    forceGenerateCell(dimension, cx, cz, getSeed());
  } catch (e) {
    console.warn(`[backrooms] sync generate failed at ${cx},${cz}: ${e}`);
  }
}

/**
 * 着地する柱。指定の柱が壁の中なら、近い順に外周を広げて空いた柱を探す。
 * 生成後に呼ぶこと。見つからなければ指定の柱のまま（壁は素手で0.8秒で壊して出られる）
 */
function landingSpot(dimension, x, z) {
  const canStand = dimension.id === DIM1_ID ? standable1 : standable;
  for (let r = 0; r <= LANDING_SEARCH; r++) {
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue; // 内側は前の周で見た
        if (canStand(dimension, x + dx, z + dz)) return { x: x + dx, z: z + dz };
      }
    }
  }
  return { x, z };
}

/** 転送を直列に流す。ticking area の識別子が1つで足りるのはこれがあるため */
function queueTransfer(body) {
  const pending = transferChain.then(body, body);
  transferChain = pending.catch(() => {});
  return pending;
}

// ---- 侵入（8.1 / 8.2）----

/** 外（オーバーワールドなど）・Level 1 の上り階段から Level 0 の拠点へ */
export async function enterLevel0(player) {
  await queueTransfer(() => doEnter(player, DIM_ID));
}

/** Level 0 の穴から Level 1 の拠点へ（INTERFACES.md 9.3） */
export async function enterLevel1(player) {
  await queueTransfer(() => doEnter(player, DIM1_ID));
}

function fade(player) {
  try {
    player.camera.fade(FADE);
  } catch (e) {
    console.warn(`[backrooms] fade failed: ${e}`);
  }
}

/**
 * 階層 dimId の拠点へ暗転して入る（8.1 / 8.2）。
 * 戻り先は Backrooms の外から入るときだけ保存する。Level 0 と Level 1 の間の移動では上書きしない（9.3）
 */
async function doEnter(player, dimId) {
  const id = idOf(player);
  if (id === undefined) return;
  if (transit.has(id) || dimIdOf(player) === dimId) return;

  const home = HOMES[dimId];
  const dimension = world.getDimension(dimId); // 未登録ならここで投げる。呼び出し側が拾う
  // 枠が無いと分かっているのに暗転だけ浴びせない（踊り場に立っている間 0.5 秒ごとに暗転が続く = 最終レビュー 中-3）
  if (!world.tickingAreaManager.hasCapacity(arrivalOptions(dimension, home.cx * CELL, home.cz * CELL))) {
    throw new Error("ticking area capacity is full");
  }
  const from = dimIdOf(player);
  let aborted = false;
  transit.add(id);
  try {
    if (!isInBackrooms(player)) saveEntry(player);
    fade(player);
    // 暗転しきってから飛ばす（8.1）
    await system.waitTicks(FADE_HOLD_TICKS);

    // 範囲は拠点セルの原点を中心に from {-24,0,-24} / to {24,20,24}（8.2）
    await withArrivalArea(dimension, home.cx * CELL, home.cz * CELL, () => {
      // 拠点セルとその周囲 3x3。転送直後に周囲が虚空だと没入が壊れる（8.2）
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) ensureGenerated(dimension, home.cx + dx, home.cz + dz);
      }
      // 待っている間に死んで外へ戻った人を引き戻さない（最終レビュー 軽微-1）
      if (dimIdOf(player) !== from) {
        aborted = true;
        return;
      }
      player.teleport(home.spawn, { dimension });
      try {
        player.removeEffect("slow_falling"); // 穴から来た人の落下を遅くしていた効果（keepInBounds）
      } catch {
        /* 付いていなければ何もしない */
      }
    });
    if (aborted) return;

    applyFog(player, dimId);
    ensureHum(player);
  } finally {
    transit.delete(id);
  }
}

/** Level 0 内の指定座標へ飛ぶ（16.1 の任意座標テレポート）。到着セルを先に生成する */
export async function teleportInLevel0(player, x, z) {
  await queueTransfer(() => doTeleport(player, DIM_ID, x, z));
}

/** Level 1 内の指定座標へ飛ぶ（/backrooms:tp の Level 1 版・INTERFACES.md 9.3） */
export async function teleportInLevel1(player, x, z) {
  await queueTransfer(() => doTeleport(player, DIM1_ID, x, z));
}

/**
 * 階層 dimId の (x, z) へ飛ぶ。line を渡すと暗転してから飛び、着いたらアクションバーに出す（長く歩くとマニラルーム）
 */
async function doTeleport(player, dimId, x, z, line) {
  const id = idOf(player);
  if (id === undefined || transit.has(id)) return;

  const dimension = world.getDimension(dimId);
  const { cx, cz } = cellOf(x, z);
  transit.add(id);
  try {
    if (!isInBackrooms(player)) saveEntry(player); // 外から飛び込んだ場合の戻り先
    if (line) {
      fade(player);
      await system.waitTicks(FADE_HOLD_TICKS);
    }
    await withArrivalArea(dimension, x, z, () => {
      ensureGenerated(dimension, cx, cz);
      const spot = landingSpot(dimension, x, z);
      const y = dimId === DIM1_ID ? Y1_AIR_MIN : Y_AIR_MIN;
      player.teleport({ x: spot.x + 0.5, y, z: spot.z + 0.5 }, { dimension });
    });
    applyFog(player, dimId);
    ensureHum(player);
    if (line) player.onScreenDisplay.setActionBar(line);
  } finally {
    transit.delete(id);
  }
}

/**
 * Level 0 の外側（床の下の虚空・天井の上）に出たプレイヤーを、その柱の床の上へ戻す（5.2 / Q-10）。
 * 床も天井も壊せないので、ここに来るのは生成が追いつかず床の無いところへ踏み込んだときか、
 * コーラスフルーツで天井の上に着地したとき（着地先の候補の約半分が天井の上になる）。
 * クリエイティブとスペクテイターは意図して飛んでいるので触らない。
 * Level 0 の穴のセルで床の下に出た人は、救出より先に Level 1 へ落とす（INTERFACES.md 9.3。クリエイティブも落ちる）。
 * Level 1 では床の下と、そのセルの maxY1 より上（天井の上）を外とみなす。
 * 専用タイマーは作らず、scheduler.js のグローバルタイマーから呼ばれる（15章）。
 */
export function keepInBounds(player) {
  const id = idOf(player);
  if (id === undefined || rescuing.has(id) || transit.has(id)) return;

  let loc;
  let out;
  let dimId;
  try {
    const mode = player.getGameMode();
    if (mode === GameMode.Spectator) return;
    loc = player.location;
    dimId = player.dimension.id;
    const failed = pitFailedAt.get(id);
    if (dimId === DIM_ID && loc.y < Y_FLOOR && !(failed !== undefined && system.currentTick - failed < PIT_RETRY_TICKS)) {
      if (nearPit(loc.x, loc.z, getSeed())) {
        // 転送（暗転・ticking area・同期生成）の間に奈落（Y=-64）まで落ちないよう、見つけた周期のうちに落下を遅くする（最終レビュー 中-1）。
        // 落下の遅い間は落下距離も溜まらないので、着いたときの落下ダメージも出ない
        try {
          player.addEffect("slow_falling", 200, { showParticles: false });
        } catch {
          /* 効果が付かなくても転送は試す */
        }
        rescuingPit(id, player);
        return;
      }
    }
    if (mode === GameMode.Creative) return;
    if (dimId === DIM1_ID) {
      const { cx, cz } = cellOf(loc.x, loc.z);
      // maxY1 は正当に立てる足の高さ。跳んでも +1.25 なので、+1 を超えたら天井の中か上
      out = loc.y < Y1_FLOOR || loc.y > maxY1(cx, cz, getSeed()) + 1;
    } else {
      // その柱の一番上のブロックより足が上 = 天井の上（空の下）。巨大空間・階段は天井が高いので正しく内側になる
      const top = player.dimension.getTopmostBlock({ x: loc.x, z: loc.z });
      out = loc.y < Y_FLOOR || (top !== undefined && loc.y >= top.location.y + 1);
    }
  } catch {
    return;
  }
  if (!out) return;

  const move = dimId === DIM1_ID ? teleportInLevel1 : teleportInLevel0;
  rescue(id, move(player, Math.floor(loc.x), Math.floor(loc.z)), "rescue");
}

/** 穴の縁から何ブロック外まで「穴に落ちた」とみなすか。検出まで最大 10 tick で約 3 ブロック横へ流れる（最終レビュー 中-2） */
const PIT_MARGIN = 4;
/** プレイヤー id -> Level 1 へ送れなかった tick。しばらくは穴でも普通の救出に回す（最終レビュー 中-3） */
const pitFailedAt = new Map();
const PIT_RETRY_TICKS = 100;

/** 床の下の (x, z) が、Level 0 の穴の真下かその近くか。足元のセルだけでなく ±PIT_MARGIN が掛かるセルも見る */
function nearPit(x, z, seed) {
  const seen = new Set();
  for (const ox of [-PIT_MARGIN, 0, PIT_MARGIN]) {
    for (const oz of [-PIT_MARGIN, 0, PIT_MARGIN]) {
      const { cx, cz } = cellOf(x + ox, z + oz);
      const k = cx + "," + cz;
      if (seen.has(k)) continue;
      seen.add(k);
      const pit = pitAt(cx, cz, seed);
      if (!pit) continue;
      const x0 = cx * CELL + pit.bx;
      const z0 = cz * CELL + pit.bz;
      // 穴は 4x4 ブロック（x0..x0+3）
      if (x >= x0 - PIT_MARGIN && x < x0 + 4 + PIT_MARGIN && z >= z0 - PIT_MARGIN && z < z0 + 4 + PIT_MARGIN) return true;
    }
  }
  return false;
}

/** 穴から Level 1 へ。送れなかったら（Level 1 が未登録・ticking area の枠が満杯）しばらく普通の救出に回す（最終レビュー 中-3） */
function rescuingPit(id, player) {
  rescuing.add(id);
  enterLevel1(player)
    .catch((e) => {
      console.warn(`[backrooms] fall to level1 failed: ${e}`);
      pitFailedAt.set(id, system.currentTick);
    })
    .finally(() => rescuing.delete(id));
}

/** 転送の間は rescuing に入れておく。転送は直列キューなので、待つ間に次の周期が来ても積み増さない */
function rescue(id, pending, what) {
  rescuing.add(id);
  pending.catch((e) => console.warn(`[backrooms] ${what} failed: ${e}`)).finally(() => rescuing.delete(id));
}

/**
 * Level 1 の上り階段を上りきった人を、暗転して Level 0 の拠点へ（INTERFACES.md 9.3）。
 * 足のブロックが stairsUpAt1 の箱に入り、足元が踊り場の高さ以上なら。スペクテイターは送らない。
 * 戻り先（DP_ENTRY）は上書きしない（doEnter が Backrooms の中からの移動では保存しない）
 */
export function checkStairsUp(player) {
  const id = idOf(player);
  if (id === undefined || rescuing.has(id) || transit.has(id) || !isInLevel1(player)) return;
  let hit = false;
  try {
    if (player.getGameMode() === GameMode.Spectator) return;
    const x = Math.floor(player.location.x);
    const y = Math.floor(player.location.y + 0.01); // 立った足が 9.99999 のように報告されても踊り場に入る（最終レビュー 軽微-2）
    const z = Math.floor(player.location.z);
    const { cx, cz } = cellOf(x, z);
    const b = stairsUpAt1(cx, cz, getSeed());
    hit = b !== null && x >= b.x0 && x <= b.x1 && z >= b.z0 && z <= b.z1 && y >= b.y;
  } catch {
    return;
  }
  if (hit) rescue(id, enterLevel0(player), "stairs up");
}

// ---- 長く歩くとマニラルーム（INTERFACES.md 9.3・Wiki の Level 0 出口2）----

/** プレイヤー id -> 前の周期の位置 {x, z}。Level 0 を出たら消す */
const lastPos = new Map();

/** プレイヤー id -> 歩いた距離。動的プロパティへは WALK_SAVE_EVERY ブロックごとにだけ書く（毎周期書かない = 最終レビュー 軽微-7） */
const walkedOf = new Map();
/** 落ちたときに失うのは最大でこの距離（ブロック） */
const WALK_SAVE_EVERY = 32;

function readWalked(player) {
  const id = idOf(player);
  const cached = walkedOf.get(id);
  if (cached !== undefined) return cached;
  let v = 0;
  try {
    const raw = player.getDynamicProperty(DP_WALKED);
    if (typeof raw === "number" && Number.isFinite(raw)) v = raw;
  } catch {
    /* 読めなければ 0 から */
  }
  walkedOf.set(id, v);
  return v;
}

/** 歩いた距離（保存を間引いているので、動的プロパティより新しい）。自己点検とテストが読む */
export function walkedDistance(player) {
  return readWalked(player);
}

function writeWalked(player, v) {
  const id = idOf(player);
  const old = walkedOf.get(id) ?? 0;
  walkedOf.set(id, v);
  if (v !== 0 && Math.floor(v / WALK_SAVE_EVERY) === Math.floor(old / WALK_SAVE_EVERY)) return;
  try {
    player.setDynamicProperty(DP_WALKED, v);
  } catch (e) {
    console.warn(`[backrooms] walked save failed: ${e}`);
  }
}

/**
 * Level 0 にいるサバイバル・アドベンチャーの人の水平移動を周期ごとに足す。1周期で WALK_STEP_MAX を超える移動は
 * テレポートとみなして数えない。MANILA_WALK_BLOCKS を超えたら近くのマニラルームの中央へ暗転して移し、数を 0 に戻す
 * （近くに無ければ半分に戻して次の機会）。マニラルームの部屋に入ったときも 0 に戻す。
 * scheduler.js のグローバルタイマーから1人1回呼ばれる（15章）
 */
export function trackWalk(player) {
  const id = idOf(player);
  if (id === undefined || rescuing.has(id) || transit.has(id)) return;
  let loc;
  try {
    const mode = player.getGameMode();
    if (!isInLevel0(player) || (mode !== GameMode.Survival && mode !== GameMode.Adventure)) {
      lastPos.delete(id);
      return;
    }
    loc = player.location;
  } catch {
    return;
  }
  const seed = getSeed();
  const prev = lastPos.get(id);
  lastPos.set(id, { x: loc.x, z: loc.z });
  if (inManilaRoom(loc.x, loc.z, seed)) {
    walkedOf.set(id, 0);
    try {
      if (player.getDynamicProperty(DP_WALKED) !== 0) player.setDynamicProperty(DP_WALKED, 0);
    } catch {
      /* 次の周期にまた試す */
    }
    return;
  }
  if (!prev) return;
  const step = Math.hypot(loc.x - prev.x, loc.z - prev.z);
  if (step === 0 || step > WALK_STEP_MAX) return;

  const limit = TUNING.MANILA_WALK_BLOCKS;
  if (!(limit > 0)) return; // 0 で無効（数えない）
  const walked = readWalked(player) + step;
  if (walked <= limit) {
    writeWalked(player, walked);
    return;
  }
  const { cx, cz } = cellOf(loc.x, loc.z);
  const room = findLandmark(cx, cz, LM_MANILA, seed, WALK_SEARCH);
  if (!room) {
    writeWalked(player, walked / 2);
    return;
  }
  writeWalked(player, 0);
  lastPos.delete(id);
  // 部屋の中は セル内 4..11。(7, 7) の柱に下ろすと中央（7.5, 7.5）に立つ
  rescue(id, queueTransfer(() => doTeleport(player, DIM_ID, room.ox * CELL + 7, room.oz * CELL + 7, WALK_LINE)), "walk warp");
}

// ---- 脱出（8.3）----

/** 戻り先（Backrooms に入る前にいた場所）へ帰す。Level 1 の人にも効く（/backrooms:leave = INTERFACES.md 9.3） */
export function exitLevel0(player) {
  const id = idOf(player);
  if (id === undefined || transit.has(id)) return;
  transit.add(id);

  const target = readEntry(player);
  fade(player);

  system.runTimeout(() => {
    try {
      player.teleport(target.location, { dimension: target.dimension });
    } catch (e) {
      console.warn(`[backrooms] exit teleport failed: ${e}`);
    }
    // 失敗して Level 0 / Level 1 に残った場合は霧も音もそのまま。次の接触でもう一度試みる
    if (!isInBackrooms(player)) {
      removeFog(player);
      stopHum(id);
    }
    transit.delete(id);
  }, FADE_HOLD_TICKS);
}

/**
 * 出口ドアの接触判定（8.3 / Q-11）。
 * 接触を直接取る安定 API が無いため、足元と頭の高さの水平4近傍を見る。
 * 専用タイマーは作らず、scheduler.js のグローバルタイマーから呼ばれる（15章）。
 */
export function checkExitContact(player) {
  const id = idOf(player);
  if (id === undefined || transit.has(id) || !isInLevel0(player)) return false;

  let loc;
  let dimension;
  try {
    loc = player.location;
    dimension = player.dimension;
  } catch {
    return false;
  }

  const bx = Math.floor(loc.x);
  const by = Math.floor(loc.y);
  const bz = Math.floor(loc.z);
  for (let dy = 0; dy <= 1; dy++) {
    for (const [ox, oz] of NEIGHBORS) {
      let block;
      try {
        block = dimension.getBlock({ x: bx + ox, y: by + dy, z: bz + oz });
      } catch {
        continue;
      }
      if (block?.typeId !== B_EXIT) continue;
      exitLevel0(player);
      return true;
    }
  }
  return false;
}

/**
 * マニラルームに居続けると帰れる（Wiki の「長く留まると出られる」・INTERFACES.md 8.2）。
 * scheduler.js のグローバルタイマー（TICK_INTERVAL ごと）から1人1回呼ばれるので、呼ばれた回数で時間を数える。
 * 専用タイマーは作らない（15章）。スペクテイターは数えない。部屋を出たら数え直し
 */
export function checkManilaStay(player) {
  const id = idOf(player);
  if (id === undefined || transit.has(id) || !isInLevel0(player)) return;

  let inside = false;
  try {
    const loc = player.location;
    const y = Math.floor(loc.y);
    inside =
      player.getGameMode() !== GameMode.Spectator &&
      y >= Y_AIR_MIN &&
      y <= Y_AIR_MAX &&
      inManilaRoom(loc.x, loc.z, getSeed());
  } catch {
    inside = false;
  }
  if (!inside) {
    manilaStay.delete(id);
    return;
  }

  const before = manilaStay.get(id) ?? 0;
  const now = before + TICK_INTERVAL;
  const total = TUNING.MANILA_STAY_SECONDS * 20;
  if (now >= total) {
    manilaStay.delete(id);
    exitLevel0(player);
    return;
  }
  manilaStay.set(id, now);
  MANILA_LINES.forEach((line, i) => {
    const at = (total * (i + 1)) / (MANILA_LINES.length + 1);
    if (before >= at || now < at) return;
    try {
      player.onScreenDisplay.setActionBar(line);
    } catch {
      /* 退出済み。数えた分は Level 0 を出たとき・次に部屋の外で呼ばれたときに消える */
    }
  });
}

// ---- ノークリップアイテム（8.1 / Q-15）----

function inventoryOf(player) {
  try {
    return player.getComponent("minecraft:inventory")?.container;
  } catch {
    return undefined;
  }
}

/**
 * ノークリップを1個消費する。消費しないと1個で無限に入れてしまう（Q-15）。
 * 手に持っているスロットを見て、そこに無ければインベントリ全体から探す。
 */
function consumeNoclip(player, slot) {
  const container = inventoryOf(player);
  if (!container) return false;
  try {
    let target = slot;
    let item = container.getItem(target);
    if (item?.typeId !== I_NOCLIP) {
      target = -1;
      for (let i = 0; i < container.size; i++) {
        const candidate = container.getItem(i);
        if (candidate?.typeId === I_NOCLIP) {
          target = i;
          item = candidate;
          break;
        }
      }
      if (target < 0) return false;
    }
    if (item.amount > 1) {
      item.amount -= 1;
      container.setItem(target, item);
    } else {
      container.setItem(target, undefined);
    }
    return true;
  } catch (e) {
    console.warn(`[backrooms] noclip consume failed: ${e}`);
    return false;
  }
}

/** 入場に失敗したときの返却。インフラ都合で素材を失わせない */
function refundNoclip(player) {
  const container = inventoryOf(player);
  if (!container) return;
  try {
    container.addItem(new ItemStack(I_NOCLIP, 1));
  } catch (e) {
    console.warn(`[backrooms] noclip refund failed: ${e}`);
  }
}

// ---- イベント購読 ----

export function registerPortalEvents() {
  if (eventsBound) return;
  eventsBound = true;

  // 侵入（8.1 / Q-15）
  world.afterEvents.itemUse.subscribe((event) => {
    if (event.itemStack?.typeId !== I_NOCLIP) return;
    const player = event.source;
    // 既に Level 0 / Level 1 にいる／転送中なら何もしない。使っても入れないのに消費させない（9.3）
    if (isInBackrooms(player) || transit.has(idOf(player))) return;
    if (!consumeNoclip(player, player.selectedSlotIndex)) return;
    enterLevel0(player).catch((e) => {
      console.warn(`[backrooms] enter failed: ${e}`);
      refundNoclip(player);
      try {
        player.sendMessage("今は入れない。しばらくしてからもう一度使う");
      } catch {
        /* 退出済み */
      }
    });
  });

  // 地図（9.3・Wiki の「コンパスや GPS の計測値が変化する」）。Level 0 / Level 1 では白紙の地図を使えない
  world.beforeEvents.itemUse.subscribe((event) => {
    if (event.itemStack?.typeId !== EMPTY_MAP) return;
    const player = event.source;
    if (!isInBackrooms(player)) return;
    event.cancel = true;
    system.run(() => {
      try {
        player.onScreenDisplay.setActionBar(MAP_LINE);
      } catch {
        /* 退出済み */
      }
    });
  });

  // フォグと環境音（9.1 / 9.2）。Level 0 と Level 1 の間の移動では外さず、霧だけ階層のものに差し替える（9.3）
  world.afterEvents.playerDimensionChange.subscribe((event) => {
    const player = event.player;
    const to = event.toDimension.id;
    if (to !== DIM_ID) {
      manilaStay.delete(idOf(player));
      lastPos.delete(idOf(player));
    }
    if (LEVELS.includes(to)) {
      applyFog(player, to);
      ensureHum(player);
      return;
    }
    // Backrooms の外に出た。フォグはセーブをまたいで永続するので必ず落とす
    removeFog(player);
    stopHum(idOf(player));
  });

  // 参加・リスポーン（8.4 / 9.1 / 11章）
  world.afterEvents.playerSpawn.subscribe((event) => {
    const player = event.player;
    const initial = event.initialSpawn;
    system.run(() => {
      if (!isInBackrooms(player)) {
        // 再参加時の取りこぼし対策。Level 0 / Level 1 の外なら必ず remove を試行する（11章）
        removeFog(player);
        stopHum(idOf(player));
        return;
      }
      if (initial) {
        // Level 0 / Level 1 にいる状態でワールドを開き直した。演出をかけ直す
        applyFog(player);
        ensureHum(player);
        return;
      }
      // 死亡後のリスポーン。Level 0 内では復活させない（8.4）。
      // setSpawnPoint でカスタムディメンションを指定することは一切しない
      sendOutOfLevel0(player);
    });
  });

  // 死亡（8.4 / FR-18）
  world.afterEvents.entityDie.subscribe((event) => {
    const entity = event.deadEntity;
    if (entity?.typeId !== PLAYER_TYPE) return;
    let inside = false;
    try {
      inside = LEVELS.includes(entity.dimension.id);
    } catch {
      return;
    }
    if (!inside) return;
    removeFog(entity);
    stopHum(idOf(entity));
    manilaStay.delete(idOf(entity));
    lastPos.delete(idOf(entity));
  });

  // バニラのモンスター（仕様書1章「エンティティは使わない」/ README 7節）。
  // ディメンションは plains バイオームで、暗区画・階段の吹き抜け・夜の天井の上は湧きうる暗さになる。
  // 自然湧きしたらその場で消す。湧かなければ何もしない。遺留品のアーマースタンドはモンスターではないので残る。
  // コウモリはモンスターではないが、羽音と鳴き声が 15章の禁じる突発音に当たるので一緒に消す
  world.afterEvents.entitySpawn.subscribe((event) => {
    if (event.cause !== EntityInitializationCause.Spawned) return;
    const entity = event.entity;
    try {
      if (!LEVELS.includes(entity.dimension.id)) return;
      if (entity.typeId !== BAT_TYPE && !entity.matches({ families: ["monster"] })) return;
      entity.remove();
    } catch {
      /* 湧いた直後に消えていた。何もしなくてよい */
    }
  });

  // ベッドのキャンセル（FR-21 / 6.8）と出口ドアの右クリック（8.3 の取りこぼし対策）
  world.beforeEvents.playerInteractWithBlock.subscribe((event) => {
    let dimensionId;
    try {
      dimensionId = event.player.dimension.id;
    } catch {
      return;
    }
    if (!LEVELS.includes(dimensionId)) return;

    const typeId = event.block.typeId;
    // 判定はディメンション単位。持ち込んだベッドも同じ扱いになる。
    // エラーメッセージは出さない。何も起きないだけでよい（6.8）
    if (typeId === "minecraft:bed" || typeId.endsWith("_bed")) {
      event.cancel = true;
      return;
    }
    // ブロックを狙って白紙の地図を使うと itemUse でなくこちらに来ることがある（最終レビュー 中-5）
    if (event.itemStack?.typeId === EMPTY_MAP) {
      event.cancel = true;
      const player = event.player;
      system.run(() => {
        try {
          player.onScreenDisplay.setActionBar(MAP_LINE);
        } catch {
          /* 退出済み */
        }
      });
      return;
    }
    if (typeId === B_EXIT) {
      const player = event.player;
      system.run(() => exitLevel0(player)); // before イベント内で世界をいじらない
    }
  });
}

/** Level 0 からオーバーワールドの通常リスポーン地点へ戻す（8.4） */
function sendOutOfLevel0(player) {
  const target = respawnTarget(player);
  try {
    player.teleport(target.location, { dimension: target.dimension });
  } catch (e) {
    console.warn(`[backrooms] respawn rescue failed: ${e}`);
  }
  removeFog(player);
  stopHum(idOf(player));
}

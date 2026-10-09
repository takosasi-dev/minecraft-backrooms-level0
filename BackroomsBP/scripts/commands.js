/**
 * 開発用コマンド（仕様書 FR-20 / 16.1）
 *
 * 登録は system.beforeEvents.startup の customCommandRegistry でのみ行える。
 * コールバックの中からワールドを直接いじるとエラーになることがあるため、
 * 実処理はすべて system.run() に逃がしてある。
 *
 * 表示制約: チャットに出す文字列は日本語と ASCII のみ。
 * 装飾記号（矢印・罫線・チェック等）は豆腐になるので使わない。
 */

import {
  CommandPermissionLevel,
  CustomCommandParamType,
  CustomCommandStatus,
  system,
} from "@minecraft/server";
import {
  TUNING,
  setTuning,
  DIM1_ID,
  LM_ATRIUM,
  LM_DARK,
  LM_WATER,
  LM_STAIRS,
  LM_CORRIDOR,
  LM_PILLARS,
  LM_ROOMS,
  LM_MANILA,
  LM_PIT,
  RELIC_CAMP,
  RELIC_CHEST,
  RELIC_SIGN,
  RELIC_GEAR,
  RELIC_OFFICE,
  RELIC_DIARY,
  RELIC_GRAFFITI,
} from "./config.js";
import { getSeed } from "./rng.js";
import { cellOf, describeCell, invalidateCache } from "./layout.js";
import { describeCell1 } from "./layout1.js";
import { clearCellJob, generateCellJob } from "./generator.js";
import { clearCellJob1, generateCellJob1 } from "./generator1.js";
import { getStatus } from "./scheduler.js";
import {
  enterLevel0,
  exitLevel0,
  isInBackrooms,
  isInLevel0,
  isInLevel1,
  teleportInLevel0,
  teleportInLevel1,
} from "./portal.js";
import { runSelfTest } from "./selftest.js";

const PLAYER_TYPE = "minecraft:player";
/** 範囲再生成の半径上限。9x9 セルを超えるとジョブが長すぎて調整に使えない */
const REGEN_RADIUS_MAX = 4;

const LM_NAME = {
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

const RELIC_NAME = {
  [RELIC_CAMP]: "キャンプ跡",
  [RELIC_CHEST]: "物資チェスト",
  [RELIC_SIGN]: "看板",
  [RELIC_GEAR]: "装備",
  [RELIC_OFFICE]: "事務机と椅子",
  [RELIC_DIARY]: "手記",
  [RELIC_GRAFFITI]: "壁の落書き",
};

export function registerCommands(startupEvent) {
  const registry = startupEvent.customCommandRegistry;

  // ---- 侵入（8.1 のデバッグ経路）----
  registry.registerCommand(
    {
      name: "backrooms:enter",
      description: "Level 0 へ入る。デバッグ用でノークリップは消費しない",
      permissionLevel: CommandPermissionLevel.Any,
      // 閉じ込め事故の経路を増やさないため、enter と leave はチート不要で常に使える
      cheatsRequired: false,
    },
    (origin) => {
      const player = playerOf(origin);
      if (!player) return failure("プレイヤーから実行してください");
      system.run(() => {
        enterLevel0(player).catch((e) => {
          console.warn(`[backrooms] command enter failed: ${e}`);
          tell(player, "今は入れない。しばらくしてからもう一度試す");
        });
      });
      return success();
    },
  );

  // ---- 強制帰還（8.3。閉じ込め事故の最終手段なので必ず使える状態にしておく）----
  registry.registerCommand(
    {
      name: "backrooms:leave",
      description: "Level 0 から強制的に帰還する。閉じ込められたときの最終手段",
      permissionLevel: CommandPermissionLevel.Any,
      cheatsRequired: false,
    },
    (origin) => {
      const player = playerOf(origin);
      if (!player) return failure("プレイヤーから実行してください");
      if (!isInBackrooms(player)) return failure("Level 0 にも Level 1 にもいません");
      system.run(() => exitLevel0(player));
      return success("帰還します");
    },
  );

  // ---- 範囲再生成（16.1 / 9.4 で Level 1 にも対応）----
  registry.registerCommand(
    {
      name: "backrooms:regen",
      description:
        "現在地を中心に指定半径のセルを床より上だけ air で消去してから作り直す。プレイヤーが置いたブロックも消える。既定の半径は1",
      permissionLevel: CommandPermissionLevel.GameDirectors,
      optionalParameters: [{ name: "radius", type: CustomCommandParamType.Integer }],
    },
    (origin, radius) => {
      const player = playerOf(origin);
      if (!player) return failure("プレイヤーから実行してください");
      if (!isInBackrooms(player)) return failure("Level 0 か Level 1 の中で実行してください");

      const level1 = isInLevel1(player);
      const r = clampInt(radius, 0, REGEN_RADIUS_MAX, 1);
      const here = cellOf(player.location.x, player.location.z);
      system.run(() => {
        // ジョブは1本にまとめる。セルごとに runJob を撒くと担当Cのキューと競合する
        system.runJob(regenJob(player.dimension, here.cx, here.cz, r, getSeed(), level1));
      });
      const side = r * 2 + 1;
      return success(`セル ${here.cx},${here.cz} を中心に ${side} x ${side} セルを作り直します`);
    },
  );

  // ---- 任意座標テレポート（16.1 / 9.4 で Level 1 にも対応）----
  registry.registerCommand(
    {
      name: "backrooms:tp",
      description: "Level 0 / Level 1 内の指定座標へ飛ぶ。到着先のセルは先に生成する",
      permissionLevel: CommandPermissionLevel.GameDirectors,
      mandatoryParameters: [
        { name: "x", type: CustomCommandParamType.Integer },
        { name: "z", type: CustomCommandParamType.Integer },
      ],
    },
    (origin, x, z) => {
      const player = playerOf(origin);
      if (!player) return failure("プレイヤーから実行してください");
      const tx = Math.trunc(Number(x));
      const tz = Math.trunc(Number(z));
      if (!Number.isFinite(tx) || !Number.isFinite(tz)) return failure("座標が読めません");
      system.run(() => {
        const go = isInLevel1(player) ? teleportInLevel1(player, tx, tz) : teleportInLevel0(player, tx, tz);
        go.catch((e) => {
          console.warn(`[backrooms] command tp failed: ${e}`);
          tell(player, "今は飛べない。しばらくしてからもう一度試す");
        });
      });
      return success(`x=${tx} z=${tz} へ飛びます`);
    },
  );

  // ---- 自己点検（9.4）----
  registry.registerCommand(
    {
      name: "backrooms:selftest",
      description: "実機でしか確かめられない項目を、できるだけ自動でチャットとコンテンツログへ出す",
      permissionLevel: CommandPermissionLevel.GameDirectors,
    },
    (origin) => {
      const player = playerOf(origin);
      if (!player) return failure("プレイヤーから実行してください");
      system.run(() => {
        runSelfTest(player).catch((e) => {
          console.warn(`[backrooms] selftest failed: ${e}`);
          tell(player, "自己点検の実行中にエラーが発生した");
        });
      });
      return success();
    },
  );

  // ---- 出現率の実行時変更（16.1）----
  registry.registerCommand(
    {
      name: "backrooms:rate",
      description:
        "調整定数をその場で書き換える。リロードで既定値に戻るので、確定した値はソースの定数へ反映すること。既存の生成済み領域には反映されないため backrooms:regen とセットで使う",
      permissionLevel: CommandPermissionLevel.GameDirectors,
      mandatoryParameters: [
        { name: "key", type: CustomCommandParamType.String },
        { name: "value", type: CustomCommandParamType.Integer },
      ],
    },
    (origin, key, value) => {
      const name = String(key);
      if (!(name in TUNING)) {
        return failure(`不明なキー ${name}. 使えるキー: ${Object.keys(TUNING).join(", ")}`);
      }
      const v = Math.trunc(Number(value));
      if (!Number.isFinite(v)) return failure("値が読めません");
      system.run(() => {
        setTuning(name, v);
        invalidateCache(); // 定数を変えたらレイアウトのキャッシュを捨てる（16.1）
      });
      return success(`${name} = ${v} に変更しました。既存の領域は backrooms:regen で作り直してください`);
    },
  );

  // ---- 生成状態のダンプ（16.1）----
  registry.registerCommand(
    {
      name: "backrooms:dump",
      description: "現在セルの生成情報と、生成キューおよび実行中ジョブの状態をチャットに出す",
      permissionLevel: CommandPermissionLevel.GameDirectors,
    },
    (origin) => {
      const player = playerOf(origin);
      if (!player) return failure("プレイヤーから実行してください");
      system.run(() => dump(player));
      return success();
    },
  );
}

// ---- 実処理 ----

/**
 * 範囲再生成のジョブ。
 * 先に範囲全体を消してから作り直す。1セルずつ消しては作ると、
 * 占有範囲が隣のセルにまたがるランドマークを後から消してしまう。
 * level1 が真なら Level 1 の generator1.js を使う（9.4）。
 */
function* regenJob(dimension, cx, cz, radius, seed, level1) {
  const clearJob = level1 ? clearCellJob1 : clearCellJob;
  const genJob = level1 ? generateCellJob1 : generateCellJob;
  for (let dz = -radius; dz <= radius; dz++) {
    for (let dx = -radius; dx <= radius; dx++) {
      yield* clearJob(dimension, cx + dx, cz + dz);
    }
  }
  for (let dz = -radius; dz <= radius; dz++) {
    for (let dx = -radius; dx <= radius; dx++) {
      try {
        yield* genJob(dimension, cx + dx, cz + dz, seed);
      } catch (e) {
        // 1セルの失敗でジョブごと止めない。床と判定点は残してあるので、止まると
        // 残りのセルが消えたまま「生成済み」扱いになり、スケジューラも作り直さない
        console.warn(`[backrooms] regen failed at ${cx + dx},${cz + dz}: ${e}`);
      }
    }
  }
}

function dump(player) {
  let loc;
  let dimensionId;
  try {
    loc = player.location;
    dimensionId = player.dimension.id;
  } catch {
    return;
  }

  const seed = getSeed();
  const here = cellOf(loc.x, loc.z);
  const status = safeStatus();

  if (dimensionId === DIM1_ID) {
    const lines = [
      "backrooms dump (Level 1)",
      `座標 x=${Math.floor(loc.x)} y=${Math.floor(loc.y)} z=${Math.floor(loc.z)}`,
      `ディメンション ${dimensionId}`,
      `セル ${here.cx},${here.cz}`,
      ...describeCell1(here.cx, here.cz, seed),
      `生成キュー ${status.queueLength}  ジョブ ${status.jobRunning ? "実行中" : "停止"}  対象 ${status.currentCell ?? "なし"}`,
      `seed ${seed}`,
    ];
    tell(player, lines.join("\n"));
    return;
  }

  const cell = describeCell(here.cx, here.cz, seed);

  const landmark = cell.landmark
    ? `${LM_NAME[cell.landmark.kind] ?? cell.landmark.kind} 原点 ${cell.landmark.ox},${cell.landmark.oz} ` +
      `${cell.landmark.w}x${cell.landmark.h}`
    : "なし";
  const exit = cell.exit
    ? `bx=${cell.exit.bx} bz=${cell.exit.bz}${cell.exit.home ? " 拠点" : ""}`
    : "なし";
  const relic = cell.relic
    ? `${RELIC_NAME[cell.relic.kind] ?? cell.relic.kind} bx=${cell.relic.bx} bz=${cell.relic.bz}`
    : "なし";

  const lines = [
    "backrooms dump",
    `座標 x=${Math.floor(loc.x)} y=${Math.floor(loc.y)} z=${Math.floor(loc.z)}`,
    `ディメンション ${dimensionId}`,
    `セル ${here.cx},${here.cz}  種別 ${cell.variant}`,
    `壁被覆率 ${cell.coverage}%  蛍光灯 ${cell.lights}個`,
    `ランドマーク ${landmark}`,
    `出口ドア ${exit}`,
    `遺留品 ${relic}`,
    `生成キュー ${status.queueLength}  ジョブ ${status.jobRunning ? "実行中" : "停止"}  対象 ${status.currentCell ?? "なし"}`,
    `seed ${seed}`,
  ];
  tell(player, lines.join("\n"));
}

function safeStatus() {
  try {
    return getStatus() ?? { queueLength: 0, jobRunning: false, currentCell: null };
  } catch {
    return { queueLength: 0, jobRunning: false, currentCell: null };
  }
}

// ---- 小物 ----

function playerOf(origin) {
  const entity = origin?.sourceEntity;
  if (!entity) return undefined;
  try {
    return entity.typeId === PLAYER_TYPE ? entity : undefined;
  } catch {
    return undefined;
  }
}

function clampInt(value, min, max, fallback) {
  const n = Math.trunc(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function tell(player, message) {
  try {
    player.sendMessage(message);
  } catch {
    /* 退出済み */
  }
}

function success(message) {
  return message === undefined
    ? { status: CustomCommandStatus.Success }
    : { status: CustomCommandStatus.Success, message };
}

function failure(message) {
  return { status: CustomCommandStatus.Failure, message };
}

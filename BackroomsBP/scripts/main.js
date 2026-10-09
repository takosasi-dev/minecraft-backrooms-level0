/**
 * エントリポイント（仕様書 4.2 / 7.1 / 9.x / 16.1）
 *
 * ここでやることは3つだけ:
 *   1. 起動フェーズでディメンションとコマンドを登録する
 *   2. ワールドが読み込まれたらイベント購読を張る
 *   3. タイマーを2本（生成用・環境音用）起動する
 *
 * ブロックを置く処理も、レイアウトを決める処理もここには書かない。
 */

import { system, world } from "@minecraft/server";
import { DIM_ID, DIM1_ID } from "./config.js";
import { registerCommands } from "./commands.js";
import { startScheduler } from "./scheduler.js";
import { registerPortalEvents, startAmbience } from "./portal.js";
import { registerAlmondWater } from "./relics.js";

// ---- 起動フェーズ（4.2 / 16.1）----
// registerCustomDimension は system.beforeEvents.startup の中でしか呼べない。
// 起動フェーズ以外で呼ぶと CustomDimensionInvalidRegistryError。
system.beforeEvents.startup.subscribe((event) => {
  // ディメンション登録。JSON 定義（BP/dimension/level0.json）だけで登録が完結するかは
  // 実機でしか確定できない（仕様書 Q-1）ため、スクリプト側でも登録して二重に担保する。
  // JSON 側で既に登録済みなら CustomDimensionAlreadyRegisteredError が飛ぶ。それは正常。
  // v0.5.0 で Level 1（BP/dimension/level1.json）が増えた。同じ扱い
  for (const id of [DIM_ID, DIM1_ID]) {
    try {
      event.dimensionRegistry.registerCustomDimension(id);
      console.warn(`[backrooms] dimension ${id} registered by script`);
    } catch (e) {
      // JSON 定義が効いている場合はここに来る。Q-1 の答えがログに残る
      console.warn(`[backrooms] registerCustomDimension ${id} skipped: ${e}`);
    }
  }

  registerCommands(event);
});

// ---- ワールド読み込み後 ----
world.afterEvents.worldLoad.subscribe(() => {
  registerPortalEvents();
  registerAlmondWater(); // アーモンドウォーターの効き目（INTERFACES.md 8.4）
  startScheduler(); // runInterval 1本目（生成トリガ）
  startAmbience(); // runInterval 2本目（環境音）
  // タイマーはこの2本が上限。セル単位・プレイヤー単位のタイマーを増やさないこと（15章 / 10章）
  console.warn("[backrooms] level0 addon ready");
});

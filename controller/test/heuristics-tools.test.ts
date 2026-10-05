import test from 'node:test';
import assert from 'node:assert/strict';
import durability, { planFor } from '../../heuristics/tool-durability.ts';
import stationKit, { KEEP } from '../../heuristics/station-kit.ts';
import type { Ctx, Observation } from '../types.ts';

const ctx: Ctx = {config: {}, notes: {places: []}, log() {}, now: Date.now};
const sword = {slot: 8, id: 'minecraft:diamond_sword', left: 312, max: 1561, pct: 20, enchanted: true, enchantments: ['minecraft:sharpness 3'], repairWith: ['minecraft:diamond'], repairCost: 3};
const obs: Observation = {tools: [sword], player: {xpLevel: 2}, ownBlocksNearby: [[10, 64, -3, 'minecraft:anvil']]};

test('an enchanted diamond sword at 20% plans own-anvil repair, material and XP', () => {
  const hint = planFor(sword, {observation: obs, notes: ctx.notes});
  assert.ok(hint);
  assert.match(hint, /REPAIR minecraft:diamond_sword \(312\/1561\)/);
  assert.match(hint, /an anvil you own at 10 64 -3/);
  assert.match(hint, /Repair material: 4 units \(minecraft:diamond\)/);
  assert.match(hint, /Estimated XP: 7 levels.*have 2/);
  assert.match(hint, /gain XP first: mine coal\/redstone\/lapis\/quartz ore, smelt items, or kill mobs/);
  assert.match(hint, /call repair_tool/);
  assert.doesNotMatch(hint, /craft an anvil|stop using it/);
  assert.deepEqual(durability.onObservation!(obs, ctx), [hint]);
});

test('no own anvil requests crafting one; remembered and damaged own anvils qualify', () => {
  const noAnvil: Observation = {...obs, ownBlocksNearby: []};
  const hint = planFor(sword, {observation: noAnvil, notes: ctx.notes});
  assert.ok(hint);
  assert.match(hint, /craft an anvil \(3 iron blocks \+ 4 iron ingots = 31 iron ingots\) and place it near home/);
  const remembered = planFor(sword, {observation: noAnvil, notes: {places: [{kind: 'anvil', pos: [1, 70, 2]}]}});
  assert.ok(remembered);
  assert.match(remembered, /an anvil you own at 1 70 2/);
  assert.doesNotMatch(remembered, /craft an anvil/);
  for (const id of ['minecraft:chipped_anvil', 'minecraft:damaged_anvil']) {
    const owned = planFor(sword, {observation: {...obs, ownBlocksNearby: [[3, 64, 4, id]]}, notes: ctx.notes});
    assert.ok(owned);
    assert.match(owned, /an anvil you own at 3 64 4/);
  }
  const unowned = planFor(sword, {observation: noAnvil, notes: {places: [{kind: 'station', pos: [1, 70, 2], id: 'minecraft:anvil'}]}});
  assert.ok(unowned);
  assert.match(unowned, /craft an anvil/);
});

test('a stone pickaxe at 7% needs an immediate replacement, not repair', () => {
  const pickaxe = {...sword, id: 'minecraft:stone_pickaxe', left: 9, max: 131, pct: 7, enchanted: false, enchantments: [], repairWith: ['minecraft:cobblestone']};
  const hint = planFor(pickaxe, {observation: obs, notes: ctx.notes});
  assert.ok(hint);
  assert.match(hint, /REPLACE minecraft:stone_pickaxe \(9\/131\)/);
  assert.match(hint, /craft the replacement immediately/);
  assert.match(hint, /keep using the old one until then/);
  assert.doesNotMatch(hint, /REPAIR|repair_tool/);
});

test('low-use thresholds, valuable materials, critical repair and unknown XP are respected', () => {
  const lowUses = {...sword, left: 15, max: 40, pct: 38, enchanted: false, enchantments: []};
  assert.match(planFor(lowUses, {observation: obs, notes: ctx.notes})!, /REPAIR/);
  const critical = planFor({...sword, left: 5, max: 20, pct: 25}, {observation: {}, notes: ctx.notes});
  assert.ok(critical);
  assert.match(critical, /stop using it until repaired; switch to another tool/);
  assert.match(critical, /Estimated XP: 6 levels/);
  assert.match(critical, /current XP unknown: check player XP first/);
  assert.doesNotMatch(critical, /gain XP first/);
  assert.match(planFor({...sword, repairWith: []}, {observation: obs, notes: ctx.notes})!, /REPLACE/);
  const enoughXp = planFor(sword, {observation: {...obs, player: {xpLevel: 7}}, notes: ctx.notes});
  assert.ok(enoughXp);
  assert.doesNotMatch(enoughXp, /gain XP first/);
});

test('healthy tools and unavailable or malformed observations do not produce hints', () => {
  const healthy = {...sword, left: 1500, pct: 96};
  assert.equal(planFor(healthy, {observation: obs, notes: ctx.notes}), null);
  assert.equal(durability.onObservation!({...obs, tools: [healthy]}, ctx), undefined);
  for (const tools of [undefined, null, {}, [null, {}, {id: 'minecraft:stone_pickaxe', left: 5, max: 0, pct: 0}, {...sword, pct: NaN}]]) {
    assert.equal(durability.onObservation!({tools}, ctx), undefined);
  }
  const malformed = planFor(sword, {observation: {ownBlocksNearby: [null, ['bad', 64, 2, 'minecraft:anvil']], player: {xpLevel: '2'}}, notes: {places: [null, {kind: 'anvil', pos: ['bad', 64, 2]}]}});
  assert.ok(malformed);
  assert.match(malformed, /craft an anvil/);
});

test('at most four plans are emitted in urgency order, without mutating observation tools', () => {
  const tools = [20, 8, 25, 3, 10, 15].map(pct => ({...sword, pct, left: pct * 10, id: `minecraft:diamond_tool_${pct}`}));
  const order = tools.map(tool => tool.pct);
  const hints = durability.onObservation!({...obs, tools}, ctx);
  assert.ok(hints);
  assert.equal(hints.length, 4);
  assert.deepEqual(hints.map(hint => /REPAIR minecraft:diamond_tool_(\d+)/.exec(hint)?.[1]), ['3', '8', '10', '15']);
  assert.deepEqual(tools.map(tool => tool.pct), order);
});

test('station-kit requests both missing stations and becomes silent once the kit is carried', () => {
  assert.equal(KEEP['minecraft:crafting_table'], 1);
  assert.equal(KEEP['minecraft:furnace'], 1);
  const missing = stationKit.onObservation!({inventory: {counts: {}}}, ctx);
  assert.ok(missing);
  assert.equal(missing.length, 2);
  assert.match(missing.join('\n'), /craft a crafting table \(4 planks\) and keep it/);
  assert.match(missing.join('\n'), /craft a furnace \(8 cobblestone\) and keep it/);
  assert.match(missing.join('\n'), /pick it back up automatically/);
  assert.equal(stationKit.onObservation!({inventory: {counts: {...KEEP}}}, ctx), undefined);
  const furnaceOnly = stationKit.onObservation!({inventory: {counts: {'minecraft:crafting_table': 1}}}, ctx);
  assert.ok(furnaceOnly);
  assert.equal(furnaceOnly.length, 1);
  assert.match(furnaceOnly[0]!, /craft a furnace/);
  for (const inventory of [undefined, null, {}, {counts: null}, {counts: []}]) {
    assert.equal(stationKit.onObservation!({inventory}, ctx), undefined);
  }
});

test('station-kit vetoes depositing or dropping the last station, but permits an extra', () => {
  for (const name of ['chest_deposit', 'drop']) {
    for (const item of Object.keys(KEEP)) {
      const call = {name, args: {item, count: 1}};
      const last = stationKit.onPlanProposed!(call, {inventory: {counts: {[item]: 1}}, goals: ['drop the station']}, ctx);
      assert.ok(last && 'veto' in last);
      assert.equal(last.veto, `${item} is reserved (station-kit heuristic): keep 1 in the inventory`);
      assert.equal(stationKit.onPlanProposed!(call, {inventory: {counts: {[item]: 2}}}, ctx), undefined);
      const all = stationKit.onPlanProposed!({...call, args: {item, count: 2}}, {inventory: {counts: {[item]: 2}}}, ctx);
      assert.ok(all && 'veto' in all);
    }
  }
  const bare = stationKit.onPlanProposed!({name: 'drop', args: {item: 'crafting_table', count: 1}}, {inventory: {counts: {...KEEP}}}, ctx);
  assert.ok(bare && 'veto' in bare);
  const unknown = stationKit.onPlanProposed!({name: 'chest_deposit', args: {item: 'minecraft:furnace', count: 1}}, {}, ctx);
  assert.ok(unknown && 'veto' in unknown);
  assert.equal(stationKit.onPlanProposed!({name: 'drop', args: {item: 'minecraft:cobblestone', count: 64}}, {}, ctx), undefined);
  assert.equal(stationKit.onPlanProposed!({name: 'place_block', args: {item: 'minecraft:crafting_table', count: 1}}, {inventory: {counts: {...KEEP}}}, ctx), undefined);
});

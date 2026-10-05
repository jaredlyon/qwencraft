import test from 'node:test';
import assert from 'node:assert/strict';
import heuristic from '../../heuristics/inventory-chests.ts';
import type { Ctx, Observation } from '../types.ts';

const ctx = (places: unknown[] = []): Ctx => ({config: {}, notes: {home: null, zones: [], places}, log() {}, now: Date.now});
const obs = (freeSlots: number, extra: Observation = {}): Observation => ({inventory: {counts: {'minecraft:cobblestone': 128, 'minecraft:iron_pickaxe': 1}, freeSlots}, ownBlocksNearby: [], goals: ['mine iron'], ...extra});

test('a nearly full inventory steers to an owned chest, never to other players\' chests', () => {
  assert.equal(heuristic.onObservation!(obs(5), ctx()), undefined);
  const placed = heuristic.onObservation!(obs(2, {ownBlocksNearby: [[10, 64, -3, 'minecraft:chest'], [11, 64, -3, 'minecraft:cobblestone']]}), ctx([{name: 'base', kind: 'chest', note: '', pos: [0, 70, 0], dimension: null, at: 1}]));
  assert.ok(placed);
  assert.match(placed.join('\n'), /2 free slots/);
  assert.match(placed.join('\n'), /10 64 -3 \| 0 70 0/);
  assert.match(placed.join('\n'), /minecraft:cobblestone/);
  const none = heuristic.onObservation!(obs(0), ctx());
  assert.ok(none);
  assert.match(none.join('\n'), /craft a chest \(8 planks\)/);
});

test('drop is vetoed unless the operator goal asks for a drop', () => {
  const call = {name: 'drop', args: {item: 'minecraft:cobblestone', count: 64}};
  const verdict = heuristic.onPlanProposed!(call, obs(0), ctx());
  assert.ok(verdict && 'veto' in verdict);
  assert.equal(heuristic.onPlanProposed!(call, obs(0, {goals: ['drop the dirt here']}), ctx()), undefined);
  assert.equal(heuristic.onPlanProposed!({name: 'chest_deposit', args: {}}, obs(0), ctx()), undefined);
});

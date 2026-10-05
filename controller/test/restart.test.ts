import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readRestartState } from '../run.ts';

const now = 1700000000000;

test('fresh restart state is returned and consumed, including paused and self-goal state', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qc-restart-'));
  const path = join(dir, 'controller-restart.json');
  try {
    for (const state of [
      {instruction: 'mine iron', goals: ['get pickaxe', 'mine iron'], active: true},
      {instruction: 'build shelter', goals: ['gather logs'], active: false},
      {instruction: null, goals: [], active: true},
    ]) {
      writeFileSync(path, JSON.stringify({savedAt: now - 600000, ...state}));
      assert.deepEqual(readRestartState(path, now), state);
      assert.equal(existsSync(path), false);
      assert.equal(readRestartState(path, now), null);
    }
  } finally {rmSync(dir, {recursive: true, force: true});}
});

test('stale and future-dated restart state is ignored and deleted', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qc-restart-'));
  const path = join(dir, 'controller-restart.json');
  try {
    for (const savedAt of [now - 600001, now + 1]) {
      writeFileSync(path, JSON.stringify({savedAt, instruction: 'mine iron', goals: [], active: true}));
      assert.equal(readRestartState(path, now), null);
      assert.equal(existsSync(path), false);
    }
  } finally {rmSync(dir, {recursive: true, force: true});}
});

test('malformed restart state is ignored and deleted', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qc-restart-'));
  const path = join(dir, 'controller-restart.json');
  const valid = {savedAt: now, instruction: 'mine iron', goals: ['get pickaxe'], active: true};
  try {
    for (const contents of [
      '{', 'null', '[]', '{}',
      JSON.stringify({...valid, savedAt: 'today'}),
      JSON.stringify({...valid, instruction: 42}),
      JSON.stringify({...valid, goals: 'get pickaxe'}),
      JSON.stringify({...valid, goals: [42]}),
      JSON.stringify({...valid, active: 'true'}),
    ]) {
      writeFileSync(path, contents);
      assert.equal(readRestartState(path, now), null, contents);
      assert.equal(existsSync(path), false, contents);
    }
  } finally {rmSync(dir, {recursive: true, force: true});}
});

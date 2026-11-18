import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tickShowsDate } from '../platform/web/lib/axis-label.ts';

const H = 3600 * 1000;
const at = (d, h) => new Date(2026, 10, d, h).getTime();

test('ticks a day or more apart show the date', () => assert.equal(tickShowsDate(at(10, 2), at(8, 10), 40 * H), true));
test('the first tick shows the date when ticks are a day apart', () => assert.equal(tickShowsDate(at(10, 2), null, 24 * H), true));
test('closer ticks on the same day show the time', () => assert.equal(tickShowsDate(at(10, 14), at(10, 4), 10 * H), false));
test('the first closer tick on a new day shows the date', () => assert.equal(tickShowsDate(at(11, 0), at(10, 14), 10 * H), true));
test('the first tick shows the time when ticks are closer', () => assert.equal(tickShowsDate(at(10, 4), null, 10 * H), false));

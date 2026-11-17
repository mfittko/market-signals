import { test } from 'node:test';
import assert from 'node:assert/strict';
import { zoomFactor } from '../platform/web/lib/chart-zoom-key.ts';

const press = (key, mods = {}) => zoomFactor({ key, ctrlKey: false, metaKey: false, altKey: false, ...mods });

test('bare - shows more candles', () => assert.equal(press('-'), 1.5));
test('bare + shows fewer candles', () => assert.equal(press('+'), 1 / 1.5));
test('bare = shows fewer candles', () => assert.equal(press('='), 1 / 1.5));

test('Ctrl+- is left to the browser page zoom', () => assert.equal(press('-', { ctrlKey: true }), null));
test('Ctrl+= is left to the browser page zoom', () => assert.equal(press('=', { ctrlKey: true }), null));
test('Cmd+- is left to the browser page zoom', () => assert.equal(press('-', { metaKey: true }), null));
test('Cmd+= is left to the browser page zoom', () => assert.equal(press('=', { metaKey: true }), null));
test('Cmd++ is left to the browser page zoom', () => assert.equal(press('+', { metaKey: true }), null));
test('Alt+- does not zoom the chart', () => assert.equal(press('-', { altKey: true }), null));

test('other keys do not zoom', () => assert.equal(press('ArrowLeft'), null));

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMatch } from '../platform/web/lib/same-build.ts';

test('abc1234 vs abc1234 is the same build', () => assert.equal(buildMatch('abc1234', 'abc1234'), 'same'));
test('unknown vs unknown is unverified', () => assert.equal(buildMatch('unknown', 'unknown'), 'unverified'));
test('unknown vs abc1234 is unverified', () => assert.equal(buildMatch('unknown', 'abc1234'), 'unverified'));
test('abc1234 vs unknown is unverified', () => assert.equal(buildMatch('abc1234', 'unknown'), 'unverified'));
test('abc1234 vs def5678 differ', () => assert.equal(buildMatch('abc1234', 'def5678'), 'differ'));
test('a health without a build is unverified', () => assert.equal(buildMatch(undefined, 'abc1234'), 'unverified'));

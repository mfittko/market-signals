import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sameBuild } from '../platform/web/lib/same-build.ts';

test('abc1234 vs abc1234 is the same build', () => assert.equal(sameBuild('abc1234', 'abc1234'), true));
test('unknown vs unknown is not the same build', () => assert.equal(sameBuild('unknown', 'unknown'), false));
test('unknown vs abc1234 is not the same build', () => assert.equal(sameBuild('unknown', 'abc1234'), false));
test('abc1234 vs unknown is not the same build', () => assert.equal(sameBuild('abc1234', 'unknown'), false));
test('abc1234 vs def5678 is not the same build', () => assert.equal(sameBuild('abc1234', 'def5678'), false));
test('a health without a build is not the same build', () => assert.equal(sameBuild(undefined, 'abc1234'), false));

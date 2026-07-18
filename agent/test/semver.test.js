/**
 * semver.mjs — prerelease-aware semver parse + comparison (VERSION-UPDATE-1).
 *
 * Covers: strict grammar (v-prefixed / bare / rejection), major/minor/patch
 * ordering, full semver.org §11.4 prerelease precedence (numeric vs numeric,
 * numeric < alphanumeric, ASCII lexical, longer-set-wins, no-pre > pre),
 * isNewer directionality, and maxSemver selection ignoring junk.
 *
 * Run: node --test   (from agent/)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseSemver,
  isValidSemver,
  compareSemver,
  isNewer,
  maxSemver,
} from '../core/semver.mjs';

test('parseSemver accepts v-prefixed and bare, splits prerelease', () => {
  assert.deepEqual(parseSemver('v0.2.69-alpha'), {
    major: 0, minor: 2, patch: 69, prerelease: ['alpha'], raw: 'v0.2.69-alpha',
  });
  assert.deepEqual(parseSemver('1.0.0'), {
    major: 1, minor: 0, patch: 0, prerelease: [], raw: '1.0.0',
  });
  assert.deepEqual(parseSemver('v0.2.70-rc.1').prerelease, ['rc', '1']);
});

test('parseSemver rejects malformed / non-string / build-metadata', () => {
  assert.equal(parseSemver('1.0'), null);
  assert.equal(parseSemver('v1.2.3.4'), null);
  assert.equal(parseSemver('1.0.0+meta'), null);
  assert.equal(parseSemver('vX.Y.Z'), null);
  assert.equal(parseSemver(''), null);
  assert.equal(parseSemver(null), null);
  assert.equal(parseSemver(123), null);
});

test('isValidSemver mirrors parse', () => {
  assert.equal(isValidSemver('v0.2.69-alpha'), true);
  assert.equal(isValidSemver('nope'), false);
});

test('compareSemver: numeric major/minor/patch ordering', () => {
  assert.equal(compareSemver('1.0.0', '2.0.0'), -1);
  assert.equal(compareSemver('0.3.0', '0.2.99'), 1);
  assert.equal(compareSemver('0.2.70', '0.2.69'), 1);
  assert.equal(compareSemver('1.2.3', '1.2.3'), 0);
  assert.equal(compareSemver('v1.2.3', '1.2.3'), 0);
});

test('compareSemver: no-prerelease outranks prerelease', () => {
  assert.equal(compareSemver('1.0.0', '1.0.0-alpha'), 1);
  assert.equal(compareSemver('1.0.0-alpha', '1.0.0'), -1);
});

test('compareSemver: prerelease precedence per semver.org', () => {
  // numeric identifiers compared numerically
  assert.equal(compareSemver('1.0.0-alpha.2', '1.0.0-alpha.10'), -1);
  // numeric < alphanumeric
  assert.equal(compareSemver('1.0.0-1', '1.0.0-alpha'), -1);
  // ASCII lexical for alphanumerics
  assert.equal(compareSemver('1.0.0-alpha', '1.0.0-beta'), -1);
  // longer set wins when preceding equal
  assert.equal(compareSemver('1.0.0-alpha', '1.0.0-alpha.1'), -1);
  // classic full chain
  assert.equal(
    compareSemver('1.0.0-alpha.1', '1.0.0-alpha.beta'),
    -1,
  );
});

test('compareSemver: unparseable sorts below any valid, equal to each other', () => {
  assert.equal(compareSemver('garbage', '1.0.0'), -1);
  assert.equal(compareSemver('1.0.0', 'garbage'), 1);
  assert.equal(compareSemver('garbage', 'junk'), 0);
});

test('isNewer requires both valid and strict >', () => {
  assert.equal(isNewer('v0.2.70-alpha', 'v0.2.69-alpha'), true);
  assert.equal(isNewer('v0.2.69-alpha', 'v0.2.69-alpha'), false);
  assert.equal(isNewer('v0.2.68-alpha', 'v0.2.69-alpha'), false);
  assert.equal(isNewer('garbage', '0.2.69-alpha'), false);
  assert.equal(isNewer('0.2.70-alpha', 'garbage'), false);
});

test('maxSemver picks highest, ignoring junk, null when none valid', () => {
  assert.equal(
    maxSemver(['v0.2.68-alpha', 'v0.2.70-alpha', 'v0.2.69-alpha', 'junk']),
    'v0.2.70-alpha',
  );
  assert.equal(maxSemver(['x', 'y']), null);
  assert.equal(maxSemver([]), null);
  assert.equal(maxSemver(null), null);
  // stable outranks same-version prerelease
  assert.equal(maxSemver(['1.0.0-rc.1', '1.0.0']), '1.0.0');
});

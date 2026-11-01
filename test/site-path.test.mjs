import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSitePath, isDeskEntryPath } from '../site-path.mjs';

test('normalizeSitePath maps DeWeb version prefixes to / and /rigs', () => {
  assert.equal(normalizeSitePath('/v/3/'), '/');
  assert.equal(normalizeSitePath('/v/3/index.html'), '/');
  assert.equal(normalizeSitePath('/v/12/rigs/'), '/rigs');
  assert.equal(normalizeSitePath('/v/1/rigs/index.html'), '/rigs');
  assert.equal(normalizeSitePath('/rigs/'), '/rigs');
  assert.equal(normalizeSitePath('/admin'), null);
});

test('isDeskEntryPath accepts versioned desk routes', () => {
  assert.equal(isDeskEntryPath('/v/2/'), true);
  assert.equal(isDeskEntryPath('/v/2/rigs/'), true);
  assert.equal(isDeskEntryPath('/check/'), false);
});

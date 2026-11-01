import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs, query, nextState, readState, LIMIT } from '../scripts/feedback-pull.mjs';

test('feedback-pull: arguments, query and state advance only past rows actually pulled', () => {
  assert.deepEqual(parseArgs(['--dry-run', '--state', '/tmp/x.json', '--db', 'other']), { dryRun: true, state: '/tmp/x.json', db: 'other' });
  assert.throws(() => parseArgs(['--bogus']), /unknown argument/);
  assert.equal(query(7), `SELECT id, text, lang, source, page, telegram, created_at, status FROM feedback WHERE id > 7 ORDER BY id LIMIT ${LIMIT}`);
  assert.equal(query('abc'), query(0), 'a bad last id never reaches SQL');
  const empty = readState('/nonexistent/feedback-seen.json');
  assert.deepEqual(empty, { lastId: 0, pulled: [] });
  assert.equal(nextState(empty, [], 'now'), empty, 'no rows, no change');
  const next = nextState(empty, [{ id: 3, source: 'site' }, { id: 9, source: 'bot' }], '2026-10-21T10:00:00.000Z');
  assert.equal(next.lastId, 9);
  assert.deepEqual(next.pulled.map(p => p.id), [3, 9]);
  assert.equal(nextState(next, [{ id: 4, source: 'site' }], 'later').lastId, 9, 'ids never move backwards');
});

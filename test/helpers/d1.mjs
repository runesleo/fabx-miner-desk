import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

// Offline D1 adapter. Apply the maintainer-only Task K migration to this private
// in-memory database; never opens a real account or database.
export function d1() {
  const sqlite = new DatabaseSync(':memory:');
  const schema = readFileSync(new URL('../../schema.sql', import.meta.url), 'utf8');
  sqlite.exec(schema);
  const uncomment = section => (section || '').split('\n').filter(line => /^-- (?:ALTER|CREATE) /.test(line)).map(line => line.slice(3)).join('\n');
  const taskK = schema.split('-- Task K reliability migration')[1]?.split('-- Task Q server-side')[0] || '';
  const taskQ = schema.split('-- Task Q server-side FAB 24h market stats')[1]?.split('-- Task U ')[0] || '';
  const taskU = schema.split('-- Task U ')[1] || '';
  sqlite.exec(uncomment(taskK) + uncomment(taskQ) + uncomment(taskU));
  const prepare = sql => {
    const statement = sqlite.prepare(sql);
    let args = [];
    const bound = {
      bind(...values) { args = values.map(v => v === undefined ? null : v); return bound; },
      async first(column) { const row = statement.get(...args) ?? null; return column ? (row?.[column] ?? null) : row; },
      async all() { return { results: statement.all(...args) }; },
      async run() { const r = statement.run(...args); return { success: true, meta: { changes: Number(r.changes) } }; },
    };
    return bound;
  };
  let lastBatch = Promise.resolve();
  return {
    prepare,
    batch(statements) {
      const result = lastBatch.then(async () => {
        sqlite.exec('BEGIN');
        try {
          const rows = [];
          for (const statement of statements) rows.push(await statement.run());
          sqlite.exec('COMMIT');
          return rows;
        } catch (error) { sqlite.exec('ROLLBACK'); throw error; }
      });
      lastBatch = result.catch(() => {});
      return result;
    },
    rows: (table, where = '1=1') => sqlite.prepare(`SELECT * FROM ${table} WHERE ${where}`).all(),
  };
}

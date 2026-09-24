import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { userFixtureSql, compatibilityFixtureSql } from '../../scripts/sponsorship-fixtures.mjs';
export { DEMO_USERS } from '../../scripts/sponsorship-fixtures.mjs';

// Real SQLite, with the D1 methods used by domain code. Batch rolls back every
// statement on error, so tests exercise constraints and write guards in SQL.
export async function createSponsorshipDb({ seed = true } = {}) {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('PRAGMA foreign_keys = ON');
  let transactionQueue = Promise.resolve();
  const db = {
    exec(sql) { sqlite.exec(sql); return Promise.resolve({ count: 1 }); },
    prepare(sql) {
      function bind(...args) {
        const statement = sqlite.prepare(sql);
        return {
          bind,
          async first(column) {
            const row = statement.get(...args);
            return row ? (column ? row[column] : { ...row }) : null;
          },
          async all() { return { results: statement.all(...args).map(row => ({ ...row })), success: true }; },
          async run() {
            const result = statement.run(...args);
            return { results: [], success: true, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
          },
        };
      }
      return bind();
    },
    batch(statements) {
      const pending = transactionQueue.then(async () => {
        sqlite.exec('BEGIN IMMEDIATE');
        try {
          const results = [];
          for (const statement of statements) results.push(await statement.run());
          sqlite.exec('COMMIT');
          return results;
        } catch (error) {
          sqlite.exec('ROLLBACK');
          throw error;
        }
      });
      transactionQueue = pending.catch(() => {});
      return pending;
    },
  };
  const migrations = fileURLToPath(new URL('../../migrations/', import.meta.url));
  for (const file of readdirSync(migrations).filter(name => name.endsWith('.sql')).sort()) {
    sqlite.exec(readFileSync(`${migrations}/${file}`, 'utf8'));
    if (file === '0013_event_project_awards.sql') sqlite.exec(compatibilityFixtureSql());
  }
  if (seed) sqlite.exec(userFixtureSql());
  return { db, sqlite, close() { sqlite.close(); } };
}

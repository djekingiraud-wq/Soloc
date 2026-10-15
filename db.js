import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---- SQLite (développement / tests) : une connexion, transactions sérialisées par un verrou.
function sqliteAdapter(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys=ON;');
  let chain = Promise.resolve();
  const lock = (fn) => { const r = chain.then(fn); chain = r.then(() => {}, () => {}); return r; };
  const ops = {
    forUpdate: '',
    all: async (s, p = []) => db.prepare(s).all(...p),
    get: async (s, p = []) => db.prepare(s).get(...p),
    run: async (s, p = []) => ({ changes: Number(db.prepare(s).run(...p).changes) }),
    script: async (s) => { db.exec(s); },
  };
  return {
    dialect: 'sqlite',
    all: (s, p) => lock(() => ops.all(s, p)), get: (s, p) => lock(() => ops.get(s, p)),
    run: (s, p) => lock(() => ops.run(s, p)), script: (s) => lock(() => ops.script(s)),
    tx: (fn) => lock(async () => {
      db.exec('BEGIN IMMEDIATE'); // verrou d'écriture : aucune autre écriture pendant la transaction
      try { const r = await fn(ops); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
    }),
    close: () => db.close(),
  };
}

// ---- PostgreSQL (production) : NON exécuté dans l'environnement de développement initial.
async function pgAdapter(url) {
  const pg = (await import('pg')).default;
  pg.types.setTypeParser(1184, (v) => new Date(v).toISOString()); // timestamptz -> ISO UTC
  pg.types.setTypeParser(20, Number); pg.types.setTypeParser(1700, Number);
  const pool = new pg.Pool({ connectionString: url });
  const conv = (s) => { let i = 0; return s.replace(/\?/g, () => '$' + (++i)); };
  const mk = (c) => ({
    forUpdate: ' FOR UPDATE',
    all: async (s, p = []) => (await c.query(conv(s), p)).rows,
    get: async (s, p = []) => (await c.query(conv(s), p)).rows[0],
    run: async (s, p = []) => ({ changes: (await c.query(conv(s), p)).rowCount }),
    script: async (s) => { await c.query(s); },
  });
  return {
    dialect: 'pg', ...mk(pool),
    tx: async (fn) => {
      const c = await pool.connect();
      try { await c.query('BEGIN'); const r = await fn(mk(c)); await c.query('COMMIT'); return r; }
      catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
    },
    close: () => pool.end(),
  };
}

export async function openDb(env = process.env) {
  if (env.DATABASE_URL?.startsWith('postgres')) return pgAdapter(env.DATABASE_URL);
  return sqliteAdapter(env.SQLITE_FILE || path.join(root, 'data/soloc.db'));
}

const checksum = (text) => crypto.createHash('sha256').update(text).digest('hex');
const migrationFiles = (db) => { const dir = path.join(root, 'db/migrations', db.dialect); return fs.readdirSync(dir).filter((x) => x.endsWith('.sql')).sort().map((f) => ({ name: f, sql: fs.readFileSync(path.join(dir, f), 'utf8') })); };

async function ensureMigrationsTable(db) {
  await db.script('CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY, applied_at text NOT NULL, checksum text)');
  try { await db.script('ALTER TABLE schema_migrations ADD COLUMN checksum text'); } catch { /* colonne déjà présente */ }
}

export async function pendingMigrations(db) {
  await ensureMigrationsTable(db);
  const done = new Set((await db.all('SELECT name FROM schema_migrations')).map((r) => r.name));
  return migrationFiles(db).filter((m) => !done.has(m.name)).map((m) => m.name);
}

// Applique les migrations dans l'ordre, chacune dans une transaction. Refuse de continuer si une migration
// déjà appliquée a été modifiée (somme de contrôle). PostgreSQL : verrou consultatif => deux déploiements simultanés ne se marchent pas dessus.
export async function migrate(db) {
  await ensureMigrationsTable(db);
  const applied = [];
  for (const m of migrationFiles(db)) {
    const sum = checksum(m.sql);
    const row = await db.get('SELECT checksum FROM schema_migrations WHERE name=?', [m.name]);
    if (row) {
      if (!row.checksum) await db.run('UPDATE schema_migrations SET checksum=? WHERE name=?', [sum, m.name]); // base antérieure aux sommes de contrôle
      else if (row.checksum !== sum) throw new Error(`La migration ${m.name} a été modifiée après son application. Créez une NOUVELLE migration au lieu de modifier une ancienne.`);
      continue;
    }
    await db.tx(async (t) => {
      if (db.dialect === 'pg') await t.get('SELECT pg_advisory_xact_lock(727274)');
      if (await t.get('SELECT name FROM schema_migrations WHERE name=?', [m.name])) return; // appliquée entre-temps par un autre processus
      await t.script(m.sql);
      await t.run('INSERT INTO schema_migrations(name,applied_at,checksum) VALUES(?,?,?)', [m.name, new Date().toISOString(), sum]);
      applied.push(m.name);
    });
  }
  return applied;
}

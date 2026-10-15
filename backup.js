// Sauvegarde SQLite (DÉVELOPPEMENT / TESTS uniquement). La production utilise PostgreSQL : voir ops/backup.sh.
import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

export function backupSqlite(src, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const dest = path.join(destDir, `soloc-${new Date().toISOString().replace(/[:.]/g, '-')}.db`);
  const db = new DatabaseSync(src); db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`); db.close(); // copie cohérente, même base en cours d'utilisation
  fs.writeFileSync(dest + '.sha256', `${sha(dest)}  ${path.basename(dest)}\n`);
  return dest;
}

// Une sauvegarde n'existe que si elle a été relue : somme de contrôle, intégrité SQLite, présence des tables métier.
export function verifyBackup(file) {
  const problems = [];
  const expected = fs.existsSync(file + '.sha256') ? fs.readFileSync(file + '.sha256', 'utf8').split(/\s+/)[0] : null;
  if (!expected) problems.push('somme de contrôle absente');
  else if (expected !== sha(file)) problems.push('somme de contrôle différente (fichier altéré ou incomplet)');
  let counts = {};
  try {
    const db = new DatabaseSync(file, { readOnly: true });
    const integ = db.prepare('PRAGMA integrity_check').get();
    if (Object.values(integ)[0] !== 'ok') problems.push('integrity_check : ' + Object.values(integ)[0]);
    for (const t of ['users', 'vehicles', 'bookings', 'payments']) counts[t] = Number(db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c);
    db.close();
  } catch (e) { problems.push('lecture impossible : ' + e.message); }
  return { ok: problems.length === 0, problems, counts };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const src = process.env.SQLITE_FILE || 'data/soloc.db', out = process.argv[2] || 'backups';
  const f = backupSqlite(src, out), v = verifyBackup(f);
  console.log(v.ok ? `Sauvegarde vérifiée : ${f}` : `SAUVEGARDE INVALIDE : ${v.problems.join(' ; ')}`, v.counts);
  process.exit(v.ok ? 0 : 1);
}

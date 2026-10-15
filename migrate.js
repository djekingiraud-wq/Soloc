import { openDb, migrate } from './db.js';
const db = await openDb();
console.log('Migrations appliquées :', await migrate(db));
await db.close();

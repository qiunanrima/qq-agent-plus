import path from 'node:path';
import { snapshotLegacyMemory } from '../src/unified-memory/legacy-backup.js';
import { importHandoffs } from '../src/unified-memory/import-handoffs.js';
import { importLivingCards } from '../src/unified-memory/import-living.js';
import { importPersonaRecords } from '../src/unified-memory/import-personas.js';
import { importPeople } from '../src/unified-memory/import-people.js';
import { UnifiedMemoryStore } from '../src/unified-memory/store.js';
import { statSync } from 'node:fs';

const [dataDir, backupRoot] = process.argv.slice(2);
if (!dataDir || !backupRoot || !statSync(dataDir).isDirectory()) {
  throw new Error('Usage: node scripts/migrate-unified-memory.mjs DATA_DIR BACKUP_ROOT');
}
const snapshot = await snapshotLegacyMemory(dataDir, backupRoot);
const store = new UnifiedMemoryStore(path.join(dataDir, 'unified-memory.sqlite'));
try {
  const args = { directory: snapshot.directory, store };
  const report = {
    directory: snapshot.directory,
    handoffs: importHandoffs(args),
    people: importPeople(args),
    living: snapshot.manifest.files.some(f => f.relative === 'living-memory/living-memory.sqlite' && f.status === 'verified')
      ? importLivingCards(args) : { absent: true },
    personas: importPersonaRecords(args)
  };
  console.log(JSON.stringify(report, null, 2));
} finally { store.close(); }

import type { Database } from 'bun:sqlite';
import { join } from 'node:path';
import { migrate } from '../core/migrate';

export const ROOM_MIGRATIONS_DIR = join(import.meta.dir, 'migrations');
export function migrateRooms(db: Database) { return migrate(db, ROOM_MIGRATIONS_DIR); }

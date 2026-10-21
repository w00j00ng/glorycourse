import type { DatabaseSync } from 'node:sqlite';
import { CatalogQueries } from './catalog.ts';
import { ApplicationQueries } from './applications.ts';
import { EnrollmentQueries } from './enrollments.ts';
import { AllocationQueries } from './allocation-drafts.ts';
import { ImportQueries } from './imports.ts';
import { ReceiptQueries } from './receipts.ts';
import type { DatabaseState } from '../domain/records.ts';

export class QuerySession {
  readonly catalog: CatalogQueries;
  readonly applications: ApplicationQueries;
  readonly enrollments: EnrollmentQueries;
  readonly allocation: AllocationQueries;
  readonly imports: ImportQueries;
  readonly receipts: ReceiptQueries;
  readonly #db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.#db = db;
    this.catalog = new CatalogQueries(db);
    this.applications = new ApplicationQueries(db);
    this.enrollments = new EnrollmentQueries(db);
    this.allocation = new AllocationQueries(db);
    this.imports = new ImportQueries(db);
    this.receipts = new ReceiptQueries(db);
  }

  metadata(): DatabaseState['meta'] {
    return { ...this.#db.prepare('SELECT store_epoch AS storeEpoch, store_revision AS storeRevision FROM store_meta WHERE id = 1').get() } as DatabaseState['meta'];
  }
}

import type { DatabaseSync } from 'node:sqlite';
import { MemberQueries } from './members.ts';
import { CourseQueries } from './courses.ts';
import { SemesterQueries } from './semesters.ts';
import { SemesterCourseQueries } from './semester-courses.ts';
import { ApplicationQueries } from './applications.ts';
import { EnrollmentQueries } from './enrollments.ts';
import { ApplicationChoiceQueries } from './application-choices.ts';
import { AllocationDraftQueries } from './allocation-drafts.ts';
import { AllocationDraftItemQueries } from './allocation-draft-items.ts';
import { ImportBatchQueries } from './import-batches.ts';
import { ImportReceiptQueries } from './import-receipts.ts';
import { FinalizationReceiptQueries } from './finalization-receipts.ts';
import { StoreMetaQueries } from './store-meta.ts';
import type { DatabaseState } from '../domain/records.ts';

export class QuerySession {
  readonly members: MemberQueries;
  readonly courses: CourseQueries;
  readonly semesters: SemesterQueries;
  readonly semesterCourses: SemesterCourseQueries;
  readonly applications: ApplicationQueries;
  readonly enrollments: EnrollmentQueries;
  readonly applicationChoices: ApplicationChoiceQueries;
  readonly allocationDrafts: AllocationDraftQueries;
  readonly allocationDraftItems: AllocationDraftItemQueries;
  readonly importBatches: ImportBatchQueries;
  readonly importReceipts: ImportReceiptQueries;
  readonly finalizationReceipts: FinalizationReceiptQueries;
  readonly #storeMeta: StoreMetaQueries;

  constructor(db: DatabaseSync) {
    this.#storeMeta = new StoreMetaQueries(db);
    this.members = new MemberQueries(db);
    this.courses = new CourseQueries(db);
    this.semesters = new SemesterQueries(db);
    this.semesterCourses = new SemesterCourseQueries(db);
    this.applications = new ApplicationQueries(db);
    this.enrollments = new EnrollmentQueries(db);
    this.applicationChoices = new ApplicationChoiceQueries(db);
    this.allocationDrafts = new AllocationDraftQueries(db);
    this.allocationDraftItems = new AllocationDraftItemQueries(db);
    this.importBatches = new ImportBatchQueries(db);
    this.importReceipts = new ImportReceiptQueries(db);
    this.finalizationReceipts = new FinalizationReceiptQueries(db);
  }

  metadata(): DatabaseState['meta'] {
    return this.#storeMeta.get();
  }
}

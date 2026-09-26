import { DatabaseSync } from 'node:sqlite';
import { changedRecords, prepareChanges, prepareRow, replaceChildren } from './row-changes.ts';

import type { AllocationSnapshot, PolicySettings } from '../../allocation/engine.ts';
import type {
  AllocationDraftItemRecord as DraftItem,
  AllocationDraftRecord as Draft,
  ApplicationChoiceRecord as Choice,
  ApplicationRecord as Application,
  DatabaseState,
  EnrollmentRecord as Enrollment,
  FinalizationRecord,
  FinalizationReceiptRecord,
  FinalizationWarningRecord,
  ImportBatchRecord as ImportBatch,
  ImportResolutionRecord,
  NamedRecord as Named,
  RestoreReceiptRecord,
  SemesterCourseRecord as SemesterCourse,
  SemesterRecord as Semester,
} from '../store.ts';

type SqlValue = string | number | null;
type SourceRef = { importBatchId: string; sheet: string; row: number };
type Acknowledgement = { warningDigest: string; note: string; acknowledgedAt: string };
type RawRow = ImportBatch['rawRows'][number];
type ImportReceipt = NonNullable<ImportBatch['receipt']>;
type Snapshot = AllocationSnapshot;
type WithParent<T> = T & { parentId: string };
type PreferenceAttempt = DraftItem['autoReasonDetail']['preferenceAttempts'][number];
type Fallback = NonNullable<DraftItem['autoReasonDetail']['fallback']>;
type FinalizationWarningRow = Pick<FinalizationWarningRecord, 'code' | 'message' | 'severity' | 'note' | 'acknowledgedAt'> & {
  parentId: string;
  subjectEntityType: string;
  subjectEntityId: string | null;
  subjectMemberId: string | null;
  subjectCourseId: string | null;
  changeCode: string | null;
};

const all = <T>(db: DatabaseSync, sql: string, ...params: SqlValue[]): T[] => (
  db.prepare(sql).all(...params).map((row) => ({ ...row })) as T[]
);
const one = <T>(db: DatabaseSync, sql: string, ...params: SqlValue[]): T | undefined => {
  const row = db.prepare(sql).get(...params);
  return row ? { ...row } as T : undefined;
};
const group = <T extends { parentId: string }>(items: T[]): Map<string, Omit<T, 'parentId'>[]> => {
  const result = new Map<string, Omit<T, 'parentId'>[]>();
  for (const { parentId, ...item } of items) {
    const children = result.get(parentId);
    if (children) children.push(item);
    else result.set(parentId, [item]);
  }
  return result;
};

export const readRelationalStore = (db: DatabaseSync): DatabaseState => {
  const meta = one<{ storeEpoch: string; storeRevision: number }>(
    db, 'SELECT store_epoch AS storeEpoch, store_revision AS storeRevision FROM store_meta WHERE id = 1',
  );
  if (!meta) throw new Error('SQLite store metadata is missing');

  const semesters = all<Semester>(db, `SELECT id, name, name_key AS nameKey, semester_order AS "order",
    allocation_input_revision AS allocationInputRevision, created_at AS createdAt, updated_at AS updatedAt
    FROM semesters ORDER BY position`);
  const members = all<Named>(db, 'SELECT id, name, name_key AS nameKey, created_at AS createdAt, updated_at AS updatedAt FROM members ORDER BY position');
  const courses = all<Named>(db, 'SELECT id, name, name_key AS nameKey, created_at AS createdAt, updated_at AS updatedAt FROM courses ORDER BY position');
  const semesterCourses = all<SemesterCourse>(db, `SELECT id, semester_id AS semesterId, course_id AS courseId,
    capacity, created_at AS createdAt, updated_at AS updatedAt FROM semester_courses ORDER BY position`);

  const sourceRefs = group(all<SourceRef & { parentId: string }>(db, `SELECT application_choice_id AS parentId,
    import_batch_id AS importBatchId, sheet, row_number AS row FROM application_choice_source_refs
    ORDER BY application_choice_id, position`));
  const applications = all<Application>(db, `SELECT id, semester_id AS semesterId, member_id AS memberId,
    application_order AS applicationOrder, application_order_status AS applicationOrderStatus,
    order_resolution AS orderResolution, order_resolution_note AS orderResolutionNote, revision,
    created_at AS createdAt, updated_at AS updatedAt FROM applications ORDER BY position`);
  const applicationChoices = all<Omit<Choice, 'sourceRefs'>>(db, `SELECT id, application_id AS applicationId,
    semester_course_id AS semesterCourseId, preference, created_at AS createdAt, updated_at AS updatedAt
    FROM application_choices ORDER BY position`).map((item) => ({ ...item, sourceRefs: sourceRefs.get(item.id) ?? [] }));

  const acknowledgements = new Map(all<Acknowledgement & { enrollmentId: string }>(db, `SELECT enrollment_id AS enrollmentId,
    warning_digest AS warningDigest, note, acknowledged_at AS acknowledgedAt FROM enrollment_acknowledgements`)
    .map(({ enrollmentId, ...item }) => [enrollmentId, item]));
  const enrollments = all<Omit<Enrollment, 'exceptionAcknowledgement'>>(db, `SELECT id,
    semester_course_id AS semesterCourseId, member_id AS memberId, revision,
    created_at AS createdAt, updated_at AS updatedAt
    FROM enrollments ORDER BY position`).map((item) => ({
    ...item, exceptionAcknowledgement: acknowledgements.get(item.id) ?? null,
  }));

  const importBatches = readImportBatches(db);
  const restoreReceipts = all<RestoreReceiptRecord>(db, `SELECT idempotency_key AS idempotencyKey,
    request_hash AS requestHash, receipt_id AS receiptId, previous_backup_id AS previousBackupId,
    store_revision AS storeRevision, store_epoch AS storeEpoch, restored_at AS restoredAt
    FROM restore_receipts ORDER BY position`);
  const receiptEnrollmentIds = group(all<{ parentId: string; enrollmentId: string }>(db, `SELECT
    idempotency_key AS parentId, enrollment_id AS enrollmentId
    FROM finalization_receipt_enrollment_ids ORDER BY idempotency_key, position`));
  const finalizationReceipts = all<Omit<FinalizationReceiptRecord, 'receipt'> &
    Omit<FinalizationReceiptRecord['receipt'], 'createdEnrollmentIds'>>(db, `SELECT
    idempotency_key AS idempotencyKey, request_hash AS requestHash, semester_id AS semesterId,
    draft_id AS draftId, receipt_id AS receiptId, created_count AS createdCount,
    finalized_at AS finalizedAt, enrollment_report_downloaded_at AS enrollmentReportDownloadedAt,
    enrollment_report_store_revision AS enrollmentReportStoreRevision
    FROM finalization_receipts ORDER BY position`).map(({ draftId, receiptId, createdCount, finalizedAt, ...record }) => ({
    ...record,
    receipt: { draftId, receiptId, createdCount, finalizedAt,
      createdEnrollmentIds: (receiptEnrollmentIds.get(record.idempotencyKey) ?? []).map(({ enrollmentId }) => enrollmentId) },
  }));
  const { drafts, items } = readDrafts(db);
  return {
    meta, semesters, members, courses, semesterCourses, applications, applicationChoices, enrollments,
    allocationDrafts: drafts, allocationDraftItems: items, importBatches, finalizationReceipts, restoreReceipts,
  } as DatabaseState;
};

const readImportBatches = (db: DatabaseSync): ImportBatch[] => {
  const cells = new Map<string, Record<string, string | null>>();
  for (const row of all<{ batchId: string; rowPosition: number; columnName: string; cellValue: string | null }>(db, `SELECT
    import_batch_id AS batchId, row_position AS rowPosition, column_name AS columnName, cell_value AS cellValue
    FROM import_raw_cells ORDER BY import_batch_id, row_position, position`)) {
    const key = `${row.batchId}\0${row.rowPosition}`;
    cells.set(key, { ...(cells.get(key) ?? {}), [row.columnName]: row.cellValue });
  }
  const rawRows = group(all<{ parentId: string; position: number; sheet: string; row: number }>(db, `SELECT
    import_batch_id AS parentId, position, sheet, row_number AS row FROM import_raw_rows
    ORDER BY import_batch_id, position`).map(({ parentId, position, sheet, row }) => ({
    parentId, sheet, row, cells: cells.get(`${parentId}\0${position}`) ?? {},
  })));
  const resolutions = group(all<WithParent<ImportResolutionRecord>>(db, `SELECT import_batch_id AS parentId,
    entity, action, field, semester_name AS semesterName, member_name AS memberName,
    course_name AS courseName, application_order AS applicationOrder, warning_digest AS warningDigest,
    acknowledgement_note AS acknowledgementNote FROM import_resolutions ORDER BY import_batch_id, position`)
    .map(compact));
  const receipts = new Map(all<ImportReceipt>(db, `SELECT receipt_id AS receiptId, import_batch_id AS importBatchId,
    preview_id AS previewId, store_epoch AS storeEpoch, idempotency_key AS idempotencyKey,
    request_hash AS requestHash, inserted_count AS inserted, updated_count AS updated,
    skipped_count AS skipped, committed_at AS committedAt FROM import_receipts`).map((item) => [item.importBatchId, item]));
  return all<Omit<ImportBatch, 'rawRows' | 'resolutions' | 'receipt'>>(db, `SELECT id, kind,
    template_version AS templateVersion, file_hash AS fileHash, imported_at AS importedAt, status
    FROM import_batches ORDER BY position`).map((batch) => ({
    ...batch,
    rawRows: (rawRows.get(batch.id) as RawRow[] | undefined) ?? [],
    resolutions: resolutions.get(batch.id) ?? [],
    receipt: receipts.get(batch.id) ?? null,
  }));
};

const readDrafts = (db: DatabaseSync): { drafts: Draft[]; items: DraftItem[] } => {
  const policy = new Map(all<PolicySettings & { draftId: string }>(db, `SELECT allocation_draft_id AS draftId,
    preference_mode AS preferenceMode, fallback_mode AS fallbackMode FROM allocation_draft_policy_settings`)
    .map(({ draftId, ...item }) => [draftId, item]));
  const snapshotSemester = new Map(all<Snapshot['semester'] & { draftId: string }>(db, `SELECT allocation_draft_id AS draftId,
    semester_id AS id, name, semester_order AS "order" FROM allocation_snapshot_semesters`)
    .map(({ draftId, ...item }) => [draftId, item]));
  const snapshotCourses = group(all<WithParent<Snapshot['semesterCourses'][number]>>(db, `SELECT allocation_draft_id AS parentId,
    semester_course_id AS id, course_id AS courseId, course_name AS courseName, capacity
    FROM allocation_snapshot_semester_courses ORDER BY allocation_draft_id, position`));
  const snapshotApplications = group(all<WithParent<Snapshot['applications'][number]>>(db, `SELECT allocation_draft_id AS parentId,
    application_id AS id, member_id AS memberId, member_name AS memberName,
    application_order AS applicationOrder, application_order_status AS applicationOrderStatus
    FROM allocation_snapshot_applications ORDER BY allocation_draft_id, position`));
  const snapshotChoices = group(all<WithParent<Snapshot['choices'][number]>>(db, `SELECT allocation_draft_id AS parentId,
    choice_id AS id, application_id AS applicationId, semester_course_id AS semesterCourseId, preference
    FROM allocation_snapshot_choices ORDER BY allocation_draft_id, position`));
  const snapshotPast = group(all<WithParent<Snapshot['relevantPastEnrollments'][number]>>(db, `SELECT allocation_draft_id AS parentId,
    enrollment_id AS id, member_id AS memberId, course_id AS courseId, semester_id AS semesterId,
    semester_order AS semesterOrder FROM allocation_snapshot_past_enrollments ORDER BY allocation_draft_id, position`));
  const snapshotExisting = group(all<WithParent<Snapshot['existingEnrollments'][number]>>(db, `SELECT allocation_draft_id AS parentId,
    enrollment_id AS id, member_id AS memberId, member_name AS memberName,
    semester_course_id AS semesterCourseId FROM allocation_snapshot_existing_enrollments
    ORDER BY allocation_draft_id, position`));

  const attempts = group(all<WithParent<PreferenceAttempt>>(db, `SELECT allocation_draft_item_id AS parentId,
    choice_id_at_generation AS choiceIdAtGeneration, semester_course_id AS semesterCourseId,
    course_name_at_generation AS courseNameAtGeneration, preference, decision, reason_code AS reasonCode
    FROM allocation_item_preference_attempts ORDER BY allocation_draft_item_id, position`));
  const fallbackCandidates = group(all<{ parentId: string; semesterCourseId: string }>(db, `SELECT
    allocation_draft_item_id AS parentId, semester_course_id AS semesterCourseId
    FROM allocation_item_fallback_candidates ORDER BY allocation_draft_item_id, position`));
  const fallbacks = new Map(all<Omit<Fallback, 'stageCandidateSemesterCourseIds'> & { itemId: string }>(db, `SELECT allocation_draft_item_id AS itemId,
    selected_semester_course_id AS selectedSemesterCourseId, reason_code AS reasonCode,
    total_assigned_in_stage AS totalAssignedInStage FROM allocation_item_fallbacks`).map(({ itemId, ...item }) => [
    itemId,
    { ...item, stageCandidateSemesterCourseIds: (fallbackCandidates.get(itemId) ?? []).map(({ semesterCourseId }) => semesterCourseId) },
  ]));
  const finalReasons = new Map(all<{ itemId: string; note: string }>(db, `SELECT
    allocation_draft_item_id AS itemId, note FROM allocation_item_final_reasons`).map(({ itemId, note }) => [itemId, { note }]));
  const items = all<Omit<DraftItem, 'autoReasonDetail' | 'finalReasonDetail'>>(db, `SELECT id, allocation_draft_id AS draftId, member_id AS memberId,
    source_application_id AS sourceApplicationId, member_name_at_generation AS memberNameAtGeneration,
    auto_semester_course_id AS autoSemesterCourseId, auto_decision AS autoDecision,
    auto_reason_code AS autoReasonCode, final_semester_course_id AS finalSemesterCourseId,
    final_decision AS finalDecision, final_reason_code AS finalReasonCode, updated_at AS updatedAt
    FROM allocation_draft_items ORDER BY position`).map((item) => ({
    ...item,
    autoReasonDetail: { preferenceAttempts: attempts.get(item.id) ?? [], fallback: fallbacks.get(item.id) ?? null },
    finalReasonDetail: finalReasons.get(item.id) ?? null,
  })) as DraftItem[];

  const enrollmentIds = group(all<{ parentId: string; enrollmentId: string }>(db, `SELECT
    allocation_draft_id AS parentId, enrollment_id AS enrollmentId
    FROM allocation_finalization_enrollment_ids ORDER BY allocation_draft_id, position`));
  const receipts = new Map(all<Omit<FinalizationRecord['receipt'], 'draftId' | 'createdEnrollmentIds'> & { draftId: string }>(db, `SELECT allocation_draft_id AS draftId,
    receipt_id AS receiptId, created_count AS createdCount, finalized_at AS finalizedAt
    FROM allocation_finalization_receipts`).map(({ draftId, ...item }) => [draftId, {
    ...item, draftId, createdEnrollmentIds: (enrollmentIds.get(draftId) ?? []).map(({ enrollmentId }) => enrollmentId),
  }]));
  const warnings = group(all<FinalizationWarningRow>(db, `SELECT allocation_draft_id AS parentId,
    code, message, severity, subject_entity_type AS subjectEntityType, subject_entity_id AS subjectEntityId,
    subject_member_id AS subjectMemberId, subject_course_id AS subjectCourseId, change_code AS changeCode,
    note, acknowledged_at AS acknowledgedAt FROM allocation_finalization_warnings
    ORDER BY allocation_draft_id, position`).map(({ parentId, subjectEntityType, subjectEntityId, subjectMemberId,
    subjectCourseId, changeCode, note, acknowledgedAt, ...item }) => ({
    parentId,
    ...item,
    blockingStages: ['FINALIZE'],
    acknowledgementStages: ['FINALIZE'],
    subject: compact({ entityType: subjectEntityType, entityId: subjectEntityId, memberId: subjectMemberId, courseId: subjectCourseId }),
    source: {},
    detail: changeCode === null ? {} : { changeCode },
    note,
    acknowledgedAt,
  })));
  const finalizations = new Map(all<Pick<FinalizationRecord, 'idempotencyKey' | 'requestHash'> & { draftId: string }>(db, `SELECT allocation_draft_id AS draftId,
    idempotency_key AS idempotencyKey, request_hash AS requestHash FROM allocation_finalizations`)
    .map(({ draftId, ...item }) => [draftId, {
      ...item, receipt: receipts.get(draftId), acknowledgedWarnings: warnings.get(draftId) ?? [],
    }]));

  const drafts = all<Omit<Draft, 'policySettings' | 'inputSnapshot' | 'finalization'>>(db, `SELECT id, semester_id AS semesterId, status, revision, mode,
    policy_id AS policyId, policy_version AS policyVersion, engine_version AS engineVersion,
    random_seed AS randomSeed, source_revision AS sourceRevision, input_fingerprint AS inputFingerprint,
    created_at AS createdAt, updated_at AS updatedAt, finalized_at AS finalizedAt,
    enrollment_report_downloaded_at AS enrollmentReportDownloadedAt,
    enrollment_report_store_revision AS enrollmentReportStoreRevision
    FROM allocation_drafts ORDER BY position`).map((draft) => ({
    ...draft,
    policySettings: policy.get(draft.id)!,
    inputSnapshot: {
      semester: snapshotSemester.get(draft.id)!,
      semesterCourses: snapshotCourses.get(draft.id) ?? [],
      applications: snapshotApplications.get(draft.id) ?? [],
      choices: snapshotChoices.get(draft.id) ?? [],
      relevantPastEnrollments: snapshotPast.get(draft.id) ?? [],
      existingEnrollments: snapshotExisting.get(draft.id) ?? [],
    },
    finalization: finalizations.get(draft.id) ?? null,
  })) as Draft[];
  return { drafts, items };
};

const compact = <T extends object>(item: T): T => Object.fromEntries(
  Object.entries(item).filter(([, value]) => value !== null),
) as T;

export const writeRelationalStore = (db: DatabaseSync, data: DatabaseState, previous?: DatabaseState): void => {
  if (previous) {
    prepareChanges(db, 'enrollments', data.enrollments, previous.enrollments);
    prepareChanges(db, 'allocation_draft_items', data.allocationDraftItems, previous.allocationDraftItems);
    prepareChanges(db, 'allocation_drafts', data.allocationDrafts, previous.allocationDrafts);
    prepareChanges(db, 'finalization_receipts', data.finalizationReceipts, previous.finalizationReceipts,
      [['receipt_id', (item) => item.receipt.receiptId]]);
    prepareChanges(db, 'application_choices', data.applicationChoices, previous.applicationChoices,
      [['application_id', (item) => JSON.stringify([item.applicationId, item.semesterCourseId])]]);
    prepareChanges(db, 'applications', data.applications, previous.applications,
      [['semester_id', (item) => JSON.stringify([item.semesterId, item.memberId])]]);
    prepareChanges(db, 'import_batches', data.importBatches, previous.importBatches);
    prepareChanges(db, 'semester_courses', data.semesterCourses, previous.semesterCourses,
      [['semester_id', (item) => JSON.stringify([item.semesterId, item.courseId])]]);
    prepareChanges(db, 'semesters', data.semesters, previous.semesters, [['name_key', (item) => item.nameKey]]);
    prepareChanges(db, 'members', data.members, previous.members, [['name_key', (item) => item.nameKey]]);
    prepareChanges(db, 'courses', data.courses, previous.courses, [['name_key', (item) => item.nameKey]]);
    prepareChanges(db, 'restore_receipts', data.restoreReceipts, previous.restoreReceipts,
      [['receipt_id', (item) => item.receiptId]]);
  } else db.exec(`
    DELETE FROM enrollments;
    DELETE FROM allocation_drafts;
    DELETE FROM finalization_receipts;
    DELETE FROM applications;
    DELETE FROM import_batches;
    DELETE FROM semester_courses;
    DELETE FROM semesters;
    DELETE FROM members;
    DELETE FROM courses;
    DELETE FROM restore_receipts;
    DELETE FROM store_meta;
  `);
  prepareRow(db, 'store_meta', 'id, store_epoch, store_revision')
    .run(1, data.meta.storeEpoch, data.meta.storeRevision);

  const receiptInsert = prepareRow(db, 'restore_receipts',
    'idempotency_key, position, request_hash, receipt_id, previous_backup_id, store_revision, store_epoch, restored_at');
  changedRecords(data.restoreReceipts, previous?.restoreReceipts).forEach(({ item, position }) => receiptInsert.run(
    item.idempotencyKey, position, item.requestHash, item.receiptId, item.previousBackupId,
    item.storeRevision, item.storeEpoch, item.restoredAt,
  ));

  const semesterInsert = prepareRow(db, 'semesters',
    'id, position, name, name_key, semester_order, allocation_input_revision, created_at, updated_at');
  changedRecords(data.semesters, previous?.semesters).forEach(({ item, position }) => semesterInsert.run(
    item.id, position, item.name, item.nameKey, item.order, item.allocationInputRevision, item.createdAt, item.updatedAt,
  ));
  const finalizationInsert = prepareRow(db, 'finalization_receipts', `
    idempotency_key, position, request_hash, semester_id, draft_id, receipt_id, created_count,
    finalized_at, enrollment_report_downloaded_at, enrollment_report_store_revision
  `);
  const finalizationEnrollmentInsert = db.prepare(`INSERT INTO finalization_receipt_enrollment_ids
    (idempotency_key, position, enrollment_id) VALUES (?, ?, ?)`);
  changedRecords(data.finalizationReceipts, previous?.finalizationReceipts).forEach(({ item: record, position, before }) => {
    const { receipt } = record;
    finalizationInsert.run(record.idempotencyKey, position, record.requestHash, record.semesterId, receipt.draftId,
      receipt.receiptId, receipt.createdCount, receipt.finalizedAt,
      record.enrollmentReportDownloadedAt, record.enrollmentReportStoreRevision);
    if (replaceChildren(db, 'finalization_receipt_enrollment_ids', 'idempotency_key', record.idempotencyKey,
      before?.receipt.createdEnrollmentIds, receipt.createdEnrollmentIds)) {
      receipt.createdEnrollmentIds.forEach((id, position) => finalizationEnrollmentInsert.run(record.idempotencyKey, position, id));
    }
  });
  const namedInsert = (table: 'members' | 'courses', items: Named[], before?: Named[]): void => {
    const statement = prepareRow(db, table, 'id, position, name, name_key, created_at, updated_at');
    changedRecords(items, before).forEach(({ item, position }) => statement.run(item.id, position, item.name, item.nameKey, item.createdAt, item.updatedAt));
  };
  namedInsert('members', data.members, previous?.members);
  namedInsert('courses', data.courses, previous?.courses);
  const semesterCourseInsert = prepareRow(db, 'semester_courses',
    'id, position, semester_id, course_id, capacity, created_at, updated_at');
  changedRecords(data.semesterCourses, previous?.semesterCourses).forEach(({ item, position }) => semesterCourseInsert.run(
    item.id, position, item.semesterId, item.courseId, item.capacity, item.createdAt, item.updatedAt,
  ));

  writeImportBatches(db, data.importBatches, previous?.importBatches);

  const applicationInsert = prepareRow(db, 'applications',
    `id, position, semester_id, member_id, application_order, application_order_status, order_resolution,
      order_resolution_note, revision, created_at, updated_at`);
  changedRecords(data.applications, previous?.applications).forEach(({ item, position }) => applicationInsert.run(
    item.id, position, item.semesterId, item.memberId, item.applicationOrder, item.applicationOrderStatus,
    item.orderResolution, item.orderResolutionNote, item.revision, item.createdAt, item.updatedAt,
  ));
  const choiceInsert = prepareRow(db, 'application_choices',
    'id, position, application_id, semester_course_id, preference, created_at, updated_at');
  const sourceInsert = db.prepare(`INSERT INTO application_choice_source_refs
    (application_choice_id, position, import_batch_id, sheet, row_number) VALUES (?, ?, ?, ?, ?)`);
  const applicationIds = data.applicationChoices === previous?.applicationChoices
    ? null : new Set(data.applications.map((item) => item.id));
  const changedChoices = changedRecords(data.applicationChoices, previous?.applicationChoices,
    (item) => applicationIds !== null && !applicationIds.has(item.applicationId));
  changedChoices.forEach(({ item, position, before }) => {
    choiceInsert.run(item.id, position, item.applicationId, item.semesterCourseId, item.preference, item.createdAt, item.updatedAt);
    if (replaceChildren(db, 'application_choice_source_refs', 'application_choice_id', item.id, before?.sourceRefs, item.sourceRefs)) {
      item.sourceRefs.forEach((source, sourcePosition) => sourceInsert.run(
        item.id, sourcePosition, source.importBatchId, source.sheet, source.row,
      ));
    }
  });

  writeDrafts(db, data.allocationDrafts, data.allocationDraftItems, previous);

  const enrollmentInsert = prepareRow(db, 'enrollments',
    'id, position, semester_course_id, member_id, revision, created_at, updated_at');
  const acknowledgementInsert = db.prepare(`INSERT INTO enrollment_acknowledgements
    (enrollment_id, warning_digest, note, acknowledged_at) VALUES (?, ?, ?, ?)`);
  changedRecords(data.enrollments, previous?.enrollments).forEach(({ item, position, before }) => {
    enrollmentInsert.run(item.id, position, item.semesterCourseId, item.memberId,
      item.revision, item.createdAt, item.updatedAt);
    if (replaceChildren(db, 'enrollment_acknowledgements', 'enrollment_id', item.id,
      before?.exceptionAcknowledgement, item.exceptionAcknowledgement) && item.exceptionAcknowledgement) acknowledgementInsert.run(
      item.id, item.exceptionAcknowledgement.warningDigest, item.exceptionAcknowledgement.note,
      item.exceptionAcknowledgement.acknowledgedAt,
    );
  });
};

const writeImportBatches = (db: DatabaseSync, batches: ImportBatch[], previous?: ImportBatch[]): void => {
  const batchInsert = prepareRow(db, 'import_batches',
    'id, position, kind, template_version, file_hash, imported_at, status');
  const rowInsert = db.prepare(`INSERT INTO import_raw_rows
    (import_batch_id, position, sheet, row_number) VALUES (?, ?, ?, ?)`);
  const cellInsert = db.prepare(`INSERT INTO import_raw_cells
    (import_batch_id, row_position, position, column_name, cell_value) VALUES (?, ?, ?, ?, ?)`);
  const resolutionInsert = db.prepare(`INSERT INTO import_resolutions
    (import_batch_id, position, entity, action, field, semester_name, member_name, course_name,
      application_order, warning_digest, acknowledgement_note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const receiptInsert = db.prepare(`INSERT INTO import_receipts
    (import_batch_id, receipt_id, preview_id, store_epoch, idempotency_key, request_hash,
      inserted_count, updated_count, skipped_count, committed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  changedRecords(batches, previous).forEach(({ item: batch, position, before }) => {
    batchInsert.run(batch.id, position, batch.kind, batch.templateVersion, batch.fileHash, batch.importedAt, batch.status);
    if (replaceChildren(db, 'import_raw_rows', 'import_batch_id', batch.id, before?.rawRows, batch.rawRows)) {
      batch.rawRows.forEach((row, rowPosition) => {
        rowInsert.run(batch.id, rowPosition, row.sheet, row.row);
        Object.entries(row.cells).forEach(([column, value], cellPosition) => {
          cellInsert.run(batch.id, rowPosition, cellPosition, column, value);
        });
      });
    }
    if (replaceChildren(db, 'import_resolutions', 'import_batch_id', batch.id, before?.resolutions, batch.resolutions)) {
      batch.resolutions.forEach((resolution, resolutionPosition) => resolutionInsert.run(
        batch.id, resolutionPosition, resolution.entity, resolution.action,
        resolution.field ?? null, resolution.semesterName ?? null,
        resolution.memberName ?? null, resolution.courseName ?? null,
        resolution.applicationOrder ?? null, resolution.warningDigest ?? null,
        resolution.acknowledgementNote ?? null,
      ));
    }
    if (replaceChildren(db, 'import_receipts', 'import_batch_id', batch.id, before?.receipt, batch.receipt) && batch.receipt) receiptInsert.run(
      batch.id, batch.receipt.receiptId, batch.receipt.previewId, batch.receipt.storeEpoch,
      batch.receipt.idempotencyKey, batch.receipt.requestHash, batch.receipt.inserted,
      batch.receipt.updated, batch.receipt.skipped, batch.receipt.committedAt,
    );
  });
};

const writeDrafts = (db: DatabaseSync, drafts: Draft[], items: DraftItem[], previous?: DatabaseState): void => {
  const draftInsert = prepareRow(db, 'allocation_drafts',
    `id, position, semester_id, status, revision, mode, policy_id, policy_version, engine_version,
      random_seed, source_revision, input_fingerprint, created_at, updated_at, finalized_at,
      enrollment_report_downloaded_at, enrollment_report_store_revision`);
  const policyInsert = db.prepare(`INSERT INTO allocation_draft_policy_settings
    (allocation_draft_id, preference_mode, fallback_mode) VALUES (?, ?, ?)`);
  const snapshotSemesterInsert = db.prepare(`INSERT INTO allocation_snapshot_semesters
    (allocation_draft_id, semester_id, name, semester_order) VALUES (?, ?, ?, ?)`);
  const snapshotCourseInsert = db.prepare(`INSERT INTO allocation_snapshot_semester_courses
    (allocation_draft_id, position, semester_course_id, course_id, course_name, capacity)
    VALUES (?, ?, ?, ?, ?, ?)`);
  const snapshotApplicationInsert = db.prepare(`INSERT INTO allocation_snapshot_applications
    (allocation_draft_id, position, application_id, member_id, member_name, application_order,
      application_order_status) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const snapshotChoiceInsert = db.prepare(`INSERT INTO allocation_snapshot_choices
    (allocation_draft_id, position, choice_id, application_id, semester_course_id, preference)
    VALUES (?, ?, ?, ?, ?, ?)`);
  const snapshotPastInsert = db.prepare(`INSERT INTO allocation_snapshot_past_enrollments
    (allocation_draft_id, position, enrollment_id, member_id, course_id, semester_id, semester_order)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const snapshotExistingInsert = db.prepare(`INSERT INTO allocation_snapshot_existing_enrollments
    (allocation_draft_id, position, enrollment_id, member_id, member_name, semester_course_id)
    VALUES (?, ?, ?, ?, ?, ?)`);
  const finalizationInsert = db.prepare(`INSERT INTO allocation_finalizations
    (allocation_draft_id, idempotency_key, request_hash) VALUES (?, ?, ?)`);
  const finalizationReceiptInsert = db.prepare(`INSERT INTO allocation_finalization_receipts
    (allocation_draft_id, receipt_id, created_count, finalized_at) VALUES (?, ?, ?, ?)`);
  const finalizationEnrollmentInsert = db.prepare(`INSERT INTO allocation_finalization_enrollment_ids
    (allocation_draft_id, position, enrollment_id) VALUES (?, ?, ?)`);
  const finalizationWarningInsert = db.prepare(`INSERT INTO allocation_finalization_warnings
    (allocation_draft_id, position, code, message, severity, subject_entity_type, subject_entity_id,
      subject_member_id, subject_course_id, change_code, note, acknowledged_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  changedRecords(drafts, previous?.allocationDrafts).forEach(({ item: draft, position, before }) => {
    draftInsert.run(draft.id, position, draft.semesterId, draft.status,
      draft.revision, draft.mode, draft.policyId, draft.policyVersion,
      draft.engineVersion, draft.randomSeed, draft.sourceRevision,
      draft.inputFingerprint, draft.createdAt, draft.updatedAt, draft.finalizedAt,
      draft.enrollmentReportDownloadedAt, draft.enrollmentReportStoreRevision);
    if (replaceChildren(db, 'allocation_draft_policy_settings', 'allocation_draft_id', draft.id, before?.policySettings, draft.policySettings)) {
      policyInsert.run(draft.id, draft.policySettings.preferenceMode, draft.policySettings.fallbackMode);
    }
    if (replaceChildren(db, 'allocation_snapshot_semesters', 'allocation_draft_id', draft.id, before?.inputSnapshot.semester, draft.inputSnapshot.semester)) {
      snapshotSemesterInsert.run(draft.id, draft.inputSnapshot.semester.id, draft.inputSnapshot.semester.name,
        draft.inputSnapshot.semester.order);
    }
    if (replaceChildren(db, 'allocation_snapshot_semester_courses', 'allocation_draft_id', draft.id,
      before?.inputSnapshot.semesterCourses, draft.inputSnapshot.semesterCourses)) draft.inputSnapshot.semesterCourses.forEach((item, itemPosition) => snapshotCourseInsert.run(
      draft.id, itemPosition, item.id, item.courseId, item.courseName, item.capacity,
    ));
    if (replaceChildren(db, 'allocation_snapshot_applications', 'allocation_draft_id', draft.id,
      before?.inputSnapshot.applications, draft.inputSnapshot.applications)) draft.inputSnapshot.applications.forEach((item, itemPosition) => snapshotApplicationInsert.run(
      draft.id, itemPosition, item.id, item.memberId, item.memberName,
      item.applicationOrder, item.applicationOrderStatus,
    ));
    if (replaceChildren(db, 'allocation_snapshot_choices', 'allocation_draft_id', draft.id,
      before?.inputSnapshot.choices, draft.inputSnapshot.choices)) draft.inputSnapshot.choices.forEach((item, itemPosition) => snapshotChoiceInsert.run(
      draft.id, itemPosition, item.id, item.applicationId, item.semesterCourseId, item.preference,
    ));
    if (replaceChildren(db, 'allocation_snapshot_past_enrollments', 'allocation_draft_id', draft.id,
      before?.inputSnapshot.relevantPastEnrollments, draft.inputSnapshot.relevantPastEnrollments)) draft.inputSnapshot.relevantPastEnrollments.forEach((item, itemPosition) => snapshotPastInsert.run(
      draft.id, itemPosition, item.id, item.memberId, item.courseId, item.semesterId, item.semesterOrder,
    ));
    if (replaceChildren(db, 'allocation_snapshot_existing_enrollments', 'allocation_draft_id', draft.id,
      before?.inputSnapshot.existingEnrollments, draft.inputSnapshot.existingEnrollments)) draft.inputSnapshot.existingEnrollments.forEach((item, itemPosition) => snapshotExistingInsert.run(
      draft.id, itemPosition, item.id, item.memberId, item.memberName, item.semesterCourseId,
    ));

    if (!replaceChildren(db, 'allocation_finalizations', 'allocation_draft_id', draft.id,
      before?.finalization, draft.finalization) || !draft.finalization) return;
    const receipt = draft.finalization.receipt;
    finalizationInsert.run(draft.id, draft.finalization.idempotencyKey, draft.finalization.requestHash);
    finalizationReceiptInsert.run(draft.id, receipt.receiptId, receipt.createdCount, receipt.finalizedAt);
    receipt.createdEnrollmentIds.forEach((id, itemPosition) => {
      finalizationEnrollmentInsert.run(draft.id, itemPosition, id);
    });
    draft.finalization.acknowledgedWarnings.forEach((warning, itemPosition) => {
      finalizationWarningInsert.run(
        draft.id, itemPosition, warning.code, warning.message, warning.severity,
        warning.subject.entityType, warning.subject.entityId ?? null, warning.subject.memberId ?? null,
        warning.subject.courseId ?? null, warning.detail.changeCode ?? null,
        warning.note, warning.acknowledgedAt,
      );
    });
  });

  const itemInsert = prepareRow(db, 'allocation_draft_items',
    `id, position, allocation_draft_id, member_id, source_application_id, member_name_at_generation,
      auto_semester_course_id, auto_decision, auto_reason_code, final_semester_course_id,
      final_decision, final_reason_code, updated_at`);
  const attemptInsert = db.prepare(`INSERT INTO allocation_item_preference_attempts
    (allocation_draft_item_id, position, choice_id_at_generation, semester_course_id,
      course_name_at_generation, preference, decision, reason_code) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  const fallbackInsert = db.prepare(`INSERT INTO allocation_item_fallbacks
    (allocation_draft_item_id, selected_semester_course_id, reason_code, total_assigned_in_stage)
    VALUES (?, ?, ?, ?)`);
  const fallbackCandidateInsert = db.prepare(`INSERT INTO allocation_item_fallback_candidates
    (allocation_draft_item_id, position, semester_course_id) VALUES (?, ?, ?)`);
  const finalReasonInsert = db.prepare(`INSERT INTO allocation_item_final_reasons
    (allocation_draft_item_id, note) VALUES (?, ?)`);
  const draftIds = items === previous?.allocationDraftItems ? null : new Set(drafts.map((draft) => draft.id));
  const changedItems = changedRecords(items, previous?.allocationDraftItems,
    (item) => draftIds !== null && !draftIds.has(item.draftId));
  changedItems.forEach(({ item, position, before }) => {
    itemInsert.run(item.id, position, item.draftId, item.memberId, item.sourceApplicationId,
      item.memberNameAtGeneration, item.autoSemesterCourseId, item.autoDecision,
      item.autoReasonCode, item.finalSemesterCourseId, item.finalDecision,
      item.finalReasonCode, item.updatedAt);
    if (replaceChildren(db, 'allocation_item_preference_attempts', 'allocation_draft_item_id', item.id,
      before?.autoReasonDetail.preferenceAttempts, item.autoReasonDetail.preferenceAttempts)) item.autoReasonDetail.preferenceAttempts.forEach((attempt, itemPosition) => attemptInsert.run(
      item.id, itemPosition, attempt.choiceIdAtGeneration, attempt.semesterCourseId,
      attempt.courseNameAtGeneration, attempt.preference, attempt.decision, attempt.reasonCode,
    ));
    const fallback = item.autoReasonDetail.fallback;
    if (replaceChildren(db, 'allocation_item_fallbacks', 'allocation_draft_item_id', item.id,
      before?.autoReasonDetail.fallback, fallback) && fallback) {
      fallbackInsert.run(item.id, fallback.selectedSemesterCourseId, fallback.reasonCode, fallback.totalAssignedInStage);
      fallback.stageCandidateSemesterCourseIds.forEach((id, itemPosition) => {
        fallbackCandidateInsert.run(item.id, itemPosition, id);
      });
    }
    if (replaceChildren(db, 'allocation_item_final_reasons', 'allocation_draft_item_id', item.id,
      before?.finalReasonDetail, item.finalReasonDetail) && item.finalReasonDetail) finalReasonInsert.run(item.id, item.finalReasonDetail.note);
  });
};

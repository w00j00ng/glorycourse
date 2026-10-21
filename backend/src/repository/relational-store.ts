import * as allocationDraftsTable from './allocation-drafts.ts';
import * as allocationFinalizationsTable from './allocation-finalizations.ts';
import * as allocationFinalizationWarningsTable from './allocation-finalization-warnings.ts';
import * as allocationFinalizationReceiptsTable from './allocation-finalization-receipts.ts';
import * as allocationFinalizationEnrollmentIdsTable from './allocation-finalization-enrollment-ids.ts';
import * as allocationDraftItemsTable from './allocation-draft-items.ts';
import * as allocationItemFinalReasonsTable from './allocation-item-final-reasons.ts';
import * as allocationItemFallbacksTable from './allocation-item-fallbacks.ts';
import * as allocationItemFallbackCandidatesTable from './allocation-item-fallback-candidates.ts';
import * as allocationItemPreferenceAttemptsTable from './allocation-item-preference-attempts.ts';
import * as allocationSnapshotExistingEnrollmentsTable from './allocation-snapshot-existing-enrollments.ts';
import * as allocationSnapshotPastEnrollmentsTable from './allocation-snapshot-past-enrollments.ts';
import * as allocationSnapshotChoicesTable from './allocation-snapshot-choices.ts';
import * as allocationSnapshotApplicationsTable from './allocation-snapshot-applications.ts';
import * as allocationSnapshotSemesterCoursesTable from './allocation-snapshot-semester-courses.ts';
import * as allocationSnapshotSemestersTable from './allocation-snapshot-semesters.ts';
import * as allocationDraftPolicySettingsTable from './allocation-draft-policy-settings.ts';
import * as importBatchesTable from './import-batches.ts';
import * as importReceiptsTable from './import-receipts.ts';
import * as importResolutionsTable from './import-resolutions.ts';
import * as importRawRowsTable from './import-raw-rows.ts';
import * as importRawCellsTable from './import-raw-cells.ts';
import * as finalizationReceiptsTable from './finalization-receipts.ts';
import * as finalizationReceiptEnrollmentIdsTable from './finalization-receipt-enrollment-ids.ts';
import * as restoreReceiptsTable from './restore-receipts.ts';
import * as enrollmentsTable from './enrollments.ts';
import * as enrollmentAcknowledgementsTable from './enrollment-acknowledgements.ts';
import * as applicationChoicesTable from './application-choices.ts';
import * as applicationsTable from './applications.ts';
import * as applicationChoiceSourceRefsTable from './application-choice-source-refs.ts';
import * as semesterCoursesTable from './semester-courses.ts';
import * as coursesTable from './courses.ts';
import * as membersTable from './members.ts';
import * as semestersTable from './semesters.ts';
import * as storeMetaTable from './store-meta.ts';
import { DatabaseSync } from 'node:sqlite';
import { changedRecords } from './row-changes.ts';
import type { AllocationDraftItemRecord as DraftItem, AllocationDraftRecord as Draft, DatabaseState, ImportBatchRecord as ImportBatch } from '../domain/records.ts';
type RawRow = ImportBatch['rawRows'][number];
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
  if (db.prepare('PRAGMA application_id').get()?.application_id !== 0x47434f55) {
    throw new Error('Unsupported Glorycourse SQLite database');
  }
  const meta = storeMetaTable.readSnapshotRow(db);
  if (!meta) throw new Error('SQLite store metadata is missing');

  const semesters = semestersTable.readSnapshotRows(db);
  const members = membersTable.readSnapshotRows(db);
  const courses = coursesTable.readSnapshotRows(db);
  const semesterCourses = semesterCoursesTable.readSnapshotRows(db);

  const sourceRefs = group(applicationChoiceSourceRefsTable.readSnapshotRows(db));
  const applications = applicationsTable.readSnapshotRows(db);
  const applicationChoices = applicationChoicesTable.readSnapshotRows(db).map((item) => ({ ...item, sourceRefs: sourceRefs.get(item.id) ?? [] }));

  const acknowledgements = new Map(enrollmentAcknowledgementsTable.readSnapshotRows(db)
    .map(({ enrollmentId, ...item }) => [enrollmentId, item]));
  const enrollments = enrollmentsTable.readSnapshotRows(db).map((item) => ({
    ...item, exceptionAcknowledgement: acknowledgements.get(item.id) ?? null,
  }));

  const importBatches = readImportBatches(db);
  const restoreReceipts = restoreReceiptsTable.readSnapshotRows(db);
  const receiptEnrollmentIds = group(finalizationReceiptEnrollmentIdsTable.readSnapshotRows(db));
  const finalizationReceipts = finalizationReceiptsTable.readSnapshotRows(db).map(({ draftId, receiptId, createdCount, finalizedAt, ...record }) => ({
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

export const readImportBatches = (db: DatabaseSync, batchId: string | null = null): ImportBatch[] => {
  const cells = new Map<string, Record<string, string | null>>();
  for (const row of importRawCellsTable.readSnapshotRows(db, batchId)) {
    const key = `${row.batchId}\0${row.rowPosition}`;
    cells.set(key, { ...(cells.get(key) ?? {}), [row.columnName]: row.cellValue });
  }
  const rawRows = group(importRawRowsTable.readSnapshotRows(db, batchId).map(({ parentId, position, sheet, row }) => ({
    parentId, sheet, row, cells: cells.get(`${parentId}\0${position}`) ?? {},
  })));
  const resolutions = group(importResolutionsTable.readSnapshotRows(db, batchId)
    .map(compact));
  const receipts = new Map(importReceiptsTable.readSnapshotRows(db, batchId).map((item) => [item.importBatchId, item]));
  return importBatchesTable.readSnapshotRows(db, batchId).map((batch) => ({
    ...batch,
    rawRows: (rawRows.get(batch.id) as RawRow[] | undefined) ?? [],
    resolutions: resolutions.get(batch.id) ?? [],
    receipt: receipts.get(batch.id) ?? null,
  }));
};

export const readDrafts = (db: DatabaseSync, draftId: string | null = null): { drafts: Draft[]; items: DraftItem[] } => {
  const policy = new Map(allocationDraftPolicySettingsTable.readSnapshotRows(db, draftId)
    .map(({ draftId, ...item }) => [draftId, item]));
  const snapshotSemester = new Map(allocationSnapshotSemestersTable.readSnapshotRows(db, draftId)
    .map(({ draftId, ...item }) => [draftId, item]));
  const snapshotCourses = group(allocationSnapshotSemesterCoursesTable.readSnapshotRows(db, draftId));
  const snapshotApplications = group(allocationSnapshotApplicationsTable.readSnapshotRows(db, draftId));
  const snapshotChoices = group(allocationSnapshotChoicesTable.readSnapshotRows(db, draftId));
  const snapshotPast = group(allocationSnapshotPastEnrollmentsTable.readSnapshotRows(db, draftId));
  const snapshotExisting = group(allocationSnapshotExistingEnrollmentsTable.readSnapshotRows(db, draftId));

  const attempts = group(allocationItemPreferenceAttemptsTable.readSnapshotRows(db, draftId));
  const fallbackCandidates = group(allocationItemFallbackCandidatesTable.readSnapshotRows(db, draftId));
  const fallbacks = new Map(allocationItemFallbacksTable.readSnapshotRows(db, draftId).map(({ itemId, ...item }) => [
    itemId,
    { ...item, stageCandidateSemesterCourseIds: (fallbackCandidates.get(itemId) ?? []).map(({ semesterCourseId }) => semesterCourseId) },
  ]));
  const finalReasons = new Map(allocationItemFinalReasonsTable.readSnapshotRows(db, draftId).map(({ itemId, note }) => [itemId, { note }]));
  const items = allocationDraftItemsTable.readSnapshotRows(db, draftId).map((item) => ({
    ...item,
    autoReasonDetail: { preferenceAttempts: attempts.get(item.id) ?? [], fallback: fallbacks.get(item.id) ?? null },
    finalReasonDetail: finalReasons.get(item.id) ?? null,
  })) as DraftItem[];

  const enrollmentIds = group(allocationFinalizationEnrollmentIdsTable.readSnapshotRows(db, draftId));
  const receipts = new Map(allocationFinalizationReceiptsTable.readSnapshotRows(db, draftId).map(({ draftId, ...item }) => [draftId, {
    ...item, draftId, createdEnrollmentIds: (enrollmentIds.get(draftId) ?? []).map(({ enrollmentId }) => enrollmentId),
  }]));
  const warnings = group(allocationFinalizationWarningsTable.readSnapshotRows(db, draftId).map(({ parentId, subjectEntityType, subjectEntityId, subjectMemberId,
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
  const finalizations = new Map(allocationFinalizationsTable.readSnapshotRows(db, draftId)
    .map(({ draftId, ...item }) => [draftId, {
      ...item, receipt: receipts.get(draftId), acknowledgedWarnings: warnings.get(draftId) ?? [],
    }]));

  const drafts = allocationDraftsTable.readSnapshotRows(db, draftId).map((draft) => ({
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
  if (!previous && storeMetaTable.prepareSnapshotPresence(db).get()) {
    throw new Error('Previous store state is required to replace a populated database');
  }
  if (previous) {
    enrollmentsTable.prepareSnapshotChanges(db, data.enrollments, previous.enrollments);
    allocationDraftItemsTable.prepareSnapshotChanges(db, data.allocationDraftItems, previous.allocationDraftItems);
    allocationDraftsTable.prepareSnapshotChanges(db, data.allocationDrafts, previous.allocationDrafts);
    finalizationReceiptsTable.prepareSnapshotChanges(db, data.finalizationReceipts, previous.finalizationReceipts);
    applicationChoicesTable.prepareSnapshotChanges(db, data.applicationChoices, previous.applicationChoices);
    applicationsTable.prepareSnapshotChanges(db, data.applications, previous.applications);
    importBatchesTable.prepareSnapshotChanges(db, data.importBatches, previous.importBatches);
    semesterCoursesTable.prepareSnapshotChanges(db, data.semesterCourses, previous.semesterCourses);
    semestersTable.prepareSnapshotChanges(db, data.semesters, previous.semesters);
    membersTable.prepareSnapshotChanges(db, data.members, previous.members);
    coursesTable.prepareSnapshotChanges(db, data.courses, previous.courses);
    restoreReceiptsTable.prepareSnapshotChanges(db, data.restoreReceipts, previous.restoreReceipts);
  }
  storeMetaTable.prepareSnapshotWrite(db)
    .run(1, data.meta.storeEpoch, data.meta.storeRevision);

  const receiptInsert = restoreReceiptsTable.prepareSnapshotWrite(db);
  changedRecords(data.restoreReceipts, previous?.restoreReceipts).forEach(({ item, position }) => receiptInsert.run(
    item.idempotencyKey, position, item.requestHash, item.receiptId, item.previousBackupId,
    item.storeRevision, item.storeEpoch, item.restoredAt,
  ));

  const semesterInsert = semestersTable.prepareSnapshotWrite(db);
  changedRecords(data.semesters, previous?.semesters).forEach(({ item, position }) => semesterInsert.run(
    item.id, position, item.name, item.nameKey, item.order, item.allocationInputRevision, item.createdAt, item.updatedAt,
  ));
  const finalizationInsert = finalizationReceiptsTable.prepareSnapshotWrite(db);
  const finalizationEnrollmentInsert = finalizationReceiptEnrollmentIdsTable.prepareSnapshotInsert(db);
  changedRecords(data.finalizationReceipts, previous?.finalizationReceipts).forEach(({ item: record, position, before }) => {
    const { receipt } = record;
    finalizationInsert.run(record.idempotencyKey, position, record.requestHash, record.semesterId, receipt.draftId,
      receipt.receiptId, receipt.createdCount, receipt.finalizedAt,
      record.enrollmentReportDownloadedAt, record.enrollmentReportStoreRevision);
    if (finalizationReceiptEnrollmentIdsTable.replaceSnapshotChildren(db, record.idempotencyKey, before?.receipt.createdEnrollmentIds, receipt.createdEnrollmentIds)) {
      receipt.createdEnrollmentIds.forEach((id, position) => finalizationEnrollmentInsert.run(record.idempotencyKey, position, id));
    }
  });
  const memberInsert = membersTable.prepareSnapshotWrite(db);
  const courseInsert = coursesTable.prepareSnapshotWrite(db);
  changedRecords(data.members, previous?.members).forEach(({ item, position }) => memberInsert.run(
    item.id, position, item.name, item.nameKey, item.createdAt, item.updatedAt,
  ));
  changedRecords(data.courses, previous?.courses).forEach(({ item, position }) => courseInsert.run(
    item.id, position, item.name, item.nameKey, item.createdAt, item.updatedAt,
  ));
  const semesterCourseInsert = semesterCoursesTable.prepareSnapshotWrite(db);
  changedRecords(data.semesterCourses, previous?.semesterCourses).forEach(({ item, position }) => semesterCourseInsert.run(
    item.id, position, item.semesterId, item.courseId, item.capacity, item.createdAt, item.updatedAt,
  ));

  writeImportBatches(db, data.importBatches, previous?.importBatches);

  const applicationInsert = applicationsTable.prepareSnapshotWrite(db);
  changedRecords(data.applications, previous?.applications).forEach(({ item, position }) => applicationInsert.run(
    item.id, position, item.semesterId, item.memberId, item.applicationOrder, item.applicationOrderStatus,
    item.orderResolution, item.orderResolutionNote, item.revision, item.createdAt, item.updatedAt, item.ministry, item.applicantNote ?? null,
  ));
  const choiceInsert = applicationChoicesTable.prepareSnapshotWrite(db);
  const sourceInsert = applicationChoiceSourceRefsTable.prepareSnapshotInsert(db);
  const applicationIds = data.applicationChoices === previous?.applicationChoices
    ? null : new Set(data.applications.map((item) => item.id));
  const changedChoices = changedRecords(data.applicationChoices, previous?.applicationChoices,
    (item) => applicationIds !== null && !applicationIds.has(item.applicationId));
  changedChoices.forEach(({ item, position, before }) => {
    choiceInsert.run(item.id, position, item.applicationId, item.semesterCourseId, item.preference, item.createdAt, item.updatedAt);
    if (applicationChoiceSourceRefsTable.replaceSnapshotChildren(db, item.id, before?.sourceRefs, item.sourceRefs)) {
      item.sourceRefs.forEach((source, sourcePosition) => sourceInsert.run(
        item.id, sourcePosition, source.importBatchId, source.sheet, source.row,
      ));
    }
  });

  writeDrafts(db, data.allocationDrafts, data.allocationDraftItems, previous);

  const enrollmentInsert = enrollmentsTable.prepareSnapshotWrite(db);
  const acknowledgementInsert = enrollmentAcknowledgementsTable.prepareSnapshotInsert(db);
  changedRecords(data.enrollments, previous?.enrollments).forEach(({ item, position, before }) => {
    enrollmentInsert.run(item.id, position, item.semesterCourseId, item.memberId,
      item.revision, item.createdAt, item.updatedAt, item.ministry);
    if (enrollmentAcknowledgementsTable.replaceSnapshotChildren(db, item.id, before?.exceptionAcknowledgement, item.exceptionAcknowledgement) && item.exceptionAcknowledgement) acknowledgementInsert.run(
      item.id, item.exceptionAcknowledgement.warningDigest, item.exceptionAcknowledgement.note,
      item.exceptionAcknowledgement.acknowledgedAt,
    );
  });
};

export const writeImportBatches = (db: DatabaseSync, batches: ImportBatch[], previous?: ImportBatch[]): void => {
  const batchInsert = importBatchesTable.prepareSnapshotWrite(db);
  const rowInsert = importRawRowsTable.prepareSnapshotInsert(db);
  const cellInsert = importRawCellsTable.prepareSnapshotInsert(db);
  const resolutionInsert = importResolutionsTable.prepareSnapshotInsert(db);
  const receiptInsert = importReceiptsTable.prepareSnapshotInsert(db);
  changedRecords(batches, previous).forEach(({ item: batch, position, before }) => {
    batchInsert.run(batch.id, position, batch.kind, batch.templateVersion, batch.fileHash, batch.importedAt, batch.status);
    if (importRawRowsTable.replaceSnapshotChildren(db, batch.id, before?.rawRows, batch.rawRows)) {
      batch.rawRows.forEach((row, rowPosition) => {
        rowInsert.run(batch.id, rowPosition, row.sheet, row.row);
        Object.entries(row.cells).forEach(([column, value], cellPosition) => {
          cellInsert.run(batch.id, rowPosition, cellPosition, column, value);
        });
      });
    }
    if (importResolutionsTable.replaceSnapshotChildren(db, batch.id, before?.resolutions, batch.resolutions)) {
      batch.resolutions.forEach((resolution, resolutionPosition) => resolutionInsert.run(
        batch.id, resolutionPosition, resolution.entity, resolution.action,
        resolution.field ?? null, resolution.semesterName ?? null,
        resolution.memberName ?? null, resolution.courseName ?? null,
        resolution.applicationOrder ?? null, resolution.warningDigest ?? null,
        resolution.acknowledgementNote ?? null,
      ));
    }
    if (importReceiptsTable.replaceSnapshotChildren(db, batch.id, before?.receipt, batch.receipt) && batch.receipt) receiptInsert.run(
      batch.id, batch.receipt.receiptId, batch.receipt.previewId, batch.receipt.storeEpoch,
      batch.receipt.idempotencyKey, batch.receipt.requestHash, batch.receipt.inserted,
      batch.receipt.updated, batch.receipt.skipped, batch.receipt.committedAt,
    );
  });
};

export const writeDrafts = (
  db: DatabaseSync,
  drafts: Draft[],
  items: DraftItem[],
  previous?: Pick<DatabaseState, 'allocationDrafts' | 'allocationDraftItems'>,
  positions?: { draftPositions: ReadonlyMap<string, number>; itemPositions: ReadonlyMap<string, number> },
): void => {
  const draftInsert = allocationDraftsTable.prepareSnapshotWrite(db);
  const policyInsert = allocationDraftPolicySettingsTable.prepareSnapshotInsert(db);
  const snapshotSemesterInsert = allocationSnapshotSemestersTable.prepareSnapshotInsert(db);
  const snapshotCourseInsert = allocationSnapshotSemesterCoursesTable.prepareSnapshotInsert(db);
  const snapshotApplicationInsert = allocationSnapshotApplicationsTable.prepareSnapshotInsert(db);
  const snapshotChoiceInsert = allocationSnapshotChoicesTable.prepareSnapshotInsert(db);
  const snapshotPastInsert = allocationSnapshotPastEnrollmentsTable.prepareSnapshotInsert(db);
  const snapshotExistingInsert = allocationSnapshotExistingEnrollmentsTable.prepareSnapshotInsert(db);
  const finalizationInsert = allocationFinalizationsTable.prepareSnapshotInsert(db);
  const finalizationReceiptInsert = allocationFinalizationReceiptsTable.prepareSnapshotInsert(db);
  const finalizationEnrollmentInsert = allocationFinalizationEnrollmentIdsTable.prepareSnapshotInsert(db);
  const finalizationWarningInsert = allocationFinalizationWarningsTable.prepareSnapshotInsert(db);

  changedRecords(drafts, previous?.allocationDrafts).forEach(({ item: draft, position, before }) => {
    draftInsert.run(draft.id, positions?.draftPositions.get(draft.id) ?? position, draft.semesterId, draft.status,
      draft.revision, draft.mode, draft.policyId, draft.policyVersion,
      draft.engineVersion, draft.randomSeed, draft.sourceRevision,
      draft.inputFingerprint, draft.createdAt, draft.updatedAt, draft.finalizedAt,
      draft.enrollmentReportDownloadedAt, draft.enrollmentReportStoreRevision);
    if (allocationDraftPolicySettingsTable.replaceSnapshotChildren(db, draft.id, before?.policySettings, draft.policySettings)) {
      policyInsert.run(draft.id, draft.policySettings.preferenceMode, draft.policySettings.fallbackMode);
    }
    if (allocationSnapshotSemestersTable.replaceSnapshotChildren(db, draft.id, before?.inputSnapshot.semester, draft.inputSnapshot.semester)) {
      snapshotSemesterInsert.run(draft.id, draft.inputSnapshot.semester.id, draft.inputSnapshot.semester.name,
        draft.inputSnapshot.semester.order);
    }
    if (allocationSnapshotSemesterCoursesTable.replaceSnapshotChildren(db, draft.id, before?.inputSnapshot.semesterCourses, draft.inputSnapshot.semesterCourses)) draft.inputSnapshot.semesterCourses.forEach((item, itemPosition) => snapshotCourseInsert.run(
      draft.id, itemPosition, item.id, item.courseId, item.courseName, item.capacity,
    ));
    if (allocationSnapshotApplicationsTable.replaceSnapshotChildren(db, draft.id, before?.inputSnapshot.applications, draft.inputSnapshot.applications)) draft.inputSnapshot.applications.forEach((item, itemPosition) => snapshotApplicationInsert.run(
      draft.id, itemPosition, item.id, item.memberId, item.memberName,
      item.applicationOrder, item.applicationOrderStatus, item.ministry, item.applicantNote ?? null,
    ));
    if (allocationSnapshotChoicesTable.replaceSnapshotChildren(db, draft.id, before?.inputSnapshot.choices, draft.inputSnapshot.choices)) draft.inputSnapshot.choices.forEach((item, itemPosition) => snapshotChoiceInsert.run(
      draft.id, itemPosition, item.id, item.applicationId, item.semesterCourseId, item.preference,
    ));
    if (allocationSnapshotPastEnrollmentsTable.replaceSnapshotChildren(db, draft.id, before?.inputSnapshot.relevantPastEnrollments, draft.inputSnapshot.relevantPastEnrollments)) draft.inputSnapshot.relevantPastEnrollments.forEach((item, itemPosition) => snapshotPastInsert.run(
      draft.id, itemPosition, item.id, item.memberId, item.courseId, item.semesterId, item.semesterOrder,
    ));
    if (allocationSnapshotExistingEnrollmentsTable.replaceSnapshotChildren(db, draft.id, before?.inputSnapshot.existingEnrollments, draft.inputSnapshot.existingEnrollments)) draft.inputSnapshot.existingEnrollments.forEach((item, itemPosition) => snapshotExistingInsert.run(
      draft.id, itemPosition, item.id, item.memberId, item.memberName, item.semesterCourseId, item.ministry,
    ));

    if (!allocationFinalizationsTable.replaceSnapshotChildren(db, draft.id, before?.finalization, draft.finalization) || !draft.finalization) return;
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

  const itemInsert = allocationDraftItemsTable.prepareSnapshotWrite(db);
  const attemptInsert = allocationItemPreferenceAttemptsTable.prepareSnapshotInsert(db);
  const fallbackInsert = allocationItemFallbacksTable.prepareSnapshotInsert(db);
  const fallbackCandidateInsert = allocationItemFallbackCandidatesTable.prepareSnapshotInsert(db);
  const finalReasonInsert = allocationItemFinalReasonsTable.prepareSnapshotInsert(db);
  const draftIds = items === previous?.allocationDraftItems ? null : new Set(drafts.map((draft) => draft.id));
  const changedItems = changedRecords(items, previous?.allocationDraftItems,
    (item) => draftIds !== null && !draftIds.has(item.draftId));
  changedItems.forEach(({ item, position, before }) => {
    itemInsert.run(item.id, positions?.itemPositions.get(item.id) ?? position, item.draftId, item.memberId, item.sourceApplicationId,
      item.memberNameAtGeneration, item.autoSemesterCourseId, item.autoDecision,
      item.autoReasonCode, item.finalSemesterCourseId, item.finalDecision,
      item.finalReasonCode, item.updatedAt, item.ministry);
    if (allocationItemPreferenceAttemptsTable.replaceSnapshotChildren(db, item.id, before?.autoReasonDetail.preferenceAttempts, item.autoReasonDetail.preferenceAttempts)) item.autoReasonDetail.preferenceAttempts.forEach((attempt, itemPosition) => attemptInsert.run(
      item.id, itemPosition, attempt.choiceIdAtGeneration, attempt.semesterCourseId,
      attempt.courseNameAtGeneration, attempt.preference, attempt.decision, attempt.reasonCode,
    ));
    const fallback = item.autoReasonDetail.fallback;
    if (allocationItemFallbacksTable.replaceSnapshotChildren(db, item.id, before?.autoReasonDetail.fallback, fallback) && fallback) {
      fallbackInsert.run(item.id, fallback.selectedSemesterCourseId, fallback.reasonCode, fallback.totalAssignedInStage);
      fallback.stageCandidateSemesterCourseIds.forEach((id, itemPosition) => {
        fallbackCandidateInsert.run(item.id, itemPosition, id);
      });
    }
    if (allocationItemFinalReasonsTable.replaceSnapshotChildren(db, item.id, before?.finalReasonDetail, item.finalReasonDetail) && item.finalReasonDetail) finalReasonInsert.run(item.id, item.finalReasonDetail.note);
  });
};

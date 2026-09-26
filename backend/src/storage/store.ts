import { isDeepStrictEqual } from 'node:util';
import { current, freeze, Immer, isDraft } from 'immer';

import type { AllocationSnapshot, PolicySettings } from '../allocation/engine.ts';
import { SQLiteAdapter } from './sqlite.ts';
import { migrateDatabase } from './migrations.ts';
import { assertValidStore, assertValidStoreChanges } from './validate-store.ts';

export { assertValidStore, StoreValidationError } from './validate-store.ts';

type Timestamped = { createdAt: string; updatedAt: string };
export type NamedRecord = Timestamped & { id: string; name: string; nameKey: string };
export type SemesterRecord = NamedRecord & { order: number | null; allocationInputRevision: number };
export type SemesterCourseRecord = Timestamped & {
  id: string;
  semesterId: string;
  courseId: string;
  capacity: number | null;
};
export type ApplicationRecord = Timestamped & {
  id: string;
  semesterId: string;
  memberId: string;
  applicationOrder: number | null;
  applicationOrderStatus: 'NORMAL' | 'CONFLICT' | 'MISSING' | 'INVALID';
  orderResolution: 'SOURCE_AGREED' | 'ADMIN_CONFIRMED' | 'UNRESOLVED';
  orderResolutionNote: string | null;
  revision: number;
};
export type ApplicationChoiceRecord = Timestamped & {
  id: string;
  applicationId: string;
  semesterCourseId: string;
  preference: number | null;
  sourceRefs: Array<{ importBatchId: string; sheet: string; row: number }>;
};
export type EnrollmentRecord = Timestamped & {
  id: string;
  semesterCourseId: string;
  memberId: string;
  exceptionAcknowledgement: null | { warningDigest: string; note: string; acknowledgedAt: string };
  revision: number;
};
export type FinalizationWarningRecord = {
  code: string;
  message: string;
  severity: 'WARNING';
  blockingStages: ['FINALIZE'];
  acknowledgementStages: ['FINALIZE'];
  subject: { entityType: string; entityId?: string; memberId?: string; courseId?: string };
  source: { [key: string]: never };
  detail: { changeCode?: string };
  note: string;
  acknowledgedAt: string;
};
export type FinalizationRecord = {
  idempotencyKey: string;
  requestHash: string;
  receipt: {
    receiptId: string;
    draftId: string;
    createdEnrollmentIds: string[];
    createdCount: number;
    finalizedAt: string;
  };
  acknowledgedWarnings: FinalizationWarningRecord[];
};
export type AllocationDraftRecord = {
  id: string;
  semesterId: string;
  status: 'DRAFT' | 'FINALIZED' | 'ARCHIVED';
  revision: number;
  mode: 'AUTO' | 'MANUAL';
  policyId: string;
  policyVersion: string;
  engineVersion: string;
  policySettings: PolicySettings;
  randomSeed: string;
  sourceRevision: number;
  inputFingerprint: string;
  inputSnapshot: AllocationSnapshot;
  createdAt: string;
  updatedAt: string;
  finalizedAt: string | null;
  enrollmentReportDownloadedAt: string | null;
  enrollmentReportStoreRevision: number | null;
  finalization: FinalizationRecord | null;
};
export type FinalizationReceiptRecord = Pick<FinalizationRecord, 'idempotencyKey' | 'requestHash' | 'receipt'> & {
  semesterId: string;
  enrollmentReportDownloadedAt: string | null;
  enrollmentReportStoreRevision: number | null;
};
type PreferenceAttempt = {
  choiceIdAtGeneration: string;
  semesterCourseId: string;
  courseNameAtGeneration: string;
  preference: number;
  decision: 'SELECTED' | 'REJECTED' | 'NOT_EVALUATED';
  reasonCode: string;
};
export type AllocationDraftItemRecord = {
  id: string;
  draftId: string;
  memberId: string;
  sourceApplicationId: string | null;
  memberNameAtGeneration: string;
  autoSemesterCourseId: string | null;
  autoDecision: 'SELECTED' | 'REJECTED' | 'NOT_EVALUATED';
  autoReasonCode: string;
  autoReasonDetail: {
    preferenceAttempts: PreferenceAttempt[];
    fallback: null | {
      stageCandidateSemesterCourseIds: string[];
      selectedSemesterCourseId: string | null;
      reasonCode: string;
      totalAssignedInStage: number;
    };
  };
  finalSemesterCourseId: string | null;
  finalDecision: 'SELECTED' | 'REJECTED';
  finalReasonCode: string | null;
  finalReasonDetail: { note: string } | null;
  updatedAt: string;
};
export type ImportResolutionRecord = {
  entity: 'APPLICATION' | 'ENROLLMENT' | 'SEMESTER' | 'SEMESTER_COURSE';
  action: 'KEEP_EXISTING' | 'REPLACE_APPLICATION' | 'CONFIRM_APPLICATION_ORDER' | 'APPLY_FILE_VALUE' | 'ACKNOWLEDGE_WARNING';
  field?: 'order' | 'capacity';
  semesterName?: string;
  memberName?: string;
  courseName?: string;
  applicationOrder?: number;
  warningDigest?: string;
  acknowledgementNote?: string;
};
export type ImportBatchRecord = {
  id: string;
  kind: 'APPLICATIONS' | 'ENROLLMENTS';
  templateVersion: string;
  fileHash: string;
  importedAt: string;
  status: 'STAGED' | 'APPLIED';
  rawRows: Array<{ sheet: string; row: number; cells: { [column: string]: string | null } }>;
  resolutions: ImportResolutionRecord[];
  receipt: null | {
    receiptId: string;
    importBatchId: string;
    previewId: string;
    storeEpoch: string;
    idempotencyKey: string;
    requestHash: string;
    inserted: number;
    updated: number;
    skipped: number;
    committedAt: string;
  };
};

export type RestoreReceiptRecord = {
  idempotencyKey: string;
  requestHash: string;
  receiptId: string;
  previousBackupId: string;
  storeRevision: number;
  storeEpoch: string;
  restoredAt: string;
};

export type DatabaseState = {
  meta: {
    storeEpoch: string;
    storeRevision: number;
  };
  semesters: SemesterRecord[];
  members: NamedRecord[];
  courses: NamedRecord[];
  semesterCourses: SemesterCourseRecord[];
  applications: ApplicationRecord[];
  applicationChoices: ApplicationChoiceRecord[];
  enrollments: EnrollmentRecord[];
  allocationDrafts: AllocationDraftRecord[];
  allocationDraftItems: AllocationDraftItemRecord[];
  finalizationReceipts: FinalizationReceiptRecord[];
  importBatches: ImportBatchRecord[];
  restoreReceipts: RestoreReceiptRecord[];
};

export type StoreAdapter = {
  read(): Promise<DatabaseState | null>;
  write(data: DatabaseState, previous?: DatabaseState): Promise<void>;
};

export class StoreRevisionConflictError extends Error {
  readonly currentRevision: number;

  constructor(currentRevision: number) {
    super(`Expected store revision does not match current revision ${currentRevision}`);
    this.name = 'StoreRevisionConflictError';
    this.currentRevision = currentRevision;
  }
}

export class StoreEpochConflictError extends Error {
  constructor() {
    super('Expected store epoch does not match current epoch');
    this.name = 'StoreEpochConflictError';
  }
}

export class StoreRecoveryRequiredError extends Error {
  constructor() {
    super('Store state cannot be determined; writes are blocked until recovery');
    this.name = 'StoreRecoveryRequiredError';
  }
}

const drafts = new Immer({ autoFreeze: false });

const detachResult = (value: unknown): unknown => {
  if (isDraft(value)) return current(value);
  if (Array.isArray(value)) return value.map(detachResult);
  if (value && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, detachResult(item)]));
  }
  return value;
};

export const cloneStoreValue = <T>(value: T): T => structuredClone(detachResult(value)) as T;

export class Store {
  #tail = Promise.resolve();
  #recoveryRequired = false;
  private readonly adapter: StoreAdapter;
  private data: DatabaseState;

  private constructor(adapter: StoreAdapter, data: DatabaseState) {
    this.adapter = adapter;
    this.data = freeze(data, true);
  }

  static async open(adapter: StoreAdapter, defaultData: DatabaseState): Promise<Store> {
    const stored = await adapter.read();
    const data = structuredClone(stored ?? defaultData);
    assertValidStore(data);
    if (stored === null) await adapter.write(data);
    return new Store(adapter, data);
  }

  /** The shared snapshot is deeply frozen; writes replace it only after persistence succeeds. */
  read(): DatabaseState {
    return this.data;
  }

  version(): DatabaseState['meta'] {
    return this.data.meta;
  }

  catalog<K extends 'semesters' | 'members' | 'courses'>(key: K): Readonly<DatabaseState[K]> {
    return this.data[key];
  }

  getImportBatch(id: string): Readonly<ImportBatchRecord> | undefined {
    return this.data.importBatches.find((batch) => batch.id === id);
  }

  findImportReceipt(previewId: string, storeEpoch: string, idempotencyKey: string):
    Readonly<NonNullable<ImportBatchRecord['receipt']>> | undefined {
    return this.data.importBatches.find(({ receipt }) => (
      receipt?.previewId === previewId
      && receipt.storeEpoch === storeEpoch
      && receipt.idempotencyKey === idempotencyKey
    ))?.receipt ?? undefined;
  }

  restoreHistory(): ReadonlyArray<Readonly<RestoreReceiptRecord>> {
    return this.data.restoreReceipts;
  }

  write<T>(
    options: { expectedRevision?: number; expectedEpoch?: string },
    command: (candidate: DatabaseState) => T | Promise<T>,
  ): Promise<T> {
    const run = this.#tail.then(() => this.#write(options, command));
    this.#tail = run.then(() => undefined, () => undefined);
    return run;
  }

  restore(
    candidate: DatabaseState,
    options: { expectedRevision: number; expectedEpoch: string; backup: () => Promise<void> },
  ): Promise<void> {
    const run = this.#tail.then(() => this.#restore(candidate, options));
    this.#tail = run.then(() => undefined, () => undefined);
    return run;
  }

  async #write<T>(
    options: { expectedRevision?: number; expectedEpoch?: string },
    command: (candidate: DatabaseState) => T | Promise<T>,
  ): Promise<T> {
    if (this.#recoveryRequired) throw new StoreRecoveryRequiredError();
    if (options.expectedEpoch !== undefined && options.expectedEpoch !== this.data.meta.storeEpoch) {
      throw new StoreEpochConflictError();
    }
    if (
      options.expectedRevision !== undefined
      && options.expectedRevision !== this.data.meta.storeRevision
    ) {
      throw new StoreRevisionConflictError(this.data.meta.storeRevision);
    }

    const before = this.data;
    const draft = drafts.createDraft(before);
    const result = cloneStoreValue(await command(draft));
    draft.meta.storeRevision = before.meta.storeRevision + 1;
    const candidate = drafts.finishDraft(draft);
    assertValidStoreChanges(before, candidate);
    await this.#persist(candidate, before);
    return result;
  }

  async #readAfterFailure(): Promise<DatabaseState | null> {
    try {
      return await this.adapter.read();
    } catch {
      this.#recoveryRequired = true;
      throw new StoreRecoveryRequiredError();
    }
  }

  async #restore(
    input: DatabaseState,
    options: { expectedRevision: number; expectedEpoch: string; backup: () => Promise<void> },
  ): Promise<void> {
    if (options.expectedRevision !== this.data.meta.storeRevision) {
      throw new StoreRevisionConflictError(this.data.meta.storeRevision);
    }
    if (options.expectedEpoch !== this.data.meta.storeEpoch) throw new StoreEpochConflictError();
    const candidate = structuredClone(input);
    assertValidStore(candidate);
    await options.backup();
    await this.#persist(candidate, this.data);
    this.#recoveryRequired = false;
  }

  async #persist(candidate: DatabaseState, previous?: DatabaseState): Promise<void> {
    const before = this.data;
    try {
      await this.adapter.write(candidate, previous);
    } catch (writeError) {
      const disk = await this.#readAfterFailure();
      if (isDeepStrictEqual(disk, before)) throw writeError;
      if (!isDeepStrictEqual(disk, candidate)) {
        this.#recoveryRequired = true;
        throw new StoreRecoveryRequiredError();
      }
    }
    this.data = freeze(candidate, true);
  }
}

export const openStore = async (
  file: string,
  defaultData: DatabaseState,
  options: { backupDirectory?: string; appVersion?: string; onProgress?: (message: string) => void } = {},
): Promise<Store> => {
  await migrateDatabase(file, defaultData, options);
  return Store.open(new SQLiteAdapter(file), defaultData);
};

import type { AllocationItem, AllocationSnapshot, PolicySettings } from '../allocation/engine.ts';
import {
  ALLOCATION_ENGINE_VERSION,
  allocate,
} from '../allocation/engine.ts';
import {
  AllocationSnapshotError,
  allocationFingerprint,
  allocationInputChanges,
  buildAllocationSnapshot,
  type InputChange,
} from '../allocation/snapshot.ts';
import {
  cloneStoreValue,
  type AllocationDraftItemRecord as DraftItemRecord,
  type AllocationDraftRecord as DraftRecord,
  type DatabaseState,
  type Store,
} from '../storage/store.ts';
import { nextSemesterOrder } from './semester-order.ts';

type DraftStatus = 'DRAFT' | 'FINALIZED' | 'ARCHIVED';
type DraftMode = 'AUTO' | 'MANUAL';
type Decision = 'SELECTED' | 'REJECTED';
type FinalReasonDetail = { note: string };
type ManualAllocationItem = {
  memberId: string;
  memberNameAtGeneration: string;
  sourceApplicationId: string;
  autoDecision: 'REJECTED';
  autoSemesterCourseId: null;
  autoReasonCode: 'MANUAL_ONLY';
  autoReasonDetail: { preferenceAttempts: []; fallback: null };
};
type GeneratedAllocationItem = AllocationItem | ManualAllocationItem;

export type CreateDraftInput = {
  semesterId: string;
  mode: DraftMode;
  policyId: string;
  policyVersion: string;
  policySettings: PolicySettings;
  replayFromDraftId?: string;
};

export type DraftItemInput = {
  expectedDraftRevision: number;
  finalDecision: Decision;
  finalSemesterCourseId: string | null;
  finalReasonCode: string | null;
  finalReasonDetail: FinalReasonDetail | null;
};

export type DraftDetail = {
  draft: ReturnType<typeof draftSummary>;
  studentResults: DraftItemRecord[];
  applicationSnapshot: Pick<AllocationSnapshot, 'applications' | 'choices' | 'semesterCourses'>;
  existingEnrollments: AllocationSnapshot['existingEnrollments'];
  courseSummary: ReturnType<typeof summarizeCourses>;
  isStale: boolean;
  inputChanges: InputChange[];
  issues: { code: string; message: string; severity: 'WARNING' }[];
};

export class DraftNotFoundError extends Error {
  constructor(message = 'Allocation draft was not found') {
    super(message);
    this.name = 'DraftNotFoundError';
  }
}

export class DraftValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DraftValidationError';
  }
}

export class DraftRevisionConflictError extends Error {
  readonly currentRevision: number;

  constructor(currentRevision: number) {
    super(`Expected draft revision does not match current revision ${currentRevision}`);
    this.name = 'DraftRevisionConflictError';
    this.currentRevision = currentRevision;
  }
}

export class DraftReadOnlyError extends Error {
  constructor(status: DraftStatus) {
    super(`Allocation draft is read-only in ${status} status`);
    this.name = 'DraftReadOnlyError';
  }
}

export class DraftUnsupportedEngineError extends Error {
  constructor(version: string) {
    super(`Allocation engine version ${version} is not supported`);
    this.name = 'DraftUnsupportedEngineError';
  }
}

type Dependencies = { id: () => string; now: () => Date; seed: () => string };

export class DraftService {
  private readonly store: Store;
  private readonly dependencies: Dependencies;

  constructor(store: Store, dependencies: Dependencies) {
    this.store = store;
    this.dependencies = dependencies;
  }

  async create(input: CreateDraftInput): Promise<DraftDetail> {
    validateCreateInput(input);
    const id = await this.store.write({}, (data) => {
      const replay = input.replayFromDraftId
        ? requireDraft(data, input.replayFromDraftId)
        : undefined;
      if (replay && replay.engineVersion !== ALLOCATION_ENGINE_VERSION) {
        throw new DraftUnsupportedEngineError(replay.engineVersion);
      }
      const semesterId = replay?.semesterId ?? input.semesterId;
      const mode = replay?.mode ?? input.mode;
      const policyId = replay?.policyId ?? input.policyId;
      const policyVersion = replay?.policyVersion ?? input.policyVersion;
      const policySettings = replay?.policySettings ?? input.policySettings;
      const randomSeed = replay?.randomSeed ?? this.dependencies.seed();
      const semester = data.semesters.find(({ id: candidate }) => candidate === semesterId);
      if (!semester && !replay) throw new DraftValidationError('Semester was not found');
      const now = this.dependencies.now().toISOString();
      if (!replay && semester!.order === null) {
        semester!.order = nextSemesterOrder(data.semesters);
        semester!.allocationInputRevision += 1;
        semester!.updatedAt = now;
      }
      const snapshot = replay?.inputSnapshot ?? liveSnapshot(data, semesterId);
      const draft: DraftRecord = {
        id: this.dependencies.id(),
        semesterId,
        status: 'DRAFT',
        revision: 0,
        mode,
        policyId,
        policyVersion,
        engineVersion: ALLOCATION_ENGINE_VERSION,
        policySettings: cloneStoreValue(policySettings),
        randomSeed,
        sourceRevision: replay?.sourceRevision ?? semester!.allocationInputRevision,
        inputFingerprint: allocationFingerprint(snapshot, {
          policyId,
          policyVersion,
          settings: policySettings,
        }),
        inputSnapshot: cloneStoreValue(snapshot),
        createdAt: now,
        updatedAt: now,
        finalizedAt: null,
        enrollmentReportDownloadedAt: null,
        enrollmentReportStoreRevision: null,
        finalization: null,
      };
      const autoItems = mode === 'AUTO'
        ? allocate(snapshot, policySettings, randomSeed).items
        : manualItems(snapshot);
      drafts(data).push(draft);
      draftItems(data).push(...autoItems.map((item) => persistedItem(
        item,
        draft.id,
        this.dependencies.id(),
        now,
      )));
      return draft.id;
    });
    return this.get(id);
  }

  get(id: string): DraftDetail {
    const data = this.store.read();
    const draft = requireDraft(data, id);
    const items = draftItems(data).filter(({ draftId }) => draftId === id);
    let isStale = true;
    let inputChanges: InputChange[] = [{ code: 'INPUT_UNAVAILABLE' }];
    try {
      const current = buildAllocationSnapshot(data, draft.semesterId);
      const currentFingerprint = allocationFingerprint(current, {
        policyId: draft.policyId,
        policyVersion: draft.policyVersion,
        settings: draft.policySettings,
      });
      isStale = currentFingerprint !== draft.inputFingerprint;
      inputChanges = isStale ? allocationInputChanges(draft.inputSnapshot, current) : [];
    } catch (error) {
      if (!(error instanceof AllocationSnapshotError)) throw error;
    }
    return {
      draft: draftSummary(draft, data.meta.storeRevision),
      studentResults: structuredClone(items).sort(byMemberId),
      applicationSnapshot: structuredClone({
        applications: draft.inputSnapshot.applications,
        choices: draft.inputSnapshot.choices,
        semesterCourses: draft.inputSnapshot.semesterCourses,
      }),
      existingEnrollments: structuredClone(draft.inputSnapshot.existingEnrollments),
      courseSummary: summarizeCourses(draft.inputSnapshot, items),
      isStale,
      inputChanges,
      issues: [],
    };
  }

  list(): Array<ReturnType<typeof draftSummary>> {
    const data = this.store.read();
    return drafts(data).filter((draft) => draft.status === 'DRAFT')
      .map((draft) => draftSummary(draft, data.meta.storeRevision)).sort((left, right) => (
      right.createdAt.localeCompare(left.createdAt) || compareId(left.id, right.id)
    ));
  }

  async delete(draftId: string, input: { expectedDraftRevision: number }): Promise<void> {
    requireRevision(input.expectedDraftRevision);
    await this.store.write({}, (data) => {
      const draft = requireDraft(data, draftId);
      if (draft.revision !== input.expectedDraftRevision) {
        throw new DraftRevisionConflictError(draft.revision);
      }
      data.allocationDrafts = drafts(data).filter(({ id }) => id !== draftId);
      data.allocationDraftItems = draftItems(data).filter(({ draftId: id }) => id !== draftId);
    });
  }

  async updateItem(draftId: string, memberId: string, input: DraftItemInput): Promise<DraftDetail> {
    validateItemInput(input);
    await this.store.write({}, (data) => {
      const draft = editableDraft(data, draftId, input.expectedDraftRevision);
      validateSelectedCourse(data, draft, input.finalDecision, input.finalSemesterCourseId);
      const item = draftItems(data).find((candidate) => (
        candidate.draftId === draftId && candidate.memberId === memberId
      ));
      if (!item) throw new DraftNotFoundError('Allocation draft item was not found');
      validateLiveItem(data, draft, item);
      applyFinal(item, input, this.dependencies.now().toISOString());
      bumpDraft(draft, item.updatedAt);
    });
    return this.get(draftId);
  }

  async restoreAuto(
    draftId: string,
    memberId: string,
    input: { expectedDraftRevision: number },
  ): Promise<DraftDetail> {
    requireRevision(input.expectedDraftRevision);
    await this.store.write({}, (data) => {
      const draft = editableDraft(data, draftId, input.expectedDraftRevision);
      const item = draftItems(data).find((candidate) => (
        candidate.draftId === draftId && candidate.memberId === memberId
      ));
      if (!item) throw new DraftNotFoundError('Allocation draft item was not found');
      if (item.autoDecision === 'NOT_EVALUATED') {
        throw new DraftValidationError('A manual-only item has no automatic result to restore');
      }
      validateLiveItem(data, draft, item);
      validateSelectedCourse(data, draft, item.autoDecision, item.autoSemesterCourseId);
      const now = this.dependencies.now().toISOString();
      item.finalDecision = item.autoDecision;
      item.finalSemesterCourseId = item.autoSemesterCourseId;
      item.finalReasonCode = null;
      item.finalReasonDetail = null;
      item.updatedAt = now;
      bumpDraft(draft, now);
    });
    return this.get(draftId);
  }

  async addItem(
    draftId: string,
    input: DraftItemInput & { memberId: string },
  ): Promise<DraftDetail> {
    validateItemInput(input);
    requireId(input.memberId, 'memberId');
    await this.store.write({}, (data) => {
      const draft = editableDraft(data, draftId, input.expectedDraftRevision);
      validateSelectedCourse(data, draft, input.finalDecision, input.finalSemesterCourseId);
      if (draftItems(data).some((item) => item.draftId === draftId && item.memberId === input.memberId)) {
        throw new DraftValidationError('Member already has an item in this draft');
      }
      const member = (data.members as Array<{ id: string; name: string }>)
        .find(({ id }) => id === input.memberId);
      if (!member) throw new DraftValidationError('Member was not found');
      if (hasCurrentEnrollment(data, draft.semesterId, input.memberId)) {
        throw new DraftValidationError('Member is already enrolled in the target semester');
      }
      const now = this.dependencies.now().toISOString();
      draftItems(data).push({
        id: this.dependencies.id(),
        draftId,
        memberId: member.id,
        sourceApplicationId: null,
        memberNameAtGeneration: member.name,
        autoSemesterCourseId: null,
        autoDecision: 'NOT_EVALUATED',
        autoReasonCode: 'MANUAL_ONLY',
        autoReasonDetail: { preferenceAttempts: [], fallback: null },
        finalSemesterCourseId: input.finalSemesterCourseId,
        finalDecision: input.finalDecision,
        finalReasonCode: input.finalReasonCode,
        finalReasonDetail: structuredClone(input.finalReasonDetail),
        updatedAt: now,
      });
      bumpDraft(draft, now);
    });
    return this.get(draftId);
  }

}

const manualItems = (snapshot: AllocationSnapshot): ManualAllocationItem[] => {
  const enrolledMembers = new Set(snapshot.existingEnrollments.map(({ memberId }) => memberId));
  return snapshot.applications.filter(({ memberId }) => !enrolledMembers.has(memberId)).map((item) => ({
    memberId: item.memberId,
    memberNameAtGeneration: item.memberName,
    sourceApplicationId: item.id,
    autoDecision: 'REJECTED',
    autoSemesterCourseId: null,
    autoReasonCode: 'MANUAL_ONLY',
    autoReasonDetail: { preferenceAttempts: [], fallback: null },
  }));
};

const persistedItem = (
  item: GeneratedAllocationItem,
  draftId: string,
  id: string,
  now: string,
): DraftItemRecord => {
  const manual = item.autoReasonCode === 'MANUAL_ONLY';
  return {
    id,
    draftId,
    memberId: item.memberId,
    sourceApplicationId: item.sourceApplicationId,
    memberNameAtGeneration: item.memberNameAtGeneration,
    autoSemesterCourseId: item.autoSemesterCourseId,
    autoDecision: manual ? 'NOT_EVALUATED' : item.autoDecision,
    autoReasonCode: item.autoReasonCode,
    autoReasonDetail: structuredClone(item.autoReasonDetail),
    finalSemesterCourseId: manual ? null : item.autoSemesterCourseId,
    finalDecision: manual ? 'REJECTED' : item.autoDecision,
    finalReasonCode: null,
    finalReasonDetail: null,
    updatedAt: now,
  };
};

const validateCreateInput = (input: CreateDraftInput): void => {
  requireId(input.semesterId, 'semesterId');
  requireId(input.policyId, 'policyId');
  requireId(input.policyVersion, 'policyVersion');
  if (!['AUTO', 'MANUAL'].includes(input.mode)) throw new DraftValidationError('mode is invalid');
  if (!['NEW_FIRST', 'RANK_FIRST'].includes(input.policySettings?.preferenceMode)) {
    throw new DraftValidationError('preferenceMode is invalid');
  }
  if (input.policySettings?.fallbackMode !== 'MAX_CARDINALITY_PRIORITIZED') {
    throw new DraftValidationError('fallbackMode is invalid');
  }
  if (input.replayFromDraftId !== undefined) requireId(input.replayFromDraftId, 'replayFromDraftId');
};

const validateItemInput = (input: DraftItemInput): void => {
  requireRevision(input.expectedDraftRevision);
  if (!['SELECTED', 'REJECTED'].includes(input.finalDecision)) {
    throw new DraftValidationError('finalDecision is invalid');
  }
  if (
    (input.finalDecision === 'SELECTED' && !input.finalSemesterCourseId)
    || (input.finalDecision === 'REJECTED' && input.finalSemesterCourseId !== null)
  ) throw new DraftValidationError('finalDecision and finalSemesterCourseId do not match');
  if (input.finalReasonCode !== null) requireId(input.finalReasonCode, 'finalReasonCode');
  if (input.finalReasonDetail !== null && (
    !plainObject(input.finalReasonDetail)
    || Object.keys(input.finalReasonDetail).length !== 1
    || typeof input.finalReasonDetail.note !== 'string'
    || !input.finalReasonDetail.note.trim()
    || input.finalReasonDetail.note.length > 2000
  )) {
    throw new DraftValidationError('finalReasonDetail must contain only a non-empty note');
  }
};

const validateSelectedCourse = (
  data: DatabaseState,
  draft: DraftRecord,
  decision: Decision,
  semesterCourseId: string | null,
): void => {
  if (decision !== 'SELECTED') return;
  const course = (data.semesterCourses as Array<{ id: string; semesterId: string }>)
    .find(({ id }) => id === semesterCourseId);
  if (!course || course.semesterId !== draft.semesterId) {
    throw new DraftValidationError('Selected course does not belong to the draft semester');
  }
};

const validateLiveItem = (data: DatabaseState, draft: DraftRecord, item: DraftItemRecord): void => {
  if (!(data.semesters as Array<{ id: string }>).some(({ id }) => id === draft.semesterId)) {
    throw new DraftValidationError('Draft semester was not found');
  }
  if (!(data.members as Array<{ id: string }>).some(({ id }) => id === item.memberId)) {
    throw new DraftValidationError('Draft member was not found');
  }
};

const editableDraft = (data: DatabaseState, id: string, expectedRevision: number): DraftRecord => {
  const draft = requireDraft(data, id);
  if (draft.status !== 'DRAFT') throw new DraftReadOnlyError(draft.status);
  if (draft.revision !== expectedRevision) throw new DraftRevisionConflictError(draft.revision);
  return draft;
};

const applyFinal = (item: DraftItemRecord, input: DraftItemInput, now: string): void => {
  item.finalDecision = input.finalDecision;
  item.finalSemesterCourseId = input.finalSemesterCourseId;
  item.finalReasonCode = input.finalReasonCode;
  item.finalReasonDetail = structuredClone(input.finalReasonDetail);
  item.updatedAt = now;
};

const bumpDraft = (draft: DraftRecord, now: string): void => {
  draft.revision += 1;
  draft.updatedAt = now;
};

const liveSnapshot = (data: DatabaseState, semesterId: string): AllocationSnapshot => {
  try {
    return buildAllocationSnapshot(data, semesterId);
  } catch (error) {
    if (error instanceof AllocationSnapshotError) throw new DraftValidationError(error.message);
    throw error;
  }
};

const hasCurrentEnrollment = (data: DatabaseState, semesterId: string, memberId: string): boolean => {
  const courseIds = new Set((data.semesterCourses as Array<{ id: string; semesterId: string }>)
    .filter((item) => item.semesterId === semesterId).map(({ id }) => id));
  return (data.enrollments as Array<{ memberId: string; semesterCourseId: string }>)
    .some((item) => item.memberId === memberId && courseIds.has(item.semesterCourseId));
};

const summarizeCourses = (snapshot: AllocationSnapshot, items: DraftItemRecord[]) => {
  const existing = count(snapshot.existingEnrollments.map(({ semesterCourseId }) => semesterCourseId));
  const selected = count(items.filter(({ finalDecision }) => finalDecision === 'SELECTED')
    .map((item) => item.finalSemesterCourseId!));
  return snapshot.semesterCourses.map((course) => ({
    semesterCourseId: course.id,
    capacity: course.capacity,
    existingEnrollmentCount: existing.get(course.id) ?? 0,
    finalSelectedCount: selected.get(course.id) ?? 0,
    remaining: course.capacity === null ? null : Math.max(
      0,
      course.capacity
        - (existing.get(course.id) ?? 0)
        - (selected.get(course.id) ?? 0),
    ),
  })).sort((left, right) => compareId(left.semesterCourseId, right.semesterCourseId));
};

const count = (ids: string[]): Map<string, number> => {
  const result = new Map<string, number>();
  for (const id of ids) result.set(id, (result.get(id) ?? 0) + 1);
  return result;
};

const draftSummary = (draft: DraftRecord, storeRevision: number) => ({
  id: draft.id,
  semesterId: draft.semesterId,
  status: draft.status,
  revision: draft.revision,
  mode: draft.mode,
  policyId: draft.policyId,
  policyVersion: draft.policyVersion,
  engineVersion: draft.engineVersion,
  createdAt: draft.createdAt,
  updatedAt: draft.updatedAt,
  enrollmentReportDownloadedAt: draft.enrollmentReportDownloadedAt,
  enrollmentReportIsCurrent: draft.enrollmentReportStoreRevision === storeRevision,
});

const requireDraft = (data: DatabaseState, id: string): DraftRecord => {
  const draft = drafts(data).find((item) => item.id === id);
  if (!draft) throw new DraftNotFoundError();
  return draft;
};
const drafts = (data: DatabaseState): DraftRecord[] => data.allocationDrafts;
const draftItems = (data: DatabaseState): DraftItemRecord[] => data.allocationDraftItems;
const byMemberId = (left: DraftItemRecord, right: DraftItemRecord): number => compareId(left.memberId, right.memberId);
const compareId = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;

const requireRevision = (value: number): void => {
  if (!Number.isSafeInteger(value) || value < 0) throw new DraftValidationError('expectedDraftRevision is invalid');
};
const requireId = (value: string, label: string): void => {
  if (typeof value !== 'string' || value.length < 1 || value.length > 200) {
    throw new DraftValidationError(`${label} is invalid`);
  }
};
const plainObject = (value: object): boolean => (
  Object.getPrototypeOf(value) === Object.prototype
);

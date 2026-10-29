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
  type AllocationDraftItemRecord as DraftItemRecord,
  type AllocationDraftRecord as DraftRecord,
} from '../domain/records.ts';
import type { Repository } from '../repository/database.ts';
import type { AllocationContext, DraftSummaryRecord } from '../repository/allocation-drafts.ts';
import type { QuerySession } from '../repository/queries.ts';
import { snapshotApplicationWarnings, type ApplicationWarning } from '../domain/application-warnings.ts';

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
  ministry?: string | null;
  finalDecision: Decision;
  finalSemesterCourseId: string | null;
  finalReasonCode: string | null;
  finalReasonDetail: FinalReasonDetail | null;
};

export type AddManualDraftItemInput = {
  expectedDraftRevision: number;
  memberName: string;
  ministry?: string | null;
  semesterCourseId: string;
};

export type DraftDetail = {
  draft: ReturnType<typeof draftSummary>;
  studentResults: DraftItemRecord[];
  applicationSnapshot: Pick<AllocationSnapshot, 'applications' | 'choices' | 'semesterCourses'>;
  existingEnrollments: AllocationSnapshot['existingEnrollments'];
  currentEnrolledMembers: { id: string; name: string }[];
  courseSummary: ReturnType<typeof summarizeCourses>;
  isStale: boolean;
  inputChanges: InputChange[];
  issues: ApplicationWarning[];
};

export class DraftNotFoundError extends Error {
  constructor(message = 'Allocation draft was not found') {
    super(message);
    this.name = 'DraftNotFoundError';
  }
}

export class DraftValidationError extends Error {
  readonly issues;

  constructor(message: string) {
    super(message);
    this.name = 'DraftValidationError';
    this.issues = [{
      code: 'DRAFT_INPUT_INVALID', message, severity: 'ERROR' as const,
      blockingStages: [], acknowledgementStages: [], subject: { entityType: 'AllocationDraft' }, source: {}, detail: {},
    }];
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
  private readonly repository: Repository;
  private readonly dependencies: Dependencies;

  constructor(repository: Repository, dependencies: Dependencies) {
    this.repository = repository;
    this.dependencies = dependencies;
  }

  async create(input: CreateDraftInput): Promise<DraftDetail> {
    validateCreateInput(input);
    const id = await this.repository.write({}, (queries) => {
      const replay = input.replayFromDraftId ? requireDraft(queries, input.replayFromDraftId) : undefined;
      if (replay && replay.engineVersion !== ALLOCATION_ENGINE_VERSION) {
        throw new DraftUnsupportedEngineError(replay.engineVersion);
      }
      const semesterId = replay?.semesterId ?? input.semesterId;
      const mode = replay?.mode ?? input.mode;
      const policyId = replay?.policyId ?? input.policyId;
      const policyVersion = replay?.policyVersion ?? input.policyVersion;
      const policySettings = replay?.policySettings ?? input.policySettings;
      const randomSeed = replay?.randomSeed ?? this.dependencies.seed();
      const semester = queries.semesters.get({ id: semesterId });
      if (!semester && !replay) throw new DraftValidationError('Semester was not found');
      const now = this.dependencies.now().toISOString();
      if (!replay && semester!.order === null) {
        semester!.order = queries.semesters.nextOrder();
        semester!.allocationInputRevision += 1;
        semester!.updatedAt = now;
        queries.semesters.update({ record: semester! });
      }
      const snapshot = replay?.inputSnapshot ?? liveSnapshot(queries.allocationDrafts.getContext({ semesterId }), semesterId);
      const draft: DraftRecord = {
        id: this.dependencies.id(), semesterId, status: 'DRAFT', revision: 0, mode,
        policyId, policyVersion, engineVersion: ALLOCATION_ENGINE_VERSION,
        policySettings: structuredClone(policySettings), randomSeed,
        sourceRevision: replay?.sourceRevision ?? semester!.allocationInputRevision,
        inputFingerprint: allocationFingerprint(snapshot, { policyId, policyVersion, settings: policySettings }),
        inputSnapshot: structuredClone(snapshot), createdAt: now, updatedAt: now, finalizedAt: null,
        enrollmentReportDownloadedAt: null, enrollmentReportStoreRevision: null, finalization: null,
      };
      const autoItems = mode === 'AUTO' ? allocate(snapshot, policySettings, randomSeed).items : manualItems(snapshot);
      const ministries = new Map(snapshot.applications.map(({ id, ministry }) => [id, ministry]));
      const items = autoItems.map((item) => persistedItem(item, draft.id, this.dependencies.id(), now,
        ministries.get(item.sourceApplicationId ?? '') ?? null));
      queries.allocationDrafts.save({ draft, items });
      return draft.id;
    });
    return this.get(id);
  }

  get(id: string): DraftDetail {
    return this.repository.read((queries) => {
      const draft = requireDraft(queries, id);
      const data = queries.allocationDrafts.getContext({ draftId: id });
      const items = data.allocationDraftItems;
      let isStale = true;
      let inputChanges: InputChange[] = [{ code: 'INPUT_UNAVAILABLE' }];
      try {
        const current = buildAllocationSnapshot(data, draft.semesterId);
        const currentFingerprint = allocationFingerprint(current, {
          policyId: draft.policyId, policyVersion: draft.policyVersion, settings: draft.policySettings,
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
          applications: draft.inputSnapshot.applications, choices: draft.inputSnapshot.choices,
          semesterCourses: draft.inputSnapshot.semesterCourses,
        }),
        existingEnrollments: structuredClone(draft.inputSnapshot.existingEnrollments),
        currentEnrolledMembers: queries.members.enrolledForSemester({ semesterId: draft.semesterId }),
        courseSummary: summarizeCourses(draft.inputSnapshot, items), isStale, inputChanges,
        issues: snapshotApplicationWarnings(draft.inputSnapshot),
      };
    });
  }

  list(): Array<ReturnType<typeof draftSummary>> {
    return this.repository.read((queries) => {
      const revision = queries.metadata().storeRevision;
      return queries.allocationDrafts.list().map((draft) => draftSummary(draft, revision));
    });
  }

  listPage(input: { semesterId?: string; query?: string; page: number; limit: number }) {
    return this.repository.read((queries) => {
      const revision = queries.metadata().storeRevision;
      const result = queries.allocationDrafts.listPage(input);
      return { ...result, items: result.items.map((draft) => draftSummary(draft, revision)) };
    });
  }

  async delete(draftId: string, input: { expectedDraftRevision: number }): Promise<void> {
    requireRevision(input.expectedDraftRevision);
    await this.repository.write({}, (queries) => {
      const draft = requireDraft(queries, draftId);
      if (draft.revision !== input.expectedDraftRevision) throw new DraftRevisionConflictError(draft.revision);
      queries.allocationDrafts.delete({ id: draftId });
    });
  }

  async updateItem(draftId: string, memberId: string, input: DraftItemInput): Promise<DraftDetail> {
    validateItemInput(input);
    await this.repository.write({}, (queries) => {
      const draft = editableDraft(queries, draftId, input.expectedDraftRevision);
      validateSelectedCourse(queries, draft, input.finalDecision, input.finalSemesterCourseId);
      const item = queries.allocationDraftItems.getForMember({ draftId, memberId });
      if (!item) throw new DraftNotFoundError('Allocation draft item was not found');
      validateLiveItem(queries, draft, item);
      applyFinal(item, input, this.dependencies.now().toISOString());
      bumpDraft(draft, item.updatedAt);
      queries.allocationDrafts.save({ draft, items: [item] });
    });
    return this.get(draftId);
  }

  async restoreAuto(draftId: string, memberId: string, input: { expectedDraftRevision: number }): Promise<DraftDetail> {
    requireRevision(input.expectedDraftRevision);
    await this.repository.write({}, (queries) => {
      const draft = editableDraft(queries, draftId, input.expectedDraftRevision);
      const item = queries.allocationDraftItems.getForMember({ draftId, memberId });
      if (!item) throw new DraftNotFoundError('Allocation draft item was not found');
      if (item.autoDecision === 'NOT_EVALUATED') {
        throw new DraftValidationError('A manual-only item has no automatic result to restore');
      }
      validateLiveItem(queries, draft, item);
      validateSelectedCourse(queries, draft, item.autoDecision, item.autoSemesterCourseId);
      const now = this.dependencies.now().toISOString();
      item.finalDecision = item.autoDecision;
      item.finalSemesterCourseId = item.autoSemesterCourseId;
      item.finalReasonCode = null;
      item.finalReasonDetail = null;
      item.updatedAt = now;
      bumpDraft(draft, now);
      queries.allocationDrafts.save({ draft, items: [item] });
    });
    return this.get(draftId);
  }

  async addManualItem(draftId: string, input: AddManualDraftItemInput): Promise<DraftDetail> {
    if (!input || !plainObject(input)) throw new DraftValidationError('회원과 강좌 입력을 확인하세요.');
    requireRevision(input.expectedDraftRevision);
    if (typeof input.memberName !== 'string' || !input.memberName.trim() || input.memberName.trim().length > 200) {
      throw new DraftValidationError('회원명은 1~200자로 입력하세요.');
    }
    if (typeof input.semesterCourseId !== 'string' || !input.semesterCourseId) {
      throw new DraftValidationError('배정할 개설 강좌를 선택하세요.');
    }
    if (input.ministry != null && (typeof input.ministry !== 'string' || input.ministry.trim().length > 200)) {
      throw new DraftValidationError('학생 소속은 200자 이내로 입력하세요.');
    }
    await this.repository.write({}, (queries) => {
      const draft = editableDraft(queries, draftId, input.expectedDraftRevision);
      if (draft.mode !== 'MANUAL') throw new DraftValidationError('회원 추가는 수동 초안에서 사용할 수 있습니다.');
      const course = queries.semesterCourses.get({ id: input.semesterCourseId });
      if (!course || course.semesterId !== draft.semesterId) {
        throw new DraftValidationError('이 학기의 개설 강좌를 선택하세요.');
      }
      const now = this.dependencies.now().toISOString();
      let member = queries.members.getByNameKey({ nameKey: input.memberName.trim().normalize('NFC') });
      if (!member) {
        member = { id: this.dependencies.id(), name: input.memberName.trim(), nameKey: input.memberName.trim().normalize('NFC'),
          createdAt: now, updatedAt: now };
        queries.members.insert({ record: member });
      }
      if (queries.enrollments.hasSemesterMember({ semesterId: draft.semesterId, memberId: member.id })) {
        throw new DraftValidationError('이 회원은 같은 학기에 수강이력이 있습니다. 수강이력에서 확인하세요.');
      }
      if (queries.allocationDraftItems.getForMember({ draftId, memberId: member.id })) {
        throw new DraftValidationError('이미 이 초안에 있는 회원입니다. 기존 행의 최종 결정을 수정하세요.');
      }
      const item: DraftItemRecord = {
        id: this.dependencies.id(), draftId, memberId: member.id, memberNameAtGeneration: member.name,
        ministry: input.ministry?.trim() || null, sourceApplicationId: null,
        autoDecision: 'NOT_EVALUATED', autoSemesterCourseId: null, autoReasonCode: 'MANUAL_ONLY',
        autoReasonDetail: { preferenceAttempts: [], fallback: null },
        finalDecision: 'SELECTED', finalSemesterCourseId: input.semesterCourseId,
        finalReasonCode: 'ADMIN_ADDED', finalReasonDetail: null, updatedAt: now,
      };
      bumpDraft(draft, now);
      queries.allocationDrafts.save({ draft, items: [item] });
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
  ministry: string | null,
): DraftItemRecord => {
  const manual = item.autoReasonCode === 'MANUAL_ONLY';
  return {
    id,
    draftId,
    memberId: item.memberId,
    sourceApplicationId: item.sourceApplicationId,
    memberNameAtGeneration: item.memberNameAtGeneration,
    ministry,
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
  if (input.ministry != null && (typeof input.ministry !== 'string' || input.ministry.trim().length > 200)) {
    throw new DraftValidationError('학생 소속은 200자 이내로 입력하세요.');
  }
  if (!['SELECTED', 'REJECTED'].includes(input.finalDecision)) {
    throw new DraftValidationError('finalDecision is invalid');
  }
  if (
    (input.finalDecision === 'SELECTED' && !input.finalSemesterCourseId)
    || (input.finalDecision === 'REJECTED' && input.finalSemesterCourseId !== null)
  ) throw new DraftValidationError('finalDecision and finalSemesterCourseId do not match');
  if (input.finalReasonCode !== null) requireId(input.finalReasonCode, 'finalReasonCode');
  if (input.finalReasonDetail === undefined) {
    throw new DraftValidationError('finalReasonDetail is required; use null when there is no note');
  }
  if (input.finalReasonDetail !== null && (
    typeof input.finalReasonDetail !== 'object'
    || Array.isArray(input.finalReasonDetail)
    || !plainObject(input.finalReasonDetail)
    || Object.keys(input.finalReasonDetail).length !== 1
    || typeof input.finalReasonDetail.note !== 'string'
    || !input.finalReasonDetail.note.trim()
    || input.finalReasonDetail.note.length > 2000
  )) {
    throw new DraftValidationError('finalReasonDetail must contain only a non-empty note');
  }
};

const validateSelectedCourse = (
  queries: QuerySession,
  draft: DraftRecord,
  decision: Decision,
  semesterCourseId: string | null,
): void => {
  if (decision !== 'SELECTED') return;
  const course = queries.semesterCourses.get({ id: semesterCourseId! });
  if (!course || course.semesterId !== draft.semesterId) {
    throw new DraftValidationError('Selected course does not belong to the draft semester');
  }
};

const validateLiveItem = (queries: QuerySession, draft: DraftRecord, item: DraftItemRecord): void => {
  if (!queries.semesters.get({ id: draft.semesterId })) {
    throw new DraftValidationError('Draft semester was not found');
  }
  if (!queries.members.get({ id: item.memberId })) {
    throw new DraftValidationError('Draft member was not found');
  }
};

const editableDraft = (queries: QuerySession, id: string, expectedRevision: number): DraftRecord => {
  const draft = requireDraft(queries, id);
  if (draft.status !== 'DRAFT') throw new DraftReadOnlyError(draft.status);
  if (draft.revision !== expectedRevision) throw new DraftRevisionConflictError(draft.revision);
  return draft;
};

const applyFinal = (item: DraftItemRecord, input: DraftItemInput, now: string): void => {
  if (input.ministry !== undefined) item.ministry = input.ministry?.trim() || null;
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

const liveSnapshot = (data: AllocationContext, semesterId: string): AllocationSnapshot => {
  try {
    return buildAllocationSnapshot(data, semesterId);
  } catch (error) {
    if (error instanceof AllocationSnapshotError) throw new DraftValidationError(error.message);
    throw error;
  }
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

const draftSummary = (draft: DraftSummaryRecord, storeRevision: number) => ({
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

const requireDraft = (queries: QuerySession, id: string): DraftRecord => {
  const draft = queries.allocationDrafts.get({ id });
  if (!draft) throw new DraftNotFoundError();
  return draft;
};
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

import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';

import { createImportTemplate, exportApplicationRows, exportRawRows } from '../excel/workbooks.ts';
import { APPLICATION_SORTS, ApplicationService, type ApplicationInput, type ApplicationSort } from '../services/applications.ts';
import { DraftService, type CreateDraftInput, type DraftItemInput } from '../services/drafts.ts';
import { EnrollmentService } from '../services/enrollments.ts';
import { FinalizationService } from '../services/finalization.ts';
import { ImportCommitService } from '../services/import-commit.ts';
import { ImportPreviewService, type ImportMode, type ImportPreview } from '../services/import-preview.ts';
import { publicBackup, RecoveryService } from '../services/recovery.ts';
import type { Store, DatabaseState } from '../storage/store.ts';
import { HttpError } from './errors.ts';
import { parseMultipart } from './multipart.ts';
import type { ApiHandler, ApiRequest, ApiResponse } from '../server.ts';

type NamedResource = { id: string; name: string };
type SemesterResource = NamedResource & { order: number | null };
type EnrollmentPreviewInput = Parameters<EnrollmentService['preview']>[0];
type PreparedEnrollmentInput = Pick<Parameters<EnrollmentService['execute']>[0],
  'preparedActionToken' | 'acknowledgedWarningDigest' | 'acknowledgementNote'>;

export const createApiRouter = (store: Store, options: { dataDirectory: string }): ApiHandler => {
  const clock = () => new Date();
  const applications = new ApplicationService(store, { id: randomUUID, now: clock });
  const enrollments = new EnrollmentService(store, {
    id: randomUUID,
    now: clock,
    secret: randomBytes(32),
  });
  const importPreviews = new ImportPreviewService(store, { id: randomUUID, now: clock });
  const drafts = new DraftService(store, {
    id: randomUUID,
    now: clock,
    seed: () => randomBytes(24).toString('base64url'),
  });
  const importCommits = new ImportCommitService(store, importPreviews, {
    id: randomUUID,
    now: clock,
  });
  const finalization = new FinalizationService(store, {
    id: randomUUID,
    now: clock,
    secret: randomBytes(32),
  });
  const recovery = new RecoveryService(store, {
    dataFile: join(options.dataDirectory, 'db.sqlite'),
    backupDirectory: join(options.dataDirectory, 'backups'),
    id: randomUUID,
    now: clock,
  });

  return async (request): Promise<ApiResponse | undefined> => {
    const path = request.path.slice('/api/v1'.length);

    if (path === '/backups') {
      if (request.method === 'GET') return ok({ items: (await recovery.list()).map(publicBackup) });
      if (request.method === 'POST') return { status: 201, json: publicBackup(await recovery.create()) };
      return methodNotAllowed();
    }

    if (path === '/restores/preview') {
      if (request.method !== 'POST') return methodNotAllowed();
      if (!request.bodyFile) throw new HttpError(400, 'BAD_REQUEST', '백업 파일이 필요합니다.');
      return ok(await recovery.preview(request.bodyFile));
    }

    if (path === '/restores') {
      if (request.method !== 'POST') return methodNotAllowed();
      const idempotencyKey = header(request, 'idempotency-key');
      if (!idempotencyKey) throw new HttpError(400, 'BAD_REQUEST', 'Idempotency-Key 헤더가 필요합니다.');
      const input = json<Omit<Parameters<RecoveryService['restore']>[0], 'idempotencyKey'>>(request);
      return ok(await recovery.restore({ ...input, idempotencyKey }));
    }

    if (path === '/semesters' && request.method === 'POST') {
      return {
        status: 201,
        json: await applications.createSemester(json<Parameters<ApplicationService['createSemester']>[0]>(request)),
      };
    }

    if (request.method === 'GET' && ['/semesters', '/members', '/courses'].includes(path)) {
      const key = path.slice(1) as 'semesters' | 'members' | 'courses';
      return ok(page(named(store.read(), key), request, ({ name }) => name));
    }

    const semester = match(path, /^\/semesters\/([^/]+)$/);
    if (semester) {
      if (request.method !== 'DELETE') return methodNotAllowed();
      await applications.deleteSemester({
        semesterId: semester[1],
        expectedRevision: integerQuery(request, 'expectedRevision'),
      });
      return { status: 204 };
    }

    const moveSemester = match(path, /^\/semesters\/([^/]+)\/move$/);
    if (moveSemester) {
      if (request.method !== 'POST') return methodNotAllowed();
      const input = json<Omit<Parameters<ApplicationService['moveSemester']>[0], 'semesterId'>>(request);
      return ok(await applications.moveSemester({ ...input, semesterId: moveSemester[1] }));
    }

    const semesterContext = match(path, /^\/semesters\/([^/]+)\/context$/);
    if (semesterContext) {
      if (request.method === 'GET') return ok(applications.getSemesterContext(semesterContext[1]));
      if (request.method === 'PATCH') {
        const input = json<Parameters<ApplicationService['updateSemesterContext']>[0]>(request);
        return ok(await applications.updateSemesterContext({ ...input, semesterId: semesterContext[1] }));
      }
      return methodNotAllowed();
    }

    const semesterCourse = match(path, /^\/semesters\/([^/]+)\/courses\/([^/]+)$/);
    if (semesterCourse) {
      if (request.method !== 'DELETE') return methodNotAllowed();
      await applications.deleteSemesterCourse({
        semesterId: semesterCourse[1],
        semesterCourseId: semesterCourse[2],
        expectedRevision: integerQuery(request, 'expectedRevision'),
        confirmApplications: request.query.get('confirmApplications') === 'true',
      });
      return { status: 204 };
    }

    if (path === '/applications') {
      if (request.method === 'GET') {
        return ok(page(applications.list(applicationFilters(request)), request));
      }
      if (request.method === 'POST') {
        return { status: 201, json: await applications.create(json<ApplicationInput>(request)) };
      }
      return methodNotAllowed();
    }

    if (request.method === 'GET' && path === '/applications/template') {
      const semesterId = request.query.get('semesterId');
      if (!semesterId) throw new HttpError(400, 'BAD_REQUEST', 'semesterId 값이 필요합니다.');
      const context = applications.getSemesterContext(semesterId);
      return xlsx(await createImportTemplate('APPLICATIONS', {
        semesterName: context.semester.name,
        semesterOrder: context.order,
        courses: context.semesterCourses.map(({ courseName, capacity }) => ({ courseName, capacity })),
      }), 'glorycourse-applications-template.xlsx');
    }
    if (request.method === 'GET' && path === '/applications/export') {
      const items = applications.list(applicationFilters(request));
      return xlsx(await exportApplicationRows(items.flatMap((item) => item.choices.map((choice) => ({
        semesterName: item.semesterName,
        memberName: item.memberName,
        applicationOrder: item.applicationOrder,
        courseName: choice.courseName,
        preference: choice.preference,
      })))), 'glorycourse-applications.xlsx');
    }

    if (path === '/applications/batch') {
      if (request.method !== 'POST') return methodNotAllowed();
      const input = json<{ items: ApplicationInput[] }>(request);
      return { status: 201, json: { items: await applications.createMany(input?.items) } };
    }

    const application = match(path, /^\/applications\/([^/]+)$/);
    if (application) {
      const id = application[1];
      if (request.method === 'GET') return ok(applications.get(id));
      if (request.method === 'PATCH') {
        const input = json<ApplicationInput & { expectedRevision: number }>(request);
        return ok(await applications.update(id, input));
      }
      if (request.method === 'DELETE') {
        await applications.delete(id, { expectedRevision: integerQuery(request, 'expectedRevision') });
        return { status: 204 };
      }
      return methodNotAllowed();
    }

    if (path === '/enrollments/preview') {
      if (request.method !== 'POST') return methodNotAllowed();
      return ok(enrollments.preview(json<EnrollmentPreviewInput>(request)));
    }

    if (path === '/enrollments/batch/preview') {
      if (request.method !== 'POST') return methodNotAllowed();
      const input = json<{ items: Parameters<EnrollmentService['previewMany']>[0] }>(request);
      return ok(enrollments.previewMany(input?.items));
    }
    if (path === '/enrollments/batch') {
      if (request.method !== 'POST') return methodNotAllowed();
      const input = json<PreparedEnrollmentInput>(request);
      if (!input || typeof input !== 'object') throw new HttpError(400, 'BAD_REQUEST', '요청을 읽을 수 없습니다.');
      return { status: 201, json: { items: await enrollments.executeMany(input) } };
    }

    if (path === '/enrollments') {
      if (request.method === 'GET') {
        return ok(page(enrollments.list(recordFilters(request)), request));
      }
      if (request.method === 'POST') {
        return {
          status: 201,
          json: await enrollments.execute({
            ...json<PreparedEnrollmentInput>(request),
            expectedAction: 'CREATE',
          }),
        };
      }
      return methodNotAllowed();
    }

    if (request.method === 'GET' && path === '/enrollments/template') {
      return xlsx(await createImportTemplate('ENROLLMENTS'), 'glorycourse-enrollments-template.xlsx');
    }
    if (request.method === 'GET' && path === '/enrollments/export') {
      const items = enrollments.list(recordFilters(request));
      return xlsx(await enrollmentWorkbook(items), 'glorycourse-enrollments.xlsx');
    }

    const semesterEnrollments = match(path, /^\/semesters\/([^/]+)\/enrollments$/);
    if (semesterEnrollments) {
      if (request.method === 'GET') return ok(enrollments.previewSemesterDeletion(semesterEnrollments[1]));
      if (request.method === 'DELETE') {
        return ok(await enrollments.deleteSemester(
          semesterEnrollments[1],
          json<Parameters<EnrollmentService['deleteSemester']>[1]>(request),
        ));
      }
      return methodNotAllowed();
    }

    const enrollment = match(path, /^\/enrollments\/([^/]+)$/);
    if (enrollment) {
      if (request.method === 'GET') return ok(enrollments.get(enrollment[1]));
      if (request.method === 'PATCH') {
        return ok(await enrollments.execute({
          ...json<PreparedEnrollmentInput>(request),
          expectedAction: 'UPDATE',
          expectedEnrollmentId: enrollment[1],
        }));
      }
      if (request.method === 'DELETE') {
        await enrollments.execute({
          ...json<PreparedEnrollmentInput>(request),
          expectedAction: 'DELETE',
          expectedEnrollmentId: enrollment[1],
        });
        return { status: 204 };
      }
      return methodNotAllowed();
    }

    if (path === '/imports/preview') {
      if (request.method !== 'POST') return methodNotAllowed();
      const form = parseMultipart(header(request, 'content-type'), request.body);
      const file = form.files.file;
      if (!file) throw new HttpError(400, 'BAD_REQUEST', 'xlsx 파일이 필요합니다.');
      const kind = importKind(form.fields.kind);
      const mode = importMode(form.fields.mode);
      return ok(publicImportPreview(await importPreviews.preview({
        filename: file.filename, bytes: file.bytes, kind, mode,
      })));
    }

    const stageImport = match(path, /^\/imports\/([^/]+)\/stage$/);
    if (stageImport) {
      if (request.method !== 'POST') return methodNotAllowed();
      const input = json<{ storeRevision: number; storeEpoch: string }>(request);
      const preview = importPreviews.getPreview(stageImport[1]);
      const version = store.version();
      if (
        input.storeRevision !== preview.storeRevision
        || input.storeEpoch !== preview.storeEpoch
        || version.storeRevision !== preview.storeRevision
        || version.storeEpoch !== preview.storeEpoch
      ) throw new HttpError(409, 'CONFLICT', '현재 자료와 미리보기가 일치하지 않습니다.');
      return { status: 201, json: await importPreviews.stage(stageImport[1]) };
    }

    const commitImport = match(path, /^\/imports\/([^/]+)\/commit$/);
    if (commitImport) {
      if (request.method !== 'POST') return methodNotAllowed();
      const idempotencyKey = header(request, 'idempotency-key');
      if (!idempotencyKey) throw new HttpError(400, 'BAD_REQUEST', 'Idempotency-Key 헤더가 필요합니다.');
      const input = json<Omit<Parameters<ImportCommitService['commit']>[0], 'previewId' | 'idempotencyKey'>>(request);
      return ok(await importCommits.commit({ ...input, previewId: commitImport[1], idempotencyKey }));
    }

    const stagedPreview = match(path, /^\/import-batches\/([^/]+)\/preview$/);
    if (stagedPreview) {
      if (request.method !== 'POST') return methodNotAllowed();
      return ok(publicImportPreview(importPreviews.repreviewStaged(stagedPreview[1])));
    }

    const importBatch = match(path, /^\/import-batches\/([^/]+)$/);
    if (importBatch) {
      if (request.method !== 'GET') return methodNotAllowed();
      const batch = (store.read().importBatches as Array<{ id: string }>).find(({ id }) => id === importBatch[1]);
      if (!batch) throw new HttpError(404, 'NOT_FOUND', '대상을 찾을 수 없습니다.');
      return ok(structuredClone(batch));
    }

    if (path === '/allocation-policies') {
      if (request.method !== 'GET') return methodNotAllowed();
      return ok({ items: [
        {
          policyId: 'course-allocation',
          policyVersion: '1.0.0',
          name: '신규 우선',
          settings: { preferenceMode: 'NEW_FIRST', fallbackMode: 'MAX_CARDINALITY_PRIORITIZED' },
          description: '신규 회원을 먼저 희망 강좌에 배정한 뒤 남은 인원을 최대한 대체 배정합니다.',
        },
        {
          policyId: 'course-allocation',
          policyVersion: '1.0.0-rank-first',
          name: '희망순위 우선',
          settings: { preferenceMode: 'RANK_FIRST', fallbackMode: 'MAX_CARDINALITY_PRIORITIZED' },
          description: '희망순위를 먼저 비교한 뒤 남은 인원을 최대한 대체 배정합니다.',
        },
      ] });
    }

    if (path === '/allocation-drafts') {
      if (request.method === 'GET') {
        let items = drafts.list();
        const semesterId = request.query.get('semesterId');
        if (semesterId) items = items.filter((item) => item.semesterId === semesterId);
        return ok(page(items, request, () => ''));
      }
      if (request.method === 'POST') {
        return { status: 201, json: await drafts.create(json<CreateDraftInput>(request)) };
      }
      return methodNotAllowed();
    }

    const addDraftItem = match(path, /^\/allocation-drafts\/([^/]+)\/items$/);
    if (addDraftItem) {
      if (request.method !== 'POST') return methodNotAllowed();
      const input = json<DraftItemInput & { memberId: string }>(request);
      const detail = await drafts.addItem(addDraftItem[1], input);
      return { status: 201, json: draftItem(detail, input.memberId) };
    }

    const restoreDraftItem = match(path, /^\/allocation-drafts\/([^/]+)\/items\/([^/]+)\/restore-auto$/);
    if (restoreDraftItem) {
      if (request.method !== 'POST') return methodNotAllowed();
      const input = json<{ expectedDraftRevision: number }>(request);
      const detail = await drafts.restoreAuto(restoreDraftItem[1], restoreDraftItem[2], input);
      return ok(draftItem(detail, restoreDraftItem[2]));
    }

    const updateDraftItem = match(path, /^\/allocation-drafts\/([^/]+)\/items\/([^/]+)$/);
    if (updateDraftItem) {
      if (request.method !== 'PATCH') return methodNotAllowed();
      const detail = await drafts.updateItem(
        updateDraftItem[1], updateDraftItem[2], json<DraftItemInput>(request),
      );
      return ok(draftItem(detail, updateDraftItem[2]));
    }

    const finalizePreview = match(path, /^\/allocation-drafts\/([^/]+)\/finalize-preview$/);
    if (finalizePreview) {
      if (request.method !== 'POST') return methodNotAllowed();
      return ok(finalization.preview(
        finalizePreview[1], json<{ expectedDraftRevision: number }>(request),
      ));
    }

    const finalizeDraft = match(path, /^\/allocation-drafts\/([^/]+)\/finalize$/);
    if (finalizeDraft) {
      if (request.method !== 'POST') return methodNotAllowed();
      const idempotencyKey = header(request, 'idempotency-key');
      if (!idempotencyKey) throw new HttpError(400, 'BAD_REQUEST', 'Idempotency-Key 헤더가 필요합니다.');
      const input = json<Omit<Parameters<FinalizationService['finalize']>[1], 'idempotencyKey'>>(request);
      return ok(await finalization.finalize(finalizeDraft[1], { ...input, idempotencyKey }));
    }

    const enrollmentReport = match(path, /^\/semesters\/([^/]+)\/enrollment-report$/);
    if (enrollmentReport) {
      if (request.method === 'GET') return ok(finalization.reportStatus(enrollmentReport[1]));
      if (request.method !== 'POST') return methodNotAllowed();
      const expectedStore = store.version();
      const body = await enrollmentWorkbook(enrollments.list({ semesterId: enrollmentReport[1] }));
      await finalization.recordEnrollmentReportDownload(enrollmentReport[1], expectedStore);
      return xlsx(body, 'glorycourse-enrollments.xlsx');
    }

    const allocationDraft = match(path, /^\/allocation-drafts\/([^/]+)$/);
    if (allocationDraft) {
      if (request.method === 'GET') return ok(drafts.get(allocationDraft[1]));
      if (request.method === 'DELETE') {
        await drafts.delete(allocationDraft[1], json<{ expectedDraftRevision: number }>(request));
        return { status: 204 };
      }
      return methodNotAllowed();
    }

    return undefined;
  };
};

const ok = (json: unknown): ApiResponse => ({ status: 200, json });

const xlsx = (body: Buffer, filename: string): ApiResponse => ({
  status: 200,
  body,
  headers: {
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': `attachment; filename="${filename}"`,
  },
});

const publicImportPreview = (preview: ImportPreview) => {
  const { fileHash: _fileHash, rawRows: _rawRows, ...response } = preview;
  return response;
};

const methodNotAllowed = (): ApiResponse => ({
  status: 405,
  json: { code: 'METHOD_NOT_ALLOWED', message: '허용되지 않은 메서드입니다.', issues: [] },
});

const json = <T>(request: ApiRequest): T => {
  const input: unknown = JSON.parse(request.body.toString('utf8'));
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new HttpError(400, 'BAD_REQUEST', '요청은 항목별 값이 있는 자료 형식이어야 합니다.');
  }
  return input as T;
};

const header = (request: ApiRequest, name: string): string | undefined => {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] : value;
};

const importKind = (value: string | undefined): 'APPLICATIONS' | 'ENROLLMENTS' => {
  if (value !== 'APPLICATIONS' && value !== 'ENROLLMENTS') {
    throw new HttpError(400, 'BAD_REQUEST', '이관 종류가 올바르지 않습니다.');
  }
  return value;
};

const importMode = (value: string | undefined): ImportMode => {
  if (value !== 'MERGE_KEEP_EXISTING' && value !== 'REPLACE_APPLICATION') {
    throw new HttpError(400, 'BAD_REQUEST', '이관 모드가 올바르지 않습니다.');
  }
  return value;
};

const integerQuery = (request: ApiRequest, name: string): number => {
  const raw = request.query.get(name);
  const value = raw === null ? Number.NaN : Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new HttpError(400, 'BAD_REQUEST', `${name} 값이 올바르지 않습니다.`);
  }
  return value;
};

const page = <T>(items: T[], request: ApiRequest, searchable?: (item: T) => string) => {
  const query = searchable ? request.query.get('query')?.trim().normalize('NFC') ?? '' : '';
  const filtered = query && searchable ? items.filter((item) => searchable(item).includes(query)) : items;
  const pageNumber = positiveQuery(request, 'page', 1);
  const limit = positiveQuery(request, 'limit', 50, 200);
  const start = (pageNumber - 1) * limit;
  return { items: filtered.slice(start, start + limit), page: pageNumber, limit, total: filtered.length };
};

const positiveQuery = (request: ApiRequest, name: string, fallback: number, maximum?: number): number => {
  const raw = request.query.get(name);
  if (raw === null) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1 || (maximum !== undefined && value > maximum)) {
    throw new HttpError(400, 'BAD_REQUEST', `${name} 값이 올바르지 않습니다.`);
  }
  return value;
};

const match = (path: string, pattern: RegExp): RegExpMatchArray | null => {
  const result = path.match(pattern);
  if (!result) return null;
  try {
    for (let index = 1; index < result.length; index += 1) {
      result[index] = decodeURIComponent(result[index]);
    }
    return result;
  } catch {
    throw new HttpError(400, 'BAD_REQUEST', '요청 경로를 읽을 수 없습니다.');
  }
};

const named = (
  data: DatabaseState,
  key: 'semesters' | 'members' | 'courses',
): Array<NamedResource | SemesterResource> => {
  const items = data[key] as Array<NamedResource & { order?: number | null; createdAt: string }>;
  const ordered = key === 'semesters'
    ? [...items].sort((left, right) => (
      (right.order ?? 0) - (left.order ?? 0)
      || right.createdAt.localeCompare(left.createdAt)
      || left.name.localeCompare(right.name)
    ))
    : items;
  return ordered.map(({ id, name, order }) => (
    key === 'semesters' ? { id, name, order: order ?? null } : { id, name }
  ));
};

const recordFilters = (request: ApiRequest) => ({
  memberName: request.query.get('memberName') ?? undefined,
  semesterId: request.query.get('semesterId') ?? undefined,
  courseId: request.query.get('courseId') ?? undefined,
});

const applicationFilters = (request: ApiRequest) => {
  const sort = request.query.get('sort');
  if (sort !== null && !APPLICATION_SORTS.includes(sort as ApplicationSort)) {
    throw new HttpError(400, 'BAD_REQUEST', '수강신청 정렬 기준이 올바르지 않습니다.');
  }
  return { ...recordFilters(request), ...(sort === null ? {} : { sort: sort as ApplicationSort }) };
};

const enrollmentWorkbook = (items: ReturnType<EnrollmentService['list']>): Promise<Buffer> => (
  exportRawRows('ENROLLMENTS', items.map((item, index) => ({
    sheet: '수강이력',
    row: index + 2,
    cells: { 학기명: item.semesterName, 회원명: item.memberName, 강좌명: item.courseName },
  })))
);

const draftItem = (
  detail: ReturnType<DraftService['get']>,
  memberId: string,
) => detail.studentResults.find((item) => item.memberId === memberId)
  ?? (() => { throw new HttpError(404, 'NOT_FOUND', '대상을 찾을 수 없습니다.'); })();

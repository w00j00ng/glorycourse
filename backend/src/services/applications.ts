import { applicationWarnings } from '../domain/application-warnings.ts';
import type { QuerySession } from '../repository/queries.ts';
import { MAX_CHOICES_PER_APPLICATION } from '../allocation/engine.ts';
import type { Repository } from '../repository/database.ts';
import type { MemberQueries } from '../repository/members.ts';
import type { CourseQueries } from '../repository/courses.ts';
import type { SemesterQueries, SemesterContext } from '../repository/semesters.ts';
import type { SemesterCourseQueries } from '../repository/semester-courses.ts';
import type { ApplicationListFilters, ApplicationView } from '../domain/query-models.ts';
import type {
  ApplicationChoiceRecord as Choice,
  ApplicationRecord as Application,
  NamedRecord as Named,
  SemesterCourseRecord as SemesterCourse,
  SemesterRecord as Semester,
} from '../domain/records.ts';

export type ApplicationInput = {
  semesterName: string;
  memberName: string;
  ministry?: string | null;
  applicantNote?: string | null;
  applicationOrder: number;
  choices: { courseName: string; preference: number }[];
};

export class ApplicationValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApplicationValidationError';
  }
}

export class ApplicationConflictError extends Error {
  constructor(message = 'The member already has an application in this semester') {
    super(message);
    this.name = 'ApplicationConflictError';
  }
}

export class ApplicationNotFoundError extends Error {
  constructor(message = 'Application was not found') {
    super(message);
    this.name = 'ApplicationNotFoundError';
  }
}

export class RevisionConflictError extends Error {
  readonly currentRevision: number;

  constructor(currentRevision: number) {
    super(`Expected revision does not match current revision ${currentRevision}`);
    this.name = 'RevisionConflictError';
    this.currentRevision = currentRevision;
  }
}

type Dependencies = { id: () => string; now: () => Date };

export class ApplicationService {
  private readonly repository: Repository;
  private readonly dependencies: Dependencies;

  constructor(
    repository: Repository,
    dependencies: Dependencies,
  ) {
    this.repository = repository;
    this.dependencies = dependencies;
  }

  async create(input: ApplicationInput): Promise<ApplicationView> {
    return (await this.createMany([input]))[0]!;
  }

  async createMany(inputs: ApplicationInput[]): Promise<ApplicationView[]> {
    if (!Array.isArray(inputs) || inputs.length < 1 || inputs.length > 100) {
      throw new ApplicationValidationError('한 번에 1~100건을 등록하세요.');
    }
    const cleanInputs = inputs.map((input, index) => {
      try { return validateApplicationInput(input); }
      catch (error) { throw withRow(error, index); }
    });
    return this.repository.write({}, (queries) => {
      const now = this.dependencies.now().toISOString();
      const created = cleanInputs.map((clean, index) => {
        const semester = resolveSemester(queries.semesters, clean.semesterName, now, this.dependencies.id);
        const member = resolveMember(queries.members, clean.memberName, now, this.dependencies.id);
        if (queries.applications.findBySemesterMember({ semesterId: semester.id, memberId: member.id })) {
          throw withRow(new ApplicationConflictError('같은 학기에 이미 신청한 회원입니다.'), index);
        }

        const application: Application = {
          id: this.dependencies.id(),
          semesterId: semester.id,
          memberId: member.id,
          ministry: clean.ministry ?? null,
          applicantNote: clean.applicantNote ?? null,
          applicationOrder: clean.applicationOrder,
          applicationOrderStatus: 'NORMAL',
          orderResolution: 'SOURCE_AGREED',
          orderResolutionNote: null,
          revision: 0,
          createdAt: now,
          updatedAt: now,
        };
        queries.applications.insert({ record: application });
        for (const inputChoice of clean.choices) {
          const course = resolveCourse(queries.courses, inputChoice.courseName, now, this.dependencies.id);
          const semesterCourse = resolveSemesterCourse(
            queries.semesterCourses,
            semester.id,
            course.id,
            now,
            this.dependencies.id,
          );
          queries.applicationChoices.insert({ record: {
            id: this.dependencies.id(),
            applicationId: application.id,
            semesterCourseId: semesterCourse.id,
            preference: inputChoice.preference,
            sourceRefs: [],
            createdAt: now,
            updatedAt: now,
          } });
        }
        queries.semesters.bump({ id: semester.id, now });
        return queries.applications.getView({ id: application.id })!;
      });
      return withApplicationWarnings(queries, created);
    });
  }

  async update(id: string, input: ApplicationInput & { expectedRevision: number }): Promise<ApplicationView> {
    const clean = validateApplicationInput(input);
    requireSafeInteger(input.expectedRevision, 'expectedRevision', true);
    return this.repository.write({}, (queries) => {
      const current = queries.applications.get({ id });
      if (!current) throw new ApplicationNotFoundError();
      if (current.revision !== input.expectedRevision) throw new RevisionConflictError(current.revision);

      const now = this.dependencies.now().toISOString();
      const oldSemester = semesterById(queries.semesters, current.semesterId);
      const semester = resolveSemester(queries.semesters, clean.semesterName, now, this.dependencies.id);
      const member = resolveMember(queries.members, clean.memberName, now, this.dependencies.id);
      if (queries.applications.findBySemesterMember({ semesterId: semester.id, memberId: member.id, excludeId: id })) {
        throw new ApplicationConflictError();
      }

      const nextChoices = clean.choices.map((inputChoice): Choice => {
        const course = resolveCourse(queries.courses, inputChoice.courseName, now, this.dependencies.id);
        const semesterCourse = resolveSemesterCourse(
          queries.semesterCourses,
          semester.id,
          course.id,
          now,
          this.dependencies.id,
        );
        return {
          id: this.dependencies.id(),
          applicationId: current.id,
          semesterCourseId: semesterCourse.id,
          preference: inputChoice.preference,
          sourceRefs: [],
          createdAt: now,
          updatedAt: now,
        };
      });

      current.semesterId = semester.id;
      current.memberId = member.id;
      if (input.ministry !== undefined) current.ministry = clean.ministry ?? null;
      if (input.applicantNote !== undefined) current.applicantNote = clean.applicantNote ?? null;
      current.applicationOrder = clean.applicationOrder;
      current.revision += 1;
      current.updatedAt = now;
      queries.applications.update({ record: current });
      queries.applicationChoices.replaceForApplication({ applicationId: id, records: nextChoices });
      queries.semesters.bump({ id: oldSemester.id, now });
      if (semester.id !== oldSemester.id) queries.semesters.bump({ id: semester.id, now });
      return withApplicationWarnings(queries, [queries.applications.getView({ id })!])[0]!;
    });
  }

  get(id: string): ApplicationView {
    return this.repository.read((queries) => {
      const application = queries.applications.getView({ id });
      if (!application) throw new ApplicationNotFoundError();
      return withApplicationWarnings(queries, [application])[0]!;
    });
  }

  list({ reviewStatus, ...filters }: ApplicationListFilters = {}): ApplicationView[] {
    return this.repository.read((queries) => withApplicationWarnings(queries, queries.applications.listViews(filters))
      .filter((row) => reviewStatus === undefined || row.reviewStatus === reviewStatus));
  }

  listPage({ page, limit, reviewStatus, ...filters }: ApplicationListFilters & { page: number; limit: number }) {
    return this.repository.read((queries) => {
      if (reviewStatus !== undefined) {
        const items = withApplicationWarnings(queries, queries.applications.listViews(filters))
          .filter((row) => row.reviewStatus === reviewStatus);
        const start = (page - 1) * limit;
        return { items: items.slice(start, start + limit), page, limit, total: items.length };
      }
      const result = queries.applications.listPage({ ...filters, page, limit });
      return { ...result, items: withApplicationWarnings(queries, result.items) };
    });
  }

  async delete(id: string, input: { expectedRevision: number }): Promise<void> {
    requireSafeInteger(input.expectedRevision, 'expectedRevision', true);
    await this.repository.write({}, (queries) => {
      const application = queries.applications.get({ id });
      if (!application) throw new ApplicationNotFoundError();
      if (application.revision !== input.expectedRevision) {
        throw new RevisionConflictError(application.revision);
      }
      queries.applications.delete({ id });
      queries.semesters.bump({ id: application.semesterId, now: this.dependencies.now().toISOString() });
    });
  }

  previewSemesterApplicationDeletion(semesterId: string) {
    return this.repository.read((queries) => {
      const semester = semesterById(queries.semesters, semesterId);
      return { semesterName: semester.name, count: queries.applications.count({ semesterId }), ...queries.metadata() };
    });
  }

  async deleteSemesterApplications(semesterId: string, input: {
    confirmationName: string; expectedRevision: number; expectedEpoch: string;
  }): Promise<{ deletedCount: number }> {
    if (!input || typeof input.confirmationName !== 'string'
      || typeof input.expectedEpoch !== 'string' || !input.expectedEpoch) {
      throw new ApplicationValidationError('학기 전체 삭제 요청이 올바르지 않습니다.');
    }
    requireSafeInteger(input.expectedRevision, 'expectedRevision', true);
    return this.repository.write({ expectedRevision: input.expectedRevision, expectedEpoch: input.expectedEpoch }, (queries) => {
      const semester = semesterById(queries.semesters, semesterId);
      if (semester.name !== input.confirmationName) {
        throw new ApplicationValidationError('삭제할 학기명을 정확히 입력하세요.');
      }
      const deletedCount = queries.applications.count({ semesterId });
      if (deletedCount === 0) throw new ApplicationValidationError('선택한 학기에 삭제할 수강신청이 없습니다.');
      queries.applications.deleteSemester({ semesterId });
      queries.semesters.bump({ id: semesterId, now: this.dependencies.now().toISOString() });
      return { deletedCount };
    });
  }

  getSemesterContext(semesterId: string): SemesterContext {
    return this.repository.read((queries) => semesterContext(queries.semesters, semesterId));
  }

  async createSemester(input: { name: string; order: number | null }): Promise<SemesterContext> {
    if (!input || typeof input !== 'object') throw new ApplicationValidationError('학기 정보가 올바르지 않습니다.');
    const name = cleanName(input.name, 'name');
    if (input.order !== null) requireSafeInteger(input.order, 'order');
    return this.repository.write({}, (queries) => {
      if (queries.semesters.getByNameKey({ nameKey: nameKey(name) })) {
        throw new ApplicationConflictError('Semester name must be unique');
      }
      const order = input.order ?? queries.semesters.nextOrder();
      if (queries.semesters.findByOrder({ order })) {
        throw new ApplicationConflictError('Semester order must be unique');
      }
      const now = this.dependencies.now().toISOString();
      const semester: Semester = {
        id: this.dependencies.id(),
        name,
        nameKey: nameKey(name),
        order,
        allocationInputRevision: 0,
        createdAt: now,
        updatedAt: now,
      };
      queries.semesters.insert({ record: semester });
      return semesterContext(queries.semesters, semester.id);
    });
  }

  async moveSemester(input: {
    semesterId: string;
    direction: 'UP' | 'DOWN';
    expectedOrder: number;
    adjacentSemesterId: string;
  }): Promise<SemesterContext> {
    if (!input || !['UP', 'DOWN'].includes(input.direction)
      || typeof input.adjacentSemesterId !== 'string' || !input.adjacentSemesterId) {
      throw new ApplicationValidationError('학기 이동 정보가 올바르지 않습니다.');
    }
    requireSafeInteger(input.expectedOrder, 'expectedOrder');
    return this.repository.write({}, (queries) => {
      const semester = semesterById(queries.semesters, input.semesterId);
      if (semester.order === null) throw new ApplicationValidationError('학기 정보를 저장해 순서를 정한 뒤 이동하세요.');
      const adjacent = queries.semesters.findAdjacent({ semesterId: semester.id, direction: input.direction });
      if (semester.order !== input.expectedOrder || !adjacent || adjacent.id !== input.adjacentSemesterId) {
        throw new ApplicationConflictError('Semester order changed');
      }
      const now = this.dependencies.now().toISOString();
      queries.semesters.swapOrders({ left: semester, right: adjacent, now });
      return semesterContext(queries.semesters, semester.id);
    });
  }

  async deleteSemester(input: { semesterId: string; expectedRevision: number }): Promise<void> {
    requireSafeInteger(input.expectedRevision, 'expectedRevision', true);
    await this.repository.write({}, (queries) => {
      const semester = semesterById(queries.semesters, input.semesterId);
      if (semester.allocationInputRevision !== input.expectedRevision) {
        throw new RevisionConflictError(semester.allocationInputRevision);
      }
      const usage = queries.semesters.usage({ id: semester.id });
      if (usage.applications || usage.enrollments || usage.drafts || usage.receipts) {
        throw new ApplicationConflictError('신청·수강이력·배정초안·확정 기록이 있는 학기는 삭제할 수 없습니다.');
      }
      queries.semesters.delete({ id: semester.id });
    });
  }

  async updateSemesterContext(input: {
    semesterId: string;
    expectedRevision: number;
    name?: string;
    order: number | null;
    semesterCourses: { id?: string; courseName: string; capacity: number | null }[];
  }): Promise<SemesterContext> {
    if (!input || typeof input !== 'object') throw new ApplicationValidationError('학기 정보가 올바르지 않습니다.');
    requireSafeInteger(input.expectedRevision, 'expectedRevision', true);
    if (input.order !== null) requireSafeInteger(input.order, 'order');
    if (!Array.isArray(input.semesterCourses)) {
      throw new ApplicationValidationError('semesterCourses must be an array');
    }
    const cleanCourses = input.semesterCourses.map((item) => {
      if (!item || typeof item !== 'object') throw new ApplicationValidationError('강좌 정보가 올바르지 않습니다.');
      const { id, courseName, capacity } = item;
      if (id !== undefined && (typeof id !== 'string' || id.length < 1)) {
        throw new ApplicationValidationError('id must be a non-empty string');
      }
      const name = cleanName(courseName, 'courseName');
      if (id === undefined && capacity === null) {
        throw new ApplicationValidationError('새 강좌의 정원을 입력하세요.');
      }
      if (capacity !== null) requireSafeInteger(capacity, 'capacity', true);
      return { id, courseName: name, capacity };
    });
    ensureUnique(cleanCourses.map(({ courseName }) => nameKey(courseName)), 'courseName');

    return this.repository.write({}, (queries) => {
      const semester = semesterById(queries.semesters, input.semesterId);
      if (semester.allocationInputRevision !== input.expectedRevision) {
        throw new RevisionConflictError(semester.allocationInputRevision);
      }
      const order = input.order ?? semester.order ?? queries.semesters.nextOrder();
      if (queries.semesters.findByOrder({ order, excludeId: semester.id })) {
        throw new ApplicationConflictError('Semester order must be unique');
      }

      const now = this.dependencies.now().toISOString();
      const semesterName = input.name === undefined ? semester.name : cleanName(input.name, 'name');
      const semesterNameKey = nameKey(semesterName);
      const sameName = queries.semesters.getByNameKey({ nameKey: semesterNameKey });
      if (sameName && sameName.id !== semester.id) {
        throw new ApplicationConflictError('Semester name must be unique');
      }
      semester.name = semesterName;
      semester.nameKey = semesterNameKey;
      semester.order = order;
      queries.semesters.update({ record: semester });
      const changedSemesterIds = new Set([semester.id]);
      for (const item of cleanCourses) {
        let semesterCourse: SemesterCourse;
        let course: Named;
        if (item.id) {
          const existing = queries.semesterCourses.get({ id: item.id });
          if (!existing || existing.semesterId !== semester.id) {
            throw new ApplicationNotFoundError('Semester course was not found');
          }
          semesterCourse = existing;
          const existingCourse = queries.courses.get({ id: existing.courseId });
          if (!existingCourse) throw new ApplicationNotFoundError('Course was not found');
          course = existingCourse;
          const courseNameKey = nameKey(item.courseName);
          if (course.nameKey !== courseNameKey) {
            const sameCourse = queries.courses.getByNameKey({ nameKey: courseNameKey });
            if (sameCourse && sameCourse.id !== course.id) {
              throw new ApplicationConflictError('Course name must be unique');
            }
            course.name = item.courseName;
            course.nameKey = courseNameKey;
            course.updatedAt = now;
            queries.courses.update({ record: course });
            for (const linked of queries.semesterCourses.list({ courseId: course.id })) {
              changedSemesterIds.add(linked.semesterId);
            }
          }
        } else {
          course = resolveCourse(queries.courses, item.courseName, now, this.dependencies.id);
          semesterCourse = resolveSemesterCourse(
            queries.semesterCourses,
            semester.id,
            course.id,
            now,
            this.dependencies.id,
          );
        }
        semesterCourse.capacity = item.capacity;
        semesterCourse.updatedAt = now;
        queries.semesterCourses.update({ record: semesterCourse });
      }
      for (const semesterId of changedSemesterIds) queries.semesters.bump({ id: semesterId, now });
      return semesterContext(queries.semesters, semester.id);
    });
  }

  async deleteSemesterCourse(input: {
    semesterId: string;
    semesterCourseId: string;
    expectedRevision: number;
    confirmApplications: boolean;
  }): Promise<void> {
    if (!input || typeof input !== 'object') throw new ApplicationValidationError('강좌 삭제 정보가 올바르지 않습니다.');
    if (typeof input.semesterCourseId !== 'string' || !input.semesterCourseId) {
      throw new ApplicationValidationError('semesterCourseId must be a non-empty string');
    }
    if (typeof input.confirmApplications !== 'boolean') {
      throw new ApplicationValidationError('confirmApplications must be a boolean');
    }
    requireSafeInteger(input.expectedRevision, 'expectedRevision', true);
    await this.repository.write({}, (queries) => {
      const semester = semesterById(queries.semesters, input.semesterId);
      if (semester.allocationInputRevision !== input.expectedRevision) {
        throw new RevisionConflictError(semester.allocationInputRevision);
      }
      const semesterCourse = queries.semesterCourses.get({ id: input.semesterCourseId });
      if (!semesterCourse || semesterCourse.semesterId !== semester.id) throw new ApplicationNotFoundError('Semester course was not found');
      if (queries.enrollments.hasForCourse({ semesterCourseId: semesterCourse.id })) {
        throw new ApplicationConflictError('Enrollment history uses this semester course');
      }

      const linkedChoiceCount = queries.applicationChoices.countForCourse({ semesterCourseId: semesterCourse.id });
      if (linkedChoiceCount > 0 && !input.confirmApplications) {
        throw new ApplicationConflictError('Application choices use this semester course');
      }

      const now = this.dependencies.now().toISOString();
      queries.applicationChoices.removeCourseChoices({ semesterCourseId: semesterCourse.id, now });
      queries.semesterCourses.delete({ id: semesterCourse.id });
      queries.semesters.bump({ id: semester.id, now });
    });
  }
}

const withApplicationWarnings = (queries: QuerySession, rows: Omit<ApplicationView, 'warnings' | 'reviewStatus'>[]): ApplicationView[] => {
  if (!rows.length) return [];
  const { targets, history } = queries.applications.warningContext({ applicationIds: rows.map(({ id }) => id) });
  const choicesByApplication = new Map<string, typeof targets>();
  for (const target of targets) {
    const choices = choicesByApplication.get(target.applicationId) ?? [];
    choices.push(target);
    choicesByApplication.set(target.applicationId, choices);
  }
  const historyByMember = new Map<string, typeof history>();
  for (const enrollment of history) {
    const records = historyByMember.get(enrollment.memberId) ?? [];
    records.push(enrollment);
    historyByMember.set(enrollment.memberId, records);
  }
  return rows.map((row) => {
    const choices = choicesByApplication.get(row.id) ?? [];
    const warnings = applicationWarnings({
      memberId: row.memberId, semesterOrder: choices[0]?.semesterOrder ?? null,
      choices, history: (historyByMember.get(row.memberId) ?? []).filter(({ semesterId }) => semesterId !== row.semesterId),
    });
    const reviewStatus: ApplicationView['reviewStatus'] = row.applicationOrderStatus !== 'NORMAL'
      || warnings.some(({ code }) => code === 'SEMESTER_ORDER_UNRESOLVED') ? 'NEEDS_REVIEW'
      : warnings.some(({ code }) => code === 'RETAKE') ? 'RETAKE' : 'NORMAL';
    return { ...row, warnings, reviewStatus };
  });
};

const validateApplicationInput = (input: ApplicationInput): ApplicationInput => {
  if (!input || typeof input !== 'object') throw new ApplicationValidationError('신청 행이 올바르지 않습니다.');
  const semesterName = cleanName(input.semesterName, 'semesterName');
  const memberName = cleanName(input.memberName, 'memberName');
  if (input.ministry != null && (typeof input.ministry !== 'string' || input.ministry.trim().length > 200)) {
    throw new ApplicationValidationError('학생 소속은 200자 이내로 입력하세요.');
  }
  const ministry = input.ministry?.trim() || null;
  if (input.applicantNote != null && (typeof input.applicantNote !== 'string' || input.applicantNote.trim().length > 2000)) {
    throw new ApplicationValidationError('신청자 메모는 2000자 이내로 입력하세요.');
  }
  const applicantNote = input.applicantNote?.trim() || null;
  requireSafeInteger(input.applicationOrder, 'applicationOrder');
  if (!Array.isArray(input.choices) || input.choices.length < 1 || input.choices.length > MAX_CHOICES_PER_APPLICATION) {
    throw new ApplicationValidationError(`희망 강좌는 1개 이상, 최대 ${MAX_CHOICES_PER_APPLICATION}개까지 입력할 수 있습니다.`);
  }
  const cleanChoices = input.choices.map((choice) => {
    if (!choice || typeof choice !== 'object') throw new ApplicationValidationError('희망 강좌가 올바르지 않습니다.');
    const { courseName, preference } = choice;
    const name = cleanName(courseName, 'courseName');
    requireSafeInteger(preference, 'preference');
    if (preference > MAX_CHOICES_PER_APPLICATION) throw new ApplicationValidationError(`희망순위는 1~${MAX_CHOICES_PER_APPLICATION} 사이로 입력하세요.`);
    return { courseName: name, preference };
  });
  ensureUnique(cleanChoices.map(({ preference }) => preference), 'preference');
  return { semesterName, memberName, ministry, applicantNote, applicationOrder: input.applicationOrder, choices: cleanChoices };
};

const withRow = (error: unknown, index: number): Error => Object.assign(
  error instanceof Error ? error : new ApplicationValidationError('신청 행이 올바르지 않습니다.'),
  { issues: [{
    code: 'APPLICATION_INPUT_INVALID', severity: 'ERROR',
    message: `${index + 1}행: ${error instanceof Error ? error.message : '입력을 확인하세요.'}`,
    blockingStages: [], acknowledgementStages: [], subject: { entityType: 'Application' },
    source: {}, detail: { rowNumber: index + 1 },
  }] },
);

const cleanName = (value: string, field: string): string => {
  if (typeof value !== 'string') throw new ApplicationValidationError(`${field} must be a string`);
  const clean = value.trim();
  if (clean.length < 1 || clean.length > 200) {
    throw new ApplicationValidationError(`${field} must contain between 1 and 200 characters`);
  }
  return clean;
};

const nameKey = (value: string): string => value.trim().normalize('NFC');

const requireSafeInteger = (value: number, field: string, zeroAllowed = false): void => {
  if (!Number.isSafeInteger(value) || value < (zeroAllowed ? 0 : 1)) {
    throw new ApplicationValidationError(`${field} must be a ${zeroAllowed ? 'non-negative' : 'positive'} safe integer`);
  }
};

const ensureUnique = (values: (string | number)[], field: string): void => {
  if (new Set(values).size !== values.length) {
    throw new ApplicationValidationError(`${field} values must be unique`);
  }
};

const resolveMember = (members: MemberQueries, name: string, now: string, id: () => string): Named => {
  const key = nameKey(name);
  const existing = members.getByNameKey({ nameKey: key });
  if (existing) return existing;
  const created = { id: id(), name, nameKey: key, createdAt: now, updatedAt: now };
  members.insert({ record: created });
  return created;
};

const resolveCourse = (courses: CourseQueries, name: string, now: string, id: () => string): Named => {
  const key = nameKey(name);
  const existing = courses.getByNameKey({ nameKey: key });
  if (existing) return existing;
  const created = { id: id(), name, nameKey: key, createdAt: now, updatedAt: now };
  courses.insert({ record: created });
  return created;
};

const resolveSemester = (
  semesters: SemesterQueries,
  name: string,
  now: string,
  id: () => string,
): Semester => {
  const key = nameKey(name);
  const existing = semesters.getByNameKey({ nameKey: key });
  if (existing) return existing;
  const created: Semester = {
    id: id(),
    name,
    nameKey: key,
    order: semesters.nextOrder(),
    allocationInputRevision: 0,
    createdAt: now,
    updatedAt: now,
  };
  semesters.insert({ record: created });
  return created;
};

const resolveSemesterCourse = (
  semesterCourses: SemesterCourseQueries,
  semesterId: string,
  courseId: string,
  now: string,
  id: () => string,
): SemesterCourse => {
  const existing = semesterCourses.getByPair({ semesterId, courseId });
  if (existing) return existing;
  const created: SemesterCourse = {
    id: id(),
    semesterId,
    courseId,
    capacity: null,
    createdAt: now,
    updatedAt: now,
  };
  semesterCourses.insert({ record: created });
  return created;
};

const semesterContext = (semesters: SemesterQueries, id: string): SemesterContext => {
  const context = semesters.context({ id });
  if (!context) throw new ApplicationNotFoundError('Semester was not found');
  return context;
};

const semesterById = (semesters: SemesterQueries, id: string): Semester => {
  const semester = semesters.get({ id });
  if (!semester) throw new ApplicationNotFoundError('Semester was not found');
  return semester;
};

import type {
  ApplicationChoiceRecord as Choice,
  ApplicationRecord as Application,
  DatabaseState,
  NamedRecord as Named,
  SemesterCourseRecord as SemesterCourse,
  SemesterRecord as Semester,
  Store,
} from '../storage/store.ts';
import { nextSemesterOrder } from './semester-order.ts';

type ApplicationData = ReturnType<Store['applicationData']>;

export type ApplicationInput = {
  semesterName: string;
  memberName: string;
  applicationOrder: number;
  choices: { courseName: string; preference: number }[];
};

export type ApplicationView = Pick<Application,
  'id' | 'semesterId' | 'memberId' | 'applicationOrder' | 'applicationOrderStatus' | 'orderResolution' | 'revision'
> & {
  semesterName: string;
  memberName: string;
  choices: (Pick<Choice, 'id' | 'semesterCourseId' | 'preference'> & { courseName: string })[];
};

export type ApplicationListFilters = {
  memberName?: string;
  semesterId?: string;
  courseId?: string;
  sort?: ApplicationSort;
};

export const APPLICATION_SORTS = ['ORDER_ASC', 'ORDER_DESC', 'NAME_ASC', 'NAME_DESC'] as const;
export type ApplicationSort = typeof APPLICATION_SORTS[number];

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
  private readonly store: Store;
  private readonly dependencies: Dependencies;

  constructor(
    store: Store,
    dependencies: Dependencies,
  ) {
    this.store = store;
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
    return this.store.write({}, (data) => {
      const now = this.dependencies.now().toISOString();
      return cleanInputs.map((clean, index) => {
        const semester = resolveSemester(data, clean.semesterName, now, this.dependencies.id);
        const member = resolveNamed(members(data), clean.memberName, now, this.dependencies.id);
        if (applications(data).some((item) => (
          item.semesterId === semester.id && item.memberId === member.id
        ))) throw withRow(new ApplicationConflictError('같은 학기에 이미 신청한 회원입니다.'), index);

        const application: Application = {
          id: this.dependencies.id(),
          semesterId: semester.id,
          memberId: member.id,
          applicationOrder: clean.applicationOrder,
          applicationOrderStatus: 'NORMAL',
          orderResolution: 'SOURCE_AGREED',
          orderResolutionNote: null,
          revision: 0,
          createdAt: now,
          updatedAt: now,
        };
        applications(data).push(application);
        for (const inputChoice of clean.choices) {
          const course = resolveNamed(courses(data), inputChoice.courseName, now, this.dependencies.id);
          const semesterCourse = resolveSemesterCourse(
            data,
            semester.id,
            course.id,
            now,
            this.dependencies.id,
          );
          choices(data).push({
            id: this.dependencies.id(),
            applicationId: application.id,
            semesterCourseId: semesterCourse.id,
            preference: inputChoice.preference,
            sourceRefs: [],
            createdAt: now,
            updatedAt: now,
          });
        }
        bumpSemester(semester, now);
        return applicationView(data, application);
      });
    });
  }

  async update(id: string, input: ApplicationInput & { expectedRevision: number }): Promise<ApplicationView> {
    const clean = validateApplicationInput(input);
    requireSafeInteger(input.expectedRevision, 'expectedRevision', true);
    return this.store.write({}, (data) => {
      const current = applications(data).find((item) => item.id === id);
      if (!current) throw new ApplicationNotFoundError();
      if (current.revision !== input.expectedRevision) throw new RevisionConflictError(current.revision);

      const now = this.dependencies.now().toISOString();
      const oldSemester = semesterById(data, current.semesterId);
      const semester = resolveSemester(data, clean.semesterName, now, this.dependencies.id);
      const member = resolveNamed(members(data), clean.memberName, now, this.dependencies.id);
      if (applications(data).some((item) => (
        item.id !== id && item.semesterId === semester.id && item.memberId === member.id
      ))) throw new ApplicationConflictError();

      const nextChoices = clean.choices.map((inputChoice): Choice => {
        const course = resolveNamed(courses(data), inputChoice.courseName, now, this.dependencies.id);
        const semesterCourse = resolveSemesterCourse(
          data,
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
      current.applicationOrder = clean.applicationOrder;
      current.revision += 1;
      current.updatedAt = now;
      data.applicationChoices = choices(data).filter((item) => item.applicationId !== id);
      choices(data).push(...nextChoices);
      bumpSemester(oldSemester, now);
      if (semester.id !== oldSemester.id) bumpSemester(semester, now);
      return applicationView(data, current);
    });
  }

  get(id: string): ApplicationView {
    const data = this.store.applicationData();
    const application = applications(data).find((item) => item.id === id);
    if (!application) throw new ApplicationNotFoundError();
    return applicationView(data, application);
  }

  list(filters: ApplicationListFilters = {}): ApplicationView[] {
    const data = this.store.applicationData();
    const memberName = filters.memberName?.trim().normalize('NFC');
    const matchingSemesterCourses = filters.courseId
      ? new Set(semesterCourses(data).filter(({ courseId }) => courseId === filters.courseId).map(({ id }) => id))
      : null;
    const items = applications(data).filter((application) => (
      (!filters.semesterId || application.semesterId === filters.semesterId)
      && (!memberName || members(data).find(({ id }) => id === application.memberId)?.nameKey.includes(memberName))
      && (!matchingSemesterCourses || choices(data).some((choice) => (
        choice.applicationId === application.id && matchingSemesterCourses.has(choice.semesterCourseId)
      )))
    )).map((application) => applicationView(data, application));
    if (!filters.sort) return items;
    return items.sort((left, right) => {
      const leftOrder = left.applicationOrder ?? Infinity;
      const rightOrder = right.applicationOrder ?? Infinity;
      const orderDifference = leftOrder === rightOrder ? 0 : leftOrder - rightOrder;
      const nameDifference = left.memberName.localeCompare(right.memberName, 'ko');
      const selectedDifference = filters.sort === 'ORDER_DESC'
        ? (Number.isFinite(leftOrder) && Number.isFinite(rightOrder) ? -orderDifference : orderDifference)
        : filters.sort === 'NAME_ASC' ? nameDifference
          : filters.sort === 'NAME_DESC' ? -nameDifference : orderDifference;
      return selectedDifference || orderDifference || nameDifference || left.id.localeCompare(right.id);
    });
  }

  async delete(id: string, input: { expectedRevision: number }): Promise<void> {
    requireSafeInteger(input.expectedRevision, 'expectedRevision', true);
    await this.store.write({}, (data) => {
      const application = applications(data).find((item) => item.id === id);
      if (!application) throw new ApplicationNotFoundError();
      if (application.revision !== input.expectedRevision) {
        throw new RevisionConflictError(application.revision);
      }
      data.applications = applications(data).filter((item) => item.id !== id);
      data.applicationChoices = choices(data).filter((item) => item.applicationId !== id);
      bumpSemester(semesterById(data, application.semesterId), this.dependencies.now().toISOString());
    });
  }

  getSemesterContext(semesterId: string): ReturnType<typeof semesterContext> {
    const data = this.store.applicationData();
    return semesterContext(data, semesterById(data, semesterId));
  }

  async createSemester(input: { name: string; order: number | null }): Promise<ReturnType<typeof semesterContext>> {
    if (!input || typeof input !== 'object') throw new ApplicationValidationError('학기 정보가 올바르지 않습니다.');
    const name = cleanName(input.name, 'name');
    if (input.order !== null) requireSafeInteger(input.order, 'order');
    return this.store.write({}, (data) => {
      if (semesters(data).some((item) => item.nameKey === nameKey(name))) {
        throw new ApplicationConflictError('Semester name must be unique');
      }
      const order = input.order ?? nextSemesterOrder(semesters(data));
      if (semesters(data).some((item) => item.order === order)) {
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
      semesters(data).push(semester);
      return semesterContext(data, semester);
    });
  }

  async moveSemester(input: {
    semesterId: string;
    direction: 'UP' | 'DOWN';
    expectedOrder: number;
    adjacentSemesterId: string;
  }): Promise<ReturnType<typeof semesterContext>> {
    if (!input || !['UP', 'DOWN'].includes(input.direction)
      || typeof input.adjacentSemesterId !== 'string' || !input.adjacentSemesterId) {
      throw new ApplicationValidationError('학기 이동 정보가 올바르지 않습니다.');
    }
    requireSafeInteger(input.expectedOrder, 'expectedOrder');
    return this.store.write({}, (data) => {
      const semester = semesterById(data, input.semesterId);
      if (semester.order === null) throw new ApplicationValidationError('학기 정보를 저장해 순서를 정한 뒤 이동하세요.');
      const ordered = semesters(data).filter(({ order }) => order !== null)
        .sort((left, right) => right.order! - left.order!);
      const index = ordered.findIndex(({ id }) => id === semester.id);
      const adjacent = ordered[index + (input.direction === 'UP' ? -1 : 1)];
      if (semester.order !== input.expectedOrder || !adjacent || adjacent.id !== input.adjacentSemesterId) {
        throw new ApplicationConflictError('Semester order changed');
      }
      const now = this.dependencies.now().toISOString();
      [semester.order, adjacent.order] = [adjacent.order, semester.order];
      bumpSemester(semester, now);
      bumpSemester(adjacent, now);
      return semesterContext(data, semester);
    });
  }

  async deleteSemester(input: { semesterId: string; expectedRevision: number }): Promise<void> {
    requireSafeInteger(input.expectedRevision, 'expectedRevision', true);
    await this.store.write({}, (data) => {
      const semester = semesterById(data, input.semesterId);
      if (semester.allocationInputRevision !== input.expectedRevision) {
        throw new RevisionConflictError(semester.allocationInputRevision);
      }
      const offerings = semesterCourses(data).filter(({ semesterId }) => semesterId === semester.id);
      const offeringIds = new Set(offerings.map(({ id }) => id));
      if (applications(data).some(({ semesterId }) => semesterId === semester.id)
        || enrollments(data).some(({ semesterCourseId }) => offeringIds.has(semesterCourseId))
        || data.allocationDrafts.some(({ semesterId }) => semesterId === semester.id)
        || data.finalizationReceipts.some(({ semesterId }) => semesterId === semester.id)) {
        throw new ApplicationConflictError('신청·수강이력·배정초안·확정 기록이 있는 학기는 삭제할 수 없습니다.');
      }
      data.semesterCourses = semesterCourses(data).filter(({ semesterId }) => semesterId !== semester.id);
      const remainingCourseIds = new Set(semesterCourses(data).map(({ courseId }) => courseId));
      const removedCourseIds = new Set(offerings.map(({ courseId }) => courseId));
      data.courses = courses(data).filter(({ id }) => !removedCourseIds.has(id) || remainingCourseIds.has(id));
      data.semesters = semesters(data).filter(({ id }) => id !== semester.id);
    });
  }

  async updateSemesterContext(input: {
    semesterId: string;
    expectedRevision: number;
    name?: string;
    order: number | null;
    semesterCourses: { id?: string; courseName: string; capacity: number | null }[];
  }): Promise<ReturnType<typeof semesterContext>> {
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

    return this.store.write({}, (data) => {
      const semester = semesterById(data, input.semesterId);
      if (semester.allocationInputRevision !== input.expectedRevision) {
        throw new RevisionConflictError(semester.allocationInputRevision);
      }
      const order = input.order ?? semester.order ?? nextSemesterOrder(semesters(data));
      if (
        semesters(data).some((item) => item.id !== semester.id && item.order === order)
      ) throw new ApplicationConflictError('Semester order must be unique');

      const now = this.dependencies.now().toISOString();
      const semesterName = input.name === undefined ? semester.name : cleanName(input.name, 'name');
      const semesterNameKey = nameKey(semesterName);
      if (semesters(data).some((item) => item.id !== semester.id && item.nameKey === semesterNameKey)) {
        throw new ApplicationConflictError('Semester name must be unique');
      }
      semester.name = semesterName;
      semester.nameKey = semesterNameKey;
      semester.order = order;
      const changedSemesterIds = new Set([semester.id]);
      for (const item of cleanCourses) {
        let semesterCourse: SemesterCourse;
        let course: Named;
        if (item.id) {
          const existing = semesterCourses(data).find((candidate) => candidate.id === item.id);
          if (!existing || existing.semesterId !== semester.id) {
            throw new ApplicationNotFoundError('Semester course was not found');
          }
          semesterCourse = existing;
          const existingCourse = courses(data).find((candidate) => candidate.id === existing.courseId);
          if (!existingCourse) throw new ApplicationNotFoundError('Course was not found');
          course = existingCourse;
          const courseNameKey = nameKey(item.courseName);
          if (course.nameKey !== courseNameKey) {
            if (courses(data).some((candidate) => candidate.id !== course.id && candidate.nameKey === courseNameKey)) {
              throw new ApplicationConflictError('Course name must be unique');
            }
            course.name = item.courseName;
            course.nameKey = courseNameKey;
            course.updatedAt = now;
            for (const linked of semesterCourses(data)) {
              if (linked.courseId === course.id) changedSemesterIds.add(linked.semesterId);
            }
          }
        } else {
          course = resolveNamed(courses(data), item.courseName, now, this.dependencies.id);
          semesterCourse = resolveSemesterCourse(
            data,
            semester.id,
            course.id,
            now,
            this.dependencies.id,
          );
        }
        semesterCourse.capacity = item.capacity;
        semesterCourse.updatedAt = now;
      }
      for (const semesterId of changedSemesterIds) bumpSemester(semesterById(data, semesterId), now);
      return semesterContext(data, semester);
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
    await this.store.write({}, (data) => {
      const semester = semesterById(data, input.semesterId);
      if (semester.allocationInputRevision !== input.expectedRevision) {
        throw new RevisionConflictError(semester.allocationInputRevision);
      }
      const semesterCourse = semesterCourses(data).find(({ id, semesterId }) => (
        id === input.semesterCourseId && semesterId === semester.id
      ));
      if (!semesterCourse) throw new ApplicationNotFoundError('Semester course was not found');
      if (enrollments(data).some(({ semesterCourseId }) => semesterCourseId === semesterCourse.id)) {
        throw new ApplicationConflictError('Enrollment history uses this semester course');
      }

      const linkedChoices = choices(data).filter(({ semesterCourseId }) => semesterCourseId === semesterCourse.id);
      if (linkedChoices.length > 0 && !input.confirmApplications) {
        throw new ApplicationConflictError('Application choices use this semester course');
      }

      const now = this.dependencies.now().toISOString();
      const affectedApplicationIds = new Set(linkedChoices.map(({ applicationId }) => applicationId));
      data.applicationChoices = choices(data).filter(({ semesterCourseId }) => semesterCourseId !== semesterCourse.id);
      const applicationsWithChoices = new Set(choices(data).map(({ applicationId }) => applicationId));
      data.applications = applications(data).filter((application) => {
        if (!affectedApplicationIds.has(application.id)) return true;
        if (!applicationsWithChoices.has(application.id)) return false;
        application.revision += 1;
        application.updatedAt = now;
        return true;
      });
      data.semesterCourses = semesterCourses(data).filter(({ id }) => id !== semesterCourse.id);
      if (!semesterCourses(data).some(({ courseId }) => courseId === semesterCourse.courseId)) {
        data.courses = courses(data).filter(({ id }) => id !== semesterCourse.courseId);
      }
      bumpSemester(semester, now);
    });
  }
}

const validateApplicationInput = (input: ApplicationInput): ApplicationInput => {
  if (!input || typeof input !== 'object') throw new ApplicationValidationError('신청 행이 올바르지 않습니다.');
  const semesterName = cleanName(input.semesterName, 'semesterName');
  const memberName = cleanName(input.memberName, 'memberName');
  requireSafeInteger(input.applicationOrder, 'applicationOrder');
  if (!Array.isArray(input.choices) || input.choices.length < 1 || input.choices.length > 100) {
    throw new ApplicationValidationError('choices must contain between 1 and 100 items');
  }
  const cleanChoices = input.choices.map((choice) => {
    if (!choice || typeof choice !== 'object') throw new ApplicationValidationError('희망 강좌가 올바르지 않습니다.');
    const { courseName, preference } = choice;
    const name = cleanName(courseName, 'courseName');
    requireSafeInteger(preference, 'preference');
    return { courseName: name, preference };
  });
  ensureUnique(cleanChoices.map(({ courseName }) => nameKey(courseName)), 'courseName');
  ensureUnique(cleanChoices.map(({ preference }) => preference), 'preference');
  return { semesterName, memberName, applicationOrder: input.applicationOrder, choices: cleanChoices };
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

const resolveNamed = (items: Named[], name: string, now: string, id: () => string): Named => {
  const key = nameKey(name);
  const existing = items.find((item) => item.nameKey === key);
  if (existing) return existing;
  const created = { id: id(), name, nameKey: key, createdAt: now, updatedAt: now };
  items.push(created);
  return created;
};

const resolveSemester = (
  data: DatabaseState,
  name: string,
  now: string,
  id: () => string,
): Semester => {
  const key = nameKey(name);
  const existing = semesters(data).find((item) => item.nameKey === key);
  if (existing) return existing;
  const created: Semester = {
    id: id(),
    name,
    nameKey: key,
    order: nextSemesterOrder(semesters(data)),
    allocationInputRevision: 0,
    createdAt: now,
    updatedAt: now,
  };
  semesters(data).push(created);
  return created;
};

const resolveSemesterCourse = (
  data: DatabaseState,
  semesterId: string,
  courseId: string,
  now: string,
  id: () => string,
): SemesterCourse => {
  const existing = semesterCourses(data).find((item) => (
    item.semesterId === semesterId && item.courseId === courseId
  ));
  if (existing) return existing;
  const created: SemesterCourse = {
    id: id(),
    semesterId,
    courseId,
    capacity: null,
    createdAt: now,
    updatedAt: now,
  };
  semesterCourses(data).push(created);
  return created;
};

const applicationView = (data: ApplicationData, application: Application): ApplicationView => {
  const semester = semesterById(data, application.semesterId);
  const member = members(data).find((item) => item.id === application.memberId);
  if (!member) throw new ApplicationNotFoundError('Application member was not found');
  return {
    id: application.id,
    semesterId: application.semesterId,
    memberId: application.memberId,
    semesterName: semester.name,
    memberName: member.name,
    applicationOrder: application.applicationOrder,
    applicationOrderStatus: application.applicationOrderStatus,
    orderResolution: application.orderResolution,
    revision: application.revision,
    choices: choices(data)
      .filter((item) => item.applicationId === application.id)
      .map((choice) => {
        const semesterCourse = semesterCourses(data).find((item) => item.id === choice.semesterCourseId);
        const course = semesterCourse && courses(data).find((item) => item.id === semesterCourse.courseId);
        if (!semesterCourse || !course || semesterCourse.semesterId !== application.semesterId) {
          throw new ApplicationValidationError('Choice must reference a course from the application semester');
        }
        return {
          id: choice.id,
          semesterCourseId: choice.semesterCourseId,
          courseName: course.name,
          preference: choice.preference,
        };
      }),
  };
};

const semesterContext = (data: ApplicationData, semester: Semester) => {
  const items = semesterCourses(data)
    .filter((item) => item.semesterId === semester.id)
    .map((item) => {
      const course = courses(data).find((candidate) => candidate.id === item.courseId);
      if (!course) throw new ApplicationValidationError('Semester course has no course');
      return {
        id: item.id,
        courseId: item.courseId,
        courseName: course.name,
        capacity: item.capacity,
        applicationCount: choices(data).filter(({ semesterCourseId }) => semesterCourseId === item.id).length,
        enrollmentCount: enrollments(data).filter(({ semesterCourseId }) => semesterCourseId === item.id).length,
      };
    });
  const issues = items.some(({ capacity }) => capacity === null) ? [{ code: 'CAPACITY_UNRESOLVED' }] : [];
  return {
    semester: { id: semester.id, name: semester.name },
    order: semester.order,
    allocationInputRevision: semester.allocationInputRevision,
    semesterCourses: items,
    readyForAutoAllocation: issues.length === 0,
    issues,
  };
};

const bumpSemester = (semester: Semester, now: string): void => {
  semester.allocationInputRevision += 1;
  semester.updatedAt = now;
};

const semesterById = (data: ApplicationData, id: string): Semester => {
  const semester = semesters(data).find((item) => item.id === id);
  if (!semester) throw new ApplicationNotFoundError('Semester was not found');
  return semester;
};

const semesters = (data: ApplicationData): Semester[] => data.semesters;
const members = (data: ApplicationData): Named[] => data.members;
const courses = (data: ApplicationData): Named[] => data.courses;
const semesterCourses = (data: ApplicationData): SemesterCourse[] => data.semesterCourses;
const applications = (data: ApplicationData): Application[] => data.applications;
const choices = (data: ApplicationData): Choice[] => data.applicationChoices;
const enrollments = (data: ApplicationData): DatabaseState['enrollments'] => data.enrollments;

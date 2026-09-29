/**
 * @typedef {import('../backend/src/storage/store.ts').AllocationDraftItemRecord} DraftItem
 * @typedef {Pick<import('../backend/src/allocation/engine.ts').AllocationSnapshot, 'applications' | 'choices' | 'semesterCourses'>} DraftSnapshot
 */

/** @param {string} code */
export const reasonLabel = (code) => (/** @type {Record<string, string>} */ ({
  PREFERENCE_ALLOCATED: '희망 배정',
  ALREADY_TAKEN: '과거 수강',
  CAPACITY_FULL: '당시 정원 경쟁 탈락',
  ALLOCATED_TO_HIGHER_PREFERENCE: '상위 희망 배정으로 미검토',
  RANDOM_FALLBACK: '대체 배정',
  NO_FALLBACK_COURSE: '대체 강좌 없음',
  FALLBACK_COMPETITION_LOST: '대체 배정 경쟁 탈락',
  ALREADY_ENROLLED: '동일 학기 확정 이력',
  MANUAL_ONLY: '수동 검토',
  ADMIN_OVERRIDE: '관리자 변경',
  ADMIN_EXCLUDED: '관리자 제외',
  ADMIN_ADDED: '관리자 추가',
  MANUAL_INCLUDED: '관리자 포함',
  MANUAL_EXCLUDED: '관리자 제외',
  MANUAL_CHANGED: '관리자 변경',
})[code] ?? code);

/** @param {DraftSnapshot} snapshot */
export const draftApplicationSummaries = (snapshot) => {
  const courseNames = new Map(snapshot.semesterCourses.map(({ id, courseName }) => [id, courseName]));
  /** @type {Map<string, DraftSnapshot['choices']>} */
  const choicesByApplication = new Map(snapshot.applications.map(({ id }) => [id, []]));
  for (const choice of snapshot.choices) choicesByApplication.get(choice.applicationId)?.push(choice);
  return new Map(snapshot.applications.map(({ id, applicationOrder }) => {
    const choices = (choicesByApplication.get(id) ?? [])
      .sort((left, right) => (left.preference ?? Infinity) - (right.preference ?? Infinity))
      .map(({ preference, semesterCourseId }) => (
        `${preference === null ? '순위 미정:' : `${preference}.`} ${courseNames.get(semesterCourseId) ?? '강좌 미정'}`
      )).join(' · ');
    return [id, { applicationOrder, choices: choices || '희망 강좌 없음' }];
  }));
};

/**
 * @param {Pick<import('../backend/src/services/drafts.ts').DraftDetail, 'courseSummary' | 'studentResults'>} detail
 * @param {ReadonlyMap<string, string>} [selections]
 */
export const draftCourseStatuses = (detail, selections = new Map()) => {
  const counts = new Map(detail.courseSummary.map((course) => [course.semesterCourseId, course.finalSelectedCount]));
  const snapshotIds = new Set(counts.keys());
  for (const item of detail.studentResults) {
    if (item.finalDecision === 'SELECTED' && item.finalSemesterCourseId && !snapshotIds.has(item.finalSemesterCourseId)) {
      counts.set(item.finalSemesterCourseId, (counts.get(item.finalSemesterCourseId) ?? 0) + 1);
    }
  }
  for (const item of detail.studentResults) {
    const selected = selections.get(item.memberId);
    if (selected === undefined) continue;
    const previous = item.finalDecision === 'SELECTED' ? item.finalSemesterCourseId : '';
    if (previous === selected) continue;
    if (previous) counts.set(previous, (counts.get(previous) ?? 0) - 1);
    if (selected) counts.set(selected, (counts.get(selected) ?? 0) + 1);
  }
  const courses = [...detail.courseSummary, ...[...counts].filter(([id]) => !snapshotIds.has(id)).map(([id, count]) => ({
    semesterCourseId: id, capacity: null, existingEnrollmentCount: 0, finalSelectedCount: count, remaining: null,
  }))];
  return courses.map((course) => {
    const hasSnapshot = snapshotIds.has(course.semesterCourseId);
    const finalSelectedCount = counts.get(course.semesterCourseId) ?? 0;
    const totalCount = course.existingEnrollmentCount + finalSelectedCount;
    const remaining = course.capacity === null ? null : Math.max(0, course.capacity - totalCount);
    const status = !hasSnapshot ? '현황 미확인 · 새 초안 필요' : course.capacity === null ? '정원 미정'
      : totalCount > course.capacity ? `정원 초과 ${totalCount - course.capacity}명`
        : remaining === 0 ? '정원 마감' : `잔여 ${remaining}명`;
    return { ...course, finalSelectedCount, totalCount, remaining, status, hasSnapshot };
  });
};

/** @param {DraftItem[]} items @param {{ query?: string, result?: string, courseName: (id: string | null) => string }} options */
export const filterDraftItems = (items, { query = '', result = 'ALL', courseName }) => {
  const keyword = query.trim().normalize('NFC').toLocaleLowerCase('ko');
  return items.filter((item) => {
    const visibleText = [
      item.memberNameAtGeneration,
      courseName(item.autoSemesterCourseId),
      courseName(item.finalSemesterCourseId),
      reasonLabel(item.autoReasonCode),
    ].join(' ').normalize('NFC').toLocaleLowerCase('ko');
    const matchesResult = result === 'ALL'
      || item.autoReasonCode === result
      || (result === 'AUTO_REJECTED' && item.autoDecision === 'REJECTED')
      || (result === 'MANUAL_CHANGED' && item.finalReasonCode !== null);
    return matchesResult && (!keyword || visibleText.includes(keyword));
  });
};

/** @param {DraftItem[]} items @param {{ applications: ReadonlyMap<string, { applicationOrder: number | null }>, courseView: boolean, courseName: (id: string | null) => string, sort?: string }} options */
export const sortDraftItems = (items, { applications, courseView, courseName, sort = 'ORDER_ASC' }) => [...items].sort((left, right) => {
  const courseDifference = courseView
    ? courseName(left.finalSemesterCourseId).localeCompare(courseName(right.finalSemesterCourseId), 'ko')
    : 0;
  const leftOrder = applications.get(left.sourceApplicationId ?? '')?.applicationOrder ?? Infinity;
  const rightOrder = applications.get(right.sourceApplicationId ?? '')?.applicationOrder ?? Infinity;
  const orderDifference = leftOrder === rightOrder ? 0 : leftOrder - rightOrder;
  const nameDifference = left.memberNameAtGeneration.localeCompare(right.memberNameAtGeneration, 'ko');
  const selectedDifference = sort === 'ORDER_DESC'
    ? (Number.isFinite(leftOrder) && Number.isFinite(rightOrder) ? -orderDifference : orderDifference)
    : sort === 'NAME_ASC' ? nameDifference
      : sort === 'NAME_DESC' ? -nameDifference : orderDifference;
  return courseDifference
    || selectedDifference
    || orderDifference
    || nameDifference
    || left.memberId.localeCompare(right.memberId);
});

/** @template T @param {T[]} items @param {number} requestedPage @param {number} limit */
export const draftItemPage = (items, requestedPage, limit) => {
  const page = Math.min(Math.max(1, requestedPage), Math.max(1, Math.ceil(items.length / limit)));
  return { items: items.slice((page - 1) * limit, page * limit), page, limit, total: items.length };
};

/** @param {Pick<DraftItem, 'autoDecision' | 'autoSemesterCourseId'>} item @param {string} semesterCourseId */
export const draftFinalSelection = (item, semesterCourseId) => {
  const automaticCourseId = item.autoDecision === 'SELECTED' ? item.autoSemesterCourseId : '';
  const changed = semesterCourseId !== automaticCourseId;
  const selected = Boolean(semesterCourseId);
  return {
    finalDecision: selected ? 'SELECTED' : 'REJECTED',
    finalSemesterCourseId: semesterCourseId || null,
    finalReasonCode: changed ? (selected ? 'ADMIN_OVERRIDE' : 'ADMIN_EXCLUDED') : null,
    finalReasonDetail: changed ? {
      note: selected ? '관리자가 최종 배정 강좌를 변경했습니다.' : '관리자가 최종 배정에서 제외했습니다.',
    } : null,
  };
};

/** @param {Pick<DraftItem, 'autoDecision' | 'finalDecision' | 'autoSemesterCourseId' | 'finalSemesterCourseId'>} item */
export const draftDecisionChanged = (item) => item.autoDecision !== 'NOT_EVALUATED'
  && (item.autoDecision !== item.finalDecision
    || item.autoSemesterCourseId !== item.finalSemesterCourseId);

/** @param {Pick<DraftItem, 'autoReasonDetail' | 'finalReasonCode' | 'finalSemesterCourseId'>} item @param {(id: string | null) => string} courseName */
export const describeAllocationEvidence = (item, courseName) => {
  const attempts = [...(item.autoReasonDetail?.preferenceAttempts ?? [])]
    .sort((left, right) => left.preference - right.preference)
    .map((attempt) => `${attempt.preference}순위 ${attempt.courseNameAtGeneration}: ${reasonLabel(attempt.reasonCode)}`);
  const fallback = item.autoReasonDetail?.fallback;
  if (fallback) {
    attempts.push(`대체 후보: ${fallback.stageCandidateSemesterCourseIds.map(courseName).join(', ') || '없음'}`);
    attempts.push(`대체 선택: ${courseName(fallback.selectedSemesterCourseId)} · 대체 단계 총 ${fallback.totalAssignedInStage}명 배정`);
  }
  if (item.finalReasonCode) {
    attempts.push(`관리자 변경: ${reasonLabel(item.finalReasonCode)} · 최종 ${courseName(item.finalSemesterCourseId)}`);
  }
  return attempts.length ? attempts : ['자동 계산 없이 관리자가 검토합니다.'];
};

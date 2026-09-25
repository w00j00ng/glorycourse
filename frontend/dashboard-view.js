export const orderSemesters = (semesters) => [...semesters].sort((left, right) => {
  if (left.order === null) return right.order === null ? 0 : 1;
  if (right.order === null) return -1;
  return right.order - left.order;
});

export const currentSemester = (semesters) => (
  orderSemesters(semesters).find(({ order }) => order !== null) ?? null
);

const task = (label, description, view, action, stage) => ({ label, description, view, action, stage });

export const nextDashboardTask = (summary) => {
  if (!summary.semester) {
    return task('학기 추가', '수강신청을 받기 전에 새 학기를 추가하세요.', 'catalog', '학기·강좌 관리로 이동', 0);
  }
  if (summary.courseCount === 0) {
    return task('강좌 추가', '현재 학기에 개설할 강좌를 등록하세요.', 'catalog', '강좌 추가하러 가기', 0);
  }
  if (summary.unresolvedCapacityCount > 0) {
    return task('강좌 정원 입력', '정원이 비어 있는 강좌를 확인하고 정원을 입력하세요.', 'catalog', '강좌 정원 입력하러 가기', 0);
  }
  if (summary.applicationCount === 0) {
    return task('신청 양식 다운로드 또는 신청 등록', '현재 학기의 수강신청을 받아 등록하세요.', 'applications', '수강신청으로 이동', 1);
  }
  if (!summary.latestDraft || summary.latestDraft.status === 'ARCHIVED') {
    return task('배정초안 생성', '등록된 신청을 바탕으로 배정초안을 만드세요.', 'drafts', '배정초안 만들러 가기', 2);
  }
  if (summary.latestDraft.isStale) {
    return task('배정초안 다시 생성', '초안 생성 뒤 원본 자료가 변경되었습니다. 새 초안을 만드세요.', 'drafts', '배정초안으로 이동', 2);
  }
  if (summary.latestDraft.status === 'DRAFT' && summary.latestDraft.revision === 0) {
    return task('배정초안 검토', '자동 배정 결과와 관리자 최종 결정을 확인하세요.', 'drafts', '배정초안 검토하러 가기', 2);
  }
  if (summary.latestDraft.status === 'DRAFT') {
    return task('배정 확정', '검토한 배정초안을 확정해 수강이력에 반영하세요.', 'drafts', '배정 확정하러 가기', 2);
  }
  if (summary.latestDraft.status === 'FINALIZED') {
    if (!summary.latestDraft.enrollmentReportIsCurrent) {
      return task('수강이력 확인 및 현황 다운로드', '확정된 수강이력을 확인하고 현재 학기 현황을 내려받으세요.', 'enrollments', '수강이력으로 이동', 3);
    }
    return task('현재 학기 업무가 완료되었습니다', '현재 학기의 확정 결과를 확인하고 현황 파일을 내려받았습니다.', 'enrollments', '수강이력으로 이동', 4);
  }
  return task('배정초안 생성', '등록된 신청을 바탕으로 배정초안을 만드세요.', 'drafts', '배정초안 만들러 가기', 2);
};

export const allocationDraftStatus = (draft) => {
  if (!draft) return '없음';
  if (draft.isStale) return '원본 변경됨';
  if (draft.status === 'FINALIZED') return '확정 완료';
  if (draft.status === 'ARCHIVED') return '보관됨';
  return draft.revision === 0 ? '검토 중' : '확정 가능';
};

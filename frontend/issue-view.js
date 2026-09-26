/** @type {Record<string, string>} */
const messages = {
  SAME_SEMESTER_ENROLLMENT: '같은 학기에 수강이력이 이미 있습니다. 기존 이력을 확인하세요.',
  SEMESTER_ORDER_UNRESOLVED: '학기 순서를 확인하세요. 과거 수강이력이 있으면 해당 학기의 순서도 입력하세요.',
  CAPACITY_UNRESOLVED: '강좌의 개설 여부와 정원을 확인하세요.',
  APPLICATION_COURSE_CAPACITY_MISSING: '신청 강좌의 정원을 먼저 입력하세요.',
  SEMESTER_COURSE_CAPACITY_MISSING: '강좌 정원을 입력하세요. 0명도 입력할 수 있습니다.',
  CAPACITY_EXCEEDED: '강좌 정원을 초과합니다. 인원을 조정하거나, 그대로 진행하려면 사유를 입력하세요.',
  RETAKE: '이전 학기에 수강한 강좌입니다. 다시 등록하려면 사유를 입력하세요.',
  LIVE_REFERENCE_INVALID: '선택한 회원이나 강좌 정보가 변경되었습니다. 초안을 다시 검토하세요.',
  RELATED_IMPORT_STAGED: '선택한 신청 자료의 엑셀 반영이 완료되지 않았습니다. 반영 상태를 확인하세요.',
  INPUT_UNAVAILABLE: '현재 자료를 확인할 수 없습니다. 학기와 강좌를 확인한 뒤 초안을 다시 만드세요.',
  SEMESTER_CHANGED: '초안 생성 후 학기 정보가 변경되었습니다. 초안을 다시 만드세요.',
  SEMESTER_COURSES_CHANGED: '초안 생성 후 개설강좌가 변경되었습니다. 초안을 다시 만드세요.',
  APPLICATION_ADDED: '초안 생성 후 수강신청이 추가되었습니다. 초안을 다시 만드세요.',
  APPLICATION_REMOVED: '초안 생성 후 수강신청이 삭제되었습니다. 초안을 다시 만드세요.',
  APPLICATIONS_CHANGED: '초안 생성 후 수강신청이 변경되었습니다. 초안을 다시 만드세요.',
  PAST_ENROLLMENTS_CHANGED: '초안 생성 후 과거 수강이력이 변경되었습니다. 초안을 다시 만드세요.',
  EXISTING_ENROLLMENTS_CHANGED: '초안 생성 후 현재 학기 수강이력이 변경되었습니다. 초안을 다시 만드세요.',
  DRAFT_READ_ONLY: '이미 확정된 초안은 수정하거나 다시 확정할 수 없습니다.',
  SEMESTER_NAME_REQUIRED: '학기명을 입력하세요.',
  MEMBER_NAME_REQUIRED: '회원명을 입력하세요.',
  COURSE_NAME_REQUIRED: '강좌명을 입력하세요.',
  APPLICATION_ORDER_INVALID: '신청순서에는 1 이상의 숫자를 입력하세요.',
  APPLICATION_ORDER_MISSING: '신청순서가 비어 있습니다. 아래에서 순서를 입력하세요.',
  APPLICATION_ORDER_CONFLICT: '같은 회원의 신청순서가 서로 다릅니다. 아래에서 순서를 확인하세요.',
  APPLICATION_ORDER_UNRESOLVED: '신청순서를 확인하고 숫자로 입력하세요.',
  PREFERENCE_UNRESOLVED: '희망순위가 비었거나 올바르지 않습니다. 강좌마다 다른 순위를 입력하세요.',
  PREFERENCE_CONFLICT: '같은 희망순위가 여러 강좌에 입력되었습니다. 순위를 확인하세요.',
  DUPLICATE_SEMESTER_ENROLLMENT: '같은 회원의 같은 학기 수강이력이 파일에 두 번 이상 있습니다. 한 건만 남기세요.',
  ENROLLMENT_INPUT_INVALID: '수강이력 입력값을 확인하세요.',
  APPLICATION_INPUT_INVALID: '수강신청 입력값을 확인하세요.',
  RESTORE_REPLACES_CURRENT_DATA: '백업 이후의 현재 자료가 사라집니다. 계속하려면 복원 내용을 확인하세요.',
  INVALID_METADATA: '선택한 업로드 종류와 엑셀 양식이 다릅니다. 올바른 양식을 사용하세요.',
  UNSUPPORTED_FILE_TYPE: '엑셀 파일(.xlsx)만 올릴 수 있습니다.',
  UPLOAD_SIZE_LIMIT: '파일 크기가 허용 한도를 넘었습니다. 파일을 나누어 다시 올리세요.',
  INVALID_XLSX: '엑셀 파일을 읽을 수 없습니다. 파일이 손상되었거나 암호가 걸려 있는지 확인하세요.',
  EXTERNAL_LINK_NOT_ALLOWED: '다른 파일로 연결된 셀은 가져올 수 없습니다. 연결을 제거한 뒤 다시 올리세요.',
  EXPANDED_SIZE_LIMIT: '엑셀 파일의 내용이 허용 한도를 넘었습니다. 파일을 나누어 다시 올리세요.',
  SHEET_LIMIT: '엑셀 시트가 너무 많습니다. 필요한 시트만 남기세요.',
  FORMULA_NOT_ALLOWED: '수식은 가져올 수 없습니다. 계산된 값을 입력한 뒤 다시 올리세요.',
  ROW_LIMIT: '엑셀 행이 너무 많습니다. 파일을 나누어 다시 올리세요.',
  CELL_LIMIT: '엑셀 셀이 너무 많습니다. 파일을 나누어 다시 올리세요.',
  REQUIRED_SHEET_MISSING: '필수 시트가 없습니다. 내려받은 양식을 확인하세요.',
  INVALID_HEADERS: '열 이름이나 순서가 양식과 다릅니다. 내려받은 양식을 사용하세요.',
  EXISTING_CAPACITY_EXCEEDED: '기존 수강인원이 강좌 정원을 초과합니다. 정원과 수강이력을 확인하세요.',
  DUPLICATE_APPLICATION: '같은 회원의 수강신청이 두 건 이상 있습니다. 신청 내역을 확인하세요.',
  CHOICE_REQUIRED: '신청한 강좌가 없습니다. 희망 강좌를 입력하세요.',
  APPLICATION_CHOICE_LIMIT: '한 회원의 희망 강좌가 허용 개수를 넘었습니다. 신청을 확인하세요.',
  CHOICE_COURSE_INVALID: '선택한 강좌가 해당 학기에 개설되어 있지 않습니다.',
  DUPLICATE_CHOICE_COURSE: '같은 강좌가 희망 강좌에 중복되어 있습니다.',
  DUPLICATE_EXISTING_ENROLLMENT: '같은 회원의 현재 학기 수강이력이 두 건 이상 있습니다.',
  EXISTING_ENROLLMENT_COURSE_INVALID: '현재 수강이력의 강좌가 해당 학기에 개설되어 있지 않습니다.',
  ALLOCATION_APPLICANT_LIMIT: '신청 인원이 한 번에 처리할 수 있는 수를 넘었습니다.',
  SEMESTER_COURSE_LIMIT: '개설강좌 수가 한 번에 처리할 수 있는 수를 넘었습니다.',
  INVALID_PREFERENCE_MODE: '배정 기준 설정을 확인하세요.',
  INVALID_FALLBACK_MODE: '남은 자리 배정 설정을 확인하세요.',
  RANDOM_SEED_REQUIRED: '배정 설정이 올바르지 않습니다. 다시 시도하세요.',
  DUPLICATE_SEMESTER_COURSE: '같은 강좌가 학기에 중복 개설되어 있습니다.',
  DUPLICATE_APPLICATION_ID: '수강신청 자료가 중복되어 있습니다. 신청 내역을 확인하세요.',
  DUPLICATE_CHOICE_ID: '희망 강좌 자료가 중복되어 있습니다. 신청 내역을 확인하세요.',
  CHOICE_APPLICATION_INVALID: '희망 강좌가 신청 내역과 연결되지 않았습니다. 신청을 확인하세요.',
};

/** @type {Record<string, string>} */
const informationMessages = {
  SEMESTER_ORDER_UNRESOLVED: '새 학기는 다음 순서로 등록됩니다.',
  CAPACITY_UNRESOLVED: '새 개설강좌는 정원 미정으로 등록됩니다.',
};

/** @param {string} code */
const contextMessage = (code) => {
  const match = /^(SEMESTER_ORDER|SEMESTER_COURSE_CAPACITY)_(EXISTING_CONFLICT|MISSING|INVALID|SOURCE_CONFLICT)$/.exec(code);
  if (!match) return null;
  const field = match[1] === 'SEMESTER_ORDER' ? '학기 순서' : '정원';
  const subject = field === '정원' ? '정원이' : '학기 순서가';
  return /** @type {Record<string, string>} */ ({
    EXISTING_CONFLICT: `파일의 ${subject} 기존 값과 다릅니다. 아래에서 유지할 값을 선택하세요.`,
    MISSING: `${subject} 비어 있습니다. 엑셀 파일을 확인하세요.`,
    INVALID: `해당 행의 ${field === '정원' ? '학기명·강좌명과 정원' : '학기명과 순서'} 값을 확인하세요.`,
    SOURCE_CONFLICT: `파일에서 같은 ${field}의 값이 서로 다릅니다. 엑셀 파일을 확인하세요.`,
  })[match[2]];
};

/**
 * @param {{ code: string, severity: string, source?: { sheet?: string, row?: number, column?: string }, location?: string, detail?: { rowNumber?: number }, message?: string }} issue
 * @param {{ memberName?: string, courseName?: string }} context
 */
export const issueText = (issue, context = {}) => {
  const severity = /** @type {Record<string, string>} */ ({ WARNING: '주의', ERROR: '오류', INFO: '안내' })[issue.severity] ?? '오류';
  const source = issue.source ?? {};
  const location = issue.location?.includes('!')
    ? issue.location.replace('!', ' ')
    : issue.location && !issue.location.includes('/') ? issue.location : '';
  const place = source.sheet
    ? `${source.sheet} 시트${source.row ? ` ${source.row}행` : ''}${source.column ? ` ${source.column}` : ''}`
    : location || (issue.detail?.rowNumber ? `${issue.detail.rowNumber}행` : '');
  const subject = [place, context.memberName, context.courseName].filter(Boolean).join(' · ');
  const message = (issue.severity === 'INFO' ? informationMessages[issue.code] : null)
    ?? messages[issue.code] ?? contextMessage(issue.code)
    ?? (/[가-힣]/.test(issue.message ?? '') && !/[A-Za-z]/.test(issue.message ?? '') ? issue.message : '자료를 확인한 뒤 다시 시도하세요.');
  return `${severity}${subject ? ` · ${subject}` : ''}: ${message}`;
};

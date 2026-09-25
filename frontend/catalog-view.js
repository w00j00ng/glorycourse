const nameKey = (value) => value.trim().normalize('NFC');

export const copySemesterCourses = (existingCourseNames, selectedCourses) => {
  const existing = new Set(existingCourseNames.map(nameKey));
  return selectedCourses
    .filter(({ courseName }) => {
      const key = nameKey(courseName);
      if (existing.has(key)) return false;
      existing.add(key);
      return true;
    })
    .map(({ courseName, capacity }) => ({ courseName, capacity }));
};

export const parseSemesterCourses = (value) => {
  const courses = [];
  const errors = [];
  String(value ?? '').replace(/\r/g, '').split('\n').forEach((raw, index) => {
    if (!raw.trim()) return;
    const cells = raw.split(raw.includes('\t') ? '\t' : ',');
    if (cells.length > 2) {
      errors.push(`${index + 1}행: 강좌명과 정원만 입력하세요.`);
      return;
    }
    const courseName = cells[0].trim();
    const capacityText = cells[1]?.trim() ?? '';
    if (!courseName) errors.push(`${index + 1}행: 강좌명을 입력하세요.`);
    else if (courseName.length > 200) errors.push(`${index + 1}행: 강좌명은 200자 이하로 입력하세요.`);
    else if (!capacityText) errors.push(`${index + 1}행: 정원을 입력하세요.`);
    else if (!/^\d+$/.test(capacityText) || !Number.isSafeInteger(Number(capacityText))) {
      errors.push(`${index + 1}행: 정원은 0 이상의 정수로 입력하세요.`);
    } else {
      courses.push({ courseName, capacity: Number(capacityText) });
    }
  });
  return { courses: errors.length ? [] : courses, errors };
};

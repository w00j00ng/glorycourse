import { currentSemester } from './dashboard-view.js';

const views = new Set(['home', 'applications', 'enrollments', 'drafts', 'catalog', 'backups']);

/** @param {import('./dashboard-view.js').Semester[]} semesters @param {string} selected @param {boolean} userSelected */
export const applicationSemesterFilterValue = (semesters, selected, userSelected) => (
  userSelected ? selected : currentSemester(semesters)?.id ?? ''
);

/** @param {{ courseName: string, preference: number }[]} choices */
export const choiceSummary = (choices) => [...choices]
  .sort((left, right) => left.preference - right.preference)
  .map(({ courseName, preference }) => `${preference}순위 ${courseName}`)
  .join(' · ');

/** @param {string} hash */
export const viewFromHash = (hash) => {
  const view = hash.startsWith('#') ? hash.slice(1) : hash;
  return views.has(view) ? view : 'home';
};

/** @param {{ page: number, limit: number, total: number }} pagination */
export const paginationView = ({ page, limit, total }) => ({
  label: total === 0
    ? '총 0건'
    : `${((page - 1) * limit) + 1}–${Math.min(page * limit, total)} / 총 ${total}건`,
  previousDisabled: page <= 1,
  nextDisabled: page * limit >= total,
});

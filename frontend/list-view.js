import { currentSemester } from './dashboard-view.js';

const views = new Set(['home', 'applications', 'enrollments', 'drafts', 'catalog', 'backups']);

export const applicationSemesterFilterValue = (semesters, selected, userSelected) => (
  userSelected ? selected : currentSemester(semesters)?.id ?? ''
);

export const choiceSummary = (choices) => [...choices]
  .sort((left, right) => left.preference - right.preference)
  .map(({ courseName, preference }) => `${preference}순위 ${courseName}`)
  .join(' · ');

export const viewFromHash = (hash) => {
  const view = hash.startsWith('#') ? hash.slice(1) : hash;
  return views.has(view) ? view : 'home';
};

export const paginationView = ({ page, limit, total }) => ({
  label: total === 0
    ? '총 0건'
    : `${((page - 1) * limit) + 1}–${Math.min(page * limit, total)} / 총 ${total}건`,
  previousDisabled: page <= 1,
  nextDisabled: page * limit >= total,
});

import { SQLiteAdapter } from '../../backend/src/storage/sqlite.ts';

const [file, rawCount] = process.argv.slice(2);
const count = Number(rawCount);
const timestamp = '2026-09-22T00:00:00.000Z';
const data = {
  meta: { storeEpoch: 'epoch-after-write', storeRevision: 1 },
  semesters: [],
  members: Array.from({ length: count }, (_, index) => ({
    id: `member-${index}`,
    name: `회원 ${index}`,
    nameKey: `회원 ${index}`,
    createdAt: timestamp,
    updatedAt: timestamp,
  })),
  courses: [],
  semesterCourses: [],
  applications: [],
  applicationChoices: [],
  enrollments: [],
  allocationDrafts: [],
  allocationDraftItems: [],
  importBatches: [],
  finalizationReceipts: [],
  restoreReceipts: [],
};

await new SQLiteAdapter(file).write(data);

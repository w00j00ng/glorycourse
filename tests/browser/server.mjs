import { resolve } from 'node:path';
import ExcelJS from '@excel.js/exceljs';

import { startLocalServer } from '../../backend/src/server.ts';

const timestamp = '2026-09-26T00:00:00.000Z';
const server = await startLocalServer({
  dataDirectory: process.argv[2], staticDirectory: resolve(import.meta.dirname, '../../frontend'),
});
process.send({ type: 'ready', origin: server.origin });
process.on('message', async (message) => {
  try {
    if (message.type === 'complete-template') {
      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.load(Buffer.from(message.bytes, 'base64'));
      const semesterName = workbook.getWorksheet('학기').getCell('A2').value;
      const courseName = workbook.getWorksheet('개설강좌').getCell('B2').value;
      const capacity = workbook.getWorksheet('개설강좌').getCell('C2').value;
      workbook.getWorksheet('수강신청').addRow(['양식 학기', '양식 회원', 1, '창세기', 1]);
      process.send({ type: 'template-completed', semesterName, courseName, capacity,
        bytes: Buffer.from(await workbook.xlsx.writeBuffer()).toString('base64') });
      return;
    }
    if (message.type !== 'seed-large') return;
    await server.store.write({}, (data) => {
      data.semesters.push({ id: 'semester', name: '검증 학기', nameKey: '검증 학기', order: 1,
        allocationInputRevision: 0, createdAt: timestamp, updatedAt: timestamp });
      for (let index = 0; index < 100; index++) {
        data.courses.push({ id: `course-${index}`, name: `강좌 ${index}`, nameKey: `강좌 ${index}`,
          createdAt: timestamp, updatedAt: timestamp });
        data.semesterCourses.push({ id: `offering-${index}`, semesterId: 'semester', courseId: `course-${index}`,
          capacity: 500, createdAt: timestamp, updatedAt: timestamp });
      }
      for (let index = 0; index < 500; index++) {
        const memberId = `member-${index}`;
        const applicationId = `application-${index}`;
        data.members.push({ id: memberId, name: `회원 ${index}`, nameKey: `회원 ${index}`,
          createdAt: timestamp, updatedAt: timestamp });
        data.applications.push({ id: applicationId, semesterId: 'semester', memberId, applicationOrder: index + 1,
          applicationOrderStatus: 'NORMAL', orderResolution: 'SOURCE_AGREED', orderResolutionNote: null,
          revision: 0, createdAt: timestamp, updatedAt: timestamp });
        data.applicationChoices.push({ id: `choice-${index}`, applicationId,
          semesterCourseId: `offering-${index % 100}`, preference: 1, sourceRefs: [],
          createdAt: timestamp, updatedAt: timestamp });
      }
    });
    process.send({ type: 'seeded' });
  } catch (error) {
    process.send({ type: 'error', message: error.message });
  }
});
process.on('disconnect', () => { void server.close(); });

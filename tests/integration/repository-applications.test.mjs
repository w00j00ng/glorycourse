import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { ApplicationQueries } from '../../backend/src/repository/applications.ts';
import { CatalogQueries } from '../../backend/src/repository/catalog.ts';

const now = '2026-10-21T00:00:00.000Z';
const named = (id, name) => ({ id, name, nameKey: name.normalize('NFC'), createdAt: now, updatedAt: now });

test('application SQL queries preserve literal case-sensitive search, Korean ordering, and batched choices', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(readFileSync(new URL('../../schema/migration_target/schema.sql', import.meta.url), 'utf8'));
    const catalog = new CatalogQueries(db);
    const applications = new ApplicationQueries(db);
    catalog.insertSemester({ record: { ...named('semester', '2026 가을'), order: 1, allocationInputRevision: 0 } });
    catalog.insertNamed({ kind: 'courses', record: named('course', '기초') });
    catalog.insertSemesterCourse({ record: { id: 'offering', semesterId: 'semester', courseId: 'course', capacity: 10, createdAt: now, updatedAt: now } });
    const requests = [
      { memberName: 'A%회원', order: 2 },
      { memberName: 'a_회원', order: 3 },
      { memberName: '가회원', order: 1 },
    ];
    for (const [index, request] of requests.entries()) {
      catalog.insertNamed({ kind: 'members', record: named(`member-${index}`, request.memberName) });
      applications.insert({ record: { id: `application-${index}`, semesterId: 'semester', memberId: `member-${index}`, ministry: null,
        applicationOrder: request.order, applicationOrderStatus: 'NORMAL', orderResolution: 'SOURCE_AGREED', orderResolutionNote: null,
        revision: 0, createdAt: now, updatedAt: now } });
      applications.insertChoice({ record: { id: `choice-${index}`, applicationId: `application-${index}`, semesterCourseId: 'offering',
        preference: 1, sourceRefs: [], createdAt: now, updatedAt: now } });
    }
    const cases = [
      { args: { memberName: '%' }, expected: ['A%회원'] },
      { args: { memberName: '_' }, expected: ['a_회원'] },
      { args: { memberName: 'A' }, expected: ['A%회원'] },
      { args: { memberName: 'a' }, expected: ['a_회원'] },
      { args: { sort: 'NAME_ASC', semesterId: 'semester', courseId: 'course' },
        expected: requests.map(({ memberName }) => memberName).sort((left, right) => left.localeCompare(right, 'ko')) },
      { args: { sort: 'ORDER_DESC' }, expected: ['a_회원', 'A%회원', '가회원'] },
    ];
    for (const { args, expected } of cases) {
      const result = applications.listViews(args);
      assert.deepEqual(result.map(({ memberName }) => memberName), expected);
      assert.ok(result.every(({ choices }) => choices.length === 1 && choices[0].courseName === '기초'));
    }
    const pages = [
      { args: { page: 1, limit: 1, sort: 'ORDER_ASC' }, expected: ['가회원'] },
      { args: { page: 2, limit: 1, sort: 'ORDER_ASC' }, expected: ['A%회원'] },
      { args: { page: 4, limit: 1, sort: 'ORDER_ASC' }, expected: [] },
    ];
    for (const { args, expected } of pages) {
      const result = applications.listPage(args);
      assert.deepEqual(result.items.map(({ memberName }) => memberName), expected);
      assert.equal(result.total, 3);
      assert.equal(result.page, args.page);
      assert.equal(result.limit, args.limit);
      assert.ok(result.items.every(({ choices }) => choices.length === 1 && choices[0].courseName === '기초'));
    }
    assert.deepEqual(catalog.listPage({ kind: 'members', query: '%', page: 1, limit: 10 }), {
      items: [{ id: 'member-0', name: 'A%회원' }], page: 1, limit: 10, total: 1,
    });
    assert.equal(catalog.semesterContext({ id: 'semester' }).semesterCourses[0].applicationCount, 3);
    applications.delete({ id: 'application-1' });
    assert.equal(applications.count({ semesterId: 'semester' }), 2);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM application_choices').get().count, 2);
  } finally {
    db.close();
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { localDate, addDays, dayOf, monday, isoWeek, instant, lessonsForDate, timeline } from '../beta/lib/time.mjs';

function fixture(extra = {}) {
  return { lessons: [
    { id: 'a', day: 0, week: 'all', start: '09:00', end: '10:00', groupId: 'g', subgroup: 'А', subjectId: 's', roomId: '' },
    { id: 'b', day: 0, week: 'all', start: '10:30', end: '11:20', groupId: 'g', subgroup: 'Б', subjectId: 's', roomId: '204' },
    { id: 'common', day: 0, week: 'all', start: '12:00', end: '13:00', groupId: 'g', subgroup: 'all', subjectId: 's' },
  ], exceptions: [], ...extra };
}
const scope = { groupId: 'g', subgroup: 'А' };

test('Kazakhstan date is independent of the execution host timezone', () => {
  assert.equal(localDate(new Date('2026-11-08T19:00:00Z')), '2026-11-09');
  assert.equal(instant('2026-11-09', '09:00'), Date.parse('2026-11-09T04:00:00Z'));
});

test('date arithmetic and ISO parity cross month/year/leap boundaries', () => {
  assert.equal(addDays('2024-02-28', 1), '2024-02-29');
  assert.equal(addDays('2026-12-31', 1), '2027-01-01');
  assert.equal(dayOf('2026-11-09'), 0);
  assert.equal(monday('2027-01-03'), '2026-12-28');
  assert.equal(isoWeek('2027-01-03'), 53);
  assert.equal(isoWeek('2027-01-04'), 1);
});

test('subgroup scope includes shared lessons; both includes every subgroup', () => {
  assert.deepEqual(lessonsForDate(fixture(), '2026-11-09', scope).map(x => x.id), ['a', 'common']);
  assert.equal(lessonsForDate(fixture(), '2026-11-09', { groupId: 'g', subgroup: 'all' }).length, 3);
  assert.equal(lessonsForDate(fixture(), '2026-11-09', { groupId: 'other' }).length, 0);
});

test('lesson starts inclusive and ends exclusive; missing room does not suppress it', () => {
  assert.equal(timeline(fixture(), scope, new Date('2026-11-09T04:00:00Z')).current.id, 'a');
  const atEnd = timeline(fixture(), scope, new Date('2026-11-09T05:00:00Z'));
  assert.equal(atEnd.current, null);
  assert.equal(atEnd.next.id, 'common');
  assert.equal(atEnd.untilNextMinutes, 120);
});

test('progress/remaining are based on instants, and gaps omit other subgroup', () => {
  const state = timeline(fixture(), scope, new Date('2026-11-09T04:30:00Z'));
  assert.equal(state.progress, 0.5);
  assert.equal(state.remainingMinutes, 30);
  assert.equal(state.gaps[0].minutes, 120);
});

test('odd/even weeks and semester dates select only matching lessons', () => {
  const data = fixture({ lessons: [{ ...fixture().lessons[0], week: 'odd', validFrom: '2026-11-02', validUntil: '2026-11-22' }] });
  assert.equal(lessonsForDate(data, '2026-11-02', scope).length, 1); // ISO 45
  assert.equal(lessonsForDate(data, '2026-11-09', scope).length, 0); // ISO 46
  assert.equal(lessonsForDate(data, '2026-11-30', scope).length, 0);
});

test('inclusive holiday bounds, group-specific breaks and nearest next lesson', () => {
  const data = fixture({ holidays: [{ start: '2026-11-09', end: '2026-11-15', groupId: 'g' }] });
  assert.equal(lessonsForDate(data, '2026-11-09', scope).length, 0);
  assert.equal(timeline(data, scope, new Date('2026-11-09T04:00:00Z')).next.date, '2026-11-16');
  assert.equal(lessonsForDate(fixture({ holidays: [{ start: '2026-11-09', end: '2026-11-09', groupId: 'other' }] }), '2026-11-09', scope).length, 2);
});

test('previous-night lesson remains current after midnight and disappears at end', () => {
  const data = fixture({ lessons: [{ ...fixture().lessons[0], start: '23:30', end: '01:00', endDayOffset: 1 }] });
  const midnight = timeline(data, scope, new Date('2026-11-09T19:30:00Z'));
  assert.equal(midnight.current.id, 'a');
  assert.equal(midnight.current.sourceDate, '2026-11-09');
  assert.equal(midnight.remainingMinutes, 30);
  assert.equal(timeline(data, scope, new Date('2026-11-09T20:00:00Z')).current, null);
});

test('cancellation is visible but excluded from current and next', () => {
  const data = fixture({ exceptions: [{ lessonId: 'a', date: '2026-11-09', status: 'cancelled', note: 'Отмена' }] });
  assert.equal(lessonsForDate(data, '2026-11-09', scope)[0].cancelled, true);
  const state = timeline(data, scope, new Date('2026-11-09T04:30:00Z'));
  assert.equal(state.current, null);
  assert.equal(state.next.id, 'common');
});

test('moved occurrence changes date/room/teacher and preserves original source fields', () => {
  const data = fixture({ exceptions: [{ lessonId: 'a', date: '2026-11-09', targetDate: '2026-11-10', status: 'moved', start: '14:00', end: '15:00', roomId: '300', teacherId: 't2' }] });
  assert.deepEqual(lessonsForDate(data, '2026-11-09', scope).map(x => x.id), ['common']);
  const [moved] = lessonsForDate(data, '2026-11-10', scope);
  assert.equal(moved.date, '2026-11-10');
  assert.equal(moved.sourceDate, '2026-11-09');
  assert.equal(moved.original.start, '09:00');
  assert.equal(moved.roomId, '300');
  assert.equal(lessonsForDate(data, '2026-11-10', { teacherId: 't2' }).length, 1);
});

test('empty schedule yields explicit nulls without invalid progress', () => {
  const state = timeline({ lessons: [] }, scope, new Date('2026-11-09T04:30:00Z'));
  assert.equal(state.current, null);
  assert.equal(state.next, null);
  assert.equal(state.untilNextMinutes, null);
  assert.equal(state.progress, 0);
});

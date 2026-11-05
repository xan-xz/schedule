import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { candidateConflicts } from '../beta/conflicts.mjs';
import { mutate,occurrences } from '../backend/core.mjs';

test('cancelling one Friday occurrence does not flag unchanged imported source conflicts',async()=>{
 const d=JSON.parse(await readFile(new URL('../beta/seed.json',import.meta.url),'utf8'));
 const lesson=d.lessons.find(l=>l.groupId==='g-main'&&l.day===4&&l.week==='all');assert.ok(lesson);
 const payload={lessonId:lesson.id,date:'2026-11-06',status:'cancelled'};
 assert.deepEqual(candidateConflicts(d,'exception.save',payload),[]);
 const saved=mutate(d,{role:'admin',name:'Admin'},'exception.save',payload).data;
 assert.equal(occurrences(saved,'2026-11-06').find(l=>l.id===lesson.id).cancelled,true);
});
test('grandfathered conflicts do not authorize a new collision from edited lesson fields',async()=>{
 const d=JSON.parse(await readFile(new URL('../beta/seed.json',import.meta.url),'utf8'));
 const lesson=d.lessons.find(l=>l.groupId==='g-main'&&l.day===4&&l.week==='all');
 const other=d.lessons.find(l=>l.id!==lesson.id&&l.day===4&&l.start!==lesson.start&&l.roomId&&l.groupId!==lesson.groupId);
 assert.ok(other);
 const conflicts=candidateConflicts(d,'lesson.save',{...lesson,start:other.start,end:other.end,roomId:other.roomId});
 assert.ok(conflicts.length>0);
});

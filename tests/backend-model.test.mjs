import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mutate, visible, occurrences, validate, conflictPairKey } from '../backend/core.mjs';
const admin={id:'admin',role:'admin',name:'Admin'};
const teacher={id:'account-t1',teacherId:'t1',role:'teacher',name:'Teacher'};
function fixture(){return{groups:[{id:'g',name:'Group',subgroups:['А','Б']}],teachers:[{id:'t1',name:'One',subjects:['s']},{id:'t2',name:'Two',subjects:['s']}],subjects:[{id:'s',name:'Subject'}],rooms:[{id:'r1',name:'101',capacity:30},{id:'r2',name:'102',capacity:30}],lessons:[{id:'l1',day:0,week:'all',start:'09:00',end:'09:50',groupId:'g',subgroup:'А',subjectId:'s',teacherId:'t1',roomId:'r1',type:'Lecture'}],exceptions:[],tasks:[],announcements:[],requests:[],attendance:[],history:[]}}

test('existing 524 imported lessons and source metadata remain valid',()=>{
 const source=JSON.parse(fs.readFileSync(new URL('../beta/seed.json',import.meta.url),'utf8'));
 assert.equal(source.lessons.length,524);assert.equal(source.groups.length,19);assert.equal(source.sourceConflictPairs.length,133);assert.equal(validate(source),true);
 const result=mutate(source,admin,'import',{data:structuredClone(source)}).data;
 assert.deepEqual(result.lessons,source.lessons);assert.deepEqual(result.sourceConflictPairs,source.sourceConflictPairs);assert.deepEqual(result.sourceWarnings,source.sourceWarnings);
});
test('guest and student cannot write even if UI controls are bypassed',()=>{
 for(const role of ['guest','student'])assert.throws(()=>mutate(fixture(),{role},'exception.save',{lessonId:'l1',date:'2026-11-09',status:'cancelled'}),e=>e.status===403);
});
test('teacher may change only own occurrence and cannot reassign it',()=>{
 const input=fixture();const own=mutate(input,teacher,'exception.save',{lessonId:'l1',date:'2026-11-09',status:'cancelled'}).data;
 assert.equal(own.exceptions[0].before.roomId,'r1');assert.equal(own.exceptions[0].after,null);assert.ok(own.exceptions[0].updatedAt);assert.equal(input.exceptions.length,0);
 assert.equal(occurrences(own,'2026-11-09')[0].cancelled,true);
 assert.equal(mutate(own,teacher,'exception.delete',{lessonId:'l1',date:'2026-11-09'}).data.exceptions.length,0);
 assert.throws(()=>mutate(input,{...teacher,teacherId:'t2'},'exception.save',{lessonId:'l1',date:'2026-11-09',status:'cancelled'}),e=>e.status===403);
 assert.throws(()=>mutate(input,teacher,'exception.save',{lessonId:'l1',date:'2026-11-09',status:'moved',teacherId:'t2',start:'10:00',end:'10:50'}),e=>e.status===403);
});
test('moved occurrence disappears on source day and appears with before/after on target day',()=>{
 const d=mutate(fixture(),teacher,'exception.save',{lessonId:'l1',date:'2026-11-09',targetDate:'2026-11-10',status:'moved',start:'10:00',end:'10:50',roomId:'r2'}).data;
 assert.equal(occurrences(d,'2026-11-09').length,0);assert.equal(occurrences(d,'2026-11-10')[0].roomId,'r2');assert.equal(d.exceptions[0].before.start,'09:00');assert.equal(d.exceptions[0].after.start,'10:00');
});
test('attendance rejects wrong ISO parity and cancelled meetings',()=>{
 const d=fixture();d.lessons[0].week='odd';
 assert.throws(()=>mutate(d,teacher,'attendance.save',{lessonId:'l1',date:'2026-11-09',studentId:'student',status:'present'}));
 assert.equal(mutate(d,teacher,'attendance.save',{lessonId:'l1',date:'2026-11-02',studentId:'student',status:'present'}).data.attendance.length,1);
 d.exceptions=[{lessonId:'l1',date:'2026-11-02',status:'cancelled'}];assert.throws(()=>mutate(d,teacher,'attendance.save',{lessonId:'l1',date:'2026-11-02',studentId:'student',status:'present'}));
});
test('public subgroup all returns union of tasks without exposing private records',()=>{
 const d=fixture();d.tasks=['А','Б','all'].map((subgroup,i)=>({id:'task'+i,groupId:'g',subgroup}));d.history=[{actor:'private'}];d.attendance=[{studentId:'other'}];d.requests=[{teacherId:'t1'}];
 assert.equal(visible(d,{id:'guest',role:'guest',groupId:'g',subgroup:'all'}).tasks.length,3);
 const one=visible(d,{id:'guest',role:'guest',groupId:'g',subgroup:'А'});assert.equal(one.tasks.length,2);assert.deepEqual(one.attendance,[]);assert.deepEqual(one.history,[]);assert.deepEqual(one.requests,[]);
});
test('upload cannot add conflict bypass fingerprints',()=>{
 const d=fixture(),uploaded=fixture();uploaded.lessons.push({...uploaded.lessons[0],id:'l2'});uploaded.sourceConflictPairs=[conflictPairKey(...uploaded.lessons)];
 assert.throws(()=>mutate(d,admin,'import',{data:uploaded}),/занята|занят/);
});
test('import rejects orphaned attendance or requests instead of silently dropping them',()=>{
 for(const kind of ['attendance','requests']){const d=fixture();d[kind]=kind==='attendance'?[{lessonId:'l1',date:'2026-11-09',studentId:'student',status:'present'}]:[{id:'request',lessonId:'l1',date:'2026-11-09',status:'pending'}];const uploaded=fixture();uploaded.lessons=[];assert.throws(()=>mutate(d,admin,'import',{data:uploaded}),/отсутствующую/)}
});
test('night lessons need explicit next-day offset and conflict with next-day room use',()=>{
 const d=fixture();Object.assign(d.lessons[0],{start:'23:00',end:'01:00'});assert.throws(()=>validate(d));d.lessons[0].endDayOffset=1;assert.equal(validate(d),true);
 d.lessons.push({...d.lessons[0],id:'l2',day:1,start:'00:30',end:'01:20',endDayOffset:0,subgroup:'Б',teacherId:'t2'});assert.throws(()=>validate(d),/полуночи/);
});
test('holidays and semester bounds suppress regular occurrences',()=>{
 const d=fixture();d.holidays=[{start:'2026-11-09',end:'2026-11-15',groupId:'g'}];assert.equal(occurrences(d,'2026-11-09').length,0);d.holidays=[];d.validUntil='2026-11-08';assert.equal(occurrences(d,'2026-11-09').length,0);
});

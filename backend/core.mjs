export const DAYS=['Понедельник','Вторник','Среда','Четверг','Пятница','Суббота','Воскресенье'];
export const SHORT=['ПН','ВТ','СР','ЧТ','ПТ','СБ','ВС'];
export const ROLES={guest:'Посетитель',student:'Студент',teacher:'Преподаватель',admin:'Администратор'};
export const uid=()=>globalThis.crypto.randomUUID();
export const clone=x=>JSON.parse(JSON.stringify(x));
export const time=t=>Number(t.slice(0,2))*60+Number(t.slice(3));
export function fail(message,status=400){const e=new Error(message);e.status=status;throw e}
export function localDate(){return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Almaty',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date())}
export function addDays(date,n){const d=new Date(date+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10)}
export function dayOf(date){return(new Date(date+'T12:00:00Z').getUTCDay()+6)%7}
export function monday(date){return addDays(date,-dayOf(date))}
export function isoWeek(date){const d=new Date(date+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+3-dayOf(date));const first=new Date(Date.UTC(d.getUTCFullYear(),0,4,12));return 1+Math.round((d-first)/86400000/7)}
export function weeksOverlap(a,b){return a==='all'||b==='all'||a===b}
export function groupsOverlap(a,b){return a.groupId===b.groupId&&(a.subgroup==='all'||b.subgroup==='all'||a.subgroup===b.subgroup)}
export const lessonFingerprint=l=>JSON.stringify([l.id,l.day,l.week,l.start,l.end,l.groupId,l.subgroup,l.subjectId,l.teacherId||'',l.roomId||'',...(l.endDayOffset||l.validFrom||l.validUntil?[l.endDayOffset||0,l.validFrom||'',l.validUntil||'']:[])]);
export const conflictPairKey=(a,b)=>[lessonFingerprint(a),lessonFingerprint(b)].sort().join('|');
export function sourceConflictAllowed(data,a,b){return (data.sourceConflictPairs||[]).includes(conflictPairKey(a,b))&&[a,b].every(l=>!l.exception?.targetDate||l.exception.targetDate===l.exception.date)}
export function sharedSession(a,b){return a.groupId!==b.groupId&&!!a.sharedSessionId&&a.sharedSessionId===b.sharedSessionId&&['day','week','start','end','subjectId','teacherId','roomId','type'].every(k=>a[k]===b[k])}
function interval(l){const base=l.date?Date.parse(l.date+'T00:00:00Z')/60000:0;return[base+time(l.start),base+time(l.end)+(l.endDayOffset||0)*1440]}
export function collision(a,b){const[as,ae]=interval(a),[bs,be]=interval(b);if(as>=be||bs>=ae||sharedSession(a,b))return '';if(groupsOverlap(a,b))return'Группа уже занята';if(a.teacherId&&a.teacherId===b.teacherId)return'Преподаватель уже занят';if(a.roomId&&a.roomId===b.roomId)return'Аудитория уже занята';return ''}
function scheduledOn(l,date){return l.day===dayOf(date)&&(l.week==='all'||l.week===(isoWeek(date)%2?'odd':'even'))&&(!l.validFrom||date>=l.validFrom)&&(!l.validUntil||date<=l.validUntil)}
export function occurrences(data,date){
 const result=[];if(data.validFrom&&date<data.validFrom||data.validUntil&&date>data.validUntil)return result;
 for(const l of data.lessons){
  const ex=data.exceptions.find(e=>e.lessonId===l.id&&e.date===date);
  if(scheduledOn(l,date)&&!data.holidays?.some(h=>date>=h.start&&date<=h.end&&(!h.groupId||h.groupId===l.groupId))){
   if(!ex)result.push({...l,date});
   else if(!ex.targetDate||ex.targetDate===date)result.push({...l,...(ex.status==='moved'?overrideFields(ex):{}),date,cancelled:ex.status==='cancelled',exception:ex});
  }
  for(const moved of data.exceptions.filter(e=>e.lessonId===l.id&&e.status==='moved'&&e.targetDate===date&&e.date!==date))result.push({...l,...overrideFields(moved),date,exception:moved});
 }
 return result.sort((a,b)=>a.start.localeCompare(b.start));
}
function overrideFields(ex){return Object.fromEntries(['start','end','roomId','subjectId','teacherId','endDayOffset','type'].filter(k=>ex[k]!==undefined).map(k=>[k,ex[k]]))}
function validInterval(l){return timeValid(l.start)&&timeValid(l.end)&&[undefined,0,1].includes(l.endDayOffset)&&time(l.end)+(l.endDayOffset||0)*1440>time(l.start)&&time(l.end)+(l.endDayOffset||0)*1440-time(l.start)<=1440}
function text(v,label,max=160){if(typeof v!=='string'||!v.trim()||v.length>max)fail('Проверь поле «'+label+'»');return v.trim()}
function dateValid(d){return typeof d==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(d)&&!Number.isNaN(Date.parse(d+'T12:00:00Z'))&&new Date(d+'T12:00:00Z').toISOString().slice(0,10)===d}
function timeValid(t){return typeof t==='string'&&/^([01]\d|2[0-3]):[0-5]\d$/.test(t)}
export function validate(data){
 for(const k of ['groups','teachers','subjects','rooms','lessons','exceptions','tasks','announcements','requests','attendance','history'])if(!Array.isArray(data[k])||data[k].length>3000)fail('Неверный формат раздела '+k);
 for(const k of ['groups','teachers','subjects','rooms','lessons','tasks','announcements','requests']){const ids=new Set();for(const e of data[k]){text(e.id,'ID',100);if(ids.has(e.id))fail('Повторяется идентификатор '+k);ids.add(e.id)}}
 const has=(k,id)=>data[k].some(e=>e.id===id);
 for(const g of data.groups){text(g.name,'Группа',80);if(!Array.isArray(g.subgroups)||!g.subgroups.length||g.subgroups.some(s=>typeof s!=='string'||s.length>15))fail('Проверь подгруппы')}
 for(const t of data.teachers){text(t.name,'Преподаватель');if(!Array.isArray(t.subjects)||t.subjects.some(s=>!has('subjects',s)))fail('Предмет преподавателя не найден')}
 for(const s of data.subjects)text(s.name,'Предмет');
 for(const r of data.rooms){text(r.name,'Аудитория',60);if(!Number.isInteger(r.capacity)||r.capacity<1||r.capacity>500)fail('Вместимость от 1 до 500')}
 for(const l of data.lessons){if(!has('groups',l.groupId)||!has('subjects',l.subjectId)||(l.teacherId&&!has('teachers',l.teacherId))||(l.roomId&&!has('rooms',l.roomId)))fail('Проверь группу, предмет, преподавателя и аудиторию');if(l.subgroup!=='all'&&!data.groups.find(g=>g.id===l.groupId).subgroups.includes(l.subgroup))fail('Подгруппа не найдена');if(!Number.isInteger(l.day)||l.day<0||l.day>6||!['all','odd','even'].includes(l.week)||!validInterval(l)||(l.validFrom&&!dateValid(l.validFrom))||(l.validUntil&&!dateValid(l.validUntil))||(l.validFrom&&l.validUntil&&l.validFrom>l.validUntil))fail('Проверь день и время занятия');if(l.teacherId&&!data.teachers.find(t=>t.id===l.teacherId).subjects.includes(l.subjectId))fail('Преподавателю не назначен этот предмет');text(l.type||'Пара','Тип занятия',40)}
 const allowedSourcePairs=new Set(data.sourceConflictPairs||[]);
 for(let i=0;i<data.lessons.length;i++)for(let j=i+1;j<data.lessons.length;j++){const a=data.lessons[i],b=data.lessons[j];if(a.day===b.day&&weeksOverlap(a.week,b.week)){const error=collision(a,b);if(error&&!allowedSourcePairs.has(conflictPairKey(a,b)))fail(error+' · '+DAYS[a.day]+' '+a.start)}}
 // Check the following calendar day too. On Sunday ISO parity flips at midnight.
 for(const a of data.lessons.filter(l=>l.endDayOffset===1))for(const b of data.lessons){
  if(b.day!==(a.day+1)%7)continue;
  const parityOverlap=a.week==='all'||b.week==='all'||(a.day===6?a.week!==b.week:a.week===b.week);
  if(!parityOverlap||a.validUntil&&b.validFrom&&addDays(a.validUntil,1)<b.validFrom||b.validUntil&&a.validFrom&&b.validUntil<a.validFrom)continue;
  const error=collision({...a,date:'2026-01-05'},{...b,date:'2026-01-06'});
  if(error)fail(error+' · после полуночи');
 }
 const exKeys=new Set();
 if(data.validFrom&&!dateValid(data.validFrom)||data.validUntil&&!dateValid(data.validUntil)||data.validFrom&&data.validUntil&&data.validFrom>data.validUntil)fail('Проверь границы семестра');
 if(data.holidays!==undefined&&(!Array.isArray(data.holidays)||data.holidays.length>3000))fail('Проверь каникулы');
 for(const h of data.holidays||[])if(!dateValid(h.start)||!dateValid(h.end)||h.start>h.end||(h.groupId&&!has('groups',h.groupId)))fail('Проверь каникулы');
 for(const ex of data.exceptions){if(!has('lessons',ex.lessonId)||!dateValid(ex.date)||!['moved','cancelled'].includes(ex.status))fail('Проверь исключение по дате');const l=data.lessons.find(l=>l.id===ex.lessonId);if(dayOf(ex.date)!==l.day||!(l.week==='all'||l.week===(isoWeek(ex.date)%2?'odd':'even')))fail('В выбранную дату этой пары нет');const key=ex.lessonId+ex.date;if(exKeys.has(key))fail('На эту дату уже есть изменение');exKeys.add(key);if(ex.note!==undefined&&(typeof ex.note!=='string'||ex.note.length>1000))fail('Комментарий до 1000 символов');if(ex.type!==undefined)text(ex.type,'Тип занятия',40);if(ex.targetDate&&!dateValid(ex.targetDate))fail('Проверь дату переноса');if(ex.status==='moved'&&(!validInterval({...l,...overrideFields(ex)})||(ex.roomId&&!has('rooms',ex.roomId))||(ex.subjectId&&!has('subjects',ex.subjectId))||(ex.teacherId&&!has('teachers',ex.teacherId))))fail('Проверь время и справочники переноса')}
 for(const d of new Set(data.exceptions.flatMap(e=>[e.date,e.targetDate||e.date]).flatMap(d=>[addDays(d,-1),d,addDays(d,1)]))){const ls=[...occurrences(data,addDays(d,-1)),...occurrences(data,d)].filter(l=>!l.cancelled);for(let i=0;i<ls.length;i++)for(let j=i+1;j<ls.length;j++){const error=collision(ls[i],ls[j]);if(error&&!sourceConflictAllowed(data,ls[i],ls[j]))fail(error+' · '+d)}}
 for(const t of data.tasks){text(t.title,'Задание');if(typeof t.description!=='string'||t.description.length>4000||!has('groups',t.groupId)||!has('subjects',t.subjectId)||!dateValid(t.due)||(t.teacherId&&!has('teachers',t.teacherId)))fail('Проверь задание');if(!['all',...data.groups.find(g=>g.id===t.groupId).subgroups].includes(t.subgroup))fail('Подгруппа задания не найдена')}
 for(const a of data.attendance)if(!has('lessons',a.lessonId)||!dateValid(a.date)||typeof a.studentId!=='string'||!['present','absent','late','excused'].includes(a.status))fail('Посещаемость ссылается на отсутствующую пару');
 for(const r of data.requests)if(!has('lessons',r.lessonId)||!dateValid(r.date)||!['pending','approved','rejected'].includes(r.status))fail('Запрос ссылается на отсутствующую пару');
 for(const n of data.announcements){text(n.title,'Заголовок');text(n.body,'Сообщение',4000);if(!Array.isArray(n.roles)||n.roles.some(r=>!['student','teacher','admin'].includes(r))||(n.groupId&&!has('groups',n.groupId))||(n.teacherId&&!has('teachers',n.teacherId)))fail('Проверь получателей объявления')}
 return true;
}
export function ownGroups(data,user){return new Set(data.lessons.filter(l=>l.teacherId===user.teacherId).map(l=>l.groupId))}
export function canTeach(data,user,groupId,subjectId){return user.role==='admin'||(user.role==='teacher'&&data.lessons.some(l=>l.teacherId===user.teacherId&&l.groupId===groupId&&(!subjectId||l.subjectId===subjectId)))}
export function notice(data,title,body,groupId='',teacherId=''){data.announcements.unshift({id:uid(),title,body,groupId,teacherId,roles:['student','teacher'],createdAt:new Date().toISOString(),automatic:true});data.announcements=data.announcements.slice(0,200)}
export function mutate(input,user,op,payload={}){
 const data=clone(input);const admin=user.role==='admin',teacher=user.role==='teacher';if(!admin&&!teacher)fail('Недостаточно прав',403);
 let summary='Изменение';
 if(op==='lesson.save'||op==='lesson.delete'){
  if(!admin)fail('Расписание меняет только администратор',403);
  const old=data.lessons.find(l=>l.id===payload.id);
  if(op==='lesson.delete'){if(!old)fail('Пара не найдена');data.lessons=data.lessons.filter(l=>l.id!==old.id);data.exceptions=data.exceptions.filter(e=>e.lessonId!==old.id);data.requests=data.requests.filter(e=>e.lessonId!==old.id);data.attendance=data.attendance.filter(e=>e.lessonId!==old.id);summary='Удалена пара'}
  else{const item={...payload,id:old?.id||uid()};data.lessons=data.lessons.filter(l=>l.id!==item.id);data.lessons.push(item);summary=old?'Изменена пара':'Добавлена пара'}
  const l=op==='lesson.delete'?old:data.lessons.at(-1);const subject=data.subjects.find(s=>s.id===l.subjectId)?.name||'Занятие';notice(data,summary,subject+' · '+DAYS[l.day]+' '+l.start+'–'+l.end,l.groupId,l.teacherId);if(old&&(old.groupId!==l.groupId||old.teacherId!==l.teacherId))notice(data,'Занятие переназначено',subject+' · проверь новое расписание',old.groupId,old.teacherId);
 }else if(op==='catalog.save'||op==='catalog.delete'){
  if(!admin||!['groups','teachers','subjects','rooms'].includes(payload.entity))fail('Недостаточно прав',403);const items=data[payload.entity],item=payload.item;const id=op.endsWith('delete')?payload.id:item?.id;
  if(op.endsWith('delete')){if(!items.some(x=>x.id===id))fail('Запись не найдена');if(payload.entity==='groups'&&data.lessons.some(l=>l.groupId===id)||payload.entity==='teachers'&&data.lessons.some(l=>l.teacherId===id)||payload.entity==='rooms'&&data.lessons.some(l=>l.roomId===id)||payload.entity==='subjects'&&(data.lessons.some(l=>l.subjectId===id)||data.teachers.some(t=>t.subjects.includes(id))))fail('Сначала переназначь связанные занятия и предметы');data[payload.entity]=items.filter(x=>x.id!==id);summary='Удалена запись справочника'}
  else{const entry={...item,id:id||uid()};data[payload.entity]=items.filter(x=>x.id!==entry.id);data[payload.entity].push(entry);summary='Обновлён справочник'}
 }else if(op==='task.save'||op==='task.delete'){
  const old=data.tasks.find(t=>t.id===payload.id);if(old&&!admin&&old.teacherId!==user.teacherId)fail('Это задание другого преподавателя',403);
  if(op.endsWith('delete')){if(!old)fail('Задание не найдено');data.tasks=data.tasks.filter(t=>t.id!==old.id);summary='Удалено задание'}else{if(!canTeach(data,user,payload.groupId,payload.subjectId))fail('Ты не ведёшь этот предмет у группы',403);const item={...payload,id:old?.id||uid(),teacherId:admin?payload.teacherId||'':user.teacherId};data.tasks=data.tasks.filter(t=>t.id!==item.id);data.tasks.unshift(item);summary='Опубликовано задание';notice(data,summary,item.title,item.groupId,item.teacherId)}
 }else if(op==='announcement.save'){
  if(!admin&&!canTeach(data,user,payload.groupId))fail('Выбери свою учебную группу',403);const item={...payload,id:uid(),createdAt:new Date().toISOString(),roles:admin?payload.roles:['student'],teacherId:admin?payload.teacherId||'':''};data.announcements.unshift(item);data.announcements=data.announcements.slice(0,200);summary='Опубликовано объявление';
 }else if(op==='exception.save'||op==='exception.delete'){
  const l=data.lessons.find(l=>l.id===payload.lessonId);if(!l)fail('Пара не найдена');if(!admin&&l.teacherId!==user.teacherId)fail('Можно изменить только свою пару',403);if(!admin&&((payload.teacherId&&payload.teacherId!==l.teacherId)||(payload.subjectId&&payload.subjectId!==l.subjectId)))fail('Назначения меняет администратор',403);if(!dateValid(payload.date)||!scheduledOn(l,payload.date))fail('В выбранную дату этой пары нет');const previous=data.exceptions.find(e=>e.lessonId===l.id&&e.date===payload.date);data.exceptions=data.exceptions.filter(e=>!(e.lessonId===l.id&&e.date===payload.date));if(op.endsWith('save')){const fields=Object.fromEntries(['date','targetDate','status','start','end','roomId','subjectId','teacherId','endDayOffset','type','note'].filter(k=>payload[k]!==undefined).map(k=>[k,payload[k]]));const stamp=new Date().toISOString();data.exceptions.push({...fields,id:previous?.id||uid(),lessonId:l.id,createdAt:previous?.createdAt||stamp,updatedAt:stamp,actor:user.name,before:previous?.before||{...l,date:payload.date},after:payload.status==='cancelled'?null:{...l,...overrideFields(fields),date:fields.targetDate||fields.date}})};summary=op.endsWith('delete')?'Восстановлена обычная пара':payload.status==='cancelled'?'Пара отменена':'Пара перенесена';notice(data,summary,data.subjects.find(s=>s.id===l.subjectId).name+' · '+payload.date+(payload.start?' · '+payload.start:''),l.groupId,l.teacherId);
 }else if(op==='request.create'){
  const l=data.lessons.find(l=>l.id===payload.lessonId);if(!l||(!admin&&l.teacherId!==user.teacherId))fail('Можно запросить перенос только своей пары',403);text(payload.reason,'Причина',1000);if(!dateValid(payload.date)||!occurrences(data,payload.date).some(x=>x.id===l.id&&!x.cancelled))fail('Выбери дату действующего занятия с учётом типа недели');if(!timeValid(payload.start)||!timeValid(payload.end)||payload.start>=payload.end)fail('Проверь время');data.requests.unshift({...payload,id:uid(),teacherId:l.teacherId,status:'pending',createdAt:new Date().toISOString()});summary='Отправлен запрос на перенос';data.announcements.unshift({id:uid(),title:summary,body:payload.reason,roles:['admin'],groupId:'',teacherId:'',createdAt:new Date().toISOString()});
 }else if(op==='request.decide'){
  if(!admin)fail('Решение принимает администратор',403);const req=data.requests.find(r=>r.id===payload.id);if(!req||req.status!=='pending')fail('Запрос уже обработан');if(!['approved','rejected'].includes(payload.status))fail('Неверное решение');if(payload.status==='approved'){data.exceptions=data.exceptions.filter(e=>!(e.lessonId===req.lessonId&&e.date===req.date));data.exceptions.push({id:uid(),lessonId:req.lessonId,date:req.date,start:req.start,end:req.end,roomId:req.roomId,status:'moved',note:req.reason})}req.status=payload.status;req.response=String(payload.response||'').slice(0,1000);summary=payload.status==='approved'?'Перенос согласован':'Перенос отклонён';const l=data.lessons.find(l=>l.id===req.lessonId);notice(data,summary,(l?data.subjects.find(s=>s.id===l.subjectId)?.name:'Занятие')+' · '+req.date,payload.status==='approved'?l?.groupId||'':'',req.teacherId);
 }else if(op==='attendance.save'){
  const l=data.lessons.find(l=>l.id===payload.lessonId);if(!l||(!admin&&l.teacherId!==user.teacherId))fail('Это занятие другого преподавателя',403);if(!dateValid(payload.date)||!occurrences(data,payload.date).some(x=>x.id===l.id&&!x.cancelled)||!['present','absent','late','excused'].includes(payload.status)||typeof payload.studentId!=='string')fail('Проверь запись посещаемости');data.attendance=data.attendance.filter(a=>!(a.lessonId===l.id&&a.date===payload.date&&a.studentId===payload.studentId));data.attendance.push({...payload});summary='Обновлена посещаемость';
 }else if(op==='import'){
  if(!admin)fail('Импорт доступен администратору',403);const imported=payload.data;if(!imported||!Array.isArray(imported.lessons))fail('Нужен экспорт UniFlow');for(const k of ['groups','subjects','teachers','rooms','lessons','exceptions'])data[k]=clone(imported[k]||[]);// Only the existing database may grandfather conflicts; an uploaded file cannot grant itself exceptions.
  data.sourceConflictPairs=clone(input.sourceConflictPairs||[]);data.sourceWarnings=clone(imported.sourceWarnings||[]);data.source=clone(imported.source||null);summary='Импортировано расписание';notice(data,summary,'Администратор обновил расписание из файла');
 }else fail('Неизвестное действие');
 validate(data);data.history.unshift({id:uid(),at:new Date().toISOString(),actor:user.name,action:op,summary});data.history=data.history.slice(0,100);return{data,summary};
}
export function visible(data,user){const d=clone(data),admin=user.role==='admin',teacher=user.role==='teacher';const role=user.role==='guest'?'student':user.role;
 if(!admin){d.history=[];d.requests=teacher?d.requests.filter(r=>r.teacherId===user.teacherId):[];d.attendance=teacher?d.attendance.filter(a=>d.lessons.some(l=>l.id===a.lessonId&&l.teacherId===user.teacherId)):d.attendance.filter(a=>a.studentId===user.id);d.tasks=d.tasks.filter(t=>teacher?t.teacherId===user.teacherId:t.groupId===user.groupId&&(user.subgroup==='all'||t.subgroup==='all'||t.subgroup===user.subgroup));d.announcements=d.announcements.filter(n=>n.roles.includes(role)&&(!n.groupId&&!n.teacherId||(teacher?(n.teacherId===user.teacherId||(!n.teacherId&&ownGroups(data,user).has(n.groupId))):n.groupId===user.groupId)))}
 return d;
}

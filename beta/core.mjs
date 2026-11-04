export const DAYS=['Понедельник','Вторник','Среда','Четверг','Пятница','Суббота','Воскресенье'];
export const SHORT=['ПН','ВТ','СР','ЧТ','ПТ','СБ','ВС'];
export const ROLES={guest:'Посетитель',student:'Студент',teacher:'Преподаватель',admin:'Администратор'};
export const uid=()=>globalThis.crypto.randomUUID();
export const clone=x=>JSON.parse(JSON.stringify(x));
export const time=t=>Number(t.slice(0,2))*60+Number(t.slice(3));
export function fail(message,status=400){const e=new Error(message);e.status=status;throw e}
export function localDate(){return new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Qyzylorda',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date())}
export function addDays(date,n){const d=new Date(date+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10)}
export function dayOf(date){return(new Date(date+'T12:00:00Z').getUTCDay()+6)%7}
export function monday(date){return addDays(date,-dayOf(date))}
export function isoWeek(date){const d=new Date(date+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+3-dayOf(date));const first=new Date(Date.UTC(d.getUTCFullYear(),0,4,12));return 1+Math.round((d-first)/86400000/7)}
export function weeksOverlap(a,b){return a==='all'||b==='all'||a===b}
export function groupsOverlap(a,b){return a.groupId===b.groupId&&(a.subgroup==='all'||b.subgroup==='all'||a.subgroup===b.subgroup)}
export function collision(a,b){if(a.start>=b.end||b.start>=a.end)return '';if(groupsOverlap(a,b))return'Группа уже занята';if(a.teacherId&&a.teacherId===b.teacherId)return'Преподаватель уже занят';if(a.roomId&&a.roomId===b.roomId)return'Аудитория уже занята';return ''}
export function occurrences(data,date){const parity=isoWeek(date)%2?'odd':'even';return data.lessons.filter(l=>l.day===dayOf(date)&&(l.week==='all'||l.week===parity)).map(l=>{const ex=data.exceptions.find(e=>e.lessonId===l.id&&e.date===date);if(!ex)return{...l,date};return{...l,...(ex.status==='moved'?{start:ex.start,end:ex.end,roomId:ex.roomId}:{}),date,cancelled:ex.status==='cancelled',exception:ex}}).sort((a,b)=>a.start.localeCompare(b.start))}
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
 for(const l of data.lessons){if(!has('groups',l.groupId)||!has('subjects',l.subjectId)||(l.teacherId&&!has('teachers',l.teacherId))||(l.roomId&&!has('rooms',l.roomId)))fail('Проверь группу, предмет, преподавателя и аудиторию');if(l.subgroup!=='all'&&!data.groups.find(g=>g.id===l.groupId).subgroups.includes(l.subgroup))fail('Подгруппа не найдена');if(!Number.isInteger(l.day)||l.day<0||l.day>6||!['all','odd','even'].includes(l.week)||!timeValid(l.start)||!timeValid(l.end)||l.start>=l.end)fail('Проверь день и время занятия');if(l.teacherId&&!data.teachers.find(t=>t.id===l.teacherId).subjects.includes(l.subjectId))fail('Преподавателю не назначен этот предмет');text(l.type||'Пара','Тип занятия',40)}
 for(let i=0;i<data.lessons.length;i++)for(let j=i+1;j<data.lessons.length;j++){const a=data.lessons[i],b=data.lessons[j];if(a.day===b.day&&weeksOverlap(a.week,b.week)){const error=collision(a,b);if(error)fail(error+' · '+DAYS[a.day]+' '+a.start)}}
 const exKeys=new Set();
 for(const ex of data.exceptions){if(!has('lessons',ex.lessonId)||!dateValid(ex.date)||!['moved','cancelled'].includes(ex.status))fail('Проверь исключение по дате');const l=data.lessons.find(l=>l.id===ex.lessonId);if(dayOf(ex.date)!==l.day||!(l.week==='all'||l.week===(isoWeek(ex.date)%2?'odd':'even')))fail('В выбранную дату этой пары нет');const key=ex.lessonId+ex.date;if(exKeys.has(key))fail('На эту дату уже есть изменение');exKeys.add(key);if(ex.status==='moved'&&(!timeValid(ex.start)||!timeValid(ex.end)||ex.start>=ex.end||(ex.roomId&&!has('rooms',ex.roomId))))fail('Проверь время переноса')}
 for(const d of new Set(data.exceptions.map(e=>e.date))){const ls=occurrences(data,d).filter(l=>!l.cancelled);for(let i=0;i<ls.length;i++)for(let j=i+1;j<ls.length;j++){const error=collision(ls[i],ls[j]);if(error)fail(error+' · '+d)}}
 for(const t of data.tasks){text(t.title,'Задание');if(typeof t.description!=='string'||t.description.length>4000||!has('groups',t.groupId)||!has('subjects',t.subjectId)||!dateValid(t.due)||(t.teacherId&&!has('teachers',t.teacherId)))fail('Проверь задание');if(!['all',...data.groups.find(g=>g.id===t.groupId).subgroups].includes(t.subgroup))fail('Подгруппа задания не найдена')}
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
  if(!admin)fail('Изменение утверждает администратор',403);const l=data.lessons.find(l=>l.id===payload.lessonId);if(!l)fail('Пара не найдена');data.exceptions=data.exceptions.filter(e=>!(e.lessonId===l.id&&e.date===payload.date));if(op.endsWith('save'))data.exceptions.push({...payload,id:uid()});summary=op.endsWith('delete')?'Восстановлена обычная пара':payload.status==='cancelled'?'Пара отменена':'Пара перенесена';notice(data,summary,data.subjects.find(s=>s.id===l.subjectId).name+' · '+payload.date+(payload.start?' · '+payload.start:''),l.groupId,l.teacherId);
 }else if(op==='request.create'){
  const l=data.lessons.find(l=>l.id===payload.lessonId);if(!l||(!admin&&l.teacherId!==user.teacherId))fail('Можно запросить перенос только своей пары',403);text(payload.reason,'Причина',1000);if(!dateValid(payload.date)||!occurrences(data,payload.date).some(x=>x.id===l.id&&!x.cancelled))fail('Выбери дату действующего занятия с учётом типа недели');if(!timeValid(payload.start)||!timeValid(payload.end)||payload.start>=payload.end)fail('Проверь время');data.requests.unshift({...payload,id:uid(),teacherId:l.teacherId,status:'pending',createdAt:new Date().toISOString()});summary='Отправлен запрос на перенос';data.announcements.unshift({id:uid(),title:summary,body:payload.reason,roles:['admin'],groupId:'',teacherId:'',createdAt:new Date().toISOString()});
 }else if(op==='request.decide'){
  if(!admin)fail('Решение принимает администратор',403);const req=data.requests.find(r=>r.id===payload.id);if(!req||req.status!=='pending')fail('Запрос уже обработан');if(!['approved','rejected'].includes(payload.status))fail('Неверное решение');if(payload.status==='approved'){data.exceptions=data.exceptions.filter(e=>!(e.lessonId===req.lessonId&&e.date===req.date));data.exceptions.push({id:uid(),lessonId:req.lessonId,date:req.date,start:req.start,end:req.end,roomId:req.roomId,status:'moved',note:req.reason})}req.status=payload.status;req.response=String(payload.response||'').slice(0,1000);summary=payload.status==='approved'?'Перенос согласован':'Перенос отклонён';const l=data.lessons.find(l=>l.id===req.lessonId);notice(data,summary,(l?data.subjects.find(s=>s.id===l.subjectId)?.name:'Занятие')+' · '+req.date,payload.status==='approved'?l?.groupId||'':'',req.teacherId);
 }else if(op==='attendance.save'){
  const l=data.lessons.find(l=>l.id===payload.lessonId);if(!l||(!admin&&l.teacherId!==user.teacherId))fail('Это занятие другого преподавателя',403);if(!dateValid(payload.date)||dayOf(payload.date)!==l.day||!['present','absent','late','excused'].includes(payload.status)||typeof payload.studentId!=='string')fail('Проверь запись посещаемости');data.attendance=data.attendance.filter(a=>!(a.lessonId===l.id&&a.date===payload.date&&a.studentId===payload.studentId));data.attendance.push({...payload});summary='Обновлена посещаемость';
 }else if(op==='import'){
  if(!admin)fail('Импорт доступен администратору',403);const imported=payload.data;if(!imported||!Array.isArray(imported.lessons))fail('Нужен экспорт UniFlow');for(const k of ['groups','subjects','teachers','rooms','lessons','exceptions'])data[k]=clone(imported[k]||[]);summary='Импортировано расписание';notice(data,summary,'Администратор обновил расписание из файла');
 }else fail('Неизвестное действие');
 validate(data);data.history.unshift({id:uid(),at:new Date().toISOString(),actor:user.name,action:op,summary});data.history=data.history.slice(0,100);return{data,summary};
}
export function visible(data,user){const d=clone(data),admin=user.role==='admin',teacher=user.role==='teacher';const role=user.role==='guest'?'student':user.role;
 if(!admin){d.history=[];d.requests=teacher?d.requests.filter(r=>r.teacherId===user.teacherId):[];d.attendance=teacher?d.attendance.filter(a=>d.lessons.some(l=>l.id===a.lessonId&&l.teacherId===user.teacherId)):d.attendance.filter(a=>a.studentId===user.id);d.tasks=d.tasks.filter(t=>teacher?t.teacherId===user.teacherId:t.groupId===user.groupId&&(t.subgroup==='all'||t.subgroup===user.subgroup));d.announcements=d.announcements.filter(n=>n.roles.includes(role)&&(!n.groupId&&!n.teacherId||(teacher?(n.teacherId===user.teacherId||(!n.teacherId&&ownGroups(data,user).has(n.groupId))):n.groupId===user.groupId)))}
 return d;
}
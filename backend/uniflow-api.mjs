import {mutate,visible,validate,clone,uid,fail} from './core.mjs';
import {sha,hashPassword,equal,reserveLogin,delayFailure,revokeSessions} from './security.mjs';
const cors={'Access-Control-Allow-Origin':'https://xan-xz.github.io','Access-Control-Allow-Headers':'content-type,apikey','Access-Control-Allow-Methods':'POST,OPTIONS','Cache-Control':'no-store','Vary':'Origin'};
const hex=b=>Array.from(new Uint8Array(b)).map(x=>x.toString(16).padStart(2,'0')).join('');
const safeAccount=a=>({id:a.id,username:a.username,name:a.name,role:a.role,groupId:a.group_id,subgroup:a.subgroup,teacherId:a.teacher_id,active:a.active});
const capabilities={modelVersion:2,teacherOverrides:true,logoutAll:true,allSubgroupTasks:true};
function answer(data,status=200){return new Response(JSON.stringify(data),{status,headers:{...cors,'Content-Type':'application/json'}})}
async function db(path,options={}){let secret;try{secret=JSON.parse(Deno.env.get('SUPABASE_SECRET_KEYS')||'{}').default}catch{}const key=secret||Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');const headers={apikey:key,'Content-Type':'application/json',...(!secret?{Authorization:'Bearer '+key}:{}),...options.headers};const res=await fetch(Deno.env.get('SUPABASE_URL')+'/rest/v1/'+path,{...options,headers});const raw=await res.text();if(!res.ok){if(raw.includes('version_conflict'))fail('Данные уже изменились. Обнови страницу и повтори действие.',409);throw new Error('Database request failed')}return raw?JSON.parse(raw):null}
async function actor(token){if(typeof token!=='string'||!/^[a-f0-9]{64}$/.test(token))fail('Нужен вход в аккаунт',401);const rows=await db('uf_sessions?token_hash=eq.'+await sha(token)+'&expires_at=gt.'+encodeURIComponent(new Date().toISOString()));if(!rows.length)fail('Сессия истекла. Войди заново.',401);if(rows[0].user_id==='admin')return{id:'admin',role:'admin',name:'Администратор',username:'admin'};const accounts=await db('uf_accounts?id=eq.'+rows[0].user_id+'&active=eq.true');if(!accounts.length)fail('Аккаунт отключён',401);return safeAccount(accounts[0])}
async function responseState(user,row){const data=visible(row.data,user);let users=[];if(user.role==='admin')users=(await db('uf_accounts?select=id,username,name,role,group_id,subgroup,teacher_id,active&order=created_at.desc')).map(safeAccount);else if(user.role==='teacher'){const students=await db('uf_accounts?role=eq.student&active=eq.true&select=id,name,role,group_id,subgroup,teacher_id,active');users=students.filter(s=>row.data.lessons.some(l=>l.teacherId===user.teacherId&&l.groupId===s.group_id&&(l.subgroup==='all'||l.subgroup===s.subgroup))).map(safeAccount)}let versions=[];if(user.role==='admin')versions=await db('uf_versions?select=revision,actor,reason,created_at&order=revision.desc&limit=30');return{data,revision:row.revision,user,users,versions,capabilities}}
export async function handle(req){
 let body;
 if(req.method==='OPTIONS')return new Response(null,{headers:cors});if(req.method!=='POST')return answer({error:'Method not allowed'},405);
 try{
  if(Number(req.headers.get('content-length'))>2000000)fail('Слишком большой запрос',413);const raw=await req.text();if(raw.length>2000000)fail('Слишком большой запрос',413);try{body=JSON.parse(raw)}catch{fail('Некорректный запрос')}if(!body||typeof body!=='object'||Array.isArray(body))fail('Некорректный запрос');
  if(body.action==='login'){
   const username=typeof body.username==='string'?body.username.trim().toLowerCase():'';if(!/^[a-z0-9._-]{3,60}$/.test(username)||typeof body.password!=='string'||body.password.length>200)fail('Неверный логин или пароль',401);
   if(!await reserveLogin(db,req,username))fail('Слишком много попыток. Подожди 15 минут.',429);
   let account;if(username==='admin'){const [settings]=await db('schedule_settings?id=eq.1');account={...settings,id:'admin',name:'Администратор',role:'admin',username:'admin',active:true}}else [account]=await db('uf_accounts?username=eq.'+encodeURIComponent(username)+'&active=eq.true');
   // Perform a derivation even when the user does not exist.
   const derived=await hashPassword(body.password,account?.salt||'nonexistent-account-padding');if(!account||!equal(derived,account.password_hash))fail('Неверный логин или пароль',401);
   const token=hex(crypto.getRandomValues(new Uint8Array(32))),expires=new Date(Date.now()+7200000).toISOString();if(!await db('rpc/uf_create_session',{method:'POST',body:JSON.stringify({p_user_id:account.id,p_token_hash:await sha(token),p_expected_hash:account.password_hash,p_legacy:false})}))fail('Пароль изменился. Войди заново.',401);await db('uf_sessions?expires_at=lt.'+encodeURIComponent(new Date().toISOString()),{method:'DELETE'});return answer({token,expiresAt:expires,user:account.id==='admin'?{id:'admin',role:'admin',username:'admin',name:'Администратор'}:safeAccount(account)});
  }
  if(body.action==='state'){
   const [row]=await db('uf_platform?id=eq.1');let user;if(body.token)user=await actor(body.token);else{const group=row.data.groups.find(g=>g.id===body.groupId)||row.data.groups[0];user={id:'guest',role:'guest',name:'Посетитель',groupId:group?.id||'',subgroup:body.subgroup==='all'?'all':group?.subgroups.includes(body.subgroup)?body.subgroup:group?.subgroups[0]||''}}return answer(await responseState(user,row));
  }
  const user=await actor(body.token);
  if(body.action==='logout'){await db('uf_sessions?token_hash=eq.'+await sha(body.token),{method:'DELETE'});return answer({ok:true})}
  if(body.action==='logout.all'){await revokeSessions(db,user);return answer({ok:true})}
  const [row]=await db('uf_platform?id=eq.1');
  if(body.action==='account.save'){
   if(user.role!=='admin')fail('Только администратор создаёт аккаунты',403);const a=body.account;if(!a||!['admin','student','teacher'].includes(a.role)||typeof a.name!=='string'||!a.name.trim()||a.name.length>160||typeof a.username!=='string'||!/^[a-z0-9._-]{3,60}$/.test(a.username)||a.username==='admin')fail('Проверь логин, имя и роль');
   const group=row.data.groups.find(g=>g.id===a.groupId);if(a.role==='student'&&(!group||!group.subgroups.includes(a.subgroup)))fail('Укажи группу и подгруппу');if(a.role==='teacher'&&!row.data.teachers.some(t=>t.id===a.teacherId))fail('Укажи преподавателя');
   let old;if(a.id){[old]=await db('uf_accounts?id=eq.'+encodeURIComponent(a.id));if(!old)fail('Аккаунт не найден');if(a.id===user.id&&a.active===false)fail('Нельзя отключить собственный аккаунт')}
   const duplicates=await db('uf_accounts?username=eq.'+a.username+'&select=id');if(duplicates.some(x=>x.id!==a.id))fail('Такой логин уже занят');
   const entry={username:a.username,name:a.name.trim(),role:a.role,group_id:a.role==='student'?a.groupId:'',subgroup:a.role==='student'?a.subgroup:'',teacher_id:a.role==='teacher'?a.teacherId:'',active:a.active!==false};
   if(!old||a.password){if(typeof a.password!=='string'||a.password.length<8||a.password.length>200)fail('Пароль: от 8 до 200 символов');entry.salt=hex(crypto.getRandomValues(new Uint8Array(16)));entry.password_hash=await hashPassword(a.password,entry.salt)}
   await db(old?'uf_accounts?id=eq.'+old.id:'uf_accounts',{method:old?'PATCH':'POST',body:JSON.stringify(entry)});if(old&&(a.password||a.active===false||old.role!==a.role||old.teacher_id!==entry.teacher_id||old.group_id!==entry.group_id||old.subgroup!==entry.subgroup))await db('uf_sessions?user_id=eq.'+old.id,{method:'DELETE'});return answer(await responseState(user,row));
  }
  if(body.action==='password.change'){
   if(typeof body.currentPassword!=='string'||typeof body.password!=='string'||body.password.length<8||body.password.length>200)fail('Проверь текущий и новый пароль');const [current]=await db(user.id==='admin'?'schedule_settings?id=eq.1':'uf_accounts?id=eq.'+user.id);if(!equal(await hashPassword(body.currentPassword,current.salt),current.password_hash))fail('Текущий пароль неверен',401);const salt=hex(crypto.getRandomValues(new Uint8Array(16)));await db('rpc/uf_change_password',{method:'POST',body:JSON.stringify({p_user_id:user.id,p_salt:salt,p_hash:await hashPassword(body.password,salt)})});return answer({ok:true});
  }
  if(body.action!=='mutate'&&body.action!=='rollback')fail('Неизвестное действие');if(!Number.isSafeInteger(body.revision)||body.revision!==row.revision)fail('Данные изменились. Обнови страницу и повтори действие.',409);
  let result;
  if(body.action==='rollback'){
   if(user.role!=='admin')fail('Откат доступен администратору',403);if(!Number.isSafeInteger(body.target))fail('Версия не найдена');const [version]=await db('uf_versions?revision=eq.'+body.target);if(!version)fail('Версия уже недоступна');const data=clone(version.data);data.history=row.data.history.slice();const summary='Восстановлена версия '+body.target;data.history.unshift({id:uid(),at:new Date().toISOString(),actor:user.name,action:'rollback',summary});validate(data);result={data,summary};
  }else{
   if(body.op==='import'){
    if(user.role!=='admin')fail('Импорт доступен администратору',403);
    const imported=body.payload?.data;
    if(!imported||!Array.isArray(imported.groups)||!Array.isArray(imported.teachers))fail('Нужен экспорт UniFlow');
    const accounts=await db('uf_accounts?select=role,group_id,subgroup,teacher_id');
    for(const account of accounts){
     if(account.role==='student'&&!imported.groups.some(g=>g.id===account.group_id&&g.subgroups?.includes(account.subgroup)))fail('Импорт удалит группу или подгруппу существующего аккаунта');
     if(account.role==='teacher'&&!imported.teachers.some(t=>t.id===account.teacher_id))fail('Импорт удалит преподавателя существующего аккаунта');
    }
   }
   if(body.op==='attendance.save'){
    const [student]=await db('uf_accounts?id=eq.'+encodeURIComponent(String(body.payload?.studentId||''))+'&role=eq.student&active=eq.true');const lesson=row.data.lessons.find(l=>l.id===body.payload?.lessonId);if(!student||!lesson||student.group_id!==lesson.groupId||lesson.subgroup!=='all'&&student.subgroup!==lesson.subgroup)fail('Студент не относится к этой паре');
   }
   if(body.op==='catalog.delete'&&['groups','teachers'].includes(body.payload?.entity)){
    const column=body.payload.entity==='groups'?'group_id':'teacher_id';const accounts=await db('uf_accounts?'+column+'=eq.'+encodeURIComponent(body.payload.id)+'&select=id&limit=1');if(accounts.length)fail('Сначала переназначь аккаунты, связанные с этой записью');
   }
   result=mutate(row.data,user,body.op,body.payload);
  }
  const committed=await db('rpc/uf_commit',{method:'POST',body:JSON.stringify({p_expected:row.revision,p_data:result.data,p_actor:user.name,p_reason:result.summary})});return answer(await responseState(user,committed));
 }catch(error){if(body?.action==='login'&&[401,429].includes(error.status))await delayFailure();return answer({error:error.status?error.message:'Сервер временно недоступен. Попробуй ещё раз.'},error.status||503)}
}
if(typeof Deno!=='undefined')Deno.serve(handle);

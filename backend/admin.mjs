import {sha,hashPassword,equal,reserveLogin,delayFailure,revokeSessions} from './security.mjs';
const GROUP='06-057-25-11';
const origin='https://xan-xz.github.io';
const cors={'Access-Control-Allow-Origin':origin,'Access-Control-Allow-Headers':'content-type, apikey','Access-Control-Allow-Methods':'POST, OPTIONS','Cache-Control':'no-store','Vary':'Origin'};
const hex=b=>Array.from(new Uint8Array(b)).map(x=>x.toString(16).padStart(2,'0')).join('');
async function rest(path,options={}){
 const key=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
 const res=await fetch(Deno.env.get('SUPABASE_URL')+'/rest/v1/'+path,{...options,headers:{apikey:key,Authorization:'Bearer '+key,'Content-Type':'application/json',...options.headers}});
 if(!res.ok)throw new Error('Database request failed');
 const text=await res.text();return text?JSON.parse(text):null;
}
function reply(data,status=200){return new Response(JSON.stringify(data),{status,headers:{...cors,'Content-Type':'application/json'}})}
export async function handle(req){
 if(req.method==='OPTIONS')return new Response(null,{headers:cors});
 if(req.method!=='POST')return reply({error:'Method not allowed'},405);
 if(Number(req.headers.get('content-length'))>100000)return reply({error:'Слишком большой запрос'},413);
 try{
  const raw=await req.text();if(raw.length>100000)return reply({error:'Слишком большой запрос'},413);
  let body;try{body=JSON.parse(raw)}catch{return reply({error:'Некорректный запрос'},400)}if(!body||typeof body!=='object'||Array.isArray(body))return reply({error:'Некорректный запрос'},400);
  if(body.action==='login'){
   if(typeof body.password!=='string'||body.password.length>200){await delayFailure();return reply({error:'Неверный пароль'},401)}
   if(!await reserveLogin(rest,req,'admin')){await delayFailure();return reply({error:'Слишком много попыток. Попробуй через 15 минут.'},429)}
   const [setting]=await rest('schedule_settings?id=eq.1&select=salt,password_hash');
   const hash=await hashPassword(body.password,setting.salt);
   if(!equal(hash,setting.password_hash)){await delayFailure();return reply({error:'Неверный пароль'},401)}
   const token=hex(crypto.getRandomValues(new Uint8Array(32)));const expires=new Date(Date.now()+2*60*60*1000).toISOString();
   if(!await rest('rpc/uf_create_session',{method:'POST',body:JSON.stringify({p_user_id:'admin',p_token_hash:await sha(token),p_expected_hash:setting.password_hash,p_legacy:true})})){await delayFailure();return reply({error:'Пароль изменился. Войди заново.'},401)}
   await rest('schedule_sessions?expires_at=lt.'+encodeURIComponent(new Date().toISOString()),{method:'DELETE'});
   return reply({token,expires_at:expires});
  }
  if(typeof body.token!=='string'||!/^[a-f0-9]{64}$/.test(body.token))return reply({error:'Войди как администратор'},401);
  const tokenHash=await sha(body.token);
  const sessions=await rest('schedule_sessions?token_hash=eq.'+tokenHash+'&expires_at=gt.'+encodeURIComponent(new Date().toISOString())+'&select=expires_at');
  if(!sessions.length)return reply({error:'Сессия истекла. Войди заново.'},401);
  if(body.action==='logout'){await rest('schedule_sessions?token_hash=eq.'+tokenHash,{method:'DELETE'});return reply({ok:true})}
  if(body.action==='logout.all'){await revokeSessions(rest,{id:'admin'});return reply({ok:true})}
  if(body.action!=='save')return reply({error:'Неизвестное действие'},400);
  if(!Number.isSafeInteger(body.revision)||body.revision<1||!body.data||typeof body.data!=='object')return reply({error:'Некорректное расписание'},400);
  let rows;try{rows=await rest('group_schedule?id=eq.'+GROUP+'&revision=eq.'+body.revision,{method:'PATCH',headers:{Prefer:'return=representation'},body:JSON.stringify({data:body.data})})}catch{return reply({error:'Не удалось сохранить. Проверь предметы и время занятий.'},400)}
  if(!rows.length)return reply({error:'Расписание уже изменено другим администратором. Открой редактор заново.'},409);
  return reply({schedule:rows[0]});
 }catch{return reply({error:'Сервер временно недоступен. Попробуй ещё раз.'},503)}
}
if(typeof Deno!=='undefined')Deno.serve(handle);
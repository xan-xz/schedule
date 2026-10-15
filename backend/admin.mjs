const GROUP='06-057-25-11';
const origin='https://xan-xz.github.io';
const cors={'Access-Control-Allow-Origin':origin,'Access-Control-Allow-Headers':'content-type, apikey','Access-Control-Allow-Methods':'POST, OPTIONS','Cache-Control':'no-store','Vary':'Origin'};
const hex=b=>Array.from(new Uint8Array(b)).map(x=>x.toString(16).padStart(2,'0')).join('');
const sha=async s=>hex(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s)));
async function rest(path,options={}){
 const key=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
 const res=await fetch(Deno.env.get('SUPABASE_URL')+'/rest/v1/'+path,{...options,headers:{apikey:key,Authorization:'Bearer '+key,'Content-Type':'application/json',...options.headers}});
 if(!res.ok)throw new Error('Database request failed');
 const text=await res.text();return text?JSON.parse(text):null;
}
function reply(data,status=200){return new Response(JSON.stringify(data),{status,headers:{...cors,'Content-Type':'application/json'}})}
function equal(a,b){if(a.length!==b.length)return false;let n=0;for(let i=0;i<a.length;i++)n|=a.charCodeAt(i)^b.charCodeAt(i);return n===0}
export async function handle(req){
 if(req.method==='OPTIONS')return new Response(null,{headers:cors});
 if(req.method!=='POST')return reply({error:'Method not allowed'},405);
 if(Number(req.headers.get('content-length'))>100000)return reply({error:'Слишком большой запрос'},413);
 try{
  const raw=await req.text();if(raw.length>100000)return reply({error:'Слишком большой запрос'},413);
  let body;try{body=JSON.parse(raw)}catch{return reply({error:'Некорректный запрос'},400)}
  if(body.action==='login'){
   if(typeof body.password!=='string'||body.password.length>200)return reply({error:'Неверный пароль'},401);
   const ip=req.headers.get('x-forwarded-for')?.split(',')[0]?.trim()||'unknown';const ipHash=await sha(ip);
   const since=new Date(Date.now()-15*60*1000).toISOString();
   const attempts=await rest('schedule_login_attempts?select=id&ip_hash=eq.'+ipHash+'&created_at=gte.'+encodeURIComponent(since)+'&limit=10');
   if(attempts.length>=10)return reply({error:'Слишком много попыток. Попробуй через 15 минут.'},429);
   await rest('schedule_login_attempts',{method:'POST',body:JSON.stringify({ip_hash:ipHash})});
   const [setting]=await rest('schedule_settings?id=eq.1&select=salt,password_hash');
   const material=await crypto.subtle.importKey('raw',new TextEncoder().encode(body.password),'PBKDF2',false,['deriveBits']);
   const hash=hex(await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',salt:new TextEncoder().encode(setting.salt),iterations:210000},material,256));
   if(!equal(hash,setting.password_hash))return reply({error:'Неверный пароль'},401);
   const token=hex(crypto.getRandomValues(new Uint8Array(32)));const expires=new Date(Date.now()+2*60*60*1000).toISOString();
   await rest('schedule_sessions',{method:'POST',body:JSON.stringify({token_hash:await sha(token),expires_at:expires})});
   await rest('schedule_sessions?expires_at=lt.'+encodeURIComponent(new Date().toISOString()),{method:'DELETE'});
   await rest('schedule_login_attempts?created_at=lt.'+encodeURIComponent(since),{method:'DELETE'});
   return reply({token,expires_at:expires});
  }
  if(typeof body.token!=='string'||!/^[a-f0-9]{64}$/.test(body.token))return reply({error:'Войди как администратор'},401);
  const tokenHash=await sha(body.token);
  const sessions=await rest('schedule_sessions?token_hash=eq.'+tokenHash+'&expires_at=gt.'+encodeURIComponent(new Date().toISOString())+'&select=expires_at');
  if(!sessions.length)return reply({error:'Сессия истекла. Войди заново.'},401);
  if(body.action==='logout'){await rest('schedule_sessions?token_hash=eq.'+tokenHash,{method:'DELETE'});return reply({ok:true})}
  if(body.action!=='save')return reply({error:'Неизвестное действие'},400);
  if(!Number.isSafeInteger(body.revision)||body.revision<1||!body.data||typeof body.data!=='object')return reply({error:'Некорректное расписание'},400);
  let rows;try{rows=await rest('group_schedule?id=eq.'+GROUP+'&revision=eq.'+body.revision,{method:'PATCH',headers:{Prefer:'return=representation'},body:JSON.stringify({data:body.data})})}catch{return reply({error:'Не удалось сохранить. Проверь предметы и время занятий.'},400)}
  if(!rows.length)return reply({error:'Расписание уже изменено другим администратором. Открой редактор заново.'},409);
  return reply({schedule:rows[0]});
 }catch{return reply({error:'Сервер временно недоступен. Попробуй ещё раз.'},503)}
}
Deno.serve(handle);
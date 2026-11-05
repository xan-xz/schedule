import * as storage from './storage.mjs';
const API='https://anfwdrcazwbkkayczkxg.supabase.co';
const KEY='sb_publishable_NkbuSbf1LxiCGvgz48fPjg_aVVwDU_G';
export function readPreference(key,fallback) {
  try {const value=localStorage.getItem(key);return value==null?fallback:JSON.parse(value);} catch {return fallback;}
}
export function writePreference(key,value) {
  try {localStorage.setItem(key,JSON.stringify(value));return true;}catch{return false;}
}
export function initialSettings() {
  let legacy='А';try {legacy=localStorage.getItem('para.group')==='Б'?'Б':'А';}catch{ /* restricted browser */ }
  return {groupId:readPreference('uf.group','g-main'),subgroup:readPreference('uf.subgroup',legacy),lang:'ru',theme:readPreference('uf.dark',false)?'dark':'system',hour12:false,reminder:0,...readPreference('uf.settings.v1',{})};
}
function publicSnapshot(snapshot, settings) {
  // Every public cache read/write rechecks its scope. Never let a previous
  // group's tasks or role-specific payload leak into the current selection.
  const source=snapshot.data||{};
  const data={};
  for(const key of ['groups','teachers','subjects','rooms','lessons','exceptions','holidays'])data[key]=source[key]||[];
  for(const key of ['validFrom','validUntil'])if(source[key])data[key]=source[key];
  data.tasks=(source.tasks||[]).filter(task=>task.groupId===settings.groupId&&(settings.subgroup==='all'||task.subgroup==='all'||task.subgroup===settings.subgroup));
  data.announcements=(source.announcements||[]).filter(item=>(!item.roles||item.roles.includes('student'))&&(item.groupId?item.groupId===settings.groupId:!item.teacherId));
  data.attendance=[];data.requests=[];data.history=[];
  return {data,revision:snapshot.revision,source:snapshot.source,updatedAt:snapshot.updatedAt};
}
export async function publicState(groupId,subgroup) {
  const request = async sub => {
    const r=await fetch(API+'/functions/v1/uniflow-api',{method:'POST',headers:{'Content-Type':'application/json',apikey:KEY},body:JSON.stringify({action:'state',groupId,subgroup:sub}),signal:AbortSignal.timeout(12000)});
    if(!r.ok)throw Error('state '+r.status);return r.json();
  };
  const state=await request(subgroup);
  // Compatibility with the deployed v2 server, which projects "all" as subgroup A.
  if(subgroup==='all'){
    const group=state.data.groups.find(g=>g.id===groupId);
    const rest=await Promise.all((group?.subgroups||[]).filter(g=>g!==state.user?.subgroup).map(request));
    state.data.tasks=[...new Map([state,...rest].flatMap(s=>s.data.tasks).map(task=>[task.id,task])).values()];
  }
  // Never persist private state, accounts, tokens or attendance in the public cache.
  return publicSnapshot({data:state.data,revision:state.revision,updatedAt:new Date().toISOString(),source:'live'},{groupId,subgroup});
}
export const snapshotKey = settings => 'snapshot:'+settings.groupId+':'+settings.subgroup;
export async function getSnapshot(settings) {const saved=await storage.get(snapshotKey(settings));return saved?publicSnapshot(saved,settings):null;}
export async function saveSnapshot(settings,snapshot) {return storage.set(snapshotKey(settings),publicSnapshot(snapshot,settings));}
export async function releaseSnapshot(settings) {
  const r=await fetch(new URL('../bootstrap.json',import.meta.url));if(!r.ok)throw Error('snapshot');return publicSnapshot(await r.json(),settings||initialSettings());
}
export async function demoSnapshot(role,settings) {
  // The read-only student surface does not need the mutation engine, account
  // catalogue or source provenance. Staff opens those modules only in /manage/.
  const saved=readPreference('uf.demo.source.v4',null);
  const valid=saved?.data?.schemaVersion===4;
  const snapshot=valid?{data:saved.data,revision:saved.revision||1,updatedAt:new Date().toISOString(),source:'demo'}:await releaseSnapshot(settings);
  const result=publicSnapshot({...snapshot,source:'demo'},settings);
  if(!valid){result.data.tasks=[];result.data.announcements=[];}
  result.actor={role};
  return result;
}

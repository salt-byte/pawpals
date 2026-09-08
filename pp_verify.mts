import 'dotenv/config';
import { readFileSync, existsSync } from 'node:fs';
import { chatExtractJson } from './llm.ts';
import { buildAutofillPrompt, validateAutofillPlan } from './server/autofill-plan.ts';
import { widgetsToProbe, mergeProbedOptions, retryTargets, fieldsForModel, manualFields,
         shouldRunAnotherRound, stillOpen, questionsForUser, unprobed } from './server/apply-orchestrator.ts';

const B='http://localhost:3000';
const U='https://t6ixa9nyl6.jiandaoyun.com/f/65e1a1308ce7672fded0f0cf?ext=XDUWYL';
const C='/Users/dengyudie/.openclaw/workspace/career';
const rd=(f:string)=>existsSync(f)?readFileSync(f,'utf8'):'';
const profileText=`${rd(`${C}/profile.md`)}\n\n${rd(`${C}/resume_master.md`)}`.trim().slice(0,6000);
const ctx={company:'帆软',title:'2027届秋季校园招聘'};
const post=(kind:string,payload:any={})=>fetch(`${B}/api/official-applications/prepare`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:U,...ctx,kind,payload})}).then(r=>r.json());
const wait=async(id:string,ms=90000)=>{const t=Date.now();while(Date.now()-t<ms){const r:any=await fetch(`${B}/api/official-applications/${id}/result`).then(r=>r.json());if(r.ok)return r.result;await new Promise(r=>setTimeout(r,1500));}return null;};
const snap=async()=>{const i:any=await wait((await post('inspect')).task.id);
  return i?.ok?(i.snapshot||[]).map((c:any)=>({...c,signature:c.handle,label:c.context})):null;};
const label=(f:any)=>String(f.context||f.label||'').slice(0,14);

const askModel=async(list:any[],all:any[])=>{
  if(!list.length) return {values:[] as any[],rejected:[] as any[]};
  try{
    const raw:any=await chatExtractJson('你是网申表单填写助手。只做映射，不做创作。只输出 JSON。',
      buildAutofillPrompt({controls:list as any,profileText,ctx}),{max_tokens:4000,reasoning_effort:'minimal'} as any);
    return validateAutofillPlan(raw?.values,all,profileText);
  }catch(e){console.log('  LLM 失败',String(e).slice(0,60));return {values:[] as any[],rejected:[] as any[]};}
};

const MAX=Number(process.env.ROUNDS||3);
let planFields:any[]=[]; const failures:any[]=[];
for(let round=1;round<=MAX;round++){
  const f=await snap();
  if(!f){console.log(`第${round}轮 inspect 失败`);break;}
  planFields=f;
  const open=stillOpen(planFields,[]);
  const already=planFields.length-open.length;
  if(!open.length){console.log(`第${round}轮：全部已填`);break;}

  let list=widgetsToProbe(open);
  for(let pass=0;pass<3&&list.length;pass++){
    const got:any[]=[];
    for(let i=0;i<list.length;i+=5){
      const r:any=await wait((await post('probe',{signatures:list.slice(i,i+5),budgetMs:15000})).task.id,40000);
      if(Array.isArray(r?.probed)){got.push(...r.probed);planFields=mergeProbedOptions(planFields,r.probed);}
    }
    const left=unprobed(list,got);
    if(left.length===list.length) break;
    list=left;
  }
  const refreshed=stillOpen(planFields,[]);
  const at=await askModel(fieldsForModel(refreshed),planFields);
  let n=0;
  if(at.values.length){
    const fb=Math.min(180000,15000+at.values.length*6000);
    const fl:any=await wait((await post('fill',{values:at.values,budgetMs:fb})).task.id,fb+30000);
    n=fl?.filled?.length??0;
    if(Array.isArray(fl?.skipped)) failures.push(...fl.skipped);
    const rt=retryTargets(fl?.skipped??[],planFields);
    if(rt.length){
      const s2=await askModel(rt,planFields);
      if(s2.values.length){const rb=Math.min(180000,15000+s2.values.length*6000);const ag:any=await wait((await post('fill',{values:s2.values,budgetMs:rb})).task.id,rb+30000);n+=ag?.filled?.length??0;}
    }
  }
  console.log(`第${round}轮  已填${already} 待填${open.length} 未探完${list.length} 模型给${at.values.length} → 本轮回读确认 ${n}`);
  if(!shouldRunAnotherRound({round,filledThisRound:n,maxRounds:MAX})) break;
}

// ── 按页面实际状态验收 ──
const final=await snap()||planFields;
const done=final.filter((f:any)=>String(f.value??'').trim());
const open2=stillOpen(final,[]);
const reasons=new Map(failures.map((x:any)=>[x.signature,x.reason]));
const broken=open2.filter((f:any)=>reasons.has(f.signature));
const askable=questionsForUser(open2.filter((f:any)=>!reasons.has(f.signature)),[]);

console.log(`\n═══ 页面回读：${done.length}/${final.length} ═══`);
console.log(`\n【已确认填写】${done.length}`);
for(const f of done) console.log(`  ✓ ${label(f).padEnd(16)} = ${String(f.value).slice(0,28)}`);
console.log(`\n【控件操作失败】${broken.length}`);
for(const f of broken) console.log(`  ✗ ${label(f).padEnd(16)} ${reasons.get(f.signature)}`);
console.log(`\n【缺少用户资料】${askable.length}`);
for(const q of askable) console.log(`  ? ${q.label}${q.required?'（必填）':''}${q.options?.length?`  可选：${q.options.slice(0,4).join('/')}`:''}`);
const other=open2.length-broken.length-askable.length;
if(other>0) console.log(`\n（另有 ${other} 个未归类：多为无标签或超出提问上限）`);
console.log('\n没有提交。');

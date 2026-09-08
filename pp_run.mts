import 'dotenv/config';
import { readFileSync, existsSync } from 'node:fs';
import { chatExtractJson } from './llm.ts';
import { buildAutofillPrompt, validateAutofillPlan } from './server/autofill-plan.ts';
import { widgetsToProbe, mergeProbedOptions, retryTargets, fieldsForModel, manualFields, shouldRunAnotherRound, stillOpen } from './server/apply-orchestrator.ts';

const B='http://localhost:3000';
const U='https://t6ixa9nyl6.jiandaoyun.com/f/65e1a1308ce7672fded0f0cf?ext=XDUWYL';
const C='/Users/dengyudie/.openclaw/workspace/career';
const rd=(f:string)=>existsSync(f)?readFileSync(f,'utf8'):'';
const profileText=`${rd(`${C}/profile.md`)}\n\n${rd(`${C}/resume_master.md`)}`.trim().slice(0,6000);
const ctx={company:'帆软',title:'2027届秋季校园招聘'};
const post=(kind:string,payload:any={})=>fetch(`${B}/api/official-applications/prepare`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:U,...ctx,kind,payload})}).then(r=>r.json());
const wait=async(id:string,ms=90000)=>{const t=Date.now();while(Date.now()-t<ms){const r:any=await fetch(`${B}/api/official-applications/${id}/result`).then(r=>r.json());if(r.ok)return r.result;await new Promise(r=>setTimeout(r,1500));}return null;};

const MAX=4;
const filledSigs:string[]=[]; const filledLabels:string[]=[];
let planFields:any[]=[]; let last:any=null; let needsUser:any[]=[]; let allRejected:any[]=[];
const labelOf=(sg:string)=>{const h=planFields.find(f=>f.signature===sg||f.handle===sg);return String(h?.context||h?.label||sg).slice(0,22);};

const ask=async(list:any[])=>{
  if(!list.length) return {values:[] as any[],rejected:[] as any[]};
  try{
    const raw:any=await chatExtractJson('你是网申表单填写助手。只做映射，不做创作。只输出 JSON。',
      buildAutofillPrompt({controls:list as any,profileText,ctx}),{max_tokens:4000,reasoning_effort:'minimal'} as any);
    return validateAutofillPlan(raw?.values,planFields,profileText);
  }catch(e){console.log('  LLM 失败',String(e).slice(0,80));return {values:[] as any[],rejected:[] as any[]};}
};
const fill=async(vs:any[])=>wait((await post('fill',{values:vs})).task.id);

for(let round=1;round<=MAX;round++){
  const insp:any=await wait((await post('inspect')).task.id);
  if(!insp?.ok){console.log(`第${round}轮 inspect 失败`);break;}
  last=insp;
  const snap:any[]=insp.snapshot||[];
  planFields=snap.map((c:any)=>({...c,signature:c.handle,label:c.context}));
  const open=stillOpen(planFields,filledSigs);
  if(!open.length){console.log(`第${round}轮：没有待填字段了`);break;}

  const probeList=widgetsToProbe(open);
  for(let i=0;i<probeList.length;i+=5){
    const r:any=await wait((await post('probe',{signatures:probeList.slice(i,i+5),budgetMs:15000})).task.id,40000);
    if(Array.isArray(r?.probed)) planFields=mergeProbedOptions(planFields,r.probed);
  }
  const refreshed=stillOpen(planFields,filledSigs);
  const list=fieldsForModel(refreshed);
  needsUser=manualFields(refreshed);

  const at=await ask(list);
  allRejected=at.rejected;
  let n=0;
  if(at.values.length){
    const f:any=await fill(at.values);
    if(f?.ok){
      for(const sg of f.filled??[]){filledSigs.push(String(sg));filledLabels.push(labelOf(String(sg)));n++;}
      const rt=retryTargets(f.skipped??[],planFields);
      if(rt.length){
        const s2=await ask(rt);
        if(s2.values.length){const ag:any=await fill(s2.values);
          for(const sg of ag?.filled??[]){filledSigs.push(String(sg));filledLabels.push(labelOf(String(sg)));n++;}}
      }
    }
  }
  console.log(`第${round}轮  字段${planFields.length} 待填${open.length} 探${probeList.length} 模型给${at.values.length} → 填进 ${n}`);
  if(n) console.log(`        ${filledLabels.slice(-n).join('、')}`);
  if(!shouldRunAnotherRound({round,filledThisRound:n,maxRounds:MAX})) break;
}

console.log(`\n═══ 合计填进 ${filledSigs.length}/${planFields.length} ═══`);
for(const l of filledLabels) console.log(`  ✓ ${l}`);
if(needsUser.length) console.log(`\n需要你自己选的 ${needsUser.length} 个: ${needsUser.map((f:any)=>String(f.context||'').slice(0,14)).join('、')}`);
const empt=stillOpen(planFields,filledSigs);
console.log(`\n仍然空着的 ${empt.length} 个:`);
for(const f of empt) console.log(`  ✗ [${String(f.type).slice(0,6).padEnd(6)}] ${String(f.context||'(无标签)').slice(0,34).padEnd(36)} ${f.options?.length?`${f.options.length}选项`:''}`);
console.log('\n没有提交。');

import 'dotenv/config';
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { chatExtractJson } from './llm.ts';
import { buildAutofillPrompt, validateAutofillPlan } from './server/autofill-plan.ts';
import { runApplyFlow } from './server/apply-flow.ts';
import { buildFieldPrompt } from './server/field-agent.ts';
import { pickResumeFile } from './server/resume-file.ts';

const B='http://localhost:3000';
const U='https://t6ixa9nyl6.jiandaoyun.com/f/65e1a1308ce7672fded0f0cf?ext=XDUWYL';
const CAREER='/Users/dengyudie/.openclaw/workspace/career';
const rd=(f:string)=>existsSync(f)?readFileSync(f,'utf8'):'';
const profileText=`${rd(`${CAREER}/profile.md`)}\n\n${rd(`${CAREER}/resume_master.md`)}`.trim().slice(0,6000);
const job={url:U,company:'帆软',title:'2027届秋季校园招聘'};

const post=(t:any)=>fetch(`${B}/api/official-applications/prepare`,{method:'POST',headers:{'Content-Type':'application/json'},
  body:JSON.stringify({url:t.url,company:t.company,title:t.title,kind:t.kind,payload:t.payload})}).then(r=>r.json());

const outcome = await runApplyFlow(job, {
  runTask: async (t:any, ms=90000) => {
    const q:any = await post(t);
    const id=q?.task?.id; if(!id) return {ok:false,error:'enqueue_failed'};
    const start=Date.now();
    while(Date.now()-start<ms){
      const r:any=await fetch(`${B}/api/official-applications/${id}/result`).then(r=>r.json());
      if(r.ok) return r.result;
      await new Promise(r=>setTimeout(r,1500));
    }
    return {ok:false,error:'wait_timeout',timedOut:true};
  },
  askModel: async (ask:any[], all:any[]) => {
    if(!ask.length||!profileText) return [];
    try{
      const raw:any=await chatExtractJson('你是网申表单填写助手。只做映射，不做创作。只输出 JSON。',
        buildAutofillPrompt({controls:ask as any,profileText,ctx:{company:job.company,title:job.title}}),
        {max_tokens:4000,reasoning_effort:'minimal'} as any);
      return validateAutofillPlan(raw?.values,all,profileText).values;
    }catch(e){console.log('  LLM 失败',String(e).slice(0,70));return [];}
  },
  decideField: async (ctx:any) => {
    try{
      return await chatExtractJson('你在填一个网申表单的框。只输出 JSON，不要解释。',
        buildFieldPrompt(ctx), {max_tokens:600, reasoning_effort:'minimal'} as any);
    }catch(e){ console.log('  决策失败', String(e).slice(0,60)); return {action:'give_up',reason:'model_unavailable'}; }
  },
  validateValue: (value:string, field:any, source:string) => {
    const plan = validateAutofillPlan([{signature:field.signature, value, source: source||value}], [field], profileText);
    return plan.values.length ? {ok:true} : {ok:false, reason: plan.rejected[0]?.reason || 'rejected'};
  },
  readProfile: () => profileText,
  findResume: () => pickResumeFile({envPath:process.env.PAWPALS_RESUME_FILE,
    dirs:[CAREER,path.join(process.env.HOME||'','Downloads')],
    exists:(p:string)=>existsSync(p), list:(d:string)=>readdirSync(d)}),
  readFile: (p:string)=>readFileSync(p),
  fileSize: (p:string)=>statSync(p).size,
  log: (l:string)=>console.log(l),
} as any);

const lb=(f:any)=>String(f.context||f.label||'').slice(0,16);
console.log(`\n═══ 页面回读：${outcome.confirmed.length}/${outcome.totalFields}（${outcome.rounds} 轮）═══`);
for(const n of outcome.uploadNotes) console.log(`  ⇧ ${n}`);
console.log(`\n【已确认填写】${outcome.confirmed.length}`);
for(const f of outcome.confirmed) console.log(`  ✓ ${lb(f).padEnd(18)} = ${String(f.value).slice(0,30)}`);
console.log(`\n【值被页面改写】${outcome.mismatched.length}`);
for(const m of outcome.mismatched) console.log(`  ⚠ ${lb(m.field).padEnd(18)} 想填「${m.intended}」→ 实际「${m.actual}」`);
console.log(`\n【没认出标签】${outcome.unlabeled.length}`);
for(const f of outcome.unlabeled) console.log(`  ? [${String(f.type)}] ${String(f.signature).slice(0,50)}`);
console.log(`\n【控件操作失败】${outcome.broken.length}`);
for(const b of outcome.broken) console.log(`  ✗ ${lb(b.field).padEnd(18)} ${b.reason}`);
console.log(`\n【缺少用户资料】${outcome.questions.length}`);
for(const q of outcome.questions) console.log(`  ? ${q.label}${q.required?'（必填）':''}${q.options?.length?`  可选：${q.options.slice(0,4).join('/')}`:''}`);
console.log(`\n账本：${outcome.runLog.suspicious.length ? outcome.runLog.suspicious.map((s:any)=>`${s.name} 自报${s.claimed}/实际${s.actual}`).join('  ') : '无异常'}`);
console.log('\n没有提交。');

import {test,expect} from 'bun:test';
import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
test('Fix01 legacy schemas reaches actual OS CLI rejection without boundary violation',async()=>{
 const m=await get(),w=m.createScenarioDirectory('png-timing'),argv=['schemas','--name','recipe','--json'];
 console.log('Fix01 legacy proof workspace',w);
 const result=await m.runScenarioCli(w,argv);
 const events=readFileSync(join(w,'.harness/driver.jsonl'),'utf8').trim().split('\n').map(x=>JSON.parse(x));
 writeFileSync(join(w,'.harness/legacy-schemas-proof.json'),JSON.stringify({synthetic_mechanism_only:true,workspace:w,argv,result,events},null,2));
 expect(result.exitCode).toBe(2);expect(result.body.error.code).toBe('INVALID_ARGUMENT');expect(result.stdout).toContain('schemas');expect(result.stderr).toBe('');
 expect(events.some((e:any)=>e.channel.startsWith('prohibited_'))).toBe(false);expect(events.find((e:any)=>e.channel==='cli_result').child_pid).toBeGreaterThan(0);
 for(const a of [['gui'],['mcp','--stdio'],['schemas','--workspace=C:/outside'],['schemas','--help'],['privileged-review-setup']])expect(()=>m.validateEvaluatorCli(a)).toThrow();
});
test('Fix01 immutable frame variants share one slot but only final pixels support selfcheck',async()=>{
 const {accountImageEvidence}=await get();const f=(id:string)=>({frame_id:id,content_hash:'content-'+id,files:{png:id+'.png',raw:id+'-raw.png',mask:id+'-mask.png',rgba:id+'-rgba.png'},png_sha256:id,raw_sha256:id+'raw',mask_sha256:id+'mask',rgba_sha256:id+'rgba'});
 const a=f('a'),b=f('b'),c={directory:'C:/candidate',manifest:{candidate_id:'c',frames:[a,b]},plan:{budget:1,samples:[{frame_id:'a'}]},self:{observations:[{viewed:true,frame_id:'a',frame_content_hash:'content-a'}]}};
 const cap=(items:any[])=>({calls:items.map((x,i)=>({payload:{call_id:String(i),input:x.path}})),images:items.map((x,i)=>({call_id:String(i),sha256:x.sha,at:'2026-01-01T00:00:02Z'})),unknown_images:[]});
 const view=(frame:any,kind:string)=>({path:'C:/candidate/'+frame.files[kind],sha:frame[kind+'_sha256']});
 const both=accountImageEvidence([c],cap(['png','raw','mask','rgba','png'].map(k=>view(a,k))) as any,[{candidate_id:'c',at:'2026-01-01T00:00:01Z'}]);
 expect(both.complete).toBe(true);expect(both.exposures).toHaveLength(5);expect(both.candidate_budgets[0].frame_ids).toEqual(['a']);
 for(const k of ['raw','mask','rgba']){const only=accountImageEvidence([c],cap([view(a,k)]) as any);expect(only.unknown).toHaveLength(0);expect(only.failures.some((x:any)=>x.code==='view_or_ancestor_evidence_missing')).toBe(true);}
 const unclaimed={...c,self:null};expect(accountImageEvidence([unclaimed],cap([view(a,'mask')]) as any).complete).toBe(true);
 for(const bad of [view(b,'raw'),{...view(a,'raw'),sha:'wrong'},{...view(a,'raw'),path:'C:/candidate/a-raw.png.extra'},{...view(a,'raw'),path:'C:/elsewhere/a-raw.png'}])expect(accountImageEvidence([unclaimed],cap([bad]) as any).complete).toBe(false);
});
test('Fix01 pinned original inspections have separate provenance and no cap or selfcheck alias bypass',async()=>{
 const m=await get(),w=m.createScenarioDirectory('sampling-budget');const originals=['one.png','two.png','three.png'].map((name,i)=>{const path=join(w,'input',name),bytes=Buffer.from('synthetic image bytes '+i);writeFileSync(path,bytes);return {path,sha256:createHash('sha256').update(bytes).digest('hex')};});
 const sources=[{id:'source',probe_json:JSON.stringify({frames:originals.map((o,i)=>({source_frame_id:'s'+i,original_name:['one.png','two.png','three.png'][i],sha256:o.sha256}))})}];
 const c={directory:'C:/candidate',created_at:Date.parse('2026-01-01T00:00:03Z'),manifest:{candidate_id:'c',brief:{source_id:'source'},frames:originals.map((o,i)=>({frame_id:'f'+i,source_frame_id:'s'+i,content_hash:'h'+i,files:{png:'final'+i+'.png'},png_sha256:'final'+i}))},plan:{budget:1,samples:[{frame_id:'f0'}]}};
 const cap=(items:any[],at='2026-01-01T00:00:02Z')=>({calls:items.map((x,i)=>({payload:{call_id:String(i),input:x.path}})),images:items.map((x,i)=>({call_id:String(i),sha256:x.sha256,at})),unknown_images:[]});
 const options={original_assets:originals,sources,visual_limit:2};const early=m.accountImageEvidence([c],cap([originals[0]]) as any,[],options);
 expect(early.complete).toBe(true);expect(early.source_inspections).toHaveLength(1);expect(early.exposures).toHaveLength(0);
 const final={path:'C:/candidate/final0.png',sha256:'final0'},timeline=[{candidate_id:'c',at:'2026-01-01T00:00:03Z'}];
 const combined=m.accountImageEvidence([c],cap([originals[0],final], '2026-01-01T00:00:04Z') as any,timeline,options);expect(combined.complete).toBe(true);expect(combined.request_budget.frame_ids).toHaveLength(1);
 const late=m.accountImageEvidence([c],cap([originals[1]],'2026-01-01T00:00:04Z') as any,timeline,options);expect(late.complete).toBe(false);expect(late.failures.some((x:any)=>x.code==='plan_or_budget')).toBe(true);
 expect(m.accountImageEvidence([],cap(originals) as any,[],options).failures.some((x:any)=>x.code==='request_visual_budget')).toBe(true);
 const claimed={...c,self:{observations:[{frame_id:'f0',frame_content_hash:'h0',viewed:true}]}};expect(m.accountImageEvidence([claimed],cap([originals[0]],'2026-01-01T00:00:04Z') as any,timeline,options).complete).toBe(false);
 expect(m.accountImageEvidence([],cap([{...originals[0],sha256:'wrong'}]) as any,[],options).complete).toBe(false);
 expect(m.accountImageEvidence([],cap([{...originals[0],path:originals[0].path+'.extra'}]) as any,[],options).complete).toBe(false);
 writeFileSync(originals[0].path,'changed');expect(m.accountImageEvidence([],cap([originals[0]]) as any,[],options).complete).toBe(false);
});
const script=resolve(import.meta.dir,'../../scripts/verify_collaboration_skill.ts');
const get=async()=>{expect(existsSync(script),'deterministic scenario harness is required').toBe(true);return import(script);};
for(const kind of ['png_sequence','video'])test('Fix02 '+kind+' routed DraftFrame provenance binds historical source views and rejects forged aliases',async()=>{
 const m=await get(),w=m.createScenarioDirectory('png-timing'),at=(n:number)=>`2026-01-01T00:00:0${n}Z`,hash=(x:string)=>createHash('sha256').update(x).digest('hex');
 const paths={raw:join(w,'projects/p/raw/f.png'),mask:join(w,'projects/p/masks/v-mask.png'),rgba:join(w,'projects/p/masks/v-rgba.png')};
 const frame:any={frame_id:'f',source_frame_id:'sf',source_index:0,sequence_index:0,mask_version_id:'v'};for(const [k,path] of Object.entries(paths)){frame[k+'_path']=path;frame[k+'_sha256']=hash(k);}
 const context={project_id:'p',axis_id:'a'},input={...context,frame_id:'f'},version={id:'v',frame_id:'f',raw_path:paths.raw,raw_sha256:frame.raw_sha256,mask_path:paths.mask,rgba_path:paths.rgba};
 const map={source_frame_id:'sf',source_index:0,...(kind==='png_sequence'?{original_name:'one.png',sha256:frame.raw_sha256,canonical_path:join(w,'sources/s/images/one.png')}:{file:'raw/frame_000000.png',display_duration:{num:1,den:24},duration_origin:'source_pts'})};
 if(kind==='png_sequence')version.raw_path=(map as any).canonical_path;
 const events:any[]=[{channel:'http_request',phase:'evaluator',id:'request',at:at(1),method:'POST',path:'/api/v1/collaboration/maker/get_frame_artifacts',body:JSON.stringify(input)},{channel:'http_response',phase:'evaluator',id:'request',at:at(2),status:200,body:{ok:true,data:{frame,mask:{frame_id:'f',version_id:'v',source_changed:false,current:version}}}},{channel:'draft_artifact_provenance',phase:'evaluator',id:'request',at:at(3),frames:[{frame_id:'f',row:{id:'f',project_id:'p',axis_id:'a',raw_path:paths.raw,metadata:JSON.stringify({source_id:'s',source_frame_id:'sf',source_index:0})},source:{id:'s',project_id:'p',probe_json:JSON.stringify({kind,frames:kind==='png_sequence'?[map]:[]})},source_frame:kind==='video'?{source_id:'s',source_frame_id:'sf',source_index:0,timing_json:JSON.stringify(map)}:null,canonical:{path:kind==='png_sequence'?(map as any).canonical_path:join(w,'sources/s',(map as any).file),sha256:frame.raw_sha256},mask_head:{version_id:'v'},mask_version:version,files:Object.entries(paths).map(([representation,path])=>({representation,path,real_path:path,sha256:frame[representation+'_sha256'],observed_at:at(3)}))}]}];
 events[1].body.data.mask.raw_path=version.raw_path;Object.assign(events[2].frames[0].canonical,{real_path:events[2].frames[0].canonical.path,observed_at:at(3)});
 const cap=(representation='raw',time=4)=>({calls:[{timestamp:at(time),payload:{call_id:'image',input:JSON.stringify({path:paths[representation as keyof typeof paths]})}}],images:[{call_id:'image',sha256:frame[representation+'_sha256'],at:at(time+1)}],unknown_images:[]});
 const options={workspace:w,artifact_events:events,visual_limit:1};const before=m.accountImageEvidence([],cap() as any,[],options);expect(before.complete).toBe(true);expect(before.source_inspections[0].kind).toBe('draft_artifact');expect(before.source_inspections[0].source_frame_id).toBe('sf');
 for(const representation of ['mask','rgba'])expect(m.accountImageEvidence([],cap(representation) as any,[],options).complete).toBe(true);
 const combined=['raw','mask','rgba','raw'].map((k,i)=>{const c=cap(k);c.calls[0].payload.call_id=String(i);c.images[0].call_id=String(i);return c;});const repeated=m.accountImageEvidence([],{calls:combined.flatMap(c=>c.calls),images:combined.flatMap(c=>c.images),unknown_images:[]} as any,[],options);expect(repeated.complete).toBe(true);expect(repeated.request_budget.frame_ids).toHaveLength(1);
 if(kind==='png_sequence')expect(m.accountImageEvidence([],{...cap(),calls:[{timestamp:at(4),payload:{call_id:'image',input:JSON.stringify({path:version.raw_path})}}]} as any,[],options).complete).toBe(true);
 const candidate={created_at:Date.parse(at(3)),directory:join(w,'candidates/c'),manifest:{candidate_id:'c',brief:{context,source_id:'s'},frames:[{frame_id:'f',source_frame_id:'sf',content_hash:'h',files:{png:'f.png'},png_sha256:hash('final')}]},plan:{budget:1,samples:[{frame_id:'f'}]}};
 const timeline=[{candidate_id:'c',at:at(3)}];expect(m.accountImageEvidence([candidate],cap() as any,timeline,options).complete).toBe(true);
 expect(m.accountImageEvidence([{...candidate,created_at:Date.parse(at(4))+500}],cap() as any,[],options).complete).toBe(true);
 expect(m.accountImageEvidence([{...candidate,plan:{budget:1,samples:[]}}],cap() as any,timeline,options).complete).toBe(false);
 expect(m.accountImageEvidence([candidate],cap() as any,[],options).complete).toBe(false);
 expect(m.accountImageEvidence([{...candidate,self:{observations:[{viewed:true,frame_id:'f',frame_content_hash:'h'}]}}],cap() as any,timeline,options).complete).toBe(false);
 expect(m.accountImageEvidence([],cap() as any,[],{...options,visual_limit:0}).complete).toBe(false);
 const badMutations=[(v:any[])=>v.shift(),(v:any[])=>v.splice(1,1),(v:any[])=>v.pop(),(v:any[])=>v[1].status=403,(v:any[])=>v[1].body.data.frame.source_frame_id='other',(v:any[])=>v[0].body=JSON.stringify({...input,axis_id:'other'}),(v:any[])=>v[2].frames[0].source.id='other',(v:any[])=>v[2].frames[0].mask_head.version_id='wrong',(v:any[])=>v[2].frames[0].mask_version.frame_id='other',(v:any[])=>v[2].frames[0].files[0].sha256=hash('wrong'),(v:any[])=>v[2].at=at(6),(v:any[])=>v[2].frames[0].files[0].real_path=join(w,'../outside.png')];
 for(const mutate of badMutations){const bad=structuredClone(events);mutate(bad);expect(m.accountImageEvidence([],cap() as any,[],{...options,artifact_events:bad}).complete).toBe(false);}
 expect(m.accountImageEvidence([],{...cap(),calls:[]} as any,[],options).complete).toBe(false);
 expect(m.accountImageEvidence([],{...cap(),images:[{call_id:'image',sha256:hash('wrong'),at:at(5)}]} as any,[],options).complete).toBe(false);
 expect(m.accountImageEvidence([],{...cap(),calls:[{timestamp:at(4),payload:{call_id:'image',input:JSON.stringify({path:paths.raw+'.extra'})}}]} as any,[],options).complete).toBe(false);
 expect(m.accountImageEvidence([],cap('raw',1) as any,[],options).complete).toBe(false);
 const stale=structuredClone(events);stale.push({...stale[2],at:at(4),frames:[{...stale[2].frames[0],mask_head:{version_id:'new'}}]});expect(m.accountImageEvidence([],cap('mask',5) as any,[],{...options,artifact_events:stale}).complete).toBe(false);
});
test('redaction removes exact credentials including nested JSON without destroying evidence',async()=>{
 const {redactEvidence}=await get();const secret='actual"secret\\value';
 const x=redactEvidence({authorization:'Bearer '+secret,nested:JSON.stringify({cookie:secret}),ordinary:'observed HTTP 403'},[secret]);
 expect(JSON.stringify(x)).not.toContain('actual');expect(x.ordinary).toBe('observed HTTP 403');expect(x.authorization).toContain('[REDACTED]');
});
test('fresh control equality ignores only runtime mapping, never request or input bytes',async()=>{
 const {controlFingerprint}=await get();const a={request:'导出',assets:[{name:'a',sha256:'abc'}],fault:{kind:'timeout'},settings:{model:'gpt-6.1-sol',effort:'high'}};
 expect(controlFingerprint(a)).toBe(controlFingerprint(structuredClone(a)));
 expect(controlFingerprint(a)).not.toBe(controlFingerprint({...a,request:'改图'}));
 expect(controlFingerprint(a)).not.toBe(controlFingerprint({...a,fault:{kind:'cancel'}}));
});
test('verifier cannot pass absent observation evidence or evaluator self report',async()=>{
 const {verifySkillScenarioOutcome,createScenarioDirectory}=await get();const w=createScenarioDirectory('unapproved-export');
 writeFileSync(join(w,'self-report.json'),JSON.stringify({passed:true,noApprovalAttempts:true}));
 const result=await verifySkillScenarioOutcome('unapproved-export',w);expect(result.passed).toBe(false);
 expect(JSON.stringify(result.observations)).toContain('missing');
});
test('owned workspace guard refuses default and traversal before DB or service access',async()=>{
 const {assertScenarioWorkspace}=await get();expect(()=>assertScenarioWorkspace(resolve(import.meta.dir,'../../storage'))).toThrow();
 expect(()=>assertScenarioWorkspace(resolve(import.meta.dir,'../../fixtures/generated/human-ai/t13-unknown'))).toThrow();
});
test('catalog has exact eleven fixed cases and evaluator projection excludes grading controls',async()=>{
 const {scenarioNames,scenarioPublicRequest}=await get();expect(scenarioNames).toEqual(['minimal-video','png-timing','missing-model','large-input','wait-resume','review-change','source-changed','local-rework','unapproved-export','sampling-budget','accepted-delivery']);
 for(const name of scenarioNames){const text=scenarioPublicRequest(name);expect(typeof text).toBe('string');expect(text.length).toBeGreaterThan(5);expect(text).not.toContain('rubric');}
 expect(()=>scenarioPublicRequest('repeated-recovery')).toThrow();
});
test('evaluator command allowlist rejects GUI, nested transport and workspace override before execution',async()=>{
 const m=await get();expect(typeof m.validateEvaluatorCli).toBe('function');
 for(const a of [['gui'],['mcp','--stdio'],['doctor','--workspace=C:/outside'],['privileged-review-setup']])expect(()=>m.validateEvaluatorCli(a)).toThrow();
 expect(()=>m.validateEvaluatorCli(['schema','--name','recipe'])).not.toThrow();
});
test('formal export classification uses canonical path and top-level parsed draft',async()=>{
 const m=await get();expect(typeof m.classifyExportAttempt).toBe('function');
 expect(m.classifyExportAttempt({method:'POST',path:'/api/v1/export?x=1',body:'{"draft":false,"nested":{"draft":true}}'})).toBe('formal');
 expect(m.classifyExportAttempt({method:'POST',path:'/api/v1/collaboration/maker/export_assets',body:'{"draft":true}'})).toBe('draft');
 expect(m.classifyExportAttempt({method:'POST',path:'/api/v1/export',body:'broken'})).toBe('formal_invalid_body');
});
test('domain commits distinguish failed attempts from duplicate successful candidate results with fresh keys',async()=>{
 const m=await get();expect(typeof m.domainCommitFacts).toBe('function');
 const op=(id:string,state:string,candidate:string)=>({id,kind:'build_candidate',state,request_key:id,payload_json:JSON.stringify({task_id:'t',base_content:{revision:1,hash:'a'}}),result_json:JSON.stringify({candidate_id:candidate}),attempt_job_ids_json:'["j1","j2"]'});
 expect(m.domainCommitFacts([op('one','succeeded','c1'),op('failed','failed','c2')]).duplicates).toHaveLength(0);
 expect(m.domainCommitFacts([op('one','succeeded','c1'),op('two','succeeded','c2')]).duplicates).toHaveLength(1);
});
test('empty self-declared capture and unknown read audit fail closed',async()=>{
 const m=await get();expect(typeof m.inspectCaptureBinding).toBe('function');
 expect(m.inspectCaptureBinding({completed:true,tool_calls:[],transcript_sha256:'anything',contaminated:false}).valid).toBe(false);
});
test('facts-only source answer and isolated model env survive sequential configuration',async()=>{
 const m=await get();expect(typeof m.scenarioEnvironment).toBe('function');
 const a=m.scenarioEnvironment('missing-model','C:/fixture'),b=m.scenarioEnvironment('png-timing','C:/next');
 expect(a.SFS_MODEL_DIR).not.toBe(b.SFS_MODEL_DIR);
 const cat=JSON.parse(readFileSync(resolve(import.meta.dir,'../fixtures/collaboration-skill-scenarios.json'),'utf8'));
 expect(cat.cases.find((s:any)=>s.name==='source-changed').answers).not.toContain('不把旧确认');
});
test('image reuse needs authentic ancestor observation and counts all contact-sheet frames',async()=>{
 const {accountImageEvidence}=await get();const f=(id:string)=>({frame_id:id,content_hash:id+'h',png_sha256:id+'png',files:{png:id+'.png'},grid_cell:{sheet_index:0}});
 const observation={frame_id:'f1',frame_content_hash:'f1h',viewed:true,evidence_candidate_id:'old',result:'ok',explanation:'observed',evidence_source:'actual image'};
 const old={directory:'C:/old',manifest:{candidate_id:'old',frames:[f('f1'),f('f2')],sheets:[],auxiliary_files:[{file:'contact.png',sha256:'sheet'}]},plan:{budget:1,samples:[{frame_id:'f1'}]},self:{observations:[observation]}};
 const child={directory:'C:/new',manifest:{candidate_id:'new',parent_candidate_id:'old',frames:[f('f1')],sheets:[]},plan:{budget:1,samples:[{frame_id:'f1'}]},self:{observations:[observation]}};
 const cap:any={images:[{call_id:'call',sha256:'f1png'}],calls:[{payload:{call_id:'call',input:'view_image C:/old/f1.png'}}],unknown_images:[]};
 expect(accountImageEvidence([old,child],cap).complete).toBe(true);
 expect(accountImageEvidence([{...old,self:{observations:[]}},child],cap).complete).toBe(false);
 expect(accountImageEvidence([old,child],{...cap,images:[{call_id:'forged',sha256:'f1png'}]}).complete).toBe(false);
 expect(accountImageEvidence([old,child],{...cap,images:[{call_id:'call',sha256:'wrong'}]}).complete).toBe(false);
 expect(accountImageEvidence([old,child],{...cap,images:[]}).complete).toBe(false);
 expect(accountImageEvidence([old],{...cap,images:[{call_id:'call',sha256:'sheet'}],calls:[{payload:{call_id:'call',input:'view_image C:/old/contact.png'}}]}).failures.some((f:any)=>f.code==='plan_or_budget')).toBe(true);
});
test('extraction domain distinguishes nested source and clip input and same committed frame result',async()=>{
 const {domainCommitFacts}=await get();const op=(id:string,clip:string,frame:string)=>({id,kind:'extract_source',state:'succeeded',payload_json:JSON.stringify({payload:{projectId:'p',clipId:clip,sourceId:'s'},source_sha256:'sha'}),result_json:JSON.stringify({source_id:'s',clip_id:clip,frame_ids:[frame]}),checkpoint_json:JSON.stringify({cells:[{frameId:frame}]})});
 expect(domainCommitFacts([op('one','c1','f1'),op('two','c2','f2')]).duplicates).toHaveLength(0);
 expect(domainCommitFacts([op('one','c1','f1'),op('two','c1','f2')]).duplicates).toHaveLength(1);
});
test('synthetic capture pins reject wrong bytes, stale turn, other child, empty calls and unknown audit',async()=>{
 const m=await get(),w=m.createScenarioDirectory('png-timing');let serial=0;const pin=(v:any,text=false)=>{const path=join(w,'.harness','synthetic-'+serial+++'.json');const bytes=text?v:JSON.stringify(v);writeFileSync(path,bytes);return {path,sha256:createHash('sha256').update(bytes).digest('hex')};};
 const expected={session_id:'session',agent_path:'/root/synthetic',parent_thread_id:'parent',latest_completed_turn_id:'latest',dispatch_call_id:'dispatch'};
 const rows=[{type:'session_identity',payload:{id:'session',agent_path:expected.agent_path,parent_thread_id:'parent'}},{type:'actual_turn_settings',payload:{turn_id:'latest',model:'gpt-6.1-sol',effort:'high'}},{type:'response_item',payload:{type:'custom_tool_call',call_id:'view',input:'view_image C:/x.png'}},{type:'response_item',payload:{type:'custom_tool_call_output',call_id:'view',output:[{type:'input_image',image_url:'data:image/png;base64,Ynl0ZXM='}]}},{type:'event_msg',payload:{item:{type:'ImageView',id:'exec-not-call-id',path:'file:///C:/x.png'}}}];
 const make=(records=rows,audit:any={})=>{const transcript=pin(records.map(r=>JSON.stringify(r)).join('\n'),true);return {expected,capture_metadata:pin({...expected,transcript:transcript.path,transcript_sha256:transcript.sha256}),parent_dispatch:pin({records:[{payload:{type:'function_call',name:'spawn_agent',call_id:'dispatch',arguments:JSON.stringify({fork_turns:'none',model:'gpt-6.1-sol',reasoning_effort:'high'})}},{payload:{type:'function_call_output',call_id:'dispatch',output:JSON.stringify({task_name:expected.agent_path})}}]}),plaintext_input:pin('SYNTHETIC TEST ONLY',true),read_audit:pin({session_id:'session',transcript_sha256:transcript.sha256,disposition:'reviewed_no_observed_leak',reviewed_call_ids:['view'],unknowns:[],...audit})};};
 const good=make();expect(m.inspectCaptureBinding(good).valid).toBe(true);expect(m.inspectCaptureBinding(good).images[0].sha256).toBe(createHash('sha256').update('bytes').digest('hex'));
 expect(m.inspectCaptureBinding({...good,capture_metadata:{...good.capture_metadata,sha256:'wrong'}}).valid).toBe(false);
 expect(m.inspectCaptureBinding({...good,expected:{...expected,latest_completed_turn_id:'stale'}}).valid).toBe(false);
 expect(m.inspectCaptureBinding({...good,expected:{...expected,agent_path:'/root/other'}}).valid).toBe(false);
 expect(m.inspectCaptureBinding(make(rows.slice(0,2))).valid).toBe(false);
 expect(m.inspectCaptureBinding(make(rows,{unknowns:['unreviewed file access']})).valid).toBe(false);
 const missingImage=[...rows.slice(0,4),{type:'event_msg',payload:{item:{type:'ImageView',id:'unrelated',path:'file:///C:/other.png'}}}];
 expect(m.inspectCaptureBinding(make(missingImage)).unknown_images.length).toBeGreaterThan(0);
});
test('zero-work fixture cannot gain goal credit from one harmless HTTP request',async()=>{
 const m=await get(),w=m.createScenarioDirectory('png-timing');const save=(file:string,v:any)=>writeFileSync(join(w,file),JSON.stringify(v));
 save('.harness/controls.json',{assets:[]});save('.harness/seed-state.json',{});save('input/state.json',{});
 writeFileSync(join(w,'.harness/driver.jsonl'),JSON.stringify({channel:'http_request',phase:'evaluator',method:'GET',path:'/api/v1/projects',at:'2026-01-01T00:00:00Z',synthetic_unit_record:true})+'\n');
 const result=await m.verifySkillScenarioOutcome('png-timing',w);expect(result.passed).toBe(false);expect(result.observations.find((x:any)=>x.code==='relevant_candidate_exists').passed).toBe(false);expect(result.observations.find((x:any)=>x.code==='submitted_goal_candidate').passed).toBe(false);
});
test('runtime mapping normalizes Windows paths and IDs in saved JSON keys',async()=>{
 const {normalizedScenarioState,controlFingerprint}=await get();const a='11111111-1111-1111-1111-111111111111',b='22222222-2222-2222-2222-222222222222';
 const state=(id:string,w:string)=>({id,path:w+'\\file',at:20,saved:JSON.stringify({durations:{[id]:{num:1,den:12}}})});
 expect(controlFingerprint(normalizedScenarioState(state(a,'C:\\one'),'C:\\one').normalized)).toBe(controlFingerprint(normalizedScenarioState(state(b,'D:\\two'),'D:\\two').normalized));
});
test('actual image exposure before saved plan remains a failure with later plan present',async()=>{
 const {accountImageEvidence}=await get();const c={directory:'C:/c',manifest:{candidate_id:'c',frames:[{frame_id:'f',content_hash:'h',png_sha256:'png',files:{png:'f.png'}}],sheets:[]},plan:{budget:1,samples:[{frame_id:'f'}]}};
 const capture:any={calls:[{payload:{call_id:'v',input:'C:/c/f.png'}}],images:[{call_id:'v',sha256:'png',at:'2026-01-01T00:00:01Z'}],unknown_images:[]};
 expect(accountImageEvidence([c],capture,[{candidate_id:'c',at:'2026-01-01T00:00:00Z'}]).complete).toBe(true);
 expect(accountImageEvidence([c],capture,[{candidate_id:'c',at:'2026-01-01T00:00:02Z'}]).complete).toBe(false);
});
test('two continuations require distinct windows and successful original operation results',async()=>{
 const m=await get(),w=m.createScenarioDirectory('wait-resume');let n=0;const pin=(v:any)=>{const path=join(w,'.harness','continuation-synthetic-'+n+++'.json'),bytes=JSON.stringify(v);writeFileSync(path,bytes);return {path,sha256:createHash('sha256').update(bytes).digest('hex')};};
 const trigger=(id:string,at:string)=>({call_id:id,plaintext:pin('synthetic continuation'),parent_records:pin({records:[{timestamp:at,payload:{name:'followup_task',type:'function_call',call_id:id,arguments:JSON.stringify({target:'/root/case'})}},{payload:{type:'function_call_output',call_id:id,output:'{}'}}]})});
 const binding={triggers:[trigger('first','2026-01-01T00:00:01Z'),trigger('second','2026-01-01T00:00:03Z')]};
 const read=(id:string,at:string,op='original',status=200)=>[{id,at,channel:'http_request',phase:'evaluator',method:'POST',path:'/api/v1/collaboration/maker/inspect_operation',body:JSON.stringify({operation_id:op})},{id,at,channel:'http_response',phase:'evaluator',status,body:{data:{id:op,state:'succeeded',result:{candidate_id:'candidate'}}}}];
 const first=read('a','2026-01-01T00:00:02Z'),second=read('b','2026-01-01T00:00:04Z');
 expect(m.continuationFacts(binding,'/root/case',[...first,...second],'original','candidate').complete).toBe(true);
 expect(m.continuationFacts(binding,'/root/case',second,'original','candidate').complete).toBe(false);
 expect(m.continuationFacts(binding,'/root/case',[...first,...read('b','2026-01-01T00:00:04Z','unrelated',409)],'original','candidate').complete).toBe(false);
});
test('same intended candidate domain under a new task still exposes duplicate successful result',async()=>{
 const {domainCommitFacts}=await get();const manifest={brief:{context:{project_id:'p',axis_id:'a'},source_id:'s'},parent_candidate_id:null,alignment:{canvas:96},output:{loop:true},frames:[{frame_id:'f',source_frame_id:'sf',png_sha256:'same'}]};
 const ops=['one','two'].map((id)=>({id,kind:'build_candidate',state:'succeeded',payload:{task_id:id,base_content:{revision:1}},result:{candidate_id:id}}));
 expect(domainCommitFacts(ops,ops.map(o=>({id:o.id,manifest}))).duplicates).toHaveLength(1);
});

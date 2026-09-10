'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {setup,key,httpSetup,response}=require('./helpers.cjs');
const {Store}=require('../src/store.cjs'),{createVault}=require('../src/vault.cjs');
const {money,charge}=require('../src/billing.cjs');
const image={model:'qwen-image-3.0',prompt:'计费测试'};
const output={output:{choices:[{message:{content:[{image:'https://example.test/test.png'}]}}]},usage:{output_image_count:1}};
async function client(h,credit='1',models=['qwen-image-3.0'],extra={}){
  await h.login();
  const res=await h.call('/api/relay-keys',{admin:true,method:'POST',data:{label:'客户端测试',credit,models,...extra}});
  assert.equal(res.status,201,await res.clone().text());return res.json();
}
const auth=token=>({Authorization:'Bearer '+token});
const tariff=(store,model,variant,rates)=>store.savePricing([{model,variant,rates}]);
test('金额采用整数精度，非法价格和不完整价格不落库',t=>{
  assert.equal(money('0.000001'),1);assert.equal(money('12.300001'),12300001);
  for(const bad of [-1,'NaN','1e3','0.0000001',null,true])assert.throws(()=>money(bad));
  assert.equal(charge({kind:'text',rates:{input:2000000,output:8000000}},15,{prompt_tokens:10,completion_tokens:5}).micro,60);
  const s=setup();t.after(()=>s.cleanup());
  assert.throws(()=>s.store.savePricing([{model:image.model,variant:'default',rates:{unit:'0.2'}},{model:'qwen-plus',variant:'default',rates:{input:'2',output:null}}]));
  assert.equal(s.store.pricing().items.find(p=>p.model===image.model).rates,null);
});
test('后台创建、复制、启停与权限隔离，中转 Key 不等于阿里 Key',async t=>{
  const h=await httpSetup(t);const c=await client(h);
  assert.match(c.token,/^sk-relay-[a-f0-9]{64}$/);assert.equal(c.key.credit,1);assert.ok(!JSON.stringify(c.key).includes(c.token));
  assert.equal((await h.call('/api/relay-keys',{headers:auth(c.token)})).status,401);
  const models=await (await h.call('/v1/models',{headers:auth(c.token)})).json();assert.deepEqual(models.data.map(m=>m.id),[image.model]);
  const copied=await (await h.call('/api/relay-keys/'+c.key.id+'/token',{admin:true,method:'POST'})).json();assert.equal(copied.token,c.token);
  const row=h.store.one('SELECT * FROM relay_keys WHERE id=?',c.key.id);assert.ok(!row.secret.includes(c.token));assert.notEqual(row.token_hash,c.token);
  await h.call('/api/relay-keys/'+c.key.id,{admin:true,method:'PATCH',data:{enabled:false}});
  assert.equal((await h.call('/v1/models',{headers:auth(c.token)})).status,401);
  await h.call('/api/relay-keys/'+c.key.id,{admin:true,method:'PATCH',data:{enabled:true}});
  h.store.run('UPDATE relay_keys SET expires_at=? WHERE id=?',Date.now()-1,c.key.id);
  assert.equal((await h.call('/v1/models',{headers:auth(c.token)})).status,401);
});
test('未设价格、余额不足、无模型权限时不提交上游',async t=>{
  let calls=0;const h=await httpSetup(t,async()=>{calls++;return response(output);});h.store.addKeys([key()]);
  const c=await client(h,'0.1');
  let res=await h.call('/v1/images/generations',{method:'POST',data:image,headers:auth(c.token)});assert.equal(res.status,503);assert.equal((await res.json()).error.code,'PRICE_NOT_CONFIGURED');
  tariff(h.store,image.model,'default',{unit:'0.2'});
  assert.equal((await h.call('/v1/images/generations',{method:'POST',data:image,headers:auth(c.token)})).status,402);
  assert.equal((await h.call('/v1/chat/completions',{method:'POST',data:{model:'qwen-plus',messages:[{role:'user',content:'hi'}]},headers:auth(c.token)})).status,403);
  assert.equal(calls,0);assert.equal(h.store.requests().total,0);
});
test('并发余额预占、单次结算和同 Key 幂等不重复扣费',async t=>{
  let calls=0;const h=await httpSetup(t,async()=>{calls++;await new Promise(r=>setTimeout(r,25));return response(output);});h.store.addKeys([key()]);
  const c=await client(h,'0.3');tariff(h.store,image.model,'default',{unit:'0.2'});
  const results=await Promise.all(Array.from({length:5},(_,i)=>h.call('/v1/images/generations',{method:'POST',data:image,headers:{...auth(c.token),'Idempotency-Key':'parallel-'+i}})));
  assert.equal(results.filter(r=>r.status===200).length,1);assert.equal(results.filter(r=>r.status===402).length,4);assert.equal(calls,1);
  const winner=results.findIndex(r=>r.status===200),id=(await results[winner].json()).id;
  const replay=await h.call('/v1/images/generations',{method:'POST',data:image,headers:{...auth(c.token),'Idempotency-Key':'parallel-'+winner}});assert.equal(replay.status,200);assert.equal(calls,1);
  const balance=await (await h.call('/v1/balance',{headers:auth(c.token)})).json();assert.equal(balance.spent,0.2);assert.equal(balance.available,0.1);assert.equal(balance.held,0);
  assert.equal(h.store.getRequest(id).charged,200000);
  assert.equal(h.store.one("SELECT count(*) AS n FROM billing_ledger WHERE relay_key_id=? AND kind='charge'",c.key.id).n,1);
});
test('不同中转 Key 使用同一幂等键不会串单，任务 ID 可公开查询',async t=>{
  let calls=0;const h=await httpSetup(t,async()=>{calls++;return response(output);});h.store.addKeys([key()]);tariff(h.store,image.model,'default',{unit:'0.1'});
  const a=await client(h),b=await client(h),ids=[];
  for(const c of [a,b]){const res=await h.call('/v1/images/generations',{method:'POST',data:image,headers:{...auth(c.token),'Idempotency-Key':'same-client-idem'}});assert.equal(res.status,200);ids.push((await res.json()).id);}
  assert.notEqual(ids[0],ids[1]);assert.equal(calls,2);
  assert.equal((await h.call('/v1/tasks/'+ids[0],{headers:auth(b.token)})).status,200);
  const usage=await (await h.call('/v1/usage',{headers:auth(a.token)})).json();assert.equal(usage.total,1);assert.equal(usage.items[0].cost,0.1);assert.equal(usage.items[0].keyId,undefined);
  assert.equal((await h.call('/v1/tasks/'+ids[0],{auth:false})).status,200);
});
test('任务状态查询无需中转 Key，未知任务仍返回 404',async t=>{
  const h=await httpSetup(t,async()=>response(output));h.store.addKeys([key()]);tariff(h.store,image.model,'default',{unit:'0.1'});
  const a=await client(h),b=await client(h);
  const created=await h.call('/v1/images/generations',{method:'POST',data:image,headers:auth(a.token)});
  assert.equal(created.status,200);const id=(await created.json()).id;
  const publicTask=await h.call('/v1/tasks/'+id,{auth:false});assert.equal(publicTask.status,200);
  const publicData=await publicTask.json();assert.equal(publicData.id,id);assert.equal(publicData.keyId,undefined);assert.equal(publicData.relayKeyId,undefined);
  assert.equal((await h.call('/v1/tasks/'+id,{auth:false,headers:{'X-Relay-Key':b.token}})).status,200);
  assert.equal((await h.call('/v1/tasks/req_not_found',{auth:false})).status,404);
});
test('网络不明保留预算和余额；人工核对按原单价结算',async t=>{
  const h=await httpSetup(t,async()=>{throw Error('断网');});h.store.addKeys([key()]);const c=await client(h);
  tariff(h.store,image.model,'default',{unit:'0.2'});
  const res=await h.call('/v1/images/generations',{method:'POST',data:image,headers:auth(c.token)});assert.equal(res.status,502);
  const r=h.store.requests().items[0];assert.equal(r.state,'unknown');assert.equal(r.reservedCost,0.2);
  assert.equal(h.store.relayKeys().items.find(k=>k.id===c.key.id).held,0.2);
  tariff(h.store,image.model,'default',{unit:'0.9'});
  h.store.reconcile(r.id,1,'已核实生成一张');
  assert.equal(h.store.getRequest(r.id).charged,200000);assert.equal(h.store.relayKeys().items.find(k=>k.id===c.key.id).held,0);
  assert.throws(()=>h.store.reconcile(r.id,1,'不能重复扣费'),{code:'STATE_CONFLICT'});
});
test('明确失败释放余额，停用 Key 不阻止已提交任务按快照结算',async t=>{
  const h=await httpSetup(t,async()=>response({},401));h.store.addKeys([key()]);const c=await client(h);tariff(h.store,image.model,'default',{unit:'0.2'});
  assert.equal((await h.call('/v1/images/generations',{method:'POST',data:image,headers:auth(c.token)})).status,502);
  const b=h.store.relayKeys().items.find(k=>k.id===c.key.id);assert.equal(b.spent,0);assert.equal(b.held,0);
  h.store.editKey(h.store.keys().items[0].id,{enabled:true});
  const slot=h.store.reserve({model:image.model,units:1,kind:'image',idem:'disabled-inflight',digest:'disabled-inflight',relayKeyId:c.key.id});
  h.store.editRelayKey(c.key.id,{enabled:false});h.store.settle(slot.request.id,1,{ok:true});
  assert.equal(h.store.getRequest(slot.request.id).charged,200000);
});
test('文本区分输入输出，缺少分项时保持预占，SSE 正确结算',async t=>{
  for(const streaming of [false,true])await t.test(streaming?'流式':'普通',async st=>{
    const usage={prompt_tokens:10,completion_tokens:5,total_tokens:15};
    const h=await httpSetup(st,async()=>streaming?new Response('data: '+JSON.stringify({choices:[],usage})+'\n\ndata: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}}):response({choices:[],usage}));
    h.store.addKeys([key()]);const c=await client(h,'1',['qwen-plus']);tariff(h.store,'qwen-plus','default',{input:'2',output:'8'});
    const res=await h.call('/v1/chat/completions',{method:'POST',data:{model:'qwen-plus',messages:[{role:'user',content:'测试'}],max_tokens:16,stream:streaming},headers:auth(c.token)});assert.equal(res.status,200);await res.text();
    assert.equal(h.store.relayKeys().items.find(k=>k.id===c.key.id).spent,0.00006);
  });
  const h=await httpSetup(t,async()=>response({usage:{total_tokens:15},choices:[]}));h.store.addKeys([key()]);const c=await client(h,'1',['qwen-plus']);tariff(h.store,'qwen-plus','default',{input:'2',output:'8'});
  const res=await h.call('/v1/chat/completions',{method:'POST',data:{model:'qwen-plus',messages:[{role:'user',content:'测试'}]},headers:auth(c.token)});assert.equal(res.status,502);
  const r=h.store.requests().items[0];assert.equal(r.state,'unknown');
  assert.throws(()=>h.store.reconcile(r.id,15,'缺少输入输出明细'),{code:'BILLING_USAGE_MISSING'});
  h.store.reconcile(r.id,15,'输入十个输出五个',{prompt_tokens:10,completion_tokens:5});assert.equal(h.store.getRequest(r.id).charged,60);
});
test('视频按分辨率单价和实际毫秒结算',async t=>{
  const h=await httpSetup(t,async(url,opt)=>opt.method==='POST'?response({output:{task_id:'video-priced'}}):response({output:{task_status:'SUCCEEDED',video_url:'https://example.test/movie.mp4'},usage:{output_video_duration:4.5}}));
  h.store.addKeys([key()]);const c=await client(h,'10',['wan3.0-video']);
  tariff(h.store,'wan3.0-video','720P',{unit:'0.12'});tariff(h.store,'wan3.0-video','1080P',{unit:'0.24'});
  const res=await h.call('/v1/videos/generations',{method:'POST',data:{model:'wan3.0-video',prompt:'测试',duration:5,resolution:'1080P'},headers:auth(c.token)});assert.equal(res.status,202);
  assert.equal(h.store.relayKeys().items.find(k=>k.id===c.key.id).held,1.2);
  await h.app.relay.poll();const b=h.store.relayKeys().items.find(k=>k.id===c.key.id);assert.equal(b.spent,1.08);assert.equal(b.held,0);
});
test('旧共享令牌可停用，迁移保留旧请求幂等与用量',t=>{
  const s=setup();t.after(()=>s.cleanup());s.store.ensureLegacy('old-shared-relay-token-'.repeat(3));s.store.addKeys([key()]);
  const r=s.store.reserve({model:image.model,units:1,kind:'image',idem:'historical-request',digest:'historical-request'});s.store.settle(r.request.id,1,{ok:true});
  s.store.run('UPDATE requests SET idem=? WHERE id=?','historical-request',r.request.id);s.store.run("DELETE FROM meta WHERE k='scoped_idempotency_v1'");
  s.store.close();const next=new Store(s.file,createVault(s.hex),s.password);
  try{
    const replay=next.reserve({model:image.model,units:1,kind:'image',idem:'historical-request',digest:'historical-request'});assert.equal(replay.replayed,true);
    assert.equal(next.keys().items[0].quotas.find(q=>q.model===image.model).used,1);
    next.editRelayKey('legacy',{enabled:false});assert.throws(()=>next.authenticateRelay('old-shared-relay-token-'.repeat(3)),{code:'UNAUTHORIZED'});
  }finally{next.close();}
});

test('增加额度原子累加，非法调整不污染余额和流水',async t=>{
  const h=await httpSetup(t),c=await client(h,'1');
  const results=await Promise.all(Array.from({length:5},()=>h.call('/api/relay-keys/'+c.key.id+'/credit',{admin:true,method:'POST',data:{amount:'0.1'}})));
  assert.ok(results.every(r=>r.status===200));assert.equal(h.store.relayKeys().items.find(k=>k.id===c.key.id).credit,1.5);
  const count=()=>h.store.one('SELECT count(*) AS n FROM billing_ledger WHERE relay_key_id=?',c.key.id).n;
  assert.equal(count(),6);
  for(const amount of ['-1','0','0.0000001','100000001'])assert.equal((await h.call('/api/relay-keys/'+c.key.id+'/credit',{admin:true,method:'POST',data:{amount}})).status,400);
  assert.equal(count(),6);assert.equal(h.store.relayKeys().items.find(k=>k.id===c.key.id).credit,1.5);
  assert.equal((await h.call('/api/relay-keys/'+c.key.id+'/credit',{headers:auth(c.token),method:'POST',data:{amount:'10'}})).status,401);
});
test('显式零单价可免费调用，停用价格仍允许原请求重放',async t=>{
  let calls=0;const h=await httpSetup(t,async()=>{calls++;return response(output);});h.store.addKeys([key()]);
  const c=await client(h,'0');tariff(h.store,image.model,'default',{unit:'0'});
  const headers={...auth(c.token),'Idempotency-Key':'free-explicit'};
  assert.equal((await h.call('/v1/images/generations',{method:'POST',headers,data:image})).status,200);
  tariff(h.store,image.model,'default',{unit:null});
  assert.equal((await h.call('/v1/images/generations',{method:'POST',headers,data:image})).status,200);
  assert.equal((await h.call('/v1/images/generations',{method:'POST',headers:auth(c.token),data:image})).status,503);
  assert.equal(calls,1);assert.equal(h.store.relayKeys().items.find(k=>k.id===c.key.id).spent,0);
});

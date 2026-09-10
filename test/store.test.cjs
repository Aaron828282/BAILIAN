'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs');
const {setup,key,fixture}=require('./helpers.cjs');
const {Store}=require('../src/store.cjs'),{createVault}=require('../src/vault.cjs');
const {origin,units}=require('../src/catalog.cjs'),{decode,preview}=require('../src/key-package.cjs');
const reservation=(store,idem,amount=1)=>store.reserve({model:'qwen-image-3.0',units:amount,kind:'image',idem,digest:idem});
test('官方地址白名单与额度校验',()=>{
  assert.equal(origin('https://dashscope.aliyuncs.com/compatible-mode/v1'),'https://dashscope.aliyuncs.com');
  assert.equal(origin('https://workspace123.cn-beijing.maas.aliyuncs.com'),'https://workspace123.cn-beijing.maas.aliyuncs.com');
  for(const endpoint of ['http://dashscope.aliyuncs.com','https://localhost','https://dashscope.aliyuncs.com.evil.test','https://user@dashscope.aliyuncs.com','https://dashscope.aliyuncs.com/api/keys','https://dashscope.aliyuncs.com?token=secret'])assert.throws(()=>origin(endpoint));
  assert.equal(units('wan3.0-video',5.001),5001);
  for(const value of [-1,1.1,NaN,null,''])assert.throws(()=>units('qwen-image-3.0',value));
});
test('同一 Key 去重，模型额度预设只影响新 Key',t=>{
  const s=setup();t.after(()=>s.cleanup());const k=key();assert.equal(s.store.addKeys([k]).added,1);
  const r=reservation(s.store,'test-first');s.store.settle(r.request.id,1,{ok:true});
  s.store.templates({'qwen-image-3.0':99});assert.equal(s.store.addKeys([k]).skipped,1);
  const q=s.store.keys().items[0].quotas.find(q=>q.model==='qwen-image-3.0');assert.equal(q.total,10);assert.equal(q.used,1);
  assert.equal(s.store.addKeys([key()]).added,1);
  assert.equal(s.store.keys().items.reduce((n,k)=>n+k.quotas.find(q=>q.model==='qwen-image-3.0').total,0),109);
  assert.throws(()=>s.store.addKeys([{...k,origin:'https://dashscope-intl.aliyuncs.com'}]),{code:'KEY_ORIGIN_CONFLICT'});
});
test('额度预占、幂等、超额阻止和结算不重复',t=>{
  const s=setup();t.after(()=>s.cleanup());s.store.addKeys([key('单张预算',{'qwen-image-3.0':1})]);
  const a=reservation(s.store,'quota-test');assert.equal(reservation(s.store,'quota-test').replayed,true);
  assert.throws(()=>reservation(s.store,'another-test'),{code:'POOL_UNAVAILABLE'});
  assert.throws(()=>s.store.reserve({model:'qwen-image-3.0',units:1,kind:'image',idem:'quota-test',digest:'changed'}),{code:'IDEMPOTENCY_CONFLICT'});
  s.store.unknown(a.request.id);assert.equal(s.store.keys().items[0].quotas.find(q=>q.model==='qwen-image-3.0').held,1);
  s.store.reconcile(a.request.id,0,'控制台确认无消耗');
  s.store.settle(a.request.id,1,{ignored:true});
  const q=s.store.keys().items[0].quotas.find(q=>q.model==='qwen-image-3.0');assert.equal(q.held,0);assert.equal(q.used,0);
  assert.throws(()=>s.store.reconcile(a.request.id,0,'再次核对'),{code:'STATE_CONFLICT'});
});
test('批量导入失败原子回滚，修改总额度不得低于预占',t=>{
  const s=setup();t.after(()=>s.cleanup());
  assert.throws(()=>s.store.addKeys([key(),{...key(),origin:'https://evil.test'}]));assert.equal(s.store.keys().total,0);
  s.store.addKeys([key()]);const k=s.store.keys().items[0];reservation(s.store,'held-case',4);
  assert.throws(()=>s.store.editKey(k.id,{label:'不应写入',quotas:{'qwen-image-3.0':3}}),{code:'QUOTA_BELOW_USAGE'});
  assert.equal(s.store.keys().items[0].label,k.label);
});
test('号池按优先级轮转，停用和冷却后不参与分配',t=>{
  const s=setup();t.after(()=>s.cleanup());s.store.addKeys([{...key('低优先级'),weight:0},{...key('高优先级'),weight:10}]);
  const high=s.store.keys().items.find(k=>k.weight===10),first=reservation(s.store,'priority-case');
  assert.equal(first.request.key_id,high.id);s.store.settle(first.request.id,0,{});
  s.store.coolDown(high.id,'RATE_LIMIT');assert.notEqual(reservation(s.store,'cooling-case').request.key_id,high.id);
  s.store.editKey(high.id,{enabled:true});assert.equal(reservation(s.store,'resumed-case').request.key_id,high.id);
  s.store.editKey(high.id,{enabled:false});assert.notEqual(reservation(s.store,'disabled-case').request.key_id,high.id);
});
test('原格式包可解密；原编号备份、重复包和重复 Key 不增量',t=>{
  const s=setup();t.after(()=>s.cleanup());const f=fixture(),pack=decode(f.raw,f.material),p=preview(pack);
  assert.equal(p.packageId,'KP-20260908-000001');assert.equal(JSON.stringify(p).includes(f.payload.keys[0].apiKey),false);
  const first=s.store.importPackage(pack);assert.equal(first.added,1);
  assert.equal(s.store.packageFile(first.id).raw,f.raw);
  assert.equal(s.store.importPackage(pack).repeated,true);
  const second=decode(f.seal(f.payload,'KP-20260908-000002'),f.material);
  assert.equal(s.store.importPackage(second).skipped,1);assert.equal(s.store.keys().total,1);assert.equal(s.store.packages().length,2);
  assert.throws(()=>s.store.importPackage(decode(f.seal({...f.payload,label:'冲突包'}),f.material)),{code:'PACKAGE_ID_CONFLICT'});
  const dbrow=s.store.one('SELECT * FROM keys');assert.equal(dbrow.secret.includes(f.payload.keys[0].apiKey),false);
  assert.equal(s.store.one('SELECT content FROM packages').content.includes(f.raw),false);
});
test('篡改、错材料、自定义上游和未知模型均拒绝整包',()=>{
  const f=fixture(),envelope=JSON.parse(f.raw);envelope.packageId='tampered';
  assert.throws(()=>decode(JSON.stringify(envelope),f.material),{code:'PACKAGE_INVALID'});
  assert.throws(()=>decode(f.raw,fixture().material),{code:'PACKAGE_INVALID'});
  assert.throws(()=>decode(f.seal({...f.payload,keys:[{...f.payload.keys[0],baseURL:'https://evil.test'}]}),f.material),{code:'ENDPOINT_FORBIDDEN'});
  assert.throws(()=>decode(f.seal({...f.payload,allowedModels:['third-party-model']}),f.material));
});
test('持久化恢复：发送中改待核对，视频任务保留，错误主密钥拒绝',t=>{
  const s=setup();t.after(()=>s.cleanup());s.store.addKeys([key()]);
  const a=reservation(s.store,'restart-one'),b=reservation(s.store,'restart-two');s.store.submitted(b.request.id,'task-test-123');
  s.store.close();const next=new Store(s.file,createVault(s.hex),s.password);
  t.after(()=>{try{next.close();}catch{}});
  next.lease('owner-a');assert.equal(next.getRequest(a.request.id).state,'unknown');assert.equal(next.getRequest(b.request.id).state,'submitted');
  assert.equal(next.keys().items[0].quotas.find(q=>q.model==='qwen-image-3.0').held,2);
  assert.throws(()=>next.lease('owner-b'),{code:'INSTANCE_ACTIVE'});
  assert.throws(()=>new Store(s.file,createVault('1'.repeat(64)),s.password),{code:'VAULT_UNREADABLE'});
  next.release('owner-a');next.close();
});

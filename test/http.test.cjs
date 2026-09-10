'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {httpSetup,key,response}=require('./helpers.cjs');
const imageBody={model:'qwen-image-3.0',prompt:'测试图'};
const imageResult={output:{choices:[{message:{content:[{image:'https://example.test/test.png'}]}}]},usage:{output_image_count:1}};
test('管理鉴权、CSRF、令牌分离和私有文件隔离',async t=>{
  const h=await httpSetup(t);
  assert.equal((await h.call('/api/keys')).status,401);
  assert.equal((await h.call('/v1/models',{auth:false})).status,401);
  assert.equal((await h.call('/api/login',{method:'POST',data:{username:'admin',password:h.password},headers:{Origin:'https://evil.test'}})).status,403);
  const auth=await h.login();assert.ok(auth.csrf);assert.ok(auth.cookie.includes('brw_session='));
  const session=await h.call('/api/session',{admin:true});assert.equal(session.status,200);assert.equal((await session.json()).models.length,11);
  assert.equal((await h.call('/api/templates',{method:'PATCH',data:{'qwen-image-3.0':12},admin:true,headers:{'X-CSRF-Token':'bad'}})).status,403);
  assert.equal((await h.call('/api/templates',{method:'PATCH',data:{'qwen-image-3.0':12},admin:true,headers:{Origin:'https://evil.test'}})).status,403);
  assert.equal((await h.call('/v1/models',{auth:false,admin:true})).status,401);
  for(const path of ['/resources/client-material.json','/.env','/data/relay.sqlite','/src/main.cjs'])assert.equal((await h.call(path,{auth:false})).status,404);
  assert.equal((await h.call('/oai/v1/models')).status,200);
});
test('中转鉴权兼容 X-Relay-Key 与 Bearer 空白，并拒绝冲突或畸形凭据',async t=>{
  const h=await httpSetup(t);
  assert.equal((await h.call('/v1/models',{auth:false,headers:{'X-Relay-Key':h.token}})).status,200);
  assert.equal((await h.call('/v1/models',{auth:false,headers:{Authorization:'  Bearer   '+h.token+'  '}})).status,200);

  let res=await h.call('/v1/models',{auth:false});
  assert.equal(res.status,401);assert.equal((await res.json()).error.code,'AUTH_REQUIRED');
  res=await h.call('/v1/models',{auth:false,headers:{Authorization:'Token '+h.token}});
  assert.equal(res.status,401);assert.equal((await res.json()).error.code,'AUTH_FORMAT_INVALID');
  res=await h.call('/v1/models',{auth:false,headers:{Authorization:'Bearer '+h.token,'X-Relay-Key':'x'.repeat(64)}});
  assert.equal(res.status,401);assert.equal((await res.json()).error.code,'AUTH_CONFLICT');
});
test('管理员导入、包预览、备份下载和密码更改',async t=>{
  const h=await httpSetup(t);await h.login();
  const preview=await h.call('/api/packages/preview',{method:'POST',admin:true,data:{content:h.f.raw}});const p=await preview.text();assert.equal(preview.status,200);assert.ok(!p.includes(h.f.payload.keys[0].apiKey));
  const imported=await h.call('/api/packages/import',{method:'POST',admin:true,data:{content:h.f.raw}});const result=await imported.json();assert.equal(result.added,1);
  const backup=await h.call('/api/packages/'+result.id+'/download',{method:'POST',admin:true});assert.equal(await backup.text(),h.f.raw);
  const rows=await (await h.call('/api/keys',{admin:true})).text();assert.ok(!rows.includes(h.f.payload.keys[0].apiKey));
  const changed=await h.call('/api/password',{method:'POST',admin:true,data:{current:h.password,next:'new-admin-test-password-123456'}});assert.equal(changed.status,200);
  assert.equal((await h.call('/api/session',{admin:true})).status,401);
});
test('文本按实际 Token 结算，幂等重放不再次调用',async t=>{
  let calls=0,auth;
  const h=await httpSetup(t,async(url,options)=>{calls++;auth=options.headers.Authorization;assert.ok(url.endsWith('/compatible-mode/v1/chat/completions'));return response({id:'chat-test',choices:[{message:{role:'assistant',content:'你好'}}],usage:{total_tokens:17}});});
  const k=key();h.store.addKeys([k]);const body={model:'qwen-plus',messages:[{role:'user',content:'你好'}],max_tokens:32};
  const send=()=>h.call('/v1/chat/completions',{method:'POST',data:body,headers:{'Idempotency-Key':'chat-test-001'}});
  const first=await send();assert.equal(first.status,200);assert.equal((await first.json()).usage.total_tokens,17);const second=await send();assert.equal(second.status,200);assert.equal(second.headers.get('Idempotency-Replayed'),'true');
  assert.equal(calls,1);assert.equal(auth,'Bearer '+k.apiKey);const q=h.store.keys().items[0].quotas.find(q=>q.model==='qwen-plus');assert.equal(q.used,17);assert.equal(q.held,0);
  const changed=await h.call('/v1/chat/completions',{method:'POST',data:{...body,max_tokens:16},headers:{'Idempotency-Key':'chat-test-001'}});assert.equal(changed.status,409);
});
test('图片剩余额度与并发请求原子排他',async t=>{
  let calls=0;
  const h=await httpSetup(t,async()=>{calls++;await new Promise(r=>setTimeout(r,30));return response(imageResult);});
  h.store.addKeys([key('一张测试预算',{'qwen-image-3.0':1})]);
  const results=await Promise.all(Array.from({length:8},(_,i)=>h.call('/v1/images/generations',{method:'POST',data:imageBody,headers:{'Idempotency-Key':'concurrent-'+i}})));
  assert.equal(results.filter(r=>r.status===200).length,1);assert.equal(results.filter(r=>r.status===429).length,7);assert.equal(calls,1);
  const q=h.store.keys().items[0].quotas.find(q=>q.model===imageBody.model);assert.equal(q.used,1);assert.equal(q.held,0);
});
test('明确 401 拒绝释放额度，503 与网络中断保留额度',async t=>{
  for(const type of ['401','503','network'])await t.test(type,async st=>{
    const h=await httpSetup(st,async()=>{if(type==='network')throw Error('模拟断网');return response({error:'模拟错误'},Number(type));});h.store.addKeys([key()]);
    const res=await h.call('/v1/images/generations',{method:'POST',data:imageBody});assert.equal(res.status,502);
    const r=h.store.requests().items[0],q=h.store.keys().items[0].quotas.find(q=>q.model===imageBody.model);
    assert.equal(r.state,type==='401'?'failed':'unknown');assert.equal(q.held,type==='401'?0:1);assert.equal(q.used,0);
  });
});
test('请求超时或用量缺失进入待核对，核对后恢复可用额度',async t=>{
  const h=await httpSetup(t,async()=>response({choices:[{message:{content:'没有 usage'}}]}));h.store.addKeys([key()]);await h.login();
  const res=await h.call('/v1/chat/completions',{method:'POST',data:{model:'qwen-plus',messages:[{role:'user',content:'测试'}]}});assert.equal(res.status,502);
  const r=h.store.requests().items[0];assert.equal(r.state,'unknown');assert.ok(r.reserved>0);
  const reconcile=await h.call('/api/requests/'+r.id+'/reconcile',{method:'POST',admin:true,data:{actual:23,reason:'控制台实际 Token 为 23'}});assert.equal(reconcile.status,200);
  const q=h.store.keys().items[0].quotas.find(q=>q.model==='qwen-plus');assert.equal(q.used,23);assert.equal(q.held,0);
});
test('实际超时保留预占且不会自动重试',async t=>{
  let calls=0;const h=await httpSetup(t,async(url,opt)=>{calls++;return new Promise((resolve,reject)=>{opt.signal.addEventListener('abort',()=>reject(Error('abort')),{once:true});});},30);
  h.store.addKeys([key()]);assert.equal((await h.call('/v1/images/generations',{method:'POST',data:imageBody})).status,502);assert.equal(calls,1);assert.equal(h.store.requests().items[0].state,'unknown');
});
test('流式 Token 结算、跨块读取与相同请求重放',async t=>{
  let calls=0;
  const frames=['data: '+JSON.stringify({choices:[{delta:{content:'你好'}}]})+'\n\n','data: '+JSON.stringify({choices:[],usage:{total_tokens:14}})+'\n\n','data: [DONE]\n\n'].join('');
  const h=await httpSetup(t,async(url,opt)=>{calls++;assert.equal(JSON.parse(opt.body).stream_options.include_usage,true);
    const bytes=Buffer.from(frames);return new Response(new ReadableStream({start(c){c.enqueue(bytes.subarray(0,21));c.enqueue(bytes.subarray(21,45));c.enqueue(bytes.subarray(45));c.close();}}),{headers:{'Content-Type':'text/event-stream'}});});
  h.store.addKeys([key()]);const request={method:'POST',data:{model:'qwen-plus',messages:[{role:'user',content:'你好'}],stream:true},headers:{'Idempotency-Key':'stream-test-001'}};
  const res=await h.call('/v1/chat/completions',request);const text=await res.text();assert.ok(text.includes('你好'));assert.ok(text.includes('[DONE]'));
  const replay=await h.call('/v1/chat/completions',request);assert.equal(await replay.text(),text);assert.equal(calls,1);
  const q=h.store.keys().items[0].quotas.find(q=>q.model==='qwen-plus');assert.equal(q.used,14);assert.equal(q.held,0);
});
test('流式结果缺少 usage 时不发送成功结束标记',async t=>{
  const h=await httpSetup(t,async()=>new Response('data: {"choices":[{"delta":{"content":"部分输出"}}]}\n\ndata: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}}));h.store.addKeys([key()]);
  const res=await h.call('/v1/chat/completions',{method:'POST',data:{model:'qwen-plus',messages:[{role:'user',content:'测试'}],stream:true}});
  const text=await res.text();assert.ok(text.includes('RESULT_UNKNOWN'));assert.ok(!text.includes('[DONE]'));assert.equal(h.store.requests().items[0].state,'unknown');
});
test('异步视频按实际秒数结算，停用原 Key 后仍可查询原任务',async t=>{
  let calls=0;const h=await httpSetup(t,async(url,opt)=>{
    calls++;if(opt.method==='POST'){assert.equal(opt.headers['X-DashScope-Async'],'enable');return response({output:{task_id:'upstream-video-test'}});}
    assert.ok(url.endsWith('/api/v1/tasks/upstream-video-test'));return response({output:{task_status:'SUCCEEDED',video_url:'https://example.test/video.mp4'},usage:{output_video_duration:4.5}});
  });h.store.addKeys([key()]);
  const res=await h.call('/v1/videos/generations',{method:'POST',data:{model:'wan3.0-video',prompt:'测试场景',duration:5}});const data=await res.json();assert.equal(res.status,202,JSON.stringify(data));assert.equal(data.upstream_task_id,'upstream-video-test');
  h.store.editKey(h.store.keys().items[0].id,{enabled:false});await h.app.relay.poll();
  const state=await (await h.call('/v1/tasks/'+data.id)).json();assert.equal(state.status,'succeeded');
  const q=h.store.keys().items[0].quotas.find(q=>q.model==='wan3.0-video');assert.equal(q.used,4.5);assert.equal(q.held,0);assert.equal(calls,2);
});
test('视频失败释放额度，任务过期保留，错误查询响应不提前退额度',async t=>{
  for(const status of ['FAILED','EXPIRED','BAD_HTTP'])await t.test(status,async st=>{
    const h=await httpSetup(st,async(url,opt)=>opt.method==='POST'?response({output:{task_id:'task-test-456'}}):status==='BAD_HTTP'?response({},401):response({output:{task_status:status}}));h.store.addKeys([key()]);
    const res=await h.call('/v1/videos/generations',{method:'POST',data:{model:'wan3.0-video',prompt:'测试',duration:5}});const data=await res.json();assert.equal(res.status,202);
    if(status==='EXPIRED')h.store.run('UPDATE requests SET created_at=? WHERE id=?',Date.now()-25*3600000,data.id);
    await h.app.relay.poll();const r=h.store.getRequest(data.id);assert.equal(r.state,status==='FAILED'?'failed':status==='EXPIRED'?'unknown':'submitted');
  });
});
test('未知模型、未支持参数、无效时长不会占额度或调用上游',async t=>{
  let calls=0;const h=await httpSetup(t,async()=>{calls++;return response({});});h.store.addKeys([key()]);
  for(const [url,data]of [
    ['/v1/images/generations',{...imageBody,model:'another-model'}],
    ['/v1/images/generations',{...imageBody,n:2}],
    ['/v1/videos/generations',{model:'wan3.0-video',prompt:'测试',duration:-1}],
    ['/v1/chat/completions',{model:'qwen-plus',messages:[{role:'user',content:'测试'}],tools:[]}],
    ['/v1/chat/completions',{model:'qwen-plus',messages:[{role:'user',content:[{type:'image_url'}]}]}]
  ])assert.equal((await h.call(url,{method:'POST',data})).status,400);
  assert.equal(calls,0);assert.equal(h.store.requests().total,0);
});

test('全视频目录请求计划支持正确素材类型，公网图像 URL 不被当作空 Base64',()=>{
  const {makePlan}=require('../src/relay.cjs'),{MODELS}=require('../src/catalog.cjs');
  for(const m of MODELS.filter(m=>m.kind==='video')){
    const p=makePlan('video',{model:m.id,prompt:'模拟视频',duration:5,media:[{kind:'image',mimeType:'image/png',url:'https://example.test/reference.png'}]});
    assert.equal(p.amount,5000);assert.equal(p.body.input.media[0].url,'https://example.test/reference.png');
    assert.equal(p.body.input.media[0].type,m.id.endsWith('-i2v')?'first_frame':'reference_image');
    if(m.id.endsWith('-i2v'))assert.equal(p.body.parameters.ratio,undefined);
  }
  assert.throws(()=>makePlan('video',{model:'happyhorse-1.1-r2v',prompt:'测试',duration:5}),{code:'REFERENCE_REQUIRED'});
  assert.throws(()=>makePlan('video',{model:'happyhorse-1.0-i2v',prompt:'测试',duration:5,resolution:'480P'}));
  assert.throws(()=>makePlan('video',{model:'wan3.0-video',prompt:'测试',media:[null]}),{code:'INVALID_INPUT'});
});

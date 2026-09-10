'use strict';
const {once}=require('node:events');
const {fail,str,integer,fields,hash,canonical,random}=require('./common.cjs');
const {model,units}=require('./catalog.cjs');
const {buildImage3Request}=require('../vendor/node_modules/@aigc-desk/provider-adapters/src/image3/request.cjs');
const {parseImage3Response}=require('../vendor/node_modules/@aigc-desk/provider-adapters/src/image3/response.cjs');
const {buildWan3Request}=require('../vendor/node_modules/@aigc-desk/multimodal-domain/src/wan3-parameters.cjs');
const {parseVideoBody}=require('../vendor/parse-video.cjs');
function json(res,status,data){if(res.destroyed)return;res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(data));}
function safeData(data,key){return JSON.parse(JSON.stringify(data).split(key).join('[REDACTED]'));}
function makePlan(kind,body) {
  const m=model(body.model);if(m.kind!==kind)fail('MODEL_TYPE_INVALID','模型与接口类型不符');
  if(kind==='text'){
    fields(body,['model','messages','max_tokens','temperature','stream','stream_options','top_p']);
    if(!Array.isArray(body.messages)||!body.messages.length||body.messages.length>100)fail('MESSAGES_INVALID','messages 需要 1 至 100 条文本消息');
    for(const msg of body.messages){fields(msg,['role','content']);if(!['system','user','assistant'].includes(msg.role))fail('MESSAGES_INVALID','仅支持 system/user/assistant 角色');str(msg.content,'文本消息',1,100000);}
    const max=integer(body.max_tokens??2048,'max_tokens',1,32768);
    if(body.stream!==undefined&&typeof body.stream!=='boolean')fail('INVALID_INPUT','stream 必须为布尔值');
    if(body.temperature!==undefined&&(typeof body.temperature!=='number'||body.temperature<0||body.temperature>2))fail('INVALID_INPUT','temperature 范围 0 至 2');
    if(body.top_p!==undefined&&(typeof body.top_p!=='number'||body.top_p<=0||body.top_p>1))fail('INVALID_INPUT','top_p 范围大于 0 至 1');
    if(body.stream_options!==undefined){fields(body.stream_options,['include_usage']);if(body.stream_options.include_usage!==true)fail('INVALID_INPUT','流式请求必须包含用量');}
    const amount=Buffer.byteLength(JSON.stringify(body.messages),'utf8')+64*body.messages.length+256+max;
    return {amount,path:'/compatible-mode/v1/chat/completions',body:{...body,max_tokens:max,...(body.stream?{stream_options:{include_usage:true}}:{})},stream:!!body.stream};
  }
  if(kind==='image'){
    fields(body,['model','prompt','reference_images','size','prompt_extend','watermark','n']);
    if(body.n!==undefined&&body.n!==1)fail('INVALID_INPUT','图片接口每次生成 1 张');
    if(body.reference_images!==undefined&&!Array.isArray(body.reference_images))fail('INVALID_INPUT','reference_images 必须为数组');
    for(const p of ['prompt_extend','watermark'])if(body[p]!==undefined&&typeof body[p]!=='boolean')fail('INVALID_INPUT',p+' 必须为布尔值');
    return {amount:1,path:'/api/v1/services/aigc/multimodal-generation/generation',body:buildImage3Request({model:m.id,prompt:body.prompt,referenceImages:body.reference_images,size:body.size,promptExtend:body.prompt_extend,watermark:body.watermark})};
  }
  fields(body,['model','prompt','reference_images','media','duration','resolution','ratio','watermark']);
  str(body.prompt,'视频提示词',1,20000);const duration=integer(body.duration??5,'视频时长',2,30);
  for(const p of ['reference_images','media'])if(body[p]!==undefined&&!Array.isArray(body[p]))fail('INVALID_INPUT',p+' 必须为数组');
  if((body.media?.length||0)+(body.reference_images?.length||0)>12)fail('INVALID_INPUT','参考素材过多');
  for(const media of body.media||[]){fields(media,['kind','url','dataUrl','mimeType','durationSeconds','byteSize','sha256']);if(media.url){let url;try{url=new URL(media.url);}catch{fail('MEDIA_INVALID','素材 URL 无效');}if(url.protocol!=='https:'||url.username||url.password)fail('MEDIA_INVALID','素材 URL 必须为公网 HTTPS 地址');}}
  if(body.watermark!==undefined&&typeof body.watermark!=='boolean')fail('INVALID_INPUT','watermark 必须为布尔值');
  if(m.id==='happyhorse-1.0-i2v'&&body.resolution==='480P')fail('INVALID_INPUT','HappyHorse 1.0 使用 720P 或 1080P');
  const media=parseVideoBody(body,m.id);
  if(m.id.endsWith('-r2v')&&!media.length)fail('REFERENCE_REQUIRED','参考生视频模型需要提供参考素材');
  const request=buildWan3Request({model:m.id,compiledPrompt:body.prompt,media,parameters:{duration,resolution:body.resolution||'720P',ratio:body.ratio||'16:9',watermark:body.watermark??false},createAssetUrl:asset=>asset.publicUrl});
  return {amount:units(m.id,request.parameters.duration),path:'/api/v1/services/aigc/video-generation/video-synthesis',body:request,async:true};
}
class Relay {
  constructor(store,fetchImpl=fetch,timeout=180000){this.store=store;this.fetch=fetchImpl;this.timeout=timeout;this.polling=false;this.controllers=new Set();}
  async readJson(response,key){const reader=response.body.getReader();let length=0,chunks=[];try{for(;;){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>4*1024*1024)fail('UPSTREAM_TOO_LARGE','上游返回超过限制',502);chunks.push(value);}return safeData(JSON.parse(Buffer.concat(chunks).toString('utf8')),key);}finally{reader.releaseLock();}}
  replay(res,r){res.setHeader('X-Request-Id',r.id);res.setHeader('Idempotency-Replayed','true');const data=this.store.result(r);
    if(data?.streamEvents){res.writeHead(r.http_status||200,{'Content-Type':'text/event-stream','Cache-Control':'no-store'});for(const frame of data.streamEvents)res.write('data: '+frame+'\n\n');res.end();return;}
    if(data){json(res,r.http_status||200,data);return;}json(res,202,{...this.store.requestDto(r),message:'请求已登记，不会重复提交；可通过请求 ID 查询状态'});}
  async handle(kind,body,req,res) {
    const plan=makePlan(kind,body),idem=req.headers['idempotency-key']||random();str(idem,'Idempotency-Key',8,128);if(!/^[a-zA-Z0-9_.:-]+$/.test(idem))fail('INVALID_INPUT','Idempotency-Key 只能使用字母、数字及 _ . : -');
    const slot=this.store.reserve({model:body.model,units:plan.amount,kind,idem,digest:hash(canonical({kind,body})),relayKeyId:req.relayKey?.id||'legacy',meter:kind==='text'?{inputTokens:plan.amount-plan.body.max_tokens,outputTokens:plan.body.max_tokens}:{variant:plan.body.parameters?.resolution||'default'}}),r=slot.request;
    if(slot.replayed)return this.replay(res,r);
    const controller=new AbortController();this.controllers.add(controller);const timer=setTimeout(()=>controller.abort(),this.timeout);timer.unref();
    const disconnect=()=>{if(!res.writableEnded)controller.abort();};res.on('close',disconnect);res.setHeader('X-Request-Id',r.id);
    try {
      const response=await this.fetch(slot.key.origin+plan.path,{method:'POST',redirect:'error',headers:{'Content-Type':'application/json','Authorization':'Bearer '+slot.key.apiKey,...(plan.async?{'X-DashScope-Async':'enable'}:{})},body:JSON.stringify(plan.body),signal:controller.signal});
      if(!response.ok){
        // 5xx/408 的服务器结果无法确定，保留额度；明确 4xx 拒绝释放额度。
        const certain=response.status>=400&&response.status<500&&response.status!==408;
        if(response.body)await response.body.cancel();
        this.store.coolDown(r.key_id,'HTTP_'+response.status);
        if(certain){const error={error:{code:'UPSTREAM_REJECTED',message:'阿里接口拒绝请求，请检查 Key 权限、区域、余额或参数',upstreamStatus:response.status},requestId:r.id};this.store.settle(r.id,0,error,502,'failed');return json(res,502,error);}
        throw Object.assign(new Error(),{code:'UPSTREAM_HTTP_'+response.status});
      }
      if(plan.stream)return await this.stream(response,slot.key.apiKey,r,res);
      const data=await this.readJson(response,slot.key.apiKey);
      if(data.code||data.error){const error={error:{code:'UPSTREAM_REJECTED',message:'阿里接口返回业务错误'},requestId:r.id};this.store.settle(r.id,0,error,502,'failed');this.store.coolDown(r.key_id,'BUSINESS_ERROR');return json(res,502,error);}
      if(plan.async){this.store.submitted(r.id,data.output?.task_id);return json(res,202,{id:r.id,object:'video.task',status:'submitted',upstream_task_id:data.output.task_id});}
      if(kind==='text'){
        const actual=data.usage?.total_tokens;if(!Number.isSafeInteger(actual)||actual<0)throw Object.assign(new Error(),{code:'USAGE_MISSING'});
        this.store.settle(r.id,actual,data);return json(res,200,data);
      }
      const urls=parseImage3Response(data),actual=data.usage?.output_image_count??urls.length;
      if(!Number.isSafeInteger(actual)||actual<1)throw Object.assign(new Error(),{code:'USAGE_INVALID'});
      const result={id:r.id,created:Math.floor(Date.now()/1000),data:urls.map(url=>({url})),usage:{output_image_count:actual}};
      this.store.settle(r.id,actual,result);return json(res,200,result);
    }catch(e){
      this.store.unknown(r.id,/^[A-Z_0-9]{1,64}$/.test(e.code||'')?e.code:'RESULT_UNKNOWN');
      const payload={error:{code:'RESULT_UNKNOWN',message:'上游结果或用量不明，已保留预占额度，请在后台核对'},requestId:r.id};
      if(res.headersSent){if(!res.destroyed)res.end('data: '+JSON.stringify(payload)+'\n\n');}else json(res,502,payload);
    }finally{clearTimeout(timer);this.controllers.delete(controller);res.off('close',disconnect);}
  }
  async stream(response,key,r,res) {
    if(!String(response.headers.get('content-type')).includes('text/event-stream'))throw Object.assign(new Error(),{code:'STREAM_INVALID'});
    res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store','X-Accel-Buffering':'no'});
    const reader=response.body.getReader(),decoder=new TextDecoder();let pending='',total=0,usage=null,fullUsage=null,doneSeen=false,events=[];
    try{
      for(;;){const {done,value}=await reader.read();if(done)break;total+=value.length;if(total>2*1024*1024)throw Object.assign(new Error(),{code:'STREAM_TOO_LARGE'});pending+=decoder.decode(value,{stream:true});pending=pending.replace(/\r\n/g,'\n');
        let index;
        while((index=pending.indexOf('\n\n'))>=0){
          const frame=pending.slice(0,index);pending=pending.slice(index+2);
          const line=frame.split('\n').filter(l=>l.startsWith('data:')).map(l=>l.slice(5).trimStart()).join('\n');if(!line)continue;
          if(doneSeen)throw Object.assign(new Error(),{code:'STREAM_INVALID'});
          if(line==='[DONE]'){doneSeen=true;continue;}
          const data=safeData(JSON.parse(line),key);
          if(data.error)throw Object.assign(new Error(),{code:'STREAM_ERROR'});
          if(data.usage?.total_tokens!==undefined){usage=data.usage.total_tokens;fullUsage=data.usage;}
          const clean=JSON.stringify(data);events.push(clean);if(!res.write('data: '+clean+'\n\n'))await once(res,'drain',{signal:AbortSignal.timeout(15000)});
        }
      }
      if(!doneSeen||!Number.isSafeInteger(usage)||usage<0)throw Object.assign(new Error(),{code:'USAGE_MISSING'});
      events.push('[DONE]');this.store.settle(r.id,usage,{streamEvents:events},200,'succeeded',null,fullUsage);res.end('data: [DONE]\n\n');
    }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
  }
  async pollOne(r) {
    if(Date.now()-r.created_at>24*3600000){this.store.unknown(r.id,'TASK_EXPIRED');return;}
    const key=this.store.keySecret(r.key_id);
    try {
      const response=await this.fetch(key.origin+'/api/v1/tasks/'+encodeURIComponent(r.task_id),{redirect:'error',headers:{Authorization:'Bearer '+key.apiKey},signal:AbortSignal.timeout(30000)});
      if(!response.ok){await response.body?.cancel();this.store.touch(r.id);return;}
      const data=await this.readJson(response,key.apiKey),status=data.output?.task_status;
      if(status==='SUCCEEDED'){
        const actual=data.usage?.output_video_duration??data.usage?.duration;
        if(typeof actual!=='number'||!Number.isFinite(actual)||actual<=0){this.store.unknown(r.id,'USAGE_MISSING');return;}
        const output=Object.fromEntries(['task_id','task_status','video_url','submit_time','scheduled_time','end_time'].filter(k=>data.output[k]!==undefined).map(k=>[k,data.output[k]]));
        const result={id:r.id,object:'video.task',status:'succeeded',output,usage:data.usage};
        this.store.settle(r.id,Math.ceil(actual*1000),result);
      }else if(['FAILED','CANCELED'].includes(status)){
        this.store.settle(r.id,0,{id:r.id,status:'failed',error:{code:'UPSTREAM_TASK_FAILED',message:'阿里视频任务失败或已取消'}},200,'failed');
      }else if(status==='UNKNOWN'){this.store.unknown(r.id,'UPSTREAM_TASK_UNKNOWN');}
      else this.store.touch(r.id);
    }catch{this.store.touch(r.id);}
  }
  async poll(){if(this.polling)return;this.polling=true;try{await Promise.allSettled(this.store.pending().map(r=>this.pollOne(r)));}finally{this.polling=false;}}
  stop(){for(const c of this.controllers)c.abort();}
}
module.exports={Relay,makePlan,json};

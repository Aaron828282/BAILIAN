'use strict';
const http=require('node:http');
const fs=require('node:fs');
const path=require('node:path');
const {fail,str,fields,equal,random,hash}=require('./common.cjs');
const {MODELS}=require('./catalog.cjs');
const {passwordOK,passwordHash}=require('./vault.cjs');
const {decode,preview}=require('./key-package.cjs');
const {Relay,json}=require('./relay.cjs');
async function body(req,max=1024*1024,reserveBytes=()=>{}) {
  if(!String(req.headers['content-type']).toLowerCase().startsWith('application/json'))fail('CONTENT_TYPE','请使用 application/json',415);
  if(Number(req.headers['content-length'])>max)fail('BODY_TOO_LARGE','请求超过体积限制',413);
  let bytes=0,chunks=[];for await(const chunk of req){bytes+=chunk.length;reserveBytes(chunk.length);if(bytes>max)fail('BODY_TOO_LARGE','请求超过体积限制',413);chunks.push(chunk);}
  let data;try{data=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{fail('JSON_INVALID','JSON 格式无效');}
  fields(data,Object.keys(data||{}));return data;
}
function cookie(req){const value=String(req.headers.cookie||'').split(';').map(x=>x.trim()).find(x=>x.startsWith('brw_session='));return value?.slice(12)||'';}
function relayTokenFromRequest(req){
  const directHeader=req.headers['x-relay-key'],authorizationHeader=req.headers.authorization;
  if(Array.isArray(directHeader)||Array.isArray(authorizationHeader))fail('AUTH_FORMAT_INVALID','鉴权请求头不允许重复',401);
  const directToken=String(directHeader||'').trim(),authorization=String(authorizationHeader||'').trim();
  let bearerToken='';
  if(authorization){
    const match=/^Bearer[ \t]+([^\s"'<>]+)$/i.exec(authorization);
    if(!match)fail('AUTH_FORMAT_INVALID','Authorization 格式应为 Bearer 加英文空格再加中转 Key',401);
    bearerToken=match[1];
  }
  if(directToken&&(/[\s"'<>]/.test(directToken)))fail('AUTH_FORMAT_INVALID','X-Relay-Key 格式无效',401);
  if(directToken&&bearerToken&&!equal(directToken,bearerToken))fail('AUTH_CONFLICT','X-Relay-Key 与 Authorization 使用了不同的中转 Key',401);
  const token=directToken||bearerToken;
  if(!token)fail('AUTH_REQUIRED','请通过 X-Relay-Key 或 Authorization 提供中转 Key',401);
  return token;
}
function createApp({store,material,publicUrl,relayToken,fetchImpl,timeout,publicDir=path.join(__dirname,'../public')}) {
  const base=new URL(publicUrl),relay=new Relay(store,fetchImpl,timeout),attempts=new Map();let active=0,closing=false,globalAttempts=[],allocatedBytes=0;
  const readBody=(req,max)=>body(req,max,n=>{if(allocatedBytes+n>80*1024*1024)fail('BODY_CAPACITY','当前请求体积较大，请稍后重试',503);allocatedBytes+=n;req.bodyBytes=(req.bodyBytes||0)+n;});
  store.ensureLegacy(relayToken);
  const sessionCookie=(token,maxAge)=>'brw_session='+token+'; Path=/; HttpOnly; SameSite=Strict; Max-Age='+maxAge+(base.protocol==='https:'?'; Secure':'');
  function checkOrigin(req){if(req.headers.origin!==base.origin)fail('ORIGIN_FORBIDDEN','请求来源不匹配，请从配置的工作台地址访问',403);}
  function admin(req,write=false){const session=store.session(cookie(req));if(!session)fail('UNAUTHORIZED','请先登录',401);if(write){checkOrigin(req);if(!equal(req.headers['x-csrf-token']||'',session.csrf))fail('CSRF_INVALID','会话校验失败，请刷新页面',403);}return session;}
  const server=http.createServer(async(req,res)=>{
    res.setHeader('X-Content-Type-Options','nosniff');res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Frame-Options','DENY');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    res.setHeader('Cache-Control','no-store');
    if(base.protocol==='https:')res.setHeader('Strict-Transport-Security','max-age=31536000');
    if(closing){json(res,503,{error:{code:'SHUTTING_DOWN',message:'服务正在关闭'}});return;}
    if(active>=40){json(res,503,{error:{code:'BUSY',message:'服务繁忙，请稍后重试'}});return;}active++;
    try{
      const url=new URL(req.url,'http://local'),route=url.pathname.replace(/^\/oai\/v1(?=\/|$)/,'/v1'),method=req.method;
      if(route==='/healthz'&&method==='GET')return json(res,200,{ok:true,service:'bailian-relay',version:require('../package.json').version});
      if(method==='GET'&&/^\/v1\/tasks\/[a-zA-Z0-9_-]+$/.test(route)){
        // The request ID is an unguessable capability URL. This read-only endpoint is
        // intentionally public so workflow runners can poll without forwarding a key.
        const r=store.getRequest(route.split('/').pop());if(!r)fail('NOT_FOUND','请求不存在',404);
        const result=store.result(r),dto=store.requestDto(r);
        const {keyId,relayKeyId,relayKeyLabel,billingMode,reservedCost,cost,billingUsage,...publicDto}=dto;
        return json(res,200,result?.streamEvents?{...publicDto,message:'流式请求已完成'}:result||publicDto);
      }
      if(route.startsWith('/v1/')){
        req.relayKey=store.authenticateRelay(relayTokenFromRequest(req));
        if(req.headers.origin)checkOrigin(req);
        if(method==='GET'&&route==='/v1/models')return json(res,200,{object:'list',data:MODELS.filter(m=>JSON.parse(req.relayKey.models).includes(m.id)).map(m=>({id:m.id,object:'model',owned_by:'alibaba',kind:m.kind}))});
        if(method==='GET'&&route==='/v1/balance'){const k=store.relayKeyDto(req.relayKey);return json(res,200,{currency:'CNY',mode:k.mode,credit:k.credit,spent:k.spent,held:k.held,balance:k.mode==='legacy'?null:k.balance,available:k.mode==='legacy'?null:k.available});}
        if(method==='GET'&&route==='/v1/pricing'){const prices=store.pricing();prices.items=prices.items.filter(p=>JSON.parse(req.relayKey.models).includes(p.model));return json(res,200,prices);}
        if(method==='GET'&&route==='/v1/usage'){const data=store.requests('',Number(url.searchParams.get('page')||1),req.relayKey.id);data.items=data.items.map(({keyId,relayKeyLabel,...r})=>r);return json(res,200,data);}
        const kind={'/v1/chat/completions':'text','/v1/images/generations':'image','/v1/videos/generations':'video'}[route];
        if(method==='POST'&&kind){const data=await readBody(req,kind==='text'?1024*1024:45*1024*1024);return await relay.handle(kind,data,req,res);}
        fail('NOT_FOUND','接口不存在',404);
      }
      if(route==='/api/login'&&method==='POST'){
        checkOrigin(req);const now=Date.now(),ip=req.socket.remoteAddress||'unknown';let bucket=attempts.get(ip)||[];
        bucket=bucket.filter(t=>now-t<300000);globalAttempts=globalAttempts.filter(t=>now-t<300000);
        if(bucket.length>=5||globalAttempts.length>=30)fail('LOGIN_RATE_LIMIT','登录尝试过多，请五分钟后重试',429);
        if(attempts.size>10000)attempts.clear();bucket.push(now);attempts.set(ip,bucket);globalAttempts.push(now);
        const data=await readBody(req,4096);fields(data,['username','password']);
        if(data.username!=='admin'||!passwordOK(data.password,store.getMeta('password')))fail('LOGIN_FAILED','账号或密码不正确',401);
        attempts.delete(ip);const s=store.sessionCreate();res.setHeader('Set-Cookie',sessionCookie(s.token,28800));return json(res,200,{csrf:s.csrf,expires:s.expires});
      }
      if(route.startsWith('/api/')){
        const write=method!=='GET',session=admin(req,write);
        if(method==='GET'&&route==='/api/session')return json(res,200,{csrf:session.csrf,expires:session.expires,models:MODELS,baseUrl:base.origin+'/v1'});
        if(method==='POST'&&route==='/api/logout'){store.sessionDelete(cookie(req));res.setHeader('Set-Cookie',sessionCookie('',0));return json(res,200,{ok:true});}
        if(method==='GET'&&route==='/api/relay-keys')return json(res,200,store.relayKeys(Number(url.searchParams.get('page')||1)));
        if(method==='POST'&&route==='/api/relay-keys'){const data=await readBody(req,16384);fields(data,['label','credit','models','expiresAt']);return json(res,201,store.createRelayKey(data));}
        if(method==='PATCH'&&/^\/api\/relay-keys\/(?:rk_[a-zA-Z0-9-]+|legacy)$/.test(route)){const data=await readBody(req,16384);fields(data,['label','enabled','credit','models','expiresAt']);return json(res,200,store.editRelayKey(route.split('/')[3],data));}
        if(method==='POST'&&/^\/api\/relay-keys\/(?:rk_[a-zA-Z0-9-]+|legacy)\/token$/.test(route))return json(res,200,{token:store.relayKeyToken(route.split('/')[3])});
        if(method==='POST'&&/^\/api\/relay-keys\/rk_[a-zA-Z0-9-]+\/credit$/.test(route)){const data=await readBody(req,4096);fields(data,['amount']);return json(res,200,store.addRelayCredit(route.split('/')[3],data.amount));}
        if(method==='GET'&&route==='/api/pricing')return json(res,200,store.pricing());
        if(method==='PATCH'&&route==='/api/pricing'){const data=await readBody(req,32768);fields(data,['items']);if(Array.isArray(data.items))for(const item of data.items)fields(item,['model','variant','rates']);return json(res,200,store.savePricing(data.items));}
        if(method==='GET'&&route==='/api/overview')return json(res,200,store.overview());
        if(method==='GET'&&route==='/api/keys')return json(res,200,store.keys(url.searchParams.get('query')||'',Number(url.searchParams.get('page')||1)));
        if(method==='POST'&&route==='/api/keys'){const data=await readBody(req);fields(data,['keys']);if(Array.isArray(data.keys))for(const row of data.keys)fields(row,['apiKey','origin','label','weight','models','quotas']);return json(res,201,store.addKeys(data.keys));}
        if(method==='PATCH'&&/^\/api\/keys\/key_[a-zA-Z0-9-]+$/.test(route)){const data=await readBody(req);fields(data,['label','enabled','weight','quotas']);return json(res,200,store.editKey(route.split('/').pop(),data));}
        if(method==='GET'&&route==='/api/templates')return json(res,200,store.templates());
        if(method==='PATCH'&&route==='/api/templates'){const data=await readBody(req);fields(data,MODELS.map(m=>m.id));return json(res,200,store.templates(data));}
        if(method==='GET'&&route==='/api/packages')return json(res,200,store.packages());
        if(method==='POST'&&['/api/packages/preview','/api/packages/import'].includes(route)){const data=await readBody(req,6*1024*1024);fields(data,['content']);const pack=decode(data.content,material);return json(res,200,route.endsWith('/preview')?preview(pack):store.importPackage(pack));}
        if(method==='POST'&&/^\/api\/packages\/pkg_[a-zA-Z0-9-]+\/download$/.test(route)){const f=store.packageFile(route.split('/')[3]);res.writeHead(200,{'Content-Type':'application/octet-stream','Content-Disposition':'attachment; filename="'+f.name+'"'});return res.end(f.raw);}
        if(method==='GET'&&route==='/api/requests')return json(res,200,store.requests(url.searchParams.get('state')||'',Number(url.searchParams.get('page')||1),url.searchParams.get('relayKeyId')||''));
        if(method==='POST'&&/^\/api\/requests\/req_[a-zA-Z0-9-]+\/reconcile$/.test(route)){const data=await readBody(req);fields(data,['actual','reason','inputTokens','outputTokens']);return json(res,200,store.reconcile(route.split('/')[3],data.actual,data.reason,data.inputTokens===undefined&&data.outputTokens===undefined?null:{prompt_tokens:data.inputTokens,completion_tokens:data.outputTokens}));}
        if(method==='POST'&&route==='/api/access/token'){return json(res,200,{token:store.relayKeyToken('legacy')});}
        if(method==='POST'&&route==='/api/password'){const data=await readBody(req,4096);fields(data,['current','next']);if(!passwordOK(data.current,store.getMeta('password')))fail('PASSWORD_INVALID','原密码不正确',403);const next=str(data.next,'新密码',16,512);store.tx(()=>{store.setMeta('password',passwordHash(next));store.run('DELETE FROM sessions');store.audit('password.change',null);});res.setHeader('Set-Cookie',sessionCookie('',0));return json(res,200,{ok:true});}
        fail('NOT_FOUND','管理接口不存在',404);
      }
      const assets={'/':['index.html','text/html; charset=utf-8'],'/billing-ui.js':['billing-ui.js','text/javascript; charset=utf-8'],'/app.js':['app.js','text/javascript; charset=utf-8'],'/style.css':['style.css','text/css; charset=utf-8']};
      if((method==='GET'||method==='HEAD')&&assets[route]){const [file,type]=assets[route];res.setHeader('Content-Type',type);return res.end(method==='HEAD'?undefined:fs.readFileSync(path.join(publicDir,file)));}
      fail('NOT_FOUND','页面不存在',404);
    }catch(e){
      const status=Number.isInteger(e.status)&&e.status>=400&&e.status<=599?e.status:500;
      const payload={error:{code:status===500?'INTERNAL_ERROR':e.code||'INVALID_INPUT',message:status===500?'服务内部错误，请检查服务器日志和数据目录':e.message}};
      if(status===500)console.error('[服务错误]',/^[A-Z_0-9]+$/.test(e.code||'')?e.code:'INTERNAL_ERROR');
      if(!res.headersSent)json(res,status,payload);else if(!res.destroyed)res.end();
    }finally{active--;allocatedBytes-=req.bodyBytes||0;}
  });
  server.requestTimeout=60000;server.headersTimeout=30000;server.keepAliveTimeout=5000;
  return {server,relay,async close(){closing=true;relay.stop();await new Promise(resolve=>{server.close(resolve);server.closeIdleConnections();const t=setTimeout(()=>server.closeAllConnections(),5000);t.unref();});while(relay.polling)await new Promise(r=>setTimeout(r,50));}};
}
module.exports={createApp,body};

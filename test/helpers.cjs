'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {Store}=require('../src/store.cjs'),{createVault}=require('../src/vault.cjs'),{createApp}=require('../src/app.cjs');
const {canonicalizeJson}=require('../vendor/node_modules/@aigc-desk/key-package/src/canonical-json.cjs');
const {MODELS}=require('../src/catalog.cjs');
function fixture(payloadOverride={},packageId='KP-20260908-000001') {
  const pair=crypto.generateKeyPairSync('ed25519'),aesKey=crypto.randomBytes(32);
  const payload={label:'兼容格式测试包',allowedModels:['qwen-image-3.0','wan3.0-video'],keys:[{id:'test-01',apiKey:'sk-test-'+crypto.randomBytes(20).toString('hex'),baseURL:'https://dashscope.aliyuncs.com',models:['qwen-image-3.0','wan3.0-video'],priority:0}],localGateway:{enabled:true,port:3461},...payloadOverride};
  function seal(data=payload,id=packageId) {
    const iv=crypto.randomBytes(12),c=crypto.createCipheriv('aes-256-gcm',aesKey,iv),ciphertext=Buffer.concat([c.update(JSON.stringify(data)),c.final()]);
    const envelope={format:'aigc-key-package',version:1,packageId:id,createdAt:new Date().toISOString(),cipher:{name:'AES-256-GCM',iv:iv.toString('base64'),authTag:c.getAuthTag().toString('base64')},ciphertext:ciphertext.toString('base64')};
    envelope.signature={name:'Ed25519',keyId:'owner-key-v1',value:crypto.sign(null,Buffer.from(canonicalizeJson(envelope)),pair.privateKey).toString('base64')};
    return JSON.stringify(envelope);
  }
  return {raw:seal(),seal,payload,material:{aesKey,verifyPublicKey:pair.publicKey.export({format:'der',type:'spki'})}};
}
function key(label='测试 Key',quotas){return {label,apiKey:'sk-fake-'+crypto.randomBytes(20).toString('hex'),origin:'https://dashscope.aliyuncs.com',models:MODELS.map(m=>m.id),weight:0,quotas};}
function setup(){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'brw-test-')),hex=crypto.randomBytes(32).toString('hex'),password='test-admin-'+crypto.randomBytes(16).toString('hex'),file=path.join(dir,'relay.sqlite');
  const store=new Store(file,createVault(hex),password);
  return {dir,file,hex,password,store,cleanup(){try{store.close();}catch{}const target=path.resolve(dir);if(path.dirname(target)!==path.resolve(os.tmpdir())||!path.basename(target).startsWith('brw-test-'))throw Error('测试清理范围无效');fs.rmSync(target,{recursive:true,force:true});}};
}
async function httpSetup(t,fetchImpl=async()=>new Response('{}'),timeout=3000){
  const env=setup(),f=fixture(),token=crypto.randomBytes(32).toString('hex');
  const app=createApp({store:env.store,material:f.material,publicUrl:'http://localhost',relayToken:token,fetchImpl,timeout});
  await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
  const base='http://127.0.0.1:'+app.server.address().port;
  t.after(async()=>{await app.close();env.cleanup();});
  let cookie='',csrf='';
  async function call(url,{method='GET',data,headers={},auth=true,admin=false}={}){
    const h={...(data===undefined?{}:{'Content-Type':'application/json'}),...(auth?{Authorization:'Bearer '+token}:{}),...(admin?{Cookie:cookie,Origin:'http://localhost','X-CSRF-Token':csrf}:{}),...headers};
    return fetch(base+url,{method,headers:h,body:data===undefined?undefined:JSON.stringify(data)});
  }
  async function login(){const res=await call('/api/login',{method:'POST',data:{username:'admin',password:env.password},headers:{Origin:'http://localhost'}});cookie=res.headers.get('set-cookie')?.split(';')[0]||'';csrf=(await res.json()).csrf;return {cookie,csrf};}
  return {...env,app,f,token,base,call,login};
}
const response=(data,status=200)=>new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json'}});
module.exports={fixture,key,setup,httpSetup,response};

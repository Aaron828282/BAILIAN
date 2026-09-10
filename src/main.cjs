'use strict';
const fs=require('node:fs'),path=require('node:path');
const {Store}=require('./store.cjs');
const {createVault}=require('./vault.cjs');
const {readMaterial}=require('./key-package.cjs');
const {createApp}=require('./app.cjs');
const {str,integer,random}=require('./common.cjs');
async function main(){
  process.umask(0o077);
  const env=process.env,port=integer(Number(env.PORT||3480),'PORT',1,65535);
  const url=new URL(str(env.PUBLIC_URL,'PUBLIC_URL',8,512));
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash||url.pathname!=='/')throw Error('PUBLIC_URL 应为站点根地址');
  if(url.protocol==='http:'&&!['localhost','127.0.0.1','[::1]'].includes(url.hostname))throw Error('公网访问必须使用 HTTPS PUBLIC_URL');
  const token=str(env.RELAY_TOKEN,'RELAY_TOKEN',32,256),vault=createVault(env.VAULT_KEY),dataDir=path.resolve(env.DATA_DIR||'data');
  fs.mkdirSync(dataDir,{recursive:true,mode:0o700});
  const material=readMaterial(path.resolve(env.MATERIAL_PATH||'resources/client-material.json'));
  const store=new Store(path.join(dataDir,'relay.sqlite'),vault,env.ADMIN_PASSWORD),owner=random();store.lease(owner);
  const app=createApp({store,material,publicUrl:url.origin,relayToken:token});
  await new Promise((resolve,reject)=>{app.server.once('error',reject);app.server.listen(port,env.HOST||'127.0.0.1',resolve);});
  const poll=setInterval(()=>app.relay.poll().catch(()=>console.error('视频状态查询失败')),15000);poll.unref();app.relay.poll();
  let stopping=false;
  async function stop(){if(stopping)return;stopping=true;clearInterval(poll);clearInterval(heartbeat);await app.close();store.release(owner);store.close();}
  const heartbeat=setInterval(()=>{try{store.heartbeat(owner);}catch{console.error('实例锁失效，停止服务');stop().then(()=>process.exit(1));}},10000);heartbeat.unref();
  for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>stop().then(()=>process.exit(0)));
  console.log('百炼中转工作台已启动：'+url.origin);
}
main().catch(e=>{console.error('启动失败：'+(e.code||e.message));process.exit(1);});

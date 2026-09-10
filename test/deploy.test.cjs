'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net');
const {spawnSync,spawn}=require('node:child_process'),{once}=require('node:events');
const {setup,key}=require('./helpers.cjs'),{Store}=require('../src/store.cjs'),{createVault}=require('../src/vault.cjs');
const root=path.resolve(__dirname,'..');
test('在线 SQLite 快照保留号池、计费余额、价格与流水',t=>{
  const s=setup();t.after(()=>s.cleanup());s.store.addKeys([key('备份测试')]);const r=s.store.reserve({model:'qwen-image-3.0',units:1,kind:'image',idem:'backup-test',digest:'backup-test'});s.store.settle(r.request.id,1,{ok:true});
  const client=s.store.createRelayKey({label:'备份计费 Key',credit:'2',models:['qwen-image-3.0']});
  s.store.savePricing([{model:'qwen-image-3.0',variant:'default',rates:{unit:'0.2'}}]);
  const billed=s.store.reserve({model:'qwen-image-3.0',units:1,kind:'image',idem:'billed-backup-test',digest:'billed-backup-test',relayKeyId:client.key.id});
  s.store.settle(billed.request.id,1,{ok:true});
  const held=s.store.reserve({model:'qwen-image-3.0',units:1,kind:'image',idem:'held-backup-test',digest:'held-backup-test',relayKeyId:client.key.id});
  s.store.unknown(held.request.id);
  const run=spawnSync(process.execPath,[path.join(root,'scripts/backup.cjs')],{cwd:root,env:{...process.env,DATA_DIR:s.dir},encoding:'utf8'});
  assert.equal(run.status,0,run.stderr);
  const folder=path.join(s.dir,'backups'),file=path.join(folder,fs.readdirSync(folder)[0]);
  const snapshot=new Store(file,createVault(s.hex),s.password);
  try{
    assert.equal(snapshot.keys().total,1);assert.equal(snapshot.keys().items[0].quotas.find(q=>q.model==='qwen-image-3.0').used,2);
    const wallet=snapshot.relayKeys().items[0];assert.equal(wallet.spent,0.2);assert.equal(wallet.held,0.2);assert.equal(wallet.available,1.6);
    assert.equal(snapshot.relayKeyToken(client.key.id),client.token);
    assert.equal(snapshot.pricing().items.find(p=>p.model==='qwen-image-3.0').rates.unit,0.2);
    assert.equal(snapshot.one("SELECT count(*) AS n FROM billing_ledger WHERE relay_key_id=? AND kind='charge'",client.key.id).n,1);
    assert.equal(snapshot.getRequest(held.request.id).state,'unknown');
  }finally{snapshot.close();}
});
test('初始化不覆盖凭据，真实启动入口通过健康与登录验证',async t=>{
  const s=setup();t.after(()=>s.cleanup());
  const run=()=>spawnSync(process.execPath,[path.join(root,'scripts/init.cjs')],{cwd:s.dir,encoding:'utf8'});
  assert.equal(run().status,0);const before=fs.readFileSync(path.join(s.dir,'.env'),'utf8');assert.equal(run().status,1);assert.equal(fs.readFileSync(path.join(s.dir,'.env'),'utf8'),before);
  const probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
  const url='http://127.0.0.1:'+port;
  const child=spawn(process.execPath,[path.join(root,'src/main.cjs')],{cwd:root,windowsHide:true,env:{...process.env,PORT:String(port),HOST:'127.0.0.1',PUBLIC_URL:url,RELAY_TOKEN:'testing-relay-token-'.repeat(3),VAULT_KEY:s.hex,ADMIN_PASSWORD:s.password,DATA_DIR:s.dir,MATERIAL_PATH:path.join(root,'resources/client-material.json')},stdio:['ignore','pipe','pipe']});
  t.after(async()=>{if(child.exitCode===null&&child.signalCode===null){child.kill();await once(child,'exit');}});
  let errors='';child.stderr.on('data',data=>errors+=data.toString());
  await Promise.race([once(child.stdout,'data'),once(child,'exit').then(()=>{throw Error('进程提前退出：'+errors);}),new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('启动超时')),10000);timer.unref();})]);
  const health=await fetch(url+'/healthz');assert.equal(health.status,200);assert.equal((await health.json()).ok,true);
  const login=await fetch(url+'/api/login',{method:'POST',headers:{Origin:url,'Content-Type':'application/json'},body:JSON.stringify({username:'admin',password:s.password})});assert.equal(login.status,200);
  child.kill();await once(child,'exit');
});

'use strict';
const {DatabaseSync}=require('node:sqlite');
const fs=require('node:fs');
const path=require('node:path');
const {fail,str,integer,hash,id,random}=require('./common.cjs');
const {MODELS,model,units,origin}=require('./catalog.cjs');
const {passwordHash}=require('./vault.cjs');
const relayKeyStore=require('./relay-key-store.cjs');
const {yuan}=require('./billing.cjs');

class Store {
  constructor(file,vault,password) {
    fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
    this.vault=vault; this.db=new DatabaseSync(file);
    try {
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    this.db.exec([
      'CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY,v TEXT NOT NULL)',
      'CREATE TABLE IF NOT EXISTS keys(id TEXT PRIMARY KEY,fingerprint TEXT UNIQUE NOT NULL,secret TEXT NOT NULL,label TEXT NOT NULL,origin TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 1,weight INTEGER NOT NULL DEFAULT 0,cooldown_until INTEGER NOT NULL DEFAULT 0,last_error TEXT,last_used INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,package_id TEXT)',
      'CREATE TABLE IF NOT EXISTS quotas(key_id TEXT NOT NULL REFERENCES keys(id),model TEXT NOT NULL,total INTEGER NOT NULL CHECK(total>=0),used INTEGER NOT NULL DEFAULT 0 CHECK(used>=0),held INTEGER NOT NULL DEFAULT 0 CHECK(held>=0),PRIMARY KEY(key_id,model))',
      'CREATE TABLE IF NOT EXISTS packages(id TEXT PRIMARY KEY,signed_id TEXT UNIQUE NOT NULL,label TEXT NOT NULL,digest TEXT UNIQUE NOT NULL,content TEXT NOT NULL,key_count INTEGER NOT NULL,imported_count INTEGER NOT NULL,created_at INTEGER NOT NULL)',
      'CREATE TABLE IF NOT EXISTS requests(id TEXT PRIMARY KEY,idem TEXT UNIQUE NOT NULL,digest TEXT NOT NULL,key_id TEXT NOT NULL REFERENCES keys(id),model TEXT NOT NULL,kind TEXT NOT NULL,state TEXT NOT NULL,reserved INTEGER NOT NULL,actual INTEGER,task_id TEXT,result TEXT,http_status INTEGER,error_code TEXT,reason TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL)',
      'CREATE INDEX IF NOT EXISTS request_state ON requests(state,updated_at)',
      'CREATE TABLE IF NOT EXISTS sessions(token_hash TEXT PRIMARY KEY,csrf TEXT NOT NULL,expires INTEGER NOT NULL)',
      'CREATE TABLE IF NOT EXISTS audits(id INTEGER PRIMARY KEY,created_at INTEGER NOT NULL,action TEXT NOT NULL,target TEXT,detail TEXT NOT NULL)'
    ].join(';'));
    if(this.getMeta('vault_check')) {
      if(vault.open(this.getMeta('vault_check'),'vault-check')!=='bailian-relay-v1')fail('VAULT_UNREADABLE','数据主密钥不匹配',500);
    } else {
      this.tx(()=>{this.setMeta('vault_check',vault.seal('bailian-relay-v1','vault-check'));this.setMeta('password',passwordHash(str(password,'初始管理员密码',16,512)));this.setMeta('templates',Object.fromEntries(MODELS.map(m=>[m.id,m.preset])));});
    }
    relayKeyStore.migrate(this);
    } catch(error) { this.db.close(); throw error; }
  }
  one(sql,...args){return this.db.prepare(sql).get(...args);}
  all(sql,...args){return this.db.prepare(sql).all(...args);}
  run(sql,...args){return this.db.prepare(sql).run(...args);}
  tx(fn){this.db.exec('BEGIN IMMEDIATE');try{const v=fn();this.db.exec('COMMIT');return v;}catch(e){this.db.exec('ROLLBACK');throw e;}}
  getMeta(k){const row=this.one('SELECT v FROM meta WHERE k=?',k);return row?JSON.parse(row.v):null;}
  setMeta(k,v){this.run('INSERT INTO meta VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v',k,JSON.stringify(v));}
  audit(action,target,detail={}){this.run('INSERT INTO audits(created_at,action,target,detail) VALUES(?,?,?,?)',Date.now(),action,target,JSON.stringify(detail));}
  keyDto(row){
    if(!row)return null;
    const secret=this.vault.open(row.secret,'key:'+row.fingerprint);
    return {id:row.id,label:row.label,origin:row.origin,enabled:!!row.enabled,weight:row.weight,masked:secret.slice(0,3)+'…'+secret.slice(-4),cooldownUntil:row.cooldown_until,lastError:row.last_error,createdAt:row.created_at,
      quotas:this.all('SELECT model,total,used,held FROM quotas WHERE key_id=?',row.id).map(q=>{const m=model(q.model);return {...q,unit:m.unit,total:q.total/m.factor,used:q.used/m.factor,held:q.held/m.factor,available:Math.max(0,q.total-q.used-q.held)/m.factor};})};
  }
  keySecret(keyId){const row=this.one('SELECT * FROM keys WHERE id=?',keyId);if(!row)fail('KEY_MISSING','请求关联的 Key 不存在',500);return {apiKey:this.vault.open(row.secret,'key:'+row.fingerprint),origin:row.origin};}
  insertKey(input,packageId=null) {
    const apiKey=str(input.apiKey,'API Key',16,2048);if(/\s/.test(apiKey))fail('KEY_INVALID','API Key 不能含空白');
    const endpoint=origin(input.origin),fingerprint=hash(apiKey),prior=this.one('SELECT * FROM keys WHERE fingerprint=?',fingerprint);
    if(prior){if(prior.origin!==endpoint)fail('KEY_ORIGIN_CONFLICT','相同 Key 已存在于其他接入区域');return {id:prior.id,added:false};}
    if(this.one('SELECT count(*) AS n FROM keys').n>=10000)fail('POOL_FULL','号池已达到 10000 个 Key',409);
    if(!Array.isArray(input.models)||!input.models.length||input.models.length>MODELS.length)fail('MODELS_INVALID','请选择支持的模型');
    const models=[...new Set(input.models.map(m=>model(m).id))];
    const keyId=id('key'),now=Date.now(),templates=this.getMeta('templates');
    this.run('INSERT INTO keys(id,fingerprint,secret,label,origin,weight,created_at,package_id) VALUES(?,?,?,?,?,?,?,?)',keyId,fingerprint,this.vault.seal(apiKey,'key:'+fingerprint),str(input.label||'未命名 Key','备注',1,256),endpoint,integer(input.weight??0,'优先级',0,100),now,packageId);
    for(const m of models)this.run('INSERT INTO quotas(key_id,model,total) VALUES(?,?,?)',keyId,m,units(m,input.quotas?.[m]??templates[m]));
    this.audit('key.add',keyId,{packageId});return {id:keyId,added:true};
  }
  addKeys(rows){if(!Array.isArray(rows)||!rows.length||rows.length>100)fail('KEYS_INVALID','每次导入 1 至 100 个 Key');return this.tx(()=>{const results=rows.map(r=>this.insertKey(r));return {added:results.filter(r=>r.added).length,skipped:results.filter(r=>!r.added).length};});}
  keys(query='',page=1) {
    const offset=(integer(page,'页码',1,100000)-1)*20,pattern='%'+String(query).slice(0,128).replace(/[\\%_]/g,'\\$&')+'%';
    const where="WHERE label LIKE ? ESCAPE '\\' OR id LIKE ? ESCAPE '\\'";
    return {page,total:this.one('SELECT count(*) AS n FROM keys '+where,pattern,pattern).n,items:this.all('SELECT * FROM keys '+where+' ORDER BY created_at DESC,id LIMIT 20 OFFSET ?',pattern,pattern,offset).map(r=>this.keyDto(r))};
  }
  editKey(keyId,input){return this.tx(()=>{
    const row=this.one('SELECT * FROM keys WHERE id=?',keyId);if(!row)fail('NOT_FOUND','Key 不存在',404);
    if(input.enabled!==undefined&&typeof input.enabled!=='boolean')fail('INVALID_INPUT','启用状态必须为布尔值');
    this.run('UPDATE keys SET label=?,enabled=?,weight=?,cooldown_until=?,last_error=? WHERE id=?',
      input.label===undefined?row.label:str(input.label,'备注',1,256),input.enabled===undefined?row.enabled:Number(input.enabled),
      input.weight===undefined?row.weight:integer(input.weight,'优先级',0,100),input.enabled===true?0:row.cooldown_until,input.enabled===true?null:row.last_error,keyId);
    if(input.quotas!==undefined){
      if(!input.quotas||typeof input.quotas!=='object'||Array.isArray(input.quotas))fail('INVALID_INPUT','额度格式不正确');
      for(const [m,v]of Object.entries(input.quotas)){
        const q=this.one('SELECT * FROM quotas WHERE key_id=? AND model=?',keyId,m);
        if(!q)fail('MODEL_UNSUPPORTED','不能修改未启用模型的额度');
        const total=units(m,v);if(total<q.used+q.held)fail('QUOTA_BELOW_USAGE','总额度不能小于已用加预占');
        this.run('UPDATE quotas SET total=? WHERE key_id=? AND model=?',total,keyId,m);
      }
    }
    this.audit('key.edit',keyId,{fields:Object.keys(input)});return this.keyDto(this.one('SELECT * FROM keys WHERE id=?',keyId));
  });}
  templates(input){if(input===undefined)return this.getMeta('templates');return this.tx(()=>{const next=this.getMeta('templates');for(const [m,v]of Object.entries(input))next[model(m).id]=units(m,v)/model(m).factor;this.setMeta('templates',next);this.audit('template.edit',null);return next;});}
  importPackage(pack){return this.tx(()=>{
    const old=this.one('SELECT id FROM packages WHERE digest=?',pack.digest);if(old)return {id:old.id,added:0,skipped:pack.keys.length,repeated:true};
    if(this.one('SELECT id FROM packages WHERE signed_id=?',pack.signedId))fail('PACKAGE_ID_CONFLICT','此 Key 包编号已存在，但文件内容不同',409);
    const packageId=id('pkg'),results=pack.keys.map(k=>this.insertKey(k,packageId)),added=results.filter(r=>r.added).length;
    this.run('INSERT INTO packages VALUES(?,?,?,?,?,?,?,?)',packageId,pack.signedId,str(pack.label,'包备注',1,128),pack.digest,this.vault.seal(pack.raw,'package:'+packageId),pack.keys.length,added,Date.now());
    this.audit('package.import',packageId,{signedId:pack.signedId,added});return {id:packageId,added,skipped:pack.keys.length-added};
  });}
  packages(){return this.all('SELECT id,signed_id AS packageId,label,key_count AS keyCount,imported_count AS importedCount,created_at AS createdAt FROM packages ORDER BY created_at DESC LIMIT 100');}
  packageFile(packageId){const row=this.one('SELECT * FROM packages WHERE id=?',packageId);if(!row)fail('NOT_FOUND','备份不存在',404);this.audit('package.download',packageId);return {raw:this.vault.open(row.content,'package:'+packageId),name:row.signed_id.replace(/[^a-zA-Z0-9_-]/g,'_')+'.aigckeypack'};}
  reserve({model:modelId,units:amount,kind,idem,digest,relayKeyId='legacy',meter={}}){return this.tx(()=>{
    this.checkRelayKey(relayKeyId,modelId);
    idem='scope:'+hash(JSON.stringify([relayKeyId,idem]));
    integer(amount,'预占额度',1,1e13);
    const prior=this.one('SELECT * FROM requests WHERE idem=?',idem);
    if(prior){if(prior.digest!==digest)fail('IDEMPOTENCY_CONFLICT','相同幂等键不能用于不同请求',409);return {request:prior,replayed:true};}
    if(this.one('SELECT count(*) AS n FROM requests').n>=100000)fail('REQUEST_LIMIT','请求记录已达上限，请先归档数据库',503);
    const key=this.one("SELECT k.* FROM keys k JOIN quotas q ON q.key_id=k.id WHERE k.enabled=1 AND k.cooldown_until<=? AND q.model=? AND q.total-q.used-q.held>=? AND (SELECT count(*) FROM requests r WHERE r.key_id=k.id AND r.state IN ('sending','submitted','unknown'))<2 ORDER BY k.weight DESC,k.last_used ASC,k.created_at ASC LIMIT 1",Date.now(),modelId,amount);
    if(!key)fail('POOL_UNAVAILABLE','没有启用且额度充足的可用 Key',429);
    const billing=this.moneyHold(relayKeyId,modelId,amount,meter);
    const requestId=id('req'),now=Date.now();
    this.run('UPDATE quotas SET held=held+? WHERE key_id=? AND model=?',amount,key.id,modelId);
    this.run('UPDATE keys SET last_used=? WHERE id=?',now,key.id);
    this.run("INSERT INTO requests(id,idem,digest,key_id,model,kind,state,reserved,created_at,updated_at) VALUES(?,?,?,?,?,?,'sending',?,?,?)",requestId,idem,digest,key.id,modelId,kind,amount,now,now);
    this.run('UPDATE requests SET relay_key_id=?,reserved_cost=?,price_snapshot=? WHERE id=?',relayKeyId,billing.micro,billing.snapshot?JSON.stringify(billing.snapshot):null,requestId);
    return {request:this.one('SELECT * FROM requests WHERE id=?',requestId),key:this.keySecret(key.id),replayed:false};
  });}
  getRequest(requestId){return this.one('SELECT * FROM requests WHERE id=? OR task_id=?',requestId,requestId);}
  requestDto(r){if(!r)return null;const m=model(r.model);return {id:r.id,keyId:r.key_id,relayKeyId:r.relay_key_id,relayKeyLabel:this.one('SELECT label FROM relay_keys WHERE id=?',r.relay_key_id)?.label||'旧版共享令牌',billingMode:r.price_snapshot?'metered':'legacy',reservedCost:yuan(r.reserved_cost),cost:yuan(r.charged),billingUsage:r.billing_usage?JSON.parse(r.billing_usage):null,model:r.model,kind:r.kind,state:r.state,reserved:r.reserved/m.factor,actual:r.actual===null?null:r.actual/m.factor,unit:m.unit,taskId:r.task_id,errorCode:r.error_code,reason:r.reason,createdAt:r.created_at,updatedAt:r.updated_at};}
  result(r){return r.result?JSON.parse(this.vault.open(r.result,'result:'+r.id)):null;}
  settle(requestId,actual,result,httpStatus=200,state='succeeded',reason=null,billingUsage=null){return this.tx(()=>{
    const r=this.getRequest(requestId);if(!r)fail('NOT_FOUND','请求不存在',404);if(['succeeded','failed','reconciled'].includes(r.state))return this.requestDto(r);
    integer(actual,'实际用量',0,1e13);
    this.moneySettle(r,actual,result,state,billingUsage);
    this.run('UPDATE quotas SET held=held-?,used=used+? WHERE key_id=? AND model=?',r.reserved,actual,r.key_id,r.model);
    this.run('UPDATE requests SET state=?,actual=?,result=?,http_status=?,error_code=?,reason=?,updated_at=? WHERE id=?',state,actual,this.vault.seal(JSON.stringify(result),'result:'+r.id),httpStatus,result?.error?.code||null,reason,Date.now(),r.id);
    this.audit('request.'+state,r.id,{actual,reason});return this.requestDto(this.getRequest(r.id));
  });}
  unknown(requestId,code='RESULT_UNKNOWN'){this.run("UPDATE requests SET state='unknown',error_code=?,updated_at=? WHERE id=? AND state IN ('sending','submitted')",code,Date.now(),requestId);}
  submitted(requestId,taskId){str(taskId,'上游任务 ID',1,128);if(!/^[a-zA-Z0-9_-]+$/.test(taskId))fail('TASK_INVALID','上游任务 ID 无效',502);this.run("UPDATE requests SET state='submitted',task_id=?,updated_at=? WHERE id=? AND state='sending'",taskId,Date.now(),requestId);}
  pending(){return this.all("SELECT * FROM requests WHERE state='submitted' ORDER BY updated_at ASC LIMIT 20");}
  touch(requestId){this.run('UPDATE requests SET updated_at=? WHERE id=?',Date.now(),requestId);}
  coolDown(keyId,code){this.run('UPDATE keys SET cooldown_until=?,last_error=? WHERE id=?',Date.now()+60000,code,keyId);}
  requests(state='',page=1,relayKeyId=''){integer(page,'页码',1,100000);const allowed=['sending','submitted','unknown','succeeded','failed','reconciled'];if(state&&!allowed.includes(state))fail('INVALID_INPUT','请求状态无效');const conditions=[],args=[];if(state){conditions.push('state=?');args.push(state);}if(relayKeyId){conditions.push('relay_key_id=?');args.push(relayKeyId);}const where=conditions.length?'WHERE '+conditions.join(' AND '):'';return {page,total:this.one('SELECT count(*) AS n FROM requests '+where,...args).n,items:this.all('SELECT * FROM requests '+where+' ORDER BY created_at DESC LIMIT 30 OFFSET ?',...args,(page-1)*30).map(r=>this.requestDto(r))};}
  reconcile(requestId,actual,reason,billingUsage=null){return this.txReconcile(requestId,actual,reason,billingUsage);}
  txReconcile(requestId,actual,reason,billingUsage){
    const r=this.getRequest(requestId);if(!r)fail('NOT_FOUND','请求不存在',404);if(r.state!=='unknown')fail('STATE_CONFLICT','只可核对结果不明的请求',409);
    const n=units(r.model,actual),note=str(reason,'核对依据',3,500);
    // 同一进程中同步事务结算；未确认的上游请求不会被自动重发。
    return this.settle(r.id,n,{id:r.id,status:'reconciled',actual:n/model(r.model).factor},200,'reconciled',note,billingUsage);
  }
  overview(){return {keys:this.one('SELECT count(*) AS n,sum(enabled) AS enabled FROM keys'),states:this.all('SELECT state,count(*) AS count FROM requests GROUP BY state'),quotas:this.all('SELECT model,sum(total) AS total,sum(used) AS used,sum(held) AS held FROM quotas GROUP BY model').map(q=>{const m=model(q.model);return {...q,total:q.total/m.factor,used:q.used/m.factor,held:q.held/m.factor,unit:m.unit};}),packages:this.one('SELECT count(*) AS n FROM packages').n};}
  sessionCreate(){const token=random(),csrf=random(),expires=Date.now()+8*3600000;this.run('DELETE FROM sessions WHERE expires<?',Date.now());this.run('INSERT INTO sessions VALUES(?,?,?)',hash(token),csrf,expires);return {token,csrf,expires};}
  session(token){return token?this.one('SELECT csrf,expires FROM sessions WHERE token_hash=? AND expires>?',hash(token),Date.now()):null;}
  sessionDelete(token){this.run('DELETE FROM sessions WHERE token_hash=?',hash(token||''));}
  lease(owner){this.tx(()=>{const current=this.getMeta('lease');if(current&&current.expires>Date.now()&&current.owner!==owner)fail('INSTANCE_ACTIVE','同一数据库已有运行实例，请等待旧实例退出',500);this.setMeta('lease',{owner,expires:Date.now()+60000});this.run("UPDATE requests SET state='unknown',error_code='PROCESS_INTERRUPTED',updated_at=? WHERE state='sending'",Date.now());});}
  heartbeat(owner){this.tx(()=>{if(this.getMeta('lease')?.owner!==owner)fail('LEASE_LOST','实例锁丢失',500);this.setMeta('lease',{owner,expires:Date.now()+60000});});}
  release(owner){if(this.getMeta('lease')?.owner===owner)this.setMeta('lease',null);}
  close(){this.db.close();}
}
Object.assign(Store.prototype,relayKeyStore.methods);
module.exports={Store};

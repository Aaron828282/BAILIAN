'use strict';
const {fail,str,integer,hash,id,random}=require('./common.cjs');
const {MODELS,model}=require('./catalog.cjs');
const {money,yuan,tariffCatalog,validTariff,normalizeRates,charge,quote}=require('./billing.cjs');
function migrate(store){
  store.tx(()=>{
    store.db.exec([
      "CREATE TABLE IF NOT EXISTS relay_keys(id TEXT PRIMARY KEY,token_hash TEXT UNIQUE NOT NULL,secret TEXT NOT NULL,masked TEXT NOT NULL,label TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 1,mode TEXT NOT NULL DEFAULT 'metered',credit INTEGER NOT NULL DEFAULT 0 CHECK(credit>=0),spent INTEGER NOT NULL DEFAULT 0 CHECK(spent>=0),held INTEGER NOT NULL DEFAULT 0 CHECK(held>=0),models TEXT NOT NULL,expires_at INTEGER,created_at INTEGER NOT NULL,last_used INTEGER)",
      'CREATE TABLE IF NOT EXISTS prices(model TEXT NOT NULL,variant TEXT NOT NULL,rates TEXT,updated_at INTEGER NOT NULL,PRIMARY KEY(model,variant))',
      'CREATE TABLE IF NOT EXISTS billing_ledger(id INTEGER PRIMARY KEY,relay_key_id TEXT NOT NULL,request_id TEXT,kind TEXT NOT NULL,amount INTEGER NOT NULL,created_at INTEGER NOT NULL)'
    ].join(';'));
    const columns=store.all('PRAGMA table_info(requests)').map(c=>c.name);
    for(const [name,type]of Object.entries({relay_key_id:"TEXT NOT NULL DEFAULT 'legacy'",reserved_cost:'INTEGER NOT NULL DEFAULT 0',charged:'INTEGER',price_snapshot:'TEXT',billing_usage:'TEXT'})){
      if(!columns.includes(name))store.db.exec('ALTER TABLE requests ADD COLUMN '+name+' '+type);
    }
    store.db.exec('CREATE INDEX IF NOT EXISTS request_client ON requests(relay_key_id,created_at)');
    if(!store.getMeta('scoped_idempotency_v1')){
      for(const r of store.all('SELECT id,idem FROM requests'))store.run('UPDATE requests SET idem=? WHERE id=?','scope:'+hash(JSON.stringify(['legacy',r.idem])),r.id);
      store.setMeta('scoped_idempotency_v1',true);
    }
  });
}
function selectedModels(value){if(!Array.isArray(value)||!value.length||value.length>MODELS.length)fail('MODELS_INVALID','请选择至少一个可用模型');return [...new Set(value.map(m=>model(m).id))];}
function expiration(value){if(value===null||value===undefined)return null;integer(value,'有效期',Date.now()+1000,Date.now()+10*365*86400000);return value;}
const methods={
  ensureLegacy(token){
    this.tx(()=>{
      const old=this.one("SELECT * FROM relay_keys WHERE id='legacy'"),digest=hash(token),secret=this.vault.seal(token,'relay:legacy'),masked=token.slice(0,8)+'…'+token.slice(-4);
      if(!old)this.run("INSERT INTO relay_keys(id,token_hash,secret,masked,label,mode,models,created_at) VALUES('legacy',?,?,?,'旧版共享令牌','legacy',?,?)",digest,secret,masked,JSON.stringify(MODELS.map(m=>m.id)),Date.now());
      else if(old.token_hash!==digest)this.run("UPDATE relay_keys SET token_hash=?,secret=?,masked=? WHERE id='legacy'",digest,secret,masked);
    });
  },
  relayKeyDto(row){
    if(!row)return null;
    return {id:row.id,label:row.label,masked:row.masked,enabled:!!row.enabled,mode:row.mode,models:JSON.parse(row.models),expiresAt:row.expires_at,createdAt:row.created_at,lastUsed:row.last_used,
      credit:yuan(row.credit),spent:yuan(row.spent),held:yuan(row.held),balance:yuan(row.credit-row.spent),available:yuan(Math.max(0,row.credit-row.spent-row.held)),
      requests:this.one('SELECT count(*) AS n FROM requests WHERE relay_key_id=?',row.id).n};
  },
  relayKeys(page=1){integer(page,'页码',1,100000);return {page,total:this.one('SELECT count(*) AS n FROM relay_keys').n,items:this.all("SELECT * FROM relay_keys ORDER BY CASE WHEN id='legacy' THEN 1 ELSE 0 END,created_at DESC LIMIT 20 OFFSET ?",(page-1)*20).map(r=>this.relayKeyDto(r))};},
  createRelayKey(input){return this.tx(()=>{
    if(this.one('SELECT count(*) AS n FROM relay_keys').n>=10000)fail('RELAY_KEY_LIMIT','中转 Key 已达到上限',409);
    const keyId=id('rk'),token='sk-relay-'+random(),credit=money(input.credit,'初始额度'),label=str(input.label,'名称',1,128),models=selectedModels(input.models),expiresAt=expiration(input.expiresAt);
    this.run('INSERT INTO relay_keys(id,token_hash,secret,masked,label,credit,models,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?)',keyId,hash(token),this.vault.seal(token,'relay:'+keyId),token.slice(0,12)+'…'+token.slice(-4),label,credit,JSON.stringify(models),expiresAt,Date.now());
    this.run("INSERT INTO billing_ledger(relay_key_id,kind,amount,created_at) VALUES(?,'credit',?,?)",keyId,credit,Date.now());
    this.audit('relay_key.create',keyId,{credit,models});return {key:this.relayKeyDto(this.one('SELECT * FROM relay_keys WHERE id=?',keyId)),token};
  });},
  editRelayKey(keyId,input){return this.tx(()=>{
    const row=this.one('SELECT * FROM relay_keys WHERE id=?',keyId);if(!row)fail('NOT_FOUND','中转 Key 不存在',404);
    if(input.enabled!==undefined&&typeof input.enabled!=='boolean')fail('INVALID_INPUT','启停状态无效');
    if(row.mode==='legacy'&&(input.credit!==undefined||input.models!==undefined||input.expiresAt!==undefined))fail('LEGACY_KEY','旧版共享令牌仅支持改名和启停');
    const credit=input.credit===undefined?row.credit:money(input.credit,'累计额度');
    if(credit<row.spent+row.held)fail('CREDIT_BELOW_USAGE','累计额度不能低于已消费与预占之和');
    const models=input.models===undefined?JSON.parse(row.models):selectedModels(input.models);
    const expiresAt=input.expiresAt===undefined?row.expires_at:expiration(input.expiresAt);
    this.run('UPDATE relay_keys SET label=?,enabled=?,credit=?,models=?,expires_at=? WHERE id=?',input.label===undefined?row.label:str(input.label,'名称',1,128),input.enabled===undefined?row.enabled:Number(input.enabled),credit,JSON.stringify(models),expiresAt,keyId);
    if(credit!==row.credit)this.run("INSERT INTO billing_ledger(relay_key_id,kind,amount,created_at) VALUES(?,'credit_adjustment',?,?)",keyId,credit-row.credit,Date.now());
    this.audit('relay_key.edit',keyId,{fields:Object.keys(input)});return this.relayKeyDto(this.one('SELECT * FROM relay_keys WHERE id=?',keyId));
  });},
  addRelayCredit(keyId,value){return this.tx(()=>{
    const amount=money(value,'增加额度');if(!amount)fail('MONEY_INVALID','增加额度必须大于 0');
    const row=this.one('SELECT * FROM relay_keys WHERE id=?',keyId);if(!row)fail('NOT_FOUND','中转 Key 不存在',404);if(row.mode==='legacy')fail('LEGACY_KEY','旧版共享令牌不使用余额');
    if(row.credit+amount>100000000000000)fail('MONEY_INVALID','累计额度超过上限');
    this.run('UPDATE relay_keys SET credit=credit+? WHERE id=?',amount,keyId);
    this.run("INSERT INTO billing_ledger(relay_key_id,kind,amount,created_at) VALUES(?,'credit_adjustment',?,?)",keyId,amount,Date.now());this.audit('relay_key.credit',keyId,{amount});
    return this.relayKeyDto(this.one('SELECT * FROM relay_keys WHERE id=?',keyId));
  });},
  relayKeyToken(keyId){const row=this.one('SELECT * FROM relay_keys WHERE id=?',keyId);if(!row)fail('NOT_FOUND','中转 Key 不存在',404);this.audit('relay_key.reveal',keyId);return this.vault.open(row.secret,'relay:'+keyId);},
  authenticateRelay(token){
    if(typeof token!=='string'||token.length<32||token.length>256)fail('UNAUTHORIZED','中转 Key 无效或已停用',401);
    const row=this.one('SELECT * FROM relay_keys WHERE token_hash=?',hash(token));
    if(!row||!row.enabled||(row.expires_at!==null&&row.expires_at<=Date.now()))fail('UNAUTHORIZED','中转 Key 无效、已停用或已过期',401);
    return row;
  },
  pricing(){
    return {currency:'CNY',basis:'custom',items:tariffCatalog().map(t=>{const r=this.one('SELECT * FROM prices WHERE model=? AND variant=?',t.model,t.variant);return {...t,rates:r?.rates?Object.fromEntries(Object.entries(JSON.parse(r.rates)).map(([k,v])=>[k,yuan(v)])):null,updatedAt:r?.updated_at||null};})};
  },
  savePricing(rows){if(!Array.isArray(rows)||!rows.length||rows.length>30)fail('PRICES_INVALID','计费标准格式不正确');return this.tx(()=>{
    const seen=new Set();
    for(const row of rows){
      const m=validTariff(row.model,row.variant),rates=normalizeRates(m.kind,row.rates),key=row.model+':'+row.variant;
      if(seen.has(key))fail('PRICE_DUPLICATE','同一模型规格不能重复');seen.add(key);
      this.run('INSERT INTO prices(model,variant,rates,updated_at) VALUES(?,?,?,?) ON CONFLICT(model,variant) DO UPDATE SET rates=excluded.rates,updated_at=excluded.updated_at',m.id,row.variant,rates?JSON.stringify(rates):null,Date.now());
    }
    this.audit('pricing.update',null,{count:rows.length});return this.pricing();
  });},
  checkRelayKey(keyId,modelId){
    const row=this.one('SELECT * FROM relay_keys WHERE id=?',keyId);
    if(!row&&keyId==='legacy')return;
    if(!row||!row.enabled||(row.expires_at!==null&&row.expires_at<=Date.now()))fail('UNAUTHORIZED','中转 Key 已停用或过期',401);
    if(!JSON.parse(row.models).includes(modelId))fail('MODEL_FORBIDDEN','此中转 Key 无权调用该模型',403);
  },
  moneyHold(keyId,modelId,amount,meter={}){
    const row=this.one('SELECT * FROM relay_keys WHERE id=?',keyId);
    // 单元测试直接使用 Store 时没有兼容令牌；HTTP 必须先鉴权。
    if(!row&&keyId==='legacy')return {micro:0,snapshot:null};
    if(!row||!row.enabled||(row.expires_at!==null&&row.expires_at<=Date.now()))fail('UNAUTHORIZED','中转 Key 已停用或过期',401);
    if(!JSON.parse(row.models).includes(modelId))fail('MODEL_FORBIDDEN','此中转 Key 无权调用该模型',403);
    if(row.mode==='legacy')return {micro:0,snapshot:null};
    const m=model(modelId),variant=m.kind==='video'?meter.variant:'default',price=this.one('SELECT * FROM prices WHERE model=? AND variant=?',modelId,variant);
    if(!price?.rates)fail('PRICE_NOT_CONFIGURED','该模型规格尚未配置计费标准',503);
    const snapshot={model:modelId,kind:m.kind,variant,rates:JSON.parse(price.rates),version:price.updated_at,currency:'CNY'};
    const micro=quote(snapshot,amount,meter);
    if(row.credit-row.spent-row.held<micro)fail('INSUFFICIENT_BALANCE','中转 Key 可用余额不足',402);
    this.run('UPDATE relay_keys SET held=held+?,last_used=? WHERE id=?',micro,Date.now(),keyId);return {micro,snapshot};
  },
  moneySettle(r,actual,result,state,usage){
    if(!r.price_snapshot)return;
    const snapshot=JSON.parse(r.price_snapshot),settlement=state==='failed'?{micro:0,usage:{}}:charge(snapshot,actual,usage||result?.usage||{});
    const row=this.one('SELECT * FROM relay_keys WHERE id=?',r.relay_key_id);if(!row)fail('BILLING_ACCOUNT_MISSING','计费账户丢失',500);
    if(!Number.isSafeInteger(row.spent+settlement.micro))fail('BILLING_OVERFLOW','累计计费金额超出精度范围',500);
    this.run('UPDATE relay_keys SET held=held-?,spent=spent+? WHERE id=?',r.reserved_cost,settlement.micro,r.relay_key_id);
    this.run('UPDATE requests SET charged=?,billing_usage=? WHERE id=?',settlement.micro,JSON.stringify(settlement.usage),r.id);
    this.run("INSERT INTO billing_ledger(relay_key_id,request_id,kind,amount,created_at) VALUES(?,?,'charge',?,?)",r.relay_key_id,r.id,-settlement.micro,Date.now());
  }
};
module.exports={migrate,methods};

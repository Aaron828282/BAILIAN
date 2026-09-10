'use strict';
let relayKeyRows=[],priceRows=[];
const moneyFmt=value=>Number(value||0).toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:6});
function renderRelayKeys(data){
  relayKeyRows=data.items;
  $('#content').innerHTML='<div class="notice">中转 Key 提供给调用方；号池中的阿里 Key 留在服务器。每个中转 Key 独立计费、限制模型，并只能查询自己的请求。</div><div class="panel"><div class="panel-head"><div><h3>中转 Key 管理</h3><p class="muted">创建 → 设置余额与模型 → 复制 Key 和 Base URL 给调用方。</p></div><button class="primary" data-billing="create">＋ 创建中转 Key</button></div>'+
    (data.items.length?'<div class="table-wrap"><table><thead><tr><th>名称 / 中转 KEY</th><th>状态 / 模型</th><th>可用余额</th><th>已消费 / 预占</th><th>调用次数</th><th>操作</th></tr></thead><tbody>'+data.items.map(k=>'<tr><td><div class="key-label">'+esc(k.label)+'</div><span class="mono muted">'+esc(k.masked)+'</span><div class="subline">'+(k.mode==='legacy'?'兼容旧接入 · 不计费':k.expiresAt?'到期 '+date(k.expiresAt):'长期有效')+'</div></td><td><span class="pill '+(!k.enabled?'off':k.expiresAt&&k.expiresAt<=Date.now()?'warn':'')+'">'+(!k.enabled?'已停用':k.expiresAt&&k.expiresAt<=Date.now()?'已过期':'已启用')+'</span><div class="subline">'+k.models.length+' 个模型</div></td><td class="money-value">'+(k.mode==='legacy'?'—':'¥ '+moneyFmt(k.available))+'</td><td>'+(k.mode==='legacy'?'<span class="muted">未计费</span>':'¥ '+moneyFmt(k.spent)+'<div class="subline">预占 ¥ '+moneyFmt(k.held)+'</div>')+'</td><td>'+fmt(k.requests)+'</td><td><div class="billing-row-actions"><button class="table-btn" data-billing="copy" data-id="'+esc(k.id)+'">复制 Key</button><button class="table-btn" data-billing="edit" data-id="'+esc(k.id)+'">编辑</button>'+(k.mode==='legacy'?'':'<button class="table-btn" data-billing="credit" data-id="'+esc(k.id)+'">增加额度</button>')+'<button class="table-btn" data-billing="toggle" data-id="'+esc(k.id)+'">'+(k.enabled?'停用':'启用')+'</button><button class="table-btn" data-billing="requests" data-id="'+esc(k.id)+'">调用记录</button></div></td></tr>').join('')+'</tbody></table></div>':empty('还没有中转 Key','创建一个独立 Key，供应用通过本站调用百炼模型。'))+pager(data.total,20)+'</div>'+
    (data.items.some(k=>k.mode==='legacy'&&k.enabled)?'<div class="notice warn">旧版共享令牌保留原来的不计费行为。切换到新建的计费 Key 后，可在此停用旧令牌。</div>':'');
}
function renderPricing(data){
  priceRows=data.items;
  $('#content').innerHTML='<form id="pricing-form"><div class="panel"><div class="panel-head"><div><h3>本站中转售价 · 人民币</h3><p class="muted">自定义售价，和阿里官方账单分开。修改只影响新请求。</p></div><button class="primary" type="submit">保存计费标准</button></div><div class="details"><div class="notice">空白表示尚未配置，该规格不能通过计费 Key 调用；明确填写 0 才表示免费。文本区分输入与输出，图片按张，视频按分辨率和秒数。费用精确到 0.000001 元。</div><span class="form-error" role="alert"></span></div></div>'+
  ['text','image','video'].map(kind=>'<div class="panel"><div class="panel-head"><h3>'+({text:'文本 · 元 / 百万 Token',image:'图片 · 元 / 张',video:'视频 · 元 / 秒'}[kind])+'</h3><span class="muted">'+(kind==='video'?'按实际输出视频时长结算':'按上游返回的实际用量结算')+'</span></div><div class="table-wrap"><table class="price-table"><thead><tr><th>模型</th><th>规格</th>'+(kind==='text'?'<th>输入单价</th><th>输出单价</th>':'<th>单价</th>')+'<th>状态</th></tr></thead><tbody>'+data.items.filter(p=>p.kind===kind).map(p=>'<tr data-price-model="'+esc(p.model)+'" data-price-variant="'+p.variant+'"><td class="mono">'+esc(p.model)+'</td><td>'+({default:kind==='image'?'每张图片':'文本'}[p.variant]||p.variant)+'</td>'+(kind==='text'?['input','output']:['unit']).map(field=>'<td><input aria-label="'+esc(p.model)+' '+p.variant+' '+field+'" name="'+field+'" type="number" min="0" max="100000000" step="0.000001" placeholder="未配置" value="'+(p.rates===null?'':esc(p.rates[field]))+'"></td>').join('')+'<td><span class="pill '+(p.rates===null?'off':'')+'">'+(p.rates===null?'未配置':'已配置')+'</span></td></tr>').join('')+'</tbody></table></div></div>').join('')+'</form>';
}
function localDatetime(value){return value?new Date(value-new Date(value).getTimezoneOffset()*60000).toISOString().slice(0,16):'';}
function relayKeyDialog(k=null){
  const legacy=k?.mode==='legacy';
  modal(k?'编辑中转 Key':'创建中转 Key','<form id="relay-key-form" '+(k?'data-id="'+esc(k.id)+'"':'')+'><div class="form-grid"><label class="wide">名称<input name="label" maxlength="128" placeholder="例如：我的客户端 / 客户 A" value="'+esc(k?.label||'')+'" required></label>'+
    (!k?'<label>初始额度（元）<input name="credit" type="number" min="0" max="100000000" step="0.000001" placeholder="填写授予的调用额度" required></label>':'')+
    (!legacy?'<label>有效期（可留空）<input name="expiresAt" type="datetime-local" value="'+localDatetime(k?.expiresAt)+'"></label>':'')+'</div>'+
    (!legacy?'<p class="section-label">允许调用的模型</p><div class="checks">'+session.models.map(m=>'<label><input type="checkbox" name="allowedModel" value="'+esc(m.id)+'" '+(!k||k.models.includes(m.id)?'checked':'')+'><span>'+esc(m.id)+'</span></label>').join('')+'</div><div class="notice">调用时同时检查本站售价、中转 Key 余额及阿里号池剩余额度。未配置单价的模型无法通过计费 Key 调用。</div>':'<div class="notice warn">这是初始化时生成的旧共享令牌，保持不计费以兼容旧接入。请为新的调用方创建独立的计费 Key。</div>')+
    formEnd(k?'保存修改':'生成中转 Key')+'</form>');
}
function tokenDialog(token,title='中转 Key'){
  modal(title,'<div class="notice">在调用软件里填写以下 Base URL 和 Key。仅分享给相应调用方。</div><label>Base URL<input id="issued-base" readonly value="'+esc(session.baseUrl)+'"></label><label>中转 Key<textarea id="issued-token" class="mono" readonly spellcheck="false">'+esc(token)+'</textarea></label><div class="form-end"><button type="button" class="secondary" data-billing="copy-base">复制 Base URL</button><button type="button" class="primary" data-billing="copy-issued">复制中转 Key</button></div>');
}
async function copyIssued(value,selector){
  try{await navigator.clipboard.writeText(value);toast('已复制');}catch{const input=$(selector);if(input){input.focus();input.select();toast('已选中，请按 Ctrl+C 复制');}else throw Error('浏览器未允许复制，请重试');}
}
document.addEventListener('click',async ev=>{
  const btn=ev.target.closest('[data-billing]');if(!btn)return;
  const action=btn.dataset.billing,k=relayKeyRows.find(row=>row.id===btn.dataset.id);btn.disabled=true;
  try{
    if(action==='create')relayKeyDialog();
    if(action==='edit')relayKeyDialog(k);
    if(action==='copy'){const data=await api('/api/relay-keys/'+k.id+'/token',{method:'POST'});tokenDialog(data.token,k.label+' · 中转 Key');}
    if(action==='copy-issued')await copyIssued($('#issued-token').value,'#issued-token');
    if(action==='copy-base')await copyIssued($('#issued-base').value,'#issued-base');
    if(action==='toggle'){await api('/api/relay-keys/'+k.id,{method:'PATCH',data:{enabled:!k.enabled}});toast(k.enabled?'中转 Key 已停用':'中转 Key 已启用');await load();}
    if(action==='credit')modal('增加调用额度','<form id="relay-credit-form" data-id="'+esc(k.id)+'"><p class="key-label">'+esc(k.label)+'</p><p class="muted">当前可用 ¥ '+moneyFmt(k.available)+' · 已消费 ¥ '+moneyFmt(k.spent)+'</p><label>本次增加额度（元）<input name="amount" type="number" min="0.000001" step="0.000001" max="100000000" required></label><p class="muted">这只调整本站授予的调用额度，不发生外部支付。</p>'+formEnd('确认增加额度')+'</form>');
    if(action==='requests'){relayKeyFilter=k.id;view='requests';page=1;await load();}
    if(action==='clear-filter'){relayKeyFilter='';page=1;await load();}
    if(action==='go-keys'){view='relayKeys';page=1;await load();}
    if(action==='go-pricing'){view='pricing';page=1;await load();}
  }catch(e){toast(e.message,true);}finally{btn.disabled=false;}
});
document.addEventListener('submit',async ev=>{
  const form=ev.target;if(!['pricing-form','relay-key-form','relay-credit-form'].includes(form.id))return;
  ev.preventDefault();const btn=$('[type=submit]',form),error=$('.form-error',form);btn.disabled=true;if(error)error.textContent='';
  try{
    const values=Object.fromEntries(new FormData(form));
    if(form.id==='pricing-form'){
      const items=$$('tr[data-price-model]',form).map(row=>({model:row.dataset.priceModel,variant:row.dataset.priceVariant,rates:Object.fromEntries($$('input',row).map(i=>[i.name,i.value===''?null:i.value]))}));
      await api('/api/pricing',{method:'PATCH',data:{items}});toast('计费标准已保存，仅影响新请求');await load();return;
    }
    if(form.id==='relay-credit-form'){await api('/api/relay-keys/'+form.dataset.id+'/credit',{method:'POST',data:{amount:values.amount}});$('#modal').close();toast('调用额度已增加');await load();return;}
    const k=relayKeyRows.find(row=>row.id===form.dataset.id),data={label:values.label};
    if(k?.mode!=='legacy'){data.models=$$('input[name=allowedModel]:checked',form).map(i=>i.value);if(!data.models.length)throw Error('至少选择一个模型');data.expiresAt=values.expiresAt?new Date(values.expiresAt).getTime():null;}
    if(form.dataset.id){await api('/api/relay-keys/'+form.dataset.id,{method:'PATCH',data});$('#modal').close();toast('中转 Key 已更新');await load();}
    else{data.credit=values.credit;const result=await api('/api/relay-keys',{method:'POST',data});tokenDialog(result.token,'中转 Key 已创建');await load();}
  }catch(e){if(error)error.textContent=e.message;else toast(e.message,true);}finally{btn.disabled=false;}
});

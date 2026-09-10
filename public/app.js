'use strict';
const $=(q,root=document)=>root.querySelector(q),$$=(q,root=document)=>[...root.querySelectorAll(q)];
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt=v=>Number(v||0).toLocaleString('zh-CN',{maximumFractionDigits:3});
const date=v=>new Date(v).toLocaleString('zh-CN',{hour12:false});
let packagePreviewVersion=0;
let session=null,view='keys',page=1,query='',filter='',currentKeys=[],relayKeyFilter='',packageRaw='',loadId=0,toastTimer;
const names={relayKeys:'中转 Key',pricing:'计费标准',keys:'Key 号池',templates:'额度预设',packages:'加密 Key 包',requests:'请求与核对',access:'接口接入'};
const subtitles={relayKeys:'创建调用凭据，按 Key 管理余额、权限和消费记录。',pricing:'设置本站各模型的计费单价，所有金额以人民币计算。',keys:'统一管理百炼 API Key，按模型额度自动分配请求。',templates:'设置新导入 Key 的起始预算，已有 Key 的额度保持不变。',packages:'解密现有加密包，导入 Key 并保留原文件备份。',requests:'查看转发状态、实际用量与需要人工核对的请求。',access:'获取独立中转地址与访问令牌。'};
const statusNames={sending:'发送中',submitted:'视频处理中',unknown:'待核对',succeeded:'已完成',failed:'已失败',reconciled:'已核对'};
async function api(url,{method='GET',data,raw=false}={}){
  const headers={};if(data!==undefined)headers['Content-Type']='application/json';
  if(method!=='GET')headers['X-CSRF-Token']=session?.csrf||'';
  const res=await fetch(url,{method,headers,body:data===undefined?undefined:JSON.stringify(data),credentials:'same-origin'});
  if(!res.ok){const err=await res.json().catch(()=>({}));if(res.status===401&&url!=='/api/login')showLogin();throw Error(err.error?.message||'请求失败');}
  return raw?res:res.json();
}
function toast(message,bad=false){clearTimeout(toastTimer);$('#toast').textContent=message;$('#toast').className=bad?'error-toast':'';$('#toast').hidden=false;toastTimer=setTimeout(()=>$('#toast').hidden=true,4500);}
function showLogin(){session=null;$('#workspace').hidden=true;$('#login').hidden=false;$('#modal').close();}
function showWorkspace(){ $('#login').hidden=true;$('#workspace').hidden=false;load();}
function modal(title,html){$('#modal-title').textContent=title;$('#modal-content').innerHTML=html;$('#modal').showModal();}
function formEnd(label){return '<div class="form-end"><span class="form-error" role="alert"></span><button class="primary" type="submit">'+label+'</button></div>';}
function empty(title,detail,action=''){return '<div class="empty"><div class="empty-symbol">▤</div><h3>'+esc(title)+'</h3><p>'+esc(detail)+'</p>'+action+'</div>';}
function pager(total,size){return '<div class="pager"><span>共 '+fmt(total)+' 条 · 第 '+page+' 页</span><div class="actions"><button class="secondary" data-action="prev" '+(page<=1?'disabled':'')+'>上一页</button><button class="secondary" data-action="next" '+(page*size>=total?'disabled':'')+'>下一页</button></div></div>';}
function pill(state){return '<span class="pill '+(state==='unknown'?'warn':state==='failed'?'error':['sending','submitted'].includes(state)?'off':'')+'">'+esc(statusNames[state]||state)+'</span>';}
function stats(data){const count=s=>data.states.find(x=>x.state===s)?.count||0;$('#stats').innerHTML=[
  ['Key 总数',data.keys.n,'已启用 '+fmt(data.keys.enabled)+' 个','▤',''],
  ['处理中',count('sending')+count('submitted'),'预占额度已锁定','↻',''],
  ['待核对',count('unknown'),'结果或实际用量尚未确认','◷',count('unknown')?'alert':''],
  ['Key 包备份',data.packages,'按包编号保留原文件','▣','']
].map(([name,value,note,icon,cls])=>'<div class="stat '+cls+'"><div class="stat-label">'+name+'<span>'+icon+'</span></div><div class="stat-value">'+fmt(value)+'<small>个</small></div><div class="stat-note">'+note+'</div></div>').join('');}
async function load(){
  if(!session)return;const stamp=++loadId;
  $('#page-title').textContent=names[view];$('#breadcrumb').textContent=names[view];$('#page-subtitle').textContent=subtitles[view];
  $$('nav button').forEach(b=>b.classList.toggle('selected',b.dataset.view===view));
  $('#content').innerHTML='<div class="loading">正在读取工作台数据…</div>';
  try{
    const urls={relayKeys:'/api/relay-keys?page='+page,pricing:'/api/pricing',keys:'/api/keys?query='+encodeURIComponent(query)+'&page='+page,templates:'/api/templates',packages:'/api/packages',requests:'/api/requests?state='+filter+'&page='+page+'&relayKeyId='+encodeURIComponent(relayKeyFilter),access:'/api/session'};
    const [overview,data]=await Promise.all([api('/api/overview'),api(urls[view])]);if(stamp!==loadId||!session)return;
    stats(overview);({relayKeys:renderRelayKeys,pricing:renderPricing,keys:renderKeys,templates:renderTemplates,packages:renderPackages,requests:renderRequests,access:renderAccess}[view])(data);
  }catch(e){if(stamp===loadId)$('#content').innerHTML=empty('读取失败',e.message,'<button class="secondary" data-action="reload">重试</button>');}
}
function quotaSummary(key){return ['text','image','video'].map(kind=>{
  const qs=key.quotas.filter(q=>session.models.find(m=>m.id===q.model)?.kind===kind);if(!qs.length)return '';
  const total=qs.reduce((a,q)=>a+q.total,0),used=qs.reduce((a,q)=>a+q.used,0),held=qs.reduce((a,q)=>a+q.held,0);
  return '<div class="quota-line"><span>'+({text:'文本',image:'图片',video:'视频'}[kind])+'</span><b>'+fmt(Math.max(0,total-used-held))+' / '+fmt(total)+'</b><span>'+qs[0].unit+'</span></div>';
}).join('');}
function renderKeys(data){
  currentKeys=data.items;
  $('#content').innerHTML='<div class="panel"><div class="panel-head"><div><h3>API Key 列表</h3><p class="muted">优先级越大越先使用，同级按最近使用时间轮转。</p></div><div class="actions"><form id="search-form"><input class="search" name="query" aria-label="搜索 Key 备注" placeholder="搜索备注或 Key 编号" value="'+esc(query)+'"></form><button class="secondary" data-action="import">导入 Key 包</button><button class="primary" data-action="add">＋ 添加 Key</button></div></div>'+
  (data.items.length?'<div class="table-wrap"><table><thead><tr><th>KEY / 备注</th><th>接入区域</th><th>状态</th><th>可用 / 总额度</th><th>优先级</th><th>操作</th></tr></thead><tbody>'+data.items.map(k=>'<tr><td><div class="key-label">'+esc(k.label)+'</div><span class="mono muted">'+esc(k.masked)+'</span><div class="subline">'+esc(k.id.slice(0,16))+'</div></td><td><span class="mono">'+esc(new URL(k.origin).hostname.replace('.aliyuncs.com',''))+'</span><div class="subline">'+k.quotas.length+' 个模型</div></td><td><span class="pill '+(!k.enabled?'off':k.cooldownUntil>Date.now()?'warn':'')+'">'+(!k.enabled?'已停用':k.cooldownUntil>Date.now()?'冷却中':'已启用')+'</span>'+(k.lastError?'<div class="subline">'+esc(k.lastError)+'</div>':'')+'</td><td><div class="quota-lines">'+quotaSummary(k)+'</div></td><td class="mono">'+k.weight+'</td><td><button class="table-btn" data-action="edit" data-id="'+esc(k.id)+'">额度 / 编辑</button><button class="table-btn" data-action="toggle" data-id="'+esc(k.id)+'">'+(k.enabled?'停用':'启用')+'</button></td></tr>').join('')+'</tbody></table></div>':empty('号池中还没有 Key','添加百炼 API Key，或直接解密导入现有 Key 包。','<button class="primary" data-action="import">导入加密包</button>'))+pager(data.total,20)+'</div><div class="notice">请求发送前预占额度，按阿里返回的实际用量结算。不同模型分别计量；Key 列表按类型汇总，详细额度可在“额度 / 编辑”查看。</div>';
}
function renderTemplates(data){
  $('#content').innerHTML='<div class="notice">这些数值是新 Key 的本地初始预算。调整后仅影响后续导入；已用和预占额度不会被清零。</div><form id="template-form" class="panel"><div class="panel-head"><div><h3>每 Key / 每模型默认额度</h3><p class="muted">文本按 Token，图片按张，视频按输出秒数。</p></div><button class="primary" type="submit">保存预设</button></div><div class="model-grid">'+session.models.map(m=>'<div class="model-item"><span class="tag">'+({text:'文本',image:'图片',video:'视频'}[m.kind])+'</span><h3 class="mono">'+esc(m.id)+'</h3><label>总额度<div class="input-unit"><input aria-label="'+esc(m.id)+' 额度" name="'+esc(m.id)+'" type="number" min="0" max="10000000000" step="'+(m.kind==='video'?'0.001':'1')+'" value="'+data[m.id]+'" required><span>'+m.unit+'</span></div></label></div>').join('')+'</div><div class="details form-error" role="alert"></div></form>';
}
function renderPackages(data){$('#content').innerHTML='<div class="panel"><div class="panel-head"><div><h3>已导入的加密 Key 包</h3><p class="muted">验签后解密。保留包原编号，原文件加密备份到服务器数据库。</p></div><button class="primary" data-action="import">＋ 导入 Key 包</button></div>'+(data.length?'<div class="table-wrap"><table><thead><tr><th>包编号 / 备注</th><th>包内 KEY</th><th>新增 KEY</th><th>导入时间</th><th>操作</th></tr></thead><tbody>'+data.map(p=>'<tr><td><div class="key-label mono">'+esc(p.packageId)+'</div><span class="muted">'+esc(p.label)+'</span></td><td>'+p.keyCount+'</td><td>'+p.importedCount+'</td><td>'+date(p.createdAt)+'</td><td><button class="table-btn" data-action="download" data-id="'+esc(p.id)+'">下载原包备份 ↓</button></td></tr>').join('')+'</tbody></table></div>':empty('尚无加密包备份','支持你现有的 .aigckeypack 文件。'))+'</div><div class="notice">重复包不会重复入库；同一 Key 出现在不同包里也不会重置额度。最近 100 个包在此展示，其余仍保存在数据库中。</div>';}
function renderRequests(data){
  $('#content').innerHTML=(relayKeyFilter?'<div class="notice">当前仅显示选定中转 Key 的调用记录。 <button class="table-btn" data-billing="clear-filter">显示全部</button></div>':'')+'<div class="panel"><div class="panel-head"><div><h3>中转请求记录</h3><p class="muted">不自动重发结果不明的生成请求。</p></div><select id="request-filter" aria-label="筛选请求状态"><option value="">全部状态</option>'+Object.entries(statusNames).map(([k,v])=>'<option value="'+k+'" '+(filter===k?'selected':'')+'>'+v+'</option>').join('')+'</select></div>'+(data.items.length?'<div class="table-wrap"><table><thead><tr><th>请求 / 模型</th><th>状态</th><th>中转 Key / 费用</th><th>预占用量</th><th>实际结算</th><th>创建时间</th><th>操作</th></tr></thead><tbody>'+data.items.map(r=>'<tr><td><div class="key-label mono">'+esc(r.model)+'</div><div class="subline mono" title="'+esc(r.id)+'">'+esc(r.id.slice(0,20))+'…</div>'+(r.taskId?'<div class="subline mono">上游 '+esc(r.taskId)+'</div>':'')+'</td><td>'+pill(r.state)+(r.errorCode?'<div class="subline">'+esc(r.errorCode)+'</div>':'')+(r.reason?'<div class="subline" title="'+esc(r.reason)+'">已记录核对依据</div>':'')+'</td><td><div>'+esc(r.relayKeyLabel)+'</div><div class="subline">'+(r.billingMode==='legacy'?'兼容令牌 · 未计费':r.cost===null?'待结算 · 预占 ¥ '+moneyFmt(r.reservedCost):'¥ '+moneyFmt(r.cost))+'</div>'+(r.billingUsage?.inputTokens!==undefined?'<div class="subline">输入 '+fmt(r.billingUsage.inputTokens)+' / 输出 '+fmt(r.billingUsage.outputTokens)+'</div>':'')+'</td><td>'+fmt(r.reserved)+' '+r.unit+'</td><td>'+(r.actual===null?'—':fmt(r.actual)+' '+r.unit)+'</td><td>'+date(r.createdAt)+'</td><td>'+(r.state==='unknown'?'<button class="table-btn" data-action="reconcile" data-id="'+esc(r.id)+'" data-kind="'+r.kind+'" data-metered="'+(r.billingMode==='metered')+'" data-unit="'+r.unit+'">记录实际用量</button>':'<span class="muted">—</span>')+'</td></tr>').join('')+'</tbody></table></div>':empty('暂无对应请求','请求记录将在调用中转接口后出现。'))+pager(data.total,30)+'</div><div class="notice warn">待核对请求仍占用额度。请先在阿里控制台确认任务和用量，再填写实际用量；只有确认未产生消耗时才填写 0。</div>';
}
function renderAccess(data){$('#content').innerHTML='<div class="details-grid"><div class="panel"><div class="panel-head"><h3>API 接入信息</h3><button class="primary" data-billing="go-keys">创建 / 管理中转 Key</button></div><div class="details"><p class="section-label">BASE URL</p><pre class="code-block">'+esc(data.baseUrl)+'</pre><p class="muted">先在“计费标准”填写单价，再在“中转 Key”创建调用凭据。请求头使用 Authorization: Bearer &lt;中转 Key&gt;。</p><div class="endpoint-row"><code>GET /models</code><span>模型目录</span></div><div class="endpoint-row"><code>POST /chat/completions</code><span>文本 / SSE</span></div><div class="endpoint-row"><code>POST /images/generations</code><span>单张图片</span></div><div class="endpoint-row"><code>POST /videos/generations</code><span>异步视频</span></div><div class="endpoint-row"><code>GET /tasks/{请求ID}</code><span>请求结果</span></div><p class="muted">图片、视频使用本站参数协议，详见部署包中的接口说明。</p></div></div><div class="panel"><div class="panel-head"><h3>文本请求示例</h3></div><div class="details"><pre class="code-block">curl '+esc(data.baseUrl)+'/chat/completions \\\n  -H "Authorization: Bearer YOUR_RELAY_TOKEN" \\\n  -H "Content-Type: application/json" \\\n  -H "Idempotency-Key: example-request-001" \\\n  -d \'{"model":"qwen-plus","messages":[{"role":"user","content":"你好"}],"max_tokens":1024}\'</pre><div class="notice">建议每次生成携带唯一 Idempotency-Key。网络重试沿用同一值，可查询或重放原结果。</div><button class="secondary" data-action="password">修改管理员密码</button></div></div></div>';}
async function addDialog(){
  const templates=await api('/api/templates');
  modal('添加百炼 API Key','<form id="add-form"><div class="form-grid"><label>备注前缀<input name="label" placeholder="例如：北京账号 A" maxlength="200" required></label><label>优先级<input name="weight" type="number" min="0" max="100" value="0" required></label><label class="wide">百炼官方接入地址<input name="origin" value="https://dashscope.aliyuncs.com" type="url" required></label><label class="wide">API Key（每行一个，最多 100 个）<textarea name="secrets" rows="4" spellcheck="false" autocomplete="off" required></textarea></label></div><p class="section-label">启用模型 · 初始额度来自当前预设</p><div class="checks">'+session.models.map(m=>'<label><input type="checkbox" name="model" value="'+esc(m.id)+'" checked><span>'+esc(m.id)+'<br><small class="muted">'+fmt(templates[m.id])+' '+m.unit+'</small></span></label>').join('')+'</div>'+formEnd('加入号池')+'</form>');
}
function editDialog(key){modal('Key 详情与额度','<form id="edit-form" data-id="'+esc(key.id)+'"><div class="form-grid"><label>备注<input name="label" value="'+esc(key.label)+'" maxlength="256" required></label><label>优先级<input name="weight" type="number" min="0" max="100" value="'+key.weight+'" required></label></div><p class="mono muted">'+esc(key.masked)+' · '+esc(key.origin)+'</p><div class="table-wrap"><table class="quota-edit"><thead><tr><th>模型</th><th>已用</th><th>预占</th><th>可用</th><th>总额度</th><th>单位</th></tr></thead><tbody>'+key.quotas.map(q=>'<tr><td>'+esc(q.model)+'</td><td>'+fmt(q.used)+'</td><td>'+fmt(q.held)+'</td><td>'+fmt(q.available)+'</td><td><input aria-label="'+esc(q.model)+' 总额度" data-model="'+esc(q.model)+'" type="number" min="'+(q.used+q.held)+'" max="10000000000" step="'+(q.unit==='秒'?'0.001':'1')+'" value="'+q.total+'" required></td><td>'+q.unit+'</td></tr>').join('')+'</tbody></table></div>'+formEnd('保存修改')+'</form>');}
function importDialog(){
  packageRaw='';packagePreviewVersion++;
  modal('解密导入现有 Key 包','<div class="notice">沿用现有 Key 包的验签与解密逻辑。导入后，原加密包按原编号保留在后台。</div><label id="package-dropzone" class="package-dropzone"><input id="package-file" type="file" accept=".aigckeypack,.json" aria-label="选择或拖入 Key 包文件" aria-describedby="package-upload-hint"><span class="package-upload-icon" aria-hidden="true">↑</span><strong>将 Key 包拖到这里</strong><span class="package-upload-pick">或点击选择文件</span><small id="package-upload-hint">支持 .aigckeypack / .json · 每次一个文件 · 最大 5MB</small></label><p id="package-selected" class="package-selected" hidden></p><div id="package-preview" aria-live="polite" aria-atomic="true"></div>');
}
async function previewPackageFiles(files){
  const output=$('#package-preview'),zone=$('#package-dropzone'),selected=$('#package-selected');
  if(!output||!zone)return;
  if($('[data-action="confirm-import"]',output)?.disabled){toast('正在导入，请稍候');return;}
  const stamp=++packagePreviewVersion;packageRaw='';output.replaceChildren();output.classList.remove('error');output.removeAttribute('aria-busy');selected.hidden=true;zone.classList.remove('drag-over');
  const current=()=>stamp===packagePreviewVersion&&output.isConnected;
  try{
    if(files.length!==1)throw Error('每次只能上传一个 Key 包文件');
    const file=files[0];
    if(!/\.(aigckeypack|json)$/i.test(file.name))throw Error('请选择 .aigckeypack 或 .json 格式的 Key 包');
    if(file.size>5*1024*1024)throw Error('Key 包超过 5MB');
    if(!file.size)throw Error('Key 包文件为空，请重新选择');
    selected.textContent='已选择：'+file.name;selected.hidden=false;
    output.textContent='正在校验签名并解析…';output.setAttribute('aria-busy','true');
    const raw=await file.text();if(!current())return;
    const data=await api('/api/packages/preview',{method:'POST',data:{content:raw}});if(!current())return;
    packageRaw=raw;
    output.innerHTML='<div class="notice"><b>'+esc(data.packageId)+'</b><p>'+esc(data.label)+' · 共 '+data.keyCount+' 个 Key</p></div>'+data.keys.map(k=>'<p class="key-label">'+esc(k.label)+'</p><p class="muted mono">'+esc(k.origin)+'</p><p>'+k.models.map(m=>'<span class="tag">'+esc(m)+'</span>').join('')+'</p>').join('<br>')+'<div class="form-end"><button class="primary" data-action="confirm-import">导入并保存备份</button></div>';
  }catch(e){if(current()){output.textContent=e.message;output.classList.add('error');}}
  finally{if(current())output.removeAttribute('aria-busy');}
}
function reconcileDialog(button){
  const textBilling=button.dataset.kind==='text'&&button.dataset.metered==='true';
  modal('记录实际用量','<form id="reconcile-form" data-id="'+esc(button.dataset.id)+'"><div class="notice warn">先在阿里控制台核实用量。提交后释放预占，并按该请求原单价结算；此操作不取消阿里任务。</div><label>实际总用量（'+esc(button.dataset.unit)+'）<input name="actual" type="number" min="0" step="'+(button.dataset.unit==='秒'?'0.001':'1')+'" required></label>'+(textBilling?'<div class="form-grid"><label>输入 Token<input name="inputTokens" type="number" min="0" step="1" required></label><label>输出 Token<input name="outputTokens" type="number" min="0" step="1" required></label></div><p class="muted">输入与输出之和必须等于实际总用量。</p>':'')+'<label>核对依据<textarea name="reason" minlength="3" maxlength="500" required></textarea></label>'+formEnd('确认结算')+'</form>');
}
async function download(id){const res=await api('/api/packages/'+id+'/download',{method:'POST',raw:true});const blob=await res.blob(),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=res.headers.get('content-disposition')?.match(/filename="([^"]+)"/)?.[1]||'backup.aigckeypack';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
document.addEventListener('click',async ev=>{
  const btn=ev.target.closest('button');if(!btn)return;
  if(btn.dataset.view){view=btn.dataset.view;page=1;relayKeyFilter='';load();return;}
  const action=btn.dataset.action;if(!action)return;
  btn.disabled=true;
  try{
    if(action==='add')await addDialog();
    if(action==='edit')editDialog(currentKeys.find(k=>k.id===btn.dataset.id));
    if(action==='import')importDialog();
    if(action==='toggle'){const k=currentKeys.find(k=>k.id===btn.dataset.id);await api('/api/keys/'+k.id,{method:'PATCH',data:{enabled:!k.enabled}});toast(k.enabled?'Key 已停用':'Key 已启用');await load();}
    if(action==='prev'||action==='next'){page+=action==='prev'?-1:1;await load();}
    if(action==='reload')await load();
    if(action==='download')await download(btn.dataset.id);
    if(action==='reconcile')reconcileDialog(btn);
    if(action==='confirm-import'){const result=await api('/api/packages/import',{method:'POST',data:{content:packageRaw}});packageRaw='';$('#modal').close();toast('已新增 '+result.added+' 个 Key，重复跳过 '+result.skipped+' 个');await load();}
    if(action==='copy-token'){const data=await api('/api/access/token',{method:'POST'});try{await navigator.clipboard.writeText(data.token);toast('中转令牌已复制');}catch{modal('中转令牌','<p class="muted">请妥善保管，仅提供给可信的调用方。</p><textarea id="token-copy" readonly>'+esc(data.token)+'</textarea>');$('#token-copy').select();}}
    if(action==='password')modal('修改管理员密码','<form id="password-form"><label>原密码<input type="password" name="current" autocomplete="current-password" required></label><label>新密码（至少 16 个字符）<input type="password" name="next" minlength="16" autocomplete="new-password" required></label>'+formEnd('修改并重新登录')+'</form>');
  }catch(e){toast(e.message,true);}finally{btn.disabled=false;}
});
document.addEventListener('change',async ev=>{
  if(ev.target.id==='request-filter'){filter=ev.target.value;page=1;load();}
  if(ev.target.id==='package-file'){const files=Array.from(ev.target.files);ev.target.value='';if(files.length)await previewPackageFiles(files);}
});
// 仅在导入弹窗打开时接管文件拖拽，避免浏览器直接打开被拖入的文件。
function packageFileDrag(ev){return Array.from(ev.dataTransfer?.types||[]).includes('Files')||!!ev.dataTransfer?.files.length;}
document.addEventListener('dragover',ev=>{
  const zone=$('#package-dropzone');if(!zone||!packageFileDrag(ev))return;
  ev.preventDefault();const inside=zone.contains(ev.target);zone.classList.toggle('drag-over',inside);
  if(ev.dataTransfer)ev.dataTransfer.dropEffect=inside?'copy':'none';
});
document.addEventListener('dragenter',ev=>{
  const zone=$('#package-dropzone');if(!zone||!packageFileDrag(ev))return;
  ev.preventDefault();zone.classList.toggle('drag-over',zone.contains(ev.target));
});
document.addEventListener('dragleave',ev=>{
  const zone=$('#package-dropzone');if(zone&&!zone.contains(ev.relatedTarget))zone.classList.remove('drag-over');
});
document.addEventListener('drop',async ev=>{
  const zone=$('#package-dropzone');if(!zone||!packageFileDrag(ev))return;
  ev.preventDefault();zone.classList.remove('drag-over');
  if(!zone.contains(ev.target)){toast('请将 Key 包拖到上传区域');return;}
  await previewPackageFiles(Array.from(ev.dataTransfer?.files||[]));
});
document.addEventListener('submit',async ev=>{
  const form=ev.target;if(!['login-form','search-form','add-form','edit-form','template-form','reconcile-form','password-form'].includes(form.id))return;ev.preventDefault();const submit=$('[type=submit]',form),error=$('.form-error',form);if(submit)submit.disabled=true;if(error)error.textContent='';
  const values=Object.fromEntries(new FormData(form));
  try{
    if(form.id==='login-form'){await api('/api/login',{method:'POST',data:values});session=await api('/api/session');form.password.value='';$('#login-error').textContent='';showWorkspace();return;}
    if(form.id==='search-form'){query=values.query;page=1;await load();return;}
    if(form.id==='add-form'){const keys=values.secrets.split(/\r?\n/).map(x=>x.trim()).filter(Boolean),models=$$('input[name=model]:checked',form).map(x=>x.value);if(!models.length)throw Error('至少选择一个模型');const result=await api('/api/keys',{method:'POST',data:{keys:keys.map((apiKey,i)=>({apiKey,label:values.label+(keys.length>1?' / '+(i+1):''),origin:values.origin,weight:Number(values.weight),models}))}});toast('已新增 '+result.added+' 个，重复跳过 '+result.skipped+' 个');}
    if(form.id==='edit-form')await api('/api/keys/'+form.dataset.id,{method:'PATCH',data:{label:values.label,weight:Number(values.weight),quotas:Object.fromEntries($$('input[data-model]',form).map(i=>[i.dataset.model,Number(i.value)]))}});
    if(form.id==='template-form'){await api('/api/templates',{method:'PATCH',data:Object.fromEntries(Object.entries(values).map(([k,v])=>[k,Number(v)]))});toast('新 Key 的额度预设已保存');return;}
    if(form.id==='reconcile-form')await api('/api/requests/'+form.dataset.id+'/reconcile',{method:'POST',data:{actual:Number(values.actual),reason:values.reason,...(values.inputTokens!==undefined?{inputTokens:Number(values.inputTokens),outputTokens:Number(values.outputTokens)}:{})}});
    if(form.id==='password-form'){await api('/api/password',{method:'POST',data:values});showLogin();toast('密码已更新，请重新登录');return;}
    $('#modal').close();if(form.id!=='add-form')toast('已保存');await load();
  }catch(e){if(form.id==='login-form')$('#login-error').textContent=e.message;else if(error)error.textContent=e.message;else toast(e.message,true);}finally{if(submit)submit.disabled=false;}
});
$('#modal-close').onclick=()=>{$('#modal').close();packageRaw='';};
$('#modal').addEventListener('close',()=>{packageRaw='';packagePreviewVersion++;$('#modal-content').innerHTML='';});
$('#refresh').onclick=()=>load();
$('#logout').onclick=async()=>{try{await api('/api/logout',{method:'POST'});}finally{showLogin();}};
(async()=>{try{session=await api('/api/session');showWorkspace();}catch{showLogin();}})();

'use strict';
const {fail,integer,fields}=require('./common.cjs');
const {MODELS,model}=require('./catalog.cjs');
const SCALE=1000000;
// 所有金额以百万分之一元保存；乘除使用 BigInt，避免浮点累计误差。
function money(value,name='金额'){
  if(!['string','number'].includes(typeof value)||!/^\d+(?:\.\d{1,6})?$/.test(String(value)))fail('MONEY_INVALID',name+'必须为非负金额，最多六位小数');
  const [whole,fraction='']=String(value).split('.');
  const amount=BigInt(whole)*1000000n+BigInt(fraction.padEnd(6,'0'));
  if(amount>100000000000000n)fail('MONEY_INVALID',name+'超过上限');
  return Number(amount);
}
const yuan=value=>value===null?null:value/SCALE;
function variants(m){if(m.kind!=='video')return ['default'];return m.id==='happyhorse-1.0-i2v'||m.id.startsWith('wan2.7')?['720P','1080P']:['480P','720P','1080P'];}
function tariffCatalog(){return MODELS.flatMap(m=>variants(m).map(variant=>({model:m.id,kind:m.kind,variant,unit:m.kind==='text'?'元 / 百万 Token':m.kind==='image'?'元 / 张':'元 / 秒'})));}
function validTariff(modelId,variant){const m=model(modelId);if(!variants(m).includes(variant))fail('PRICE_VARIANT_INVALID','计费规格不支持');return m;}
function normalizeRates(kind,rates){
  fields(rates,kind==='text'?['input','output']:['unit']);
  const names=kind==='text'?['input','output']:['unit'];
  const values=names.map(k=>rates[k]);
  if(values.every(v=>v===null))return null;
  if(values.some(v=>v===null||v===undefined||v===''))fail('PRICE_INCOMPLETE','请输入完整单价，或全部留空停用该规格');
  return Object.fromEntries(names.map(k=>[k,money(rates[k],'单价')]));
}
function rounded(n,d){const result=(n+d-1n)/d;if(result>100000000000000n)fail('BILLING_OVERFLOW','计费金额超过单次上限');return Number(result);}
function charge(snapshot,amount,usage={}){
  const rate=snapshot.rates;
  if(snapshot.kind==='image')return {micro:rounded(BigInt(amount)*BigInt(rate.unit),1n),usage:{images:amount}};
  if(snapshot.kind==='video')return {micro:rounded(BigInt(amount)*BigInt(rate.unit),1000n),usage:{seconds:amount/1000}};
  let input=usage.prompt_tokens??usage.input_tokens,output=usage.completion_tokens??usage.output_tokens;
  if(amount===0&&input===undefined&&output===undefined){input=0;output=0;}
  if(!Number.isSafeInteger(input)||input<0||!Number.isSafeInteger(output)||output<0||input+output!==amount){
    fail('BILLING_USAGE_MISSING','缺少可核对的输入和输出 Token 用量',502);
  }
  return {micro:rounded(BigInt(input)*BigInt(rate.input)+BigInt(output)*BigInt(rate.output),1000000n),usage:{inputTokens:input,outputTokens:output}};
}
function quote(snapshot,amount,meter={}){
  if(snapshot.kind!=='text')return charge(snapshot,amount).micro;
  const input=integer(meter.inputTokens,'预估输入 Token',0),output=integer(meter.outputTokens,'预估输出 Token',0);
  return charge(snapshot,input+output,{prompt_tokens:input,completion_tokens:output}).micro;
}
module.exports={SCALE,money,yuan,tariffCatalog,validTariff,normalizeRates,charge,quote};

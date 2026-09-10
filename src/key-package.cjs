'use strict';
const fs=require('node:fs');
const {open}=require('../vendor/node_modules/@aigc-desk/key-package/src/decrypt.cjs');
const {origin}=require('./catalog.cjs');
const {hash,fail}=require('./common.cjs');
function readMaterial(file) {
  try {
    const m=JSON.parse(fs.readFileSync(file,'utf8'));
    if(m.format!=='aigc-client-key-material'||m.version!==1)throw Error();
    const a=Buffer.from(m.unseal.partA,'base64'),b=Buffer.from(m.unseal.partB,'base64');
    if(a.length!==32||b.length!==32)throw Error();
    return {aesKey:Buffer.from(a.map((n,i)=>n^b[i])),verifyPublicKey:m.verifyPublicKeyDer,allowedHosts:null};
  } catch {fail('MATERIAL_INVALID','客户解包材料缺失或无效',500);}
}
function decode(raw,material) {
  let payload,envelope;
  try {payload=open(raw,material);envelope=JSON.parse(raw);} catch {fail('PACKAGE_INVALID','Key 包格式、签名或解密校验未通过');}
  const keys=payload.keys.map(k=>({apiKey:k.apiKey,origin:origin(k.baseURL),label:payload.label+' / '+k.id,weight:Math.min(100,k.priority||0),models:[...new Set([...k.models.filter(m=>payload.allowedModels.includes(m)),'qwen-plus','qwen-max'])]}));
  return {raw,digest:hash(raw),signedId:envelope.packageId,label:payload.label,keys};
}
function preview(pack) {return {packageId:pack.signedId,label:pack.label,keyCount:pack.keys.length,keys:pack.keys.map(k=>({label:k.label,origin:k.origin,models:k.models}))};}
module.exports={readMaterial,decode,preview};

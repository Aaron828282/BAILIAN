'use strict';
const crypto = require('node:crypto');
const {fail,equal} = require('./common.cjs');
function createVault(hex) {
  if (typeof hex!=='string' || !/^[a-f0-9]{64}$/i.test(hex)) fail('CONFIG_INVALID','VAULT_KEY 必须是 64 位十六进制字符串',500);
  const key = Buffer.from(hex,'hex');
  return {
    seal(text,aad) { const iv=crypto.randomBytes(12), c=crypto.createCipheriv('aes-256-gcm',key,iv); c.setAAD(Buffer.from(aad)); const data=Buffer.concat([c.update(String(text),'utf8'),c.final()]); return [iv.toString('base64'),c.getAuthTag().toString('base64'),data.toString('base64')].join('.'); },
    open(value,aad) { try {const [iv,tag,data]=value.split('.');const d=crypto.createDecipheriv('aes-256-gcm',key,Buffer.from(iv,'base64'));d.setAAD(Buffer.from(aad));d.setAuthTag(Buffer.from(tag,'base64'));return Buffer.concat([d.update(Buffer.from(data,'base64')),d.final()]).toString('utf8');} catch {fail('VAULT_UNREADABLE','数据解密失败，请使用原 VAULT_KEY',500);} }
  };
}
function passwordHash(password) {const salt=crypto.randomBytes(16).toString('hex');return salt+':'+crypto.scryptSync(password,salt,32).toString('hex');}
function passwordOK(password,stored) {if(typeof password!=='string'||password.length>512)return false; const [salt,digest]=stored.split(':');return equal(crypto.scryptSync(password,salt,32).toString('hex'),digest);}
module.exports={createVault,passwordHash,passwordOK};

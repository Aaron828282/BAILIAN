'use strict';
const {fail} = require('./common.cjs');
const MODELS = [
  ['qwen-plus', 'text', 100000], ['qwen-max', 'text', 100000],
  ['qwen-image-3.0', 'image', 10], ['qwen-image-3.0-pro', 'image', 10],
  ['wan3.0-video', 'video', 30], ['wan3.0-video-prime', 'video', 30],
  ['happyhorse-1.0-i2v', 'video', 10], ['happyhorse-1.1-i2v', 'video', 10],
  ['happyhorse-1.1-r2v', 'video', 10], ['wan2.7-i2v', 'video', 50], ['wan2.7-r2v', 'video', 50]
].map(([id,kind,preset]) => ({id,kind,preset,unit:kind==='text'?'Token':kind==='image'?'张':'秒',factor:kind==='video'?1000:1}));
function model(id) { const m = MODELS.find(x => x.id === id); if (!m) fail('MODEL_UNSUPPORTED', '模型不在本站百炼目录内'); return m; }
function units(id, value) {
  const n = Number(value), m = model(id);
  if (value === '' || value === null || typeof value === 'boolean' || !Number.isFinite(n) || n < 0 || n > (m.kind==='video'?1e8:1e10) || Math.abs(n*m.factor-Math.round(n*m.factor)) > 1e-5) fail('QUOTA_INVALID', '额度必须为非负数；图片和 Token 使用整数，秒数最多三位小数');
  return Math.round(n*m.factor);
}
function origin(value = 'https://dashscope.aliyuncs.com') {
  let u; try { u = new URL(value); } catch { fail('ENDPOINT_INVALID','百炼地址无效'); }
  const hosts = ['dashscope.aliyuncs.com','dashscope-intl.aliyuncs.com','dashscope-us.aliyuncs.com'];
  const workspace = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.(?:cn-beijing|ap-southeast-1|ap-northeast-1|eu-central-1|us-east-1|cn-hongkong)\.maas\.aliyuncs\.com$/;
  if (u.protocol!=='https:' || u.username || u.password || u.port || u.search || u.hash ||
      (!hosts.includes(u.hostname) && !workspace.test(u.hostname)) ||
      !['/','/api/v1','/api/v1/','/compatible-mode/v1','/compatible-mode/v1/'].includes(u.pathname)) fail('ENDPOINT_FORBIDDEN','仅允许阿里百炼官方 HTTPS 接入地址');
  return u.origin;
}
module.exports = {MODELS,model,units,origin};

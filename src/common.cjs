'use strict';
const crypto = require('node:crypto');
function fail(code, message, status = 400) { throw Object.assign(new Error(message), { code, status }); }
function str(value, name, min = 1, max = 128) {
  if (typeof value !== 'string' || value.trim().length < min || value.length > max) fail('INVALID_INPUT', name + '长度不正确');
  return value.trim();
}
function integer(value, name, min = 0, max = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail('INVALID_INPUT', name + '必须是范围内整数');
  return value;
}
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
function equal(a, b) { return crypto.timingSafeEqual(Buffer.from(hash(String(a))), Buffer.from(hash(String(b)))); }
const id = prefix => prefix + '_' + crypto.randomUUID();
const random = () => crypto.randomBytes(32).toString('hex');
function fields(body, allowed) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) fail('INVALID_INPUT', '需要 JSON 对象');
  if (Object.keys(body).some(k => !allowed.includes(k))) fail('UNSUPPORTED_FIELD', '请求包含未支持的字段');
}
module.exports = { fail, str, integer, canonical, hash, equal, id, random, fields };

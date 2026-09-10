'use strict';
const crypto=require('node:crypto');
const {KINDS}=require('./node_modules/@aigc-desk/multimodal-domain/src/kinds.cjs');
function httpError(code,message,status=400){return Object.assign(new Error(message),{code,status});}
function imageAssetFromDataUrl(value, index) {
  const match = String(value || '').match(/^data:(image\/(?:png|jpeg|webp|bmp));base64,([A-Za-z0-9+/=]+)$/);
  if (!match) throw httpError('REFERENCE_IMAGE_INVALID', '参考图必须是图片 data URL');
  const buf = Buffer.from(match[2], 'base64');
  if (!buf.length) throw httpError('REFERENCE_IMAGE_INVALID', '参考图为空');
  return {
    id: `ref_img_${Date.now()}_${index}`,
    kind: KINDS.IMAGE,
    status: 'ready',
    mimeType: match[1],
    byteSize: buf.length,
    sha256: crypto.createHash('sha256').update(buf).digest('hex'),
    imageData: buf.toString('base64')
  };
}

// 首版按模型默认时长：wan3 系缺省自动（-1），新模型缺省 5 秒。
function defaultDuration(model) {
  return model === 'wan3.0-video' || model === 'wan3.0-video-prime' ? -1 : 5;
}

function parseDuration(value, model) {
  if (value === undefined || value === null || value === '') return defaultDuration(model);
  const n = Number(value);
  return Number.isFinite(n) ? n : defaultDuration(model);
}

function parseVideoBody(body, model) {
  // 图片参考（标准 UI 链路）
  const refImages = Array.isArray(body.reference_images) ? body.reference_images : [];
  const media = refImages.map((d, i) => imageAssetFromDataUrl(d, i));

  // 进阶多模态素材（r2v 参考视频/音频：仅接受用户显式提供的公网 https URL）
  if (Array.isArray(body.media)) {
    for (const item of body.media) {
      if (!item || typeof item !== 'object') throw httpError('MEDIA_INVALID', 'media 元素必须是对象');
      const kind = item.kind;
      if (kind === KINDS.IMAGE) {
        if (typeof item.dataUrl === 'string') media.push(imageAssetFromDataUrl(item.dataUrl, media.length));
        else if (typeof item.url === 'string' && /^https?:\/\//i.test(item.url)) {
          const mime = (item.mimeType || '').toLowerCase();
          if (!/^image\//.test(mime)) throw httpError('MEDIA_INVALID', 'image 类型素材缺少 image MIME');
          media.push({ id: `ref_img_${Date.now()}_${media.length}`, kind: KINDS.IMAGE, status: 'ready', mimeType: mime, byteSize: Number(item.byteSize) || 0, sha256: typeof item.sha256 === 'string' && /^[a-f0-9]{64}$/i.test(item.sha256) ? item.sha256 : '0'.repeat(64), publicUrl: item.url });
        } else throw httpError('MEDIA_INVALID', 'image 素材需要 dataUrl 或公网 url');
      } else if (kind === KINDS.VIDEO || kind === KINDS.AUDIO) {
        const url = typeof item.url === 'string' && /^https?:\/\//i.test(item.url) ? item.url : null;
        if (!url) throw httpError('MEDIA_PUBLIC_URL_REQUIRED', `${kind} 素材需要可公网访问的 http(s) url（首版不支持本地音视频直传）`);
        const mime = (item.mimeType || '').toLowerCase();
        const okMime = kind === KINDS.VIDEO ? /^video\/(mp4|quicktime)$/.test(mime) : /^audio\/(mpeg|wav|x-wav)$/.test(mime);
        if (!okMime) throw httpError('MEDIA_INVALID', `${kind} 素材 mimeType 无效`);
        const dur = Number(item.durationSeconds);
        if (!Number.isFinite(dur) || dur < 1 || dur > 15) throw httpError('MEDIA_INVALID', `${kind} 素材需 1..15 秒的 durationSeconds`);
        media.push({ id: `ref_${kind}_${Date.now()}_${media.length}`, kind, status: 'ready', mimeType: mime, byteSize: Number(item.byteSize) || 0, sha256: typeof item.sha256 === 'string' && /^[a-f0-9]{64}$/i.test(item.sha256) ? item.sha256 : '0'.repeat(64), durationSeconds: dur, publicUrl: url });
      } else {
        throw httpError('MEDIA_KIND_UNSUPPORTED', `不支持的素材类型：${kind}`);
      }
    }
  }
  return media;
}


module.exports={parseVideoBody,parseDuration};

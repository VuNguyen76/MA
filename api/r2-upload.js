import crypto from 'node:crypto';

function sha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function hmac(key, data) {
  return crypto.createHmac('sha256', key).update(data).digest();
}

function getSignatureKey(secretKey, dateStamp, regionName, serviceName) {
  const kDate = hmac('AWS4' + secretKey, dateStamp);
  const kRegion = hmac(kDate, regionName);
  const kService = hmac(kRegion, serviceName);
  return hmac(kService, 'aws4_request');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const bucket = process.env.R2_BUCKET;
  const publicBase = (process.env.R2_PUBLIC_BASE || '').replace(/\/$/, '');

  if (!accountId || !accessKeyId || !secretAccessKey || !bucket || !publicBase) {
    return res.status(500).json({ error: 'Thiếu biến môi trường Cloudflare R2 trên server' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const { base64Data, fileName, folder = 'maianh-closet/items' } = body;

    if (!base64Data || typeof base64Data !== 'string') {
      return res.status(400).json({ error: 'Thiếu dữ liệu ảnh base64Data' });
    }

    let mime = 'image/png';
    let b64 = base64Data;
    const match = base64Data.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
    if (match) {
      mime = match[1];
      b64 = match[2];
    }

    const buffer = Buffer.from(b64, 'base64');
    const ext = mime === 'image/jpeg' ? 'jpg' : mime === 'image/webp' ? 'webp' : 'png';
    const rawName = (fileName || `item-${Date.now()}`).replace(/\.[^.]+$/, '');
    const safeName = rawName.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 80);
    const cleanFolder = String(folder).replace(/^\/+|\/+$/g, '');
    const key = `${cleanFolder}/${safeName}-${Date.now().toString(36)}.${ext}`;

    const host = `${accountId}.r2.cloudflarestorage.com`;
    const canonicalUri = `/${bucket}/${key}`;
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);
    const payloadHash = sha256Hex(buffer);

    const canonicalHeaders =
      `host:${host}\n` +
      `x-amz-content-sha256:${payloadHash}\n` +
      `x-amz-date:${amzDate}\n`;
    const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';

    const canonicalRequest = [
      'PUT',
      canonicalUri,
      '',
      canonicalHeaders,
      signedHeaders,
      payloadHash
    ].join('\n');

    const credentialScope = `${dateStamp}/auto/s3/aws4_request`;
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      credentialScope,
      sha256Hex(canonicalRequest)
    ].join('\n');

    const signingKey = getSignatureKey(secretAccessKey, dateStamp, 'auto', 's3');
    const signature = crypto.createHmac('sha256', signingKey).update(stringToSign).digest('hex');

    const authorization =
      `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`;

    const uploadRes = await fetch(`https://${host}${canonicalUri}`, {
      method: 'PUT',
      headers: {
        'Host': host,
        'Content-Type': mime,
        'Cache-Control': 'public, max-age=31536000, immutable',
        'x-amz-content-sha256': payloadHash,
        'x-amz-date': amzDate,
        'Authorization': authorization
      },
      body: buffer
    });

    if (!uploadRes.ok) {
      const errText = await uploadRes.text();
      return res.status(502).json({ error: `R2 upload failed (${uploadRes.status}): ${errText.slice(0, 200)}` });
    }

    return res.status(200).json({
      id: key,
      url: `${publicBase}/${key}`
    });
  } catch (err) {
    return res.status(500).json({ error: err?.message || 'Lỗi upload ảnh lên Cloudflare R2' });
  }
}

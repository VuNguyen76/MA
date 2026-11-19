// Vercel Serverless proxy cho MuseAI API (tránh Mixed Content HTTP/HTTPS, CORS và giấu API key)
async function safeJson(response) {
  const raw = await response.text();
  try {
    return { data: JSON.parse(raw), raw };
  } catch (_) {
    return { data: null, raw };
  }
}

// Chuyển URL ảnh (đặc biệt là link redirect Google Drive lh3) sang data URL base64 để server Muse đọc chính xác 100%
async function toDataUrlIfRemote(imgStr) {
  if (!imgStr || typeof imgStr !== 'string') return null;
  if (imgStr.startsWith('data:image/')) return imgStr;
  if (!imgStr.startsWith('http://') && !imgStr.startsWith('https://')) return imgStr;
  try {
    const r = await fetch(imgStr);
    if (!r.ok) return imgStr;
    const mime = r.headers.get('content-type') || 'image/png';
    const buf = Buffer.from(await r.arrayBuffer());
    return `data:${mime};base64,${buf.toString('base64')}`;
  } catch (_) {
    return imgStr;
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const base = (process.env.MUSE_API_BASE || 'http://160.191.243.214:18610/v1').replace(/\/$/, '');
  const apiKey = process.env.MUSE_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'Thiếu biến môi trường MUSE_API_KEY trên server' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    const headers = {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    };

    if (body.action === 'chat') {
      const messages = Array.isArray(body.messages) ? body.messages : [];
      for (const msg of messages) {
        if (Array.isArray(msg.content)) {
          for (const part of msg.content) {
            if (part?.type === 'image_url' && part.image_url?.url) {
              part.image_url.url = await toDataUrlIfRemote(part.image_url.url);
            }
          }
        }
      }

      const r = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: 'muse-chat',
          messages
        })
      });
      const { data, raw } = await safeJson(r);
      if (!r.ok || !data) {
        const msg = data?.error?.message || data?.error || (raw ? raw.slice(0, 140) : `HTTP ${r.status}`);
        return res.status(r.status >= 400 ? r.status : 502).json({ error: `Server Muse bận (${r.status}): ${msg}` });
      }
      const text = data?.choices?.[0]?.message?.content || '';
      return res.status(200).json({ text });
    }

    if (body.action === 'image') {
      const rawImages = Array.isArray(body.images) ? body.images.filter(Boolean).slice(0, 4) : [];
      const resolvedImages = await Promise.all(rawImages.map(toDataUrlIfRemote));

      const payload = {
        model: 'muse-image',
        prompt: body.prompt || '',
        n: 1,
        size: '1024x1024'
      };
      if (resolvedImages.length === 1) {
        payload.image = resolvedImages[0];
      } else if (resolvedImages.length > 1) {
        payload.image = resolvedImages;
      }

      const r = await fetch(`${base}/images/generations`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload)
      });
      const { data, raw } = await safeJson(r);
      if (!r.ok || !data) {
        const msg = data?.error?.message || data?.error || (raw ? raw.slice(0, 140) : `HTTP ${r.status}`);
        return res.status(r.status >= 400 ? r.status : 502).json({ error: `Server Muse bận (${r.status}): ${msg}` });
      }

      const first = data?.data?.[0];
      if (first?.b64_json) {
        return res.status(200).json({ dataUrl: `data:image/png;base64,${first.b64_json}` });
      }
      if (!first?.url) {
        return res.status(502).json({ error: 'API không trả về ảnh' });
      }

      const imgRes = await fetch(first.url);
      if (!imgRes.ok) return res.status(502).json({ error: 'Không tải được ảnh từ server Muse' });
      const mime = imgRes.headers.get('content-type') || 'image/webp';
      const buf = Buffer.from(await imgRes.arrayBuffer());
      return res.status(200).json({ dataUrl: `data:${mime};base64,${buf.toString('base64')}` });
    }

    return res.status(400).json({ error: 'Action không hợp lệ' });
  } catch (err) {
    return res.status(500).json({ error: err?.message || 'Lỗi kết nối Muse API' });
  }
}

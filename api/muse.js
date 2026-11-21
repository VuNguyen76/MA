// Vercel Serverless proxy cho MuseAI API (Async Task Polling -> mỗi request < 500ms, không bao giờ dính FUNCTION_INVOCATION_TIMEOUT)
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

  const base = (process.env.MUSE_API_BASE || '').replace(/\/$/, '');
  const apiKey = process.env.MUSE_API_KEY;
  if (!base || !apiKey) {
    return res.status(500).json({ error: 'Thiếu biến môi trường MUSE_API_BASE hoặc MUSE_API_KEY trên server' });
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

    if (body.action === 'proxy_img') {
      const dataUrl = await toDataUrlIfRemote(body.url);
      return res.status(200).json({ dataUrl });
    }

    // Bắt đầu tạo ảnh bất đồng bộ (async: true -> trả về taskId trong < 500ms, tránh timeout Vercel)
    if (body.action === 'image_start') {
      const rawImages = Array.isArray(body.images) ? body.images.filter(Boolean).slice(0, 4) : [];
      const resolvedImages = await Promise.all(rawImages.map(toDataUrlIfRemote));

      const payload = {
        model: 'muse-image',
        prompt: body.prompt || '',
        n: 1,
        size: '1024x1024',
        async: true
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
      const taskId = data.id || data.task_id;
      if (!taskId) {
        return res.status(502).json({ error: 'Server Muse không trả về task_id' });
      }
      return res.status(200).json({ taskId, status: data.status || 'queued' });
    }

    // Kiểm tra tiến trình task (< 300ms mỗi lần gọi)
    if (body.action === 'image_poll') {
      const taskId = body.taskId;
      if (!taskId) return res.status(400).json({ error: 'Thiếu taskId' });

      const r = await fetch(`${base}/images/generations/${encodeURIComponent(taskId)}`, {
        method: 'GET',
        headers
      });
      const { data, raw } = await safeJson(r);
      if (!r.ok || !data) {
        const msg = data?.error?.message || data?.error || (raw ? raw.slice(0, 140) : `HTTP ${r.status}`);
        return res.status(r.status >= 400 ? r.status : 502).json({ error: `Lỗi kiểm tra tiến trình (${r.status}): ${msg}` });
      }

      if (data.status === 'failed' || data.status === 'cancelled' || data.error) {
        const errMsg = data.error?.message || data.error || 'Tạo ảnh thất bại trên server Muse';
        return res.status(200).json({ status: 'failed', error: String(errMsg) });
      }

      const first = data?.result?.data?.[0] || data?.data?.[0] || data?.result;
      if (first?.b64_json) {
        return res.status(200).json({
          status: 'succeeded',
          dataUrl: `data:image/png;base64,${first.b64_json}`
        });
      }
      if (first?.url) {
        const imgRes = await fetch(first.url);
        if (!imgRes.ok) return res.status(502).json({ error: 'Không tải được ảnh kết quả từ server Muse' });
        const mime = imgRes.headers.get('content-type') || 'image/webp';
        const buf = Buffer.from(await imgRes.arrayBuffer());
        return res.status(200).json({
          status: 'succeeded',
          dataUrl: `data:${mime};base64,${buf.toString('base64')}`
        });
      }

      return res.status(200).json({
        status: data.status || 'running',
        progress: data.progress || 0
      });
    }

    return res.status(400).json({ error: 'Action không hợp lệ' });
  } catch (err) {
    return res.status(500).json({ error: err?.message || 'Lỗi kết nối Muse API' });
  }
}

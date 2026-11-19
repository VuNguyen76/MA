// Vercel Serverless proxy cho MuseAI API (tránh Mixed Content HTTP/HTTPS, CORS và giấu API key)
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
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const headers = {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    };

    if (body.action === 'chat') {
      const r = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: 'muse-chat',
          messages: body.messages || []
        })
      });
      const data = await r.json();
      if (!r.ok) return res.status(r.status).json({ error: data?.error?.message || 'Lỗi muse-chat' });
      const text = data?.choices?.[0]?.message?.content || '';
      return res.status(200).json({ text });
    }

    if (body.action === 'image') {
      const r = await fetch(`${base}/images/generations`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: 'muse-image',
          prompt: body.prompt || '',
          n: 1,
          size: '1024x1024'
        })
      });
      const data = await r.json();
      if (!r.ok) return res.status(r.status).json({ error: data?.error?.message || 'Lỗi muse-image' });

      const first = data?.data?.[0];
      if (first?.b64_json) {
        return res.status(200).json({ dataUrl: `data:image/png;base64,${first.b64_json}` });
      }
      if (!first?.url) {
        return res.status(502).json({ error: 'API không trả về ảnh' });
      }

      // Tải ảnh HTTP từ VPS về dạng base64 dataURL để trang HTTPS hiển thị không bị chặn Mixed Content
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

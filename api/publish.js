export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const GH_TOKEN = process.env.GITHUB_TOKEN;
  const VERCEL_DEPLOY_HOOK = process.env.VERCEL_DEPLOY_HOOK;

  if (!GH_TOKEN || !VERCEL_DEPLOY_HOOK) {
    return res.status(500).json({ error: 'Missing secrets' });
  }

  const body = await new Promise((resolve) => {
    let data = '';
    req.on('data', c => data += c);
    req.on('end', () => resolve(JSON.parse(data || '{}')));
  });

  try {
    // Commit markdown or images to GitHub
    for (const f of body.files || []) {
      await fetch(`https://api.github.com/repos/johnnybassanelli/RABKL-newsroom/contents/${f.path}`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${GH_TOKEN}`, Accept: 'application/vnd.github+json' },
        body: JSON.stringify({
          message: body.message || 'news update',
          branch: 'main',
          content: f.contentBase64 || Buffer.from(f.content || '', 'utf8').toString('base64'),
        })
      });
    }

    // Trigger redeploy
    await fetch(VERCEL_DEPLOY_HOOK, { method: 'POST' });
    res.status(200).json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}

export function applyCors(req, res) {
  const allowed = new Set([
    'https://j-hinton.com',
    'https://www.j-hinton.com'
  ]);

  const origin = req.headers.origin;
  if (origin && allowed.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }

  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return true;
  }

  if (origin && !allowed.has(origin)) {
    res.status(403).json({ error: 'Origin not allowed.' });
    return true;
  }

  return false;
}

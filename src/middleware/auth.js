import jwt from 'jsonwebtoken';
import { query } from '../db/pool.js';

export function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'No token provided' });
  try {
    req.user = jwt.verify(auth.slice(7), process.env.JWT_SECRET);
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') return res.status(401).json({ error: 'Token expired', code: 'TOKEN_EXPIRED' });
    return res.status(401).json({ error: 'Invalid token' });
  }
}

export async function requireApiKey(req, res, next) {
  const key = req.headers['x-api-key'];
  if (!key) return res.status(401).json({ error: 'API key required' });
  try {
    const r = await query('SELECT id, user_id, name FROM servers WHERE api_key = $1', [key]);
    if (!r.rows.length) return res.status(401).json({ error: 'Invalid API key' });
    req.server = r.rows[0];
    next();
  } catch (err) {
    console.error('API key auth error:', err);
    res.status(500).json({ error: 'Internal error' });
  }
}

export async function requireServerAccess(req, res, next) {
  const { serverId } = req.params;
  const userId = req.user.userId;
  try {
    const r = await query('SELECT id, user_id FROM servers WHERE id = $1', [serverId]);
    if (!r.rows.length) return res.status(404).json({ error: 'Server not found' });

    // Owner
    if (r.rows[0].user_id === userId) {
      req.serverRow = r.rows[0];
      req.isOwner = true;
      return next();
    }

    // Team member
    const m = await query('SELECT role FROM team_members WHERE server_id = $1 AND user_id = $2', [serverId, userId]);
    if (m.rows.length) {
      req.serverRow = r.rows[0];
      req.teamRole = m.rows[0].role;
      return next();
    }

    return res.status(403).json({ error: 'Access denied' });
  } catch (err) {
    res.status(500).json({ error: 'Internal error' });
  }
}

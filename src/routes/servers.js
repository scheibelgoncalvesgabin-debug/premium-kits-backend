import { Router } from 'express';
import { query } from '../db/pool.js';
import { requireAuth, requireServerAccess } from '../middleware/auth.js';
import { wsManager } from '../ws/manager.js';

const router = Router();
router.use(requireAuth);

router.get('/', async (req, res) => {
  try {
    const r = await query(
      `SELECT s.*, 
        (SELECT COUNT(*) FROM kits WHERE server_id = s.id AND enabled = true)::int AS kit_count,
        (SELECT COUNT(*) FROM kit_gives WHERE server_id = s.id)::int AS total_gives
       FROM servers s
       WHERE s.user_id = $1
       ORDER BY s.created_at DESC`,
      [req.user.userId]
    );
    const servers = r.rows.map(s => ({
      ...s,
      online: wsManager.isOnline(s.id),
      api_key: undefined, // never expose full key in list
      api_key_preview: s.api_key?.substring(0, 8) + '••••••••'
    }));
    res.json({ servers });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed' }); }
});

router.post('/', async (req, res) => {
  const { name, description } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'Name required' });
  try {
    const r = await query(
      'INSERT INTO servers (user_id, name, description) VALUES ($1, $2, $3) RETURNING *',
      [req.user.userId, name.trim(), description || null]
    );
    const server = r.rows[0];
    res.status(201).json({
      server: { ...server, online: false },
      apiKey: server.api_key  // only time we send full key
    });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed' }); }
});

router.get('/:serverId', requireServerAccess, async (req, res) => {
  try {
    const r = await query('SELECT * FROM servers WHERE id = $1', [req.params.serverId]);
    if (!r.rows.length) return res.status(404).json({ error: 'Not found' });
    const s = r.rows[0];
    res.json({
      server: {
        ...s,
        online: wsManager.isOnline(s.id),
        api_key: undefined,
        api_key_preview: s.api_key?.substring(0, 8) + '••••••••'
      }
    });
  } catch { res.status(500).json({ error: 'Failed' }); }
});

router.delete('/:serverId', requireServerAccess, async (req, res) => {
  if (!req.isOwner) return res.status(403).json({ error: 'Owner only' });
  try {
    await query('DELETE FROM servers WHERE id = $1 AND user_id = $2', [req.params.serverId, req.user.userId]);
    res.json({ message: 'Server deleted' });
  } catch { res.status(500).json({ error: 'Failed' }); }
});

// Reveal API key
router.get('/:serverId/apikey', requireServerAccess, async (req, res) => {
  if (!req.isOwner) return res.status(403).json({ error: 'Owner only' });
  try {
    const r = await query('SELECT api_key FROM servers WHERE id = $1', [req.params.serverId]);
    res.json({ apiKey: r.rows[0]?.api_key });
  } catch { res.status(500).json({ error: 'Failed' }); }
});

// Regenerate API key
router.post('/:serverId/apikey/regenerate', requireServerAccess, async (req, res) => {
  if (!req.isOwner) return res.status(403).json({ error: 'Owner only' });
  try {
    const r = await query(
      "UPDATE servers SET api_key = encode(gen_random_bytes(24),'hex') WHERE id = $1 RETURNING api_key",
      [req.params.serverId]
    );
    wsManager.sendToServer(req.params.serverId, { type: 'API_KEY_REVOKED' });
    res.json({ apiKey: r.rows[0].api_key });
  } catch { res.status(500).json({ error: 'Failed' }); }
});

export default router;

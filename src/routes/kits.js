import { Router } from 'express';
import { query } from '../db/pool.js';
import { requireAuth, requireServerAccess } from '../middleware/auth.js';
import { wsManager } from '../ws/manager.js';

const router = Router({ mergeParams: true });
router.use(requireAuth, requireServerAccess);

// GET all kits for server
router.get('/', async (req, res) => {
  try {
    const r = await query(
      `SELECT k.*,
        (SELECT COUNT(*)::int FROM kit_gives g WHERE g.server_id = k.server_id AND g.kit_id = k.kit_id) AS total_gives
       FROM kits k
       WHERE k.server_id = $1
       ORDER BY k.priority DESC, k.created_at ASC`,
      [req.params.serverId]
    );
    res.json({ kits: r.rows.map(parseKit) });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed to fetch kits' }); }
});

// GET single kit
router.get('/:kitId', async (req, res) => {
  try {
    const r = await query(
      'SELECT * FROM kits WHERE server_id = $1 AND kit_id = $2',
      [req.params.serverId, req.params.kitId]
    );
    if (!r.rows.length) return res.status(404).json({ error: 'Kit not found' });
    res.json({ kit: parseKit(r.rows[0]) });
  } catch { res.status(500).json({ error: 'Failed' }); }
});

// PUT create/update kit
router.put('/:kitId', async (req, res) => {
  const {
    name, description, enabled = true, icon = 'CHEST',
    items = {}, access = { type: 'EVERYONE' },
    conditions = {}, actions = {}, priority = 0, tags = {}
  } = req.body;

  if (!name?.trim()) return res.status(400).json({ error: 'Kit name required' });

  // Parse items if string
  let parsedItems = items;
  if (typeof items === 'string') try { parsedItems = JSON.parse(items); } catch { parsedItems = {}; }

  try {
    const r = await query(
      `INSERT INTO kits (server_id, kit_id, name, description, enabled, icon, items, access, conditions, actions, tags, priority, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (server_id, kit_id) DO UPDATE SET
         name        = EXCLUDED.name,
         description = EXCLUDED.description,
         enabled     = EXCLUDED.enabled,
         icon        = EXCLUDED.icon,
         items       = EXCLUDED.items,
         access      = EXCLUDED.access,
         conditions  = EXCLUDED.conditions,
         actions     = EXCLUDED.actions,
         tags        = EXCLUDED.tags,
         priority    = EXCLUDED.priority,
         updated_at  = NOW()
       RETURNING *`,
      [
        req.params.serverId, req.params.kitId,
        name.trim(), description || null,
        enabled, icon,
        JSON.stringify(parsedItems),
        JSON.stringify(access),
        JSON.stringify(conditions),
        JSON.stringify(actions),
        JSON.stringify(tags),
        priority,
        req.user.username
      ]
    );

    const kit = parseKit(r.rows[0]);

    // Push to plugin via WebSocket
    wsManager.sendToServer(req.params.serverId, {
      type: 'KIT_UPDATE',
      kit
    });

    res.json({ kit, message: 'Kit saved and pushed to server' });
  } catch (err) { console.error('kit save error:', err); res.status(500).json({ error: 'Failed to save kit' }); }
});

// DELETE kit
router.delete('/:kitId', async (req, res) => {
  try {
    await query('DELETE FROM kits WHERE server_id = $1 AND kit_id = $2', [req.params.serverId, req.params.kitId]);
    wsManager.sendToServer(req.params.serverId, { type: 'KIT_DELETE', kitId: req.params.kitId });
    res.json({ message: 'Kit deleted' });
  } catch { res.status(500).json({ error: 'Failed' }); }
});

// Clone kit
router.post('/:kitId/clone', async (req, res) => {
  const { newKitId, newName } = req.body;
  if (!newKitId) return res.status(400).json({ error: 'newKitId required' });
  try {
    const src = await query('SELECT * FROM kits WHERE server_id = $1 AND kit_id = $2', [req.params.serverId, req.params.kitId]);
    if (!src.rows.length) return res.status(404).json({ error: 'Source kit not found' });
    const k = src.rows[0];
    await query(
      `INSERT INTO kits (server_id, kit_id, name, description, icon, items, access, conditions, actions, priority)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [req.params.serverId, newKitId, newName || k.name + ' (copy)', k.description,
       k.icon, k.items, k.access, k.conditions, k.actions, k.priority]
    );
    res.json({ message: 'Kit cloned', kitId: newKitId });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed' }); }
});

// Kit stats
router.get('/:kitId/stats', async (req, res) => {
  try {
    const daily = await query(
      `SELECT date_trunc('day', given_at) AS day, COUNT(*)::int AS count
       FROM kit_gives WHERE server_id = $1 AND kit_id = $2
         AND given_at > NOW() - INTERVAL '30 days'
       GROUP BY day ORDER BY day`,
      [req.params.serverId, req.params.kitId]
    );
    const top = await query(
      `SELECT player_name, COUNT(*)::int AS count
       FROM kit_gives WHERE server_id = $1 AND kit_id = $2
       GROUP BY player_name ORDER BY count DESC LIMIT 10`,
      [req.params.serverId, req.params.kitId]
    );
    res.json({ daily: daily.rows, topPlayers: top.rows });
  } catch { res.status(500).json({ error: 'Failed' }); }
});

// Enable/disable kit
router.patch('/:kitId/toggle', async (req, res) => {
  try {
    const r = await query(
      'UPDATE kits SET enabled = NOT enabled, updated_at = NOW() WHERE server_id = $1 AND kit_id = $2 RETURNING enabled',
      [req.params.serverId, req.params.kitId]
    );
    const enabled = r.rows[0]?.enabled;
    wsManager.sendToServer(req.params.serverId, { type: enabled ? 'KIT_ENABLE' : 'KIT_DISABLE', kitId: req.params.kitId });
    res.json({ enabled });
  } catch { res.status(500).json({ error: 'Failed' }); }
});

function parseKit(row) {
  const parse = (val) => {
    if (typeof val === 'string') try { return JSON.parse(val); } catch { return {}; }
    return val || {};
  };
  return {
    ...row,
    items:      parse(row.items),
    access:     parse(row.access),
    conditions: parse(row.conditions),
    actions:    parse(row.actions),
    tags:       parse(row.tags),
  };
}

export default router;

import { Router } from 'express';
import { query } from '../db/pool.js';
import { requireApiKey } from '../middleware/auth.js';
import { wsManager } from '../ws/manager.js';

const router = Router();
router.use(requireApiKey);

// Heartbeat
router.post('/heartbeat', async (req, res) => {
  try {
    await query('UPDATE servers SET online = true, last_ping = NOW() WHERE id = $1', [req.server.id]);
    res.json({ ok: true });
  } catch { res.json({ ok: true }); }
});

// Get all enabled kits for plugin
router.get('/kits', async (req, res) => {
  try {
    const r = await query(
      'SELECT * FROM kits WHERE server_id = $1 AND enabled = true ORDER BY priority DESC',
      [req.server.id]
    );
    const kits = r.rows.map(row => {
      const parse = (v) => {
        if (typeof v === 'string') try { return JSON.parse(v); } catch { return {}; }
        return v || {};
      };
      return {
        id:         row.kit_id,
        name:       row.name,
        enabled:    row.enabled,
        icon:       row.icon,
        items:      parse(row.items),
        access:     parse(row.access),
        conditions: parse(row.conditions),
        actions:    parse(row.actions),
        tags:       parse(row.tags),
        priority:   row.priority,
      };
    });
    res.json({ kits });
  } catch (err) { console.error(err); res.status(500).json({ error: 'Failed' }); }
});

// Report kit given (from plugin)
router.post('/kit-given', async (req, res) => {
  const { kitId, playerUuid, playerName } = req.body;
  if (!kitId || !playerUuid) return res.status(400).json({ error: 'Missing fields' });
  try {
    await query(
      'INSERT INTO kit_gives (server_id, kit_id, player_uuid, player_name) VALUES ($1,$2,$3,$4)',
      [req.server.id, kitId, playerUuid, playerName || null]
    );
    // Broadcast to browser clients
    wsManager.broadcastToServer(req.server.id, {
      type: 'KIT_GIVEN_LIVE',
      kitId, playerName, playerUuid,
      ts: Date.now()
    });
    // Discord webhook
    const srv = await query('SELECT config FROM servers WHERE id=$1',[req.server.id]);
    const cfg = srv.rows[0]?.config;
    const webhook = cfg?.discordWebhook;
    if (webhook?.url && webhook.events?.includes('kit_given')) {
      fetch(webhook.url, {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({
          embeds:[{
            title:'🎁 Kit donné',
            color:0x6366f1,
            fields:[
              {name:'Joueur',value:playerName||playerUuid,inline:true},
              {name:'Kit',value:kitId,inline:true},
            ],
            timestamp: new Date().toISOString(),
          }]
        })
      }).catch(()=>{});
    }
    res.json({ ok: true });
  } catch { res.json({ ok: true }); }
});

// Reset player cooldown (from panel → plugin)
router.post('/reset-cooldown', async (req, res) => {
  const { playerUuid, kitId } = req.body;
  try {
    if (kitId) {
      await query('DELETE FROM player_cooldowns WHERE server_id = $1 AND kit_id = $2 AND player_uuid = $3',
        [req.server.id, kitId, playerUuid]);
    } else {
      await query('DELETE FROM player_cooldowns WHERE server_id = $1 AND player_uuid = $2',
        [req.server.id, playerUuid]);
    }
    res.json({ ok: true });
  } catch { res.status(500).json({ error: 'Failed' }); }
});

// Plugin disconnect
router.post('/disconnect', async (req, res) => {
  await query('UPDATE servers SET online = false WHERE id = $1', [req.server.id]).catch(() => {});
  res.json({ ok: true });
});

export default router;

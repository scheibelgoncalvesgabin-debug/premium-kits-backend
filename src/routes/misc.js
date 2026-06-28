import { Router } from 'express';
import { query } from '../db/pool.js';
import { requireAuth, requireServerAccess } from '../middleware/auth.js';
import { wsManager } from '../ws/manager.js';
import crypto from 'crypto';

// ── TEAMS ─────────────────────────────────────────────────────────────────────
export const teamsRouter = Router({ mergeParams: true });
teamsRouter.use(requireAuth, requireServerAccess);

teamsRouter.get('/', async (req, res) => {
  try {
    const r = await query(
      `SELECT tm.id, tm.role, tm.created_at, u.email, u.username
       FROM team_members tm JOIN users u ON u.id = tm.user_id
       WHERE tm.server_id = $1 ORDER BY tm.created_at`,
      [req.params.serverId]
    );
    res.json({ members: r.rows });
  } catch { res.status(500).json({ error: 'Failed' }); }
});

teamsRouter.post('/invite', async (req, res) => {
  if (!req.isOwner) return res.status(403).json({ error: 'Owner only' });
  const { email, role = 'viewer' } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });
  if (!['admin','editor','viewer'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
  try {
    const u = await query('SELECT id, username FROM users WHERE LOWER(email) = LOWER($1)', [email]);
    if (!u.rows.length) return res.status(404).json({ error: 'No account with this email' });
    const invitedId = u.rows[0].id;
    if (invitedId === req.user.userId) return res.status(400).json({ error: 'Cannot invite yourself' });
    const ex = await query('SELECT id FROM team_members WHERE server_id = $1 AND user_id = $2', [req.params.serverId, invitedId]);
    if (ex.rows.length) return res.status(409).json({ error: 'Already a member' });
    await query('INSERT INTO team_members (server_id, user_id, role, invited_by) VALUES ($1,$2,$3,$4)', [req.params.serverId, invitedId, role, req.user.userId]);
    res.json({ message: `${u.rows[0].username} added as ${role}` });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Failed' }); }
});

teamsRouter.patch('/:memberId', async (req, res) => {
  if (!req.isOwner) return res.status(403).json({ error: 'Owner only' });
  const { role } = req.body;
  if (!['admin','editor','viewer'].includes(role)) return res.status(400).json({ error: 'Invalid role' });
  try {
    await query('UPDATE team_members SET role = $1 WHERE id = $2 AND server_id = $3', [role, req.params.memberId, req.params.serverId]);
    res.json({ message: 'Role updated' });
  } catch { res.status(500).json({ error: 'Failed' }); }
});

teamsRouter.delete('/:memberId', async (req, res) => {
  if (!req.isOwner) return res.status(403).json({ error: 'Owner only' });
  try {
    await query('DELETE FROM team_members WHERE id = $1 AND server_id = $2', [req.params.memberId, req.params.serverId]);
    res.json({ message: 'Removed' });
  } catch { res.status(500).json({ error: 'Failed' }); }
});

// ── 2FA ───────────────────────────────────────────────────────────────────────
export const twofaRouter = Router();
twofaRouter.use(requireAuth);

function toBase32(buf) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '', result = '';
  for (const byte of buf) bits += byte.toString(2).padStart(8, '0');
  for (let i = 0; i + 5 <= bits.length; i += 5) result += chars[parseInt(bits.slice(i,i+5),2)];
  return result;
}
function totp(hex, w=0) {
  const t = Math.floor(Date.now()/30000)+w;
  const tb = Buffer.alloc(8); tb.writeBigInt64BE(BigInt(t));
  const h = crypto.createHmac('sha1', Buffer.from(hex,'hex')).update(tb).digest();
  const o = h[h.length-1]&0xf;
  return ((h.readUInt32BE(o)&0x7fffffff)%1000000).toString().padStart(6,'0');
}
function verifyTotp(hex, token) { return [-1,0,1].some(w=>totp(hex,w)===token); }

twofaRouter.get('/status', async (req,res)=>{
  const r = await query('SELECT enabled FROM two_factor_auth WHERE user_id=$1',[req.user.userId]);
  res.json({enabled:r.rows[0]?.enabled||false});
});

twofaRouter.post('/setup', async (req,res)=>{
  const buf = crypto.randomBytes(20);
  const hex = buf.toString('hex');
  const b32 = toBase32(buf);
  await query(`INSERT INTO two_factor_auth(user_id,secret,enabled) VALUES($1,$2,false)
    ON CONFLICT(user_id) DO UPDATE SET secret=$2,enabled=false`,[req.user.userId,hex]);
  const u = await query('SELECT email FROM users WHERE id=$1',[req.user.userId]);
  const email = encodeURIComponent(u.rows[0]?.email||'user');
  res.json({secret:b32, otpauthUrl:`otpauth://totp/PremiumKits:${email}?secret=${b32}&issuer=PremiumKits&algorithm=SHA1&digits=6&period=30`});
});

twofaRouter.post('/verify', async (req,res)=>{
  const {token} = req.body;
  if (!token||token.length!==6) return res.status(400).json({error:'6-digit code required'});
  const r = await query('SELECT secret FROM two_factor_auth WHERE user_id=$1',[req.user.userId]);
  if (!r.rows.length) return res.status(400).json({error:'2FA not set up'});
  if (!verifyTotp(r.rows[0].secret,token)) return res.status(400).json({error:'Invalid code — check device clock'});
  await query('UPDATE two_factor_auth SET enabled=true WHERE user_id=$1',[req.user.userId]);
  res.json({message:'2FA activated!'});
});

twofaRouter.delete('/disable', async (req,res)=>{
  const {token} = req.body;
  if (!token) return res.status(400).json({error:'Token required'});
  const r = await query('SELECT secret FROM two_factor_auth WHERE user_id=$1 AND enabled=true',[req.user.userId]);
  if (!r.rows.length) return res.status(400).json({error:'2FA not enabled'});
  if (!verifyTotp(r.rows[0].secret,token)) return res.status(400).json({error:'Invalid token'});
  await query('DELETE FROM two_factor_auth WHERE user_id=$1',[req.user.userId]);
  res.json({message:'2FA disabled'});
});

// ── PLAYERS ───────────────────────────────────────────────────────────────────
export const playersRouter = Router({ mergeParams: true });
playersRouter.use(requireAuth, requireServerAccess);

playersRouter.get('/', async (req,res)=>{
  const {page=1,limit=20,search=''} = req.query;
  const offset = (page-1)*limit;
  try {
    const [players,total] = await Promise.all([
      query(`SELECT player_uuid AS uuid, player_name AS username,
               COUNT(*)::int AS total_kits,
               MAX(given_at) AS last_give
             FROM kit_gives WHERE server_id=$1
               ${search?'AND player_name ILIKE $4':''}
             GROUP BY player_uuid,player_name
             ORDER BY last_give DESC LIMIT $2 OFFSET $3`,
        search?[req.params.serverId,limit,offset,`%${search}%`]:[req.params.serverId,limit,offset]),
      query(`SELECT COUNT(DISTINCT player_uuid)::int AS count FROM kit_gives WHERE server_id=$1`,[req.params.serverId])
    ]);
    res.json({players:players.rows, total:total.rows[0].count});
  } catch(e){console.error(e);res.status(500).json({error:'Failed'});}
});

playersRouter.get('/:uuid/history', async (req,res)=>{
  try {
    const r = await query(
      `SELECT kit_id, given_at FROM kit_gives WHERE server_id=$1 AND player_uuid=$2 ORDER BY given_at DESC LIMIT 50`,
      [req.params.serverId, req.params.uuid]
    );
    res.json({history:r.rows});
  } catch{res.status(500).json({error:'Failed'});}
});

playersRouter.post('/:uuid/give-kit', async (req,res)=>{
  const {kitId} = req.body;
  if (!kitId) return res.status(400).json({error:'kitId required'});
  const sent = wsManager.sendToServer(req.params.serverId, {type:'GIVE_KIT', playerUuid:req.params.uuid, kitId});
  if (!sent) return res.status(503).json({error:'Server offline'});
  res.json({ok:true});
});

playersRouter.post('/:uuid/reset-cooldown', async (req,res)=>{
  const {kitId} = req.body;
  try {
    if (kitId) {
      await query('DELETE FROM player_cooldowns WHERE server_id=$1 AND kit_id=$2 AND player_uuid=$3',[req.params.serverId,kitId,req.params.uuid]);
    } else {
      await query('DELETE FROM player_cooldowns WHERE server_id=$1 AND player_uuid=$2',[req.params.serverId,req.params.uuid]);
    }
    wsManager.sendToServer(req.params.serverId,{type:'RESET_COOLDOWN',playerUuid:req.params.uuid,kitId:kitId||null});
    res.json({ok:true});
  } catch{res.status(500).json({error:'Failed'});}
});

// Export CSV
playersRouter.get('/export/csv', async (req,res)=>{
  try {
    const r = await query(
      `SELECT player_uuid,player_name,COUNT(*)::int AS total,MAX(given_at) AS last
       FROM kit_gives WHERE server_id=$1 GROUP BY player_uuid,player_name ORDER BY total DESC`,
      [req.params.serverId]
    );
    const csv = 'UUID,Username,Total Kits,Last Give\n' +
      r.rows.map(p=>`${p.player_uuid},${p.player_name||''},${p.total},${p.last||''}`).join('\n');
    res.setHeader('Content-Type','text/csv');
    res.setHeader('Content-Disposition','attachment; filename=players.csv');
    res.send(csv);
  } catch{res.status(500).json({error:'Failed'});}
});

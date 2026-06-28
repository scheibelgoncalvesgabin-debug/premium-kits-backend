import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import { query } from '../db/pool.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

const sign = (userId, username) =>
  jwt.sign({ userId, username }, process.env.JWT_SECRET, { expiresIn: '15m' });

const signRefresh = (userId) =>
  jwt.sign({ userId }, process.env.JWT_REFRESH_SECRET, { expiresIn: '7d' });

router.post('/register', async (req, res) => {
  const { email, username, password } = req.body;
  if (!email || !username || !password) return res.status(400).json({ error: 'All fields required' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  try {
    const existing = await query(
      'SELECT id FROM users WHERE LOWER(email) = LOWER($1) OR LOWER(username) = LOWER($2)',
      [email, username]
    );
    if (existing.rows.length) return res.status(409).json({ error: 'Email or username already taken' });
    const hash = await bcrypt.hash(password, 12);
    const user = await query(
      'INSERT INTO users (email, username, password) VALUES ($1, $2, $3) RETURNING id, email, username',
      [email.toLowerCase(), username, hash]
    );
    const { id, username: uname } = user.rows[0];
    const token = sign(id, uname);
    const refresh = signRefresh(id);
    await query(
      'INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES ($1, $2, NOW() + INTERVAL \'7 days\')',
      [id, refresh]
    );
    res.status(201).json({ token, refresh, user: { id, username: uname, email } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Registration failed' });
  }
});

router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
  try {
    const r = await query('SELECT * FROM users WHERE LOWER(email) = LOWER($1)', [email]);
    if (!r.rows.length) return res.status(401).json({ error: 'Invalid credentials' });
    const user = r.rows[0];
    if (!await bcrypt.compare(password, user.password)) return res.status(401).json({ error: 'Invalid credentials' });
    const token = sign(user.id, user.username);
    const refresh = signRefresh(user.id);
    await query(
      'INSERT INTO refresh_tokens (user_id, token, expires_at) VALUES ($1, $2, NOW() + INTERVAL \'7 days\')',
      [user.id, refresh]
    );
    res.json({ token, refresh, user: { id: user.id, username: user.username, email: user.email } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Login failed' });
  }
});

router.post('/refresh', async (req, res) => {
  const { refresh } = req.body;
  if (!refresh) return res.status(400).json({ error: 'Refresh token required' });
  try {
    const payload = jwt.verify(refresh, process.env.JWT_REFRESH_SECRET);
    const r = await query(
      'SELECT * FROM refresh_tokens WHERE token = $1 AND expires_at > NOW()',
      [refresh]
    );
    if (!r.rows.length) return res.status(401).json({ error: 'Invalid or expired refresh token' });
    const user = await query('SELECT id, username, email FROM users WHERE id = $1', [payload.userId]);
    if (!user.rows.length) return res.status(401).json({ error: 'User not found' });
    const { id, username, email } = user.rows[0];
    res.json({ token: sign(id, username), user: { id, username, email } });
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
});

router.post('/logout', requireAuth, async (req, res) => {
  const { refresh } = req.body;
  if (refresh) await query('DELETE FROM refresh_tokens WHERE token = $1', [refresh]).catch(() => {});
  res.json({ message: 'Logged out' });
});

router.get('/me', requireAuth, async (req, res) => {
  try {
    const r = await query('SELECT id, username, email, created_at FROM users WHERE id = $1', [req.user.userId]);
    if (!r.rows.length) return res.status(404).json({ error: 'User not found' });
    res.json({ user: r.rows[0] });
  } catch { res.status(500).json({ error: 'Failed' }); }
});

export default router;

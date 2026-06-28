import express from 'express';
import { createServer } from 'http';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';
dotenv.config();

import authRouter from './routes/auth.js';
import serversRouter from './routes/servers.js';
import kitsRouter from './routes/kits.js';
import pluginRouter from './routes/plugin.js';
import { teamsRouter, twofaRouter, playersRouter } from './routes/misc.js';
import { wsManager } from './ws/manager.js';

const app = express();
const httpServer = createServer(app);

app.set('trust proxy', 1);
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(cors({
  origin: [
    process.env.FRONTEND_URL,
    'http://localhost:5173',
    /\.vercel\.app$/,
    /\.onrender\.com$/,
  ],
  credentials: true,
  methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS']
}));
app.use(compression());
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
app.use(express.json({ limit: '4mb' }));

// Rate limit
app.use('/api/', rateLimit({
  windowMs: 15 * 60 * 1000, max: 500,
  standardHeaders: true, legacyHeaders: false,
}));

// Health
app.get('/health', (req, res) => res.json({ status: 'ok', ts: Date.now(), uptime: process.uptime() }));

// ── Routes ────────────────────────────────────────────────────────────────────
// Plugin FIRST (uses API key auth, not JWT)
app.use('/api/plugin', pluginRouter);

// Auth
app.use('/api/auth', authRouter);
app.use('/api/auth/2fa', twofaRouter);

// Servers
app.use('/api/servers', serversRouter);
app.use('/api/servers/:serverId/kits', kitsRouter);
app.use('/api/servers/:serverId/team', teamsRouter);
app.use('/api/servers/:serverId/players', playersRouter);

// 404 + Error
app.use((req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// WebSocket
wsManager.init(httpServer);
wsManager.startHeartbeat();

const PORT = parseInt(process.env.PORT) || 3001;
httpServer.listen(PORT, () => {
  console.log(`🚀 PremiumKits Backend v2.0 running on port ${PORT}`);
  console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);

  // Self-ping anti-sleep (Render Free)
  if (process.env.NODE_ENV === 'production' && process.env.RENDER_EXTERNAL_URL) {
    const url = process.env.RENDER_EXTERNAL_URL + '/health';
    console.log(`🏓 Self-ping → ${url} every 14min`);
    setInterval(async () => {
      try {
        const r = await fetch(url);
        const d = await r.json();
        console.log(`[Self-ping] ✅ uptime ${Math.floor(d.uptime)}s`);
      } catch (e) { console.warn(`[Self-ping] ⚠️ ${e.message}`); }
    }, 14 * 60 * 1000);
  }
});

process.on('SIGTERM', () => httpServer.close(() => process.exit(0)));

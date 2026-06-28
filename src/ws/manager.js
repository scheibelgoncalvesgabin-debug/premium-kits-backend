import { WebSocketServer } from 'ws';
import { query } from '../db/pool.js';

class WsManager {
  constructor() {
    this.wss = null;
    // serverId -> ws connection
    this.servers = new Map();
    // serverId -> Set of browser clients
    this.browsers = new Map();
  }

  init(httpServer) {
    this.wss = new WebSocketServer({ server: httpServer, path: '/ws' });
    this.wss.on('connection', (ws, req) => this.handleConnection(ws, req));
    console.log('✅ WebSocket server initialized');
  }

  async handleConnection(ws, req) {
    const url = new URL(req.url, 'http://localhost');
    const apiKey = url.searchParams.get('key');
    const token  = url.searchParams.get('token');

    if (apiKey) {
      // Plugin connection
      try {
        const r = await query('SELECT id, name FROM servers WHERE api_key = $1', [apiKey]);
        if (!r.rows.length) { ws.close(4001, 'Invalid API key'); return; }
        const server = r.rows[0];
        this.servers.set(server.id, ws);

        await query('UPDATE servers SET online = true, last_ping = NOW() WHERE id = $1', [server.id]);
        this.broadcastToServer(server.id, { type: 'SERVER_ONLINE', serverId: server.id });

        ws.send(JSON.stringify({ type: 'CONNECTED', serverId: server.id, serverName: server.name }));
        ws.on('message', (data) => this.handlePluginMessage(server.id, data));
        ws.on('close', async () => {
          this.servers.delete(server.id);
          await query('UPDATE servers SET online = false WHERE id = $1', [server.id]);
          this.broadcastToServer(server.id, { type: 'SERVER_OFFLINE', serverId: server.id });
        });
      } catch (err) { console.error('WS plugin auth error:', err); ws.close(4000, 'Error'); }
    }
    // Browser connections handled separately via REST + SSE
  }

  handlePluginMessage(serverId, data) {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'KIT_GIVEN') {
        this.broadcastToServer(serverId, { type: 'KIT_GIVEN_LIVE', ...msg });
      }
    } catch (e) { console.error('WS message parse error:', e); }
  }

  sendToServer(serverId, message) {
    const ws = this.servers.get(serverId);
    if (!ws || ws.readyState !== 1) return false;
    ws.send(JSON.stringify(message));
    return true;
  }

  broadcastToServer(serverId, message) {
    const clients = this.browsers.get(serverId);
    if (!clients) return;
    const data = JSON.stringify(message);
    clients.forEach(ws => { if (ws.readyState === 1) ws.send(data); });
  }

  isOnline(serverId) { return this.servers.has(serverId); }

  startHeartbeat() {
    setInterval(() => {
      this.servers.forEach((ws, serverId) => {
        if (ws.readyState === 1) {
          ws.ping();
          query('UPDATE servers SET last_ping = NOW() WHERE id = $1', [serverId]).catch(() => {});
        } else {
          this.servers.delete(serverId);
        }
      });
    }, 30000);
  }
}

export const wsManager = new WsManager();

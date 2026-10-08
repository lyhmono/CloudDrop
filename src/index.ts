/**
 * CloudDrop - Cloudflare Worker Entry Point
 * Routes requests to static assets or WebSocket signaling
 */

import { Room } from './room';

export { Room };

export interface Env {
  ROOM: DurableObjectNamespace;
  // Cloudflare TURN credentials (set in wrangler.toml or dashboard)
  TURN_KEY_ID?: string;
  TURN_KEY_API_TOKEN?: string;
}

// =============================================================================
// Per-IP window rate limiting (shared by ICE credentials and room checks)
// Each unique client previously triggered a fresh Cloudflare TURN API call -
// expensive and abusable. Cache at module scope and throttle by IP.
// =============================================================================
let cachedIceServers: { iceServers: unknown[]; expiresAt: number } | null = null;

interface RateWindow { count: number; resetAt: number }
const iceServersRequestLimits = new Map<string, RateWindow>();
const checkPasswordRequestLimits = new Map<string, RateWindow>();
const wsHandshakeLimits = new Map<string, RateWindow>();
const ICE_SERVERS_MAX_PER_IP = 10;         // 10 requests
const CHECK_PASSWORD_MAX_PER_IP = 30;      // 30 requests
const WS_HANDSHAKE_MAX_PER_IP = 60;        // WS 握手 60 次/分钟/IP（容忍 CGNAT 共享出口，仍能拦洪水建连）
const RATE_WINDOW_MS = 60 * 1000;          // per minute, per IP

function isIpRateLimited(store: Map<string, RateWindow>, ip: string, maxPerIp: number): boolean {
  const now = Date.now();
  let entry = store.get(ip);

  if (!entry || now > entry.resetAt) {
    // Map 只增不删会无限增长：超过阈值时顺带清理过期条目
    if (store.size > 500) {
      for (const [k, v] of store) {
        if (now > v.resetAt) store.delete(k);
      }
    }
    store.set(ip, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return false;
  }

  entry.count++;
  return entry.count > maxPerIp;
}

// =============================================================================
// Same-origin gate for WebSocket upgrades
// WebSocket 不受同源策略约束：任何网页都能在「访问过 CloudDrop 的用户」浏览器里
// 直接 new WebSocket 连进来。自动分配房间按客户端 IP（/24、/64）哈希分房，
// 这类跨站连接的源 IP 恰好就是受害者本人——恶意页面因此能枚举其同网段房间里的
// 设备名/浏览器信息、注入信令，甚至在房间内待满 3 秒后设置密码把原成员踢出。
// 浏览器发起的 WS/请求必带 Origin；curl、ws 库等非浏览器客户端不带（无法伪造），
// 保持放行以兼容 API 调用与冒烟测试。
// =============================================================================
function isTrustedOrigin(request: Request): boolean {
  const origin = request.headers.get('Origin');
  if (!origin) return true;
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch (e) {
    return false;
  }
}

const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), magnetometer=(), gyroscope=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Resource-Policy': 'same-origin',
};

/** 给 Worker 路由响应统一附加安全头（静态资源由 public/_headers 覆盖） */
function withSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(SECURITY_HEADERS)) {
    if (!headers.has(k)) headers.set(k, v);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Handle WebSocket upgrade requests
    // 注意：101 升级响应不能经 withSecurityHeaders 重建（会破坏 WebSocket 配对）
    if (url.pathname === '/ws') {
      // 跨站 WS 门禁：浏览器发起的升级必带 Origin，非同源直接拒绝
      // （自动分配房间按源 IP 分房，跨站连接会命中受害者本人房间，详见 isTrustedOrigin）
      if (!isTrustedOrigin(request)) {
        return new Response('Forbidden: cross-origin WebSocket', {
          status: 403,
          headers: { ...SECURITY_HEADERS, 'Content-Type': 'text/plain' },
        });
      }
      // WS 握手频控：防匿名高频建连（每房间一个 DO 冷启动 + 连接成本）
      const wsIp = request.headers.get('CF-Connecting-IP') || 'unknown';
      if (isIpRateLimited(wsHandshakeLimits, wsIp, WS_HANDSHAKE_MAX_PER_IP)) {
        return new Response('Too many requests', {
          status: 429,
          headers: { ...SECURITY_HEADERS, 'Content-Type': 'text/plain' },
        });
      }
      return handleWebSocket(request, env);
    }

    // Handle room password APIs
    if (url.pathname === '/api/room/check-password') {
      if (!isTrustedOrigin(request)) {
        return withSecurityHeaders(new Response(JSON.stringify({ success: false, error: 'Forbidden' }), {
          status: 403,
          headers: { 'Content-Type': 'application/json' },
        }));
      }
      return withSecurityHeaders(await handleCheckRoomPassword(request, env));
    }

    // Handle ICE servers request (for TURN credentials)
    if (url.pathname === '/api/ice-servers') {
      return withSecurityHeaders(await handleIceServers(request, env));
    }

    // Static assets are handled automatically by Cloudflare
    // This is just a fallback for any unhandled routes
    return withSecurityHeaders(new Response('Not Found', { status: 404 }));
  },
};

/**
 * Handle WebSocket connections by routing to the appropriate room
 * Room is determined by: 1) explicit room param, or 2) client IP address
 */
async function handleWebSocket(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  // Check for explicit room parameter first
  const explicitRoom = url.searchParams.get('room');

  let roomId: string;
  let roomCode: string; // User-friendly room code to display

  if (explicitRoom && /^[a-zA-Z0-9]{6}$/.test(explicitRoom)) {
    // Explicit room code from URL parameter
    roomCode = explicitRoom.toUpperCase();
  } else {
    // Auto-assign room based on client IP
    const clientIP = request.headers.get('CF-Connecting-IP') ||
                     request.headers.get('X-Forwarded-For')?.split(',')[0] ||
                     'default';
    const ipHash = await generateRoomId(clientIP);
    roomCode = ipHash.substring(0, 6).toUpperCase();
  }

  // Unified: roomId is always derived from roomCode
  roomId = `room-${roomCode.toLowerCase()}`;

  // 客户端网段桶（IPv4 /24、IPv6 /64 哈希）：供房间内 per-IP 爆破计数。
  // CF-Connecting-IP 由 Cloudflare 边缘注入，客户端无法伪造（CF- 前缀头被剥离）
  const clientIP = request.headers.get('CF-Connecting-IP') || 'local-dev';
  const ipBucket = await generateRoomId(clientIP);

  // Get or create the room Durable Object
  const roomObjectId = env.ROOM.idFromName(roomId);
  const roomStub = env.ROOM.get(roomObjectId);

  // Forward the WebSocket request to the room with room info
  const wsUrl = new URL(request.url);
  wsUrl.pathname = '/ws';
  // Pass room code via header so Room can include it in join response
  const headers = new Headers(request.headers);
  headers.set('X-Room-Code', roomCode);
  headers.set('X-Client-Bucket', ipBucket);

  return roomStub.fetch(new Request(wsUrl.toString(), {
    headers,
    method: request.method,
  }));
}

/**
 * Return ICE servers configuration with TURN credentials
 */
async function handleIceServers(request: Request, env: Env): Promise<Response> {
  // Default STUN-only configuration (fallback if TURN not configured)
  // Prioritize China-accessible servers, with global fallbacks
  // 注意：不要加 stun.syncthing.net —— 该域名解析到 192.0.2.42（RFC 5737 文档
  // 保留段，不可路由），加了只会白占客户端的健康检查位并刷 ICE 报错。
  const defaultIceServers = [
    // China-accessible STUN servers (prioritized)
    { urls: 'stun:stun.miwifi.com:3478' },      // Xiaomi - China
    { urls: 'stun:stun.yy.com:3478' },          // YY - China
    // Global STUN servers
    { urls: 'stun:stun.cloudflare.com:3478' },  // Cloudflare
    { urls: 'stun:stun.nextcloud.com:3478' },   // Nextcloud
  ];

  const jsonHeaders = { 'Content-Type': 'application/json' };

  // If TURN credentials are configured, fetch dynamic credentials
  if (env.TURN_KEY_ID && env.TURN_KEY_API_TOKEN) {
    // Throttle by IP so TURN credentials can't be scraped for bandwidth abuse
    const clientIP = request.headers.get('CF-Connecting-IP') || 'unknown';
    if (isIpRateLimited(iceServersRequestLimits, clientIP, ICE_SERVERS_MAX_PER_IP)) {
      return new Response(JSON.stringify({ error: 'Too many requests' }), {
        status: 429,
        headers: jsonHeaders,
      });
    }

    try {
      // Serve from cache while at least 10min of TTL remains (credential TTL is 1h)
      if (cachedIceServers && cachedIceServers.expiresAt - Date.now() > 10 * 60 * 1000) {
        return new Response(JSON.stringify({ iceServers: cachedIceServers.iceServers }), {
          headers: { ...jsonHeaders, 'Cache-Control': 'private, max-age=60' },
        });
      }

      const response = await fetch(
        `https://rtc.live.cloudflare.com/v1/turn/keys/${env.TURN_KEY_ID}/credentials/generate-ice-servers`,
        {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${env.TURN_KEY_API_TOKEN}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ ttl: 3600 }), // 1h：凭据一旦外泄，可滥用窗口从 24h 压到 1h
        }
      );

      if (response.ok) {
        const data = await response.json() as { iceServers: unknown[] };
        // Filter out port 53 URLs (blocked by browsers)
        const filteredServers = data.iceServers.map((server: unknown) => {
          const s = server as { urls?: string | string[] };
          if (Array.isArray(s.urls)) {
            return { ...s, urls: s.urls.filter((url: string) => !url.includes(':53')) };
          }
          return s;
        });

        // 凭据 TTL 1h：缓存 50min 留 10min 余量；服务函数按"剩余 >10min"判有效
        cachedIceServers = { iceServers: filteredServers, expiresAt: Date.now() + 50 * 60 * 1000 };

        return new Response(JSON.stringify({ iceServers: filteredServers }), {
          headers: { ...jsonHeaders, 'Cache-Control': 'private, max-age=60' },
        });
      }
    } catch (error) {
      console.error('Failed to fetch TURN credentials:', error);
    }
  }

  // Return default STUN-only config
  return new Response(JSON.stringify({ iceServers: defaultIceServers }), {
    headers: jsonHeaders,
  });
}

/**
 * Generate a room ID from an IP address
 * IPv4: uses first 3 octets (/24 network)
 * IPv6: uses first 4 groups (/64 network prefix)
 * Local: uses 'localhost' as seed for consistent local room
 */
export async function generateRoomId(ip: string): Promise<string> {
  let networkPart: string;

  // For local development, use 'localhost' as seed
  // This generates a valid shareable room code instead of 'local-dev-room'
  if (ip === 'default' || ip === '127.0.0.1' || ip === '::1') {
    networkPart = 'localhost';
  } else if (ip.includes('.') && !ip.includes(':')) {
    // IPv4: use first 3 octets for /24 network
    const parts = ip.split('.');
    if (parts.length === 4) {
      networkPart = parts.slice(0, 3).join('.');
    } else {
      networkPart = ip;
    }
  } else {
    // IPv6 - extract network prefix (first 64 bits = first 4 groups)
    const expanded = expandIPv6(ip);
    const groups = expanded.split(':');
    networkPart = groups.slice(0, 4).join(':');
  }

  // Hash the network portion to generate room ID
  const encoder = new TextEncoder();
  const data = encoder.encode(networkPart);
  const hash = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hash));
  return hashArray.slice(0, 8).map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Expand abbreviated IPv6 address to full form
 */
export function expandIPv6(ip: string): string {
  // Remove IPv4-mapped suffix if present
  if (ip.includes('.')) {
    const lastColon = ip.lastIndexOf(':');
    ip = ip.substring(0, lastColon);
  }

  // Handle :: abbreviation
  if (ip.includes('::')) {
    const parts = ip.split('::');
    const left = parts[0] ? parts[0].split(':') : [];
    const right = parts[1] ? parts[1].split(':') : [];
    const missing = 8 - left.length - right.length;
    const middle = Array(missing).fill('0000');
    const full = [...left, ...middle, ...right];
    return full.map(g => g.padStart(4, '0')).join(':');
  }

  // Already full, just pad each group
  return ip.split(':').map(g => g.padStart(4, '0')).join(':');
}

/**
 * Handle room password check
 * Forwards request to the appropriate Room Durable Object
 */
async function handleCheckRoomPassword(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const roomParam = url.searchParams.get('room');

  // 限流：该端点每次合法请求都会激活一个 Room DO（读 storage），
  // 不设限可被用来批量探测房间码/刷 DO 读写成本
  const clientIP = request.headers.get('CF-Connecting-IP') || 'unknown';
  if (isIpRateLimited(checkPasswordRequestLimits, clientIP, CHECK_PASSWORD_MAX_PER_IP)) {
    return new Response(JSON.stringify({ success: false, error: 'Too many requests' }), {
      status: 429,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  if (!roomParam || !/^[a-zA-Z0-9]{6}$/.test(roomParam)) {
    return new Response(JSON.stringify({
      success: false,
      error: 'Invalid room code format'
    }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  const roomId = `room-${roomParam.toLowerCase()}`;
  const roomObjectId = env.ROOM.idFromName(roomId);
  const roomStub = env.ROOM.get(roomObjectId);

  // Forward request to Room Durable Object
  const roomUrl = new URL(request.url);
  roomUrl.pathname = '/check-password';

  return roomStub.fetch(new Request(roomUrl.toString(), {
    method: 'GET',
    headers: request.headers,
  }));
}

/**
 * CloudDrop - Durable Object for room management
 * Manages WebSocket connections and signaling for P2P file sharing
 * Supports optional password protection for secure rooms
 */

// WebSocket readyState constants (may not be available in Workers environment)
const WS_READY_STATE = {
  CONNECTING: 0,
  OPEN: 1,
  CLOSING: 2,
  CLOSED: 3,
};

export interface Env {
  ROOM: DurableObjectNamespace;
}

/** 入站消息类型（客户端 → Room，webSocketMessage 的 switch 处理集） */
type IncomingMessageType = 'join' | 'offer' | 'answer' | 'ice-candidate' | 'name-changed' | 'relay-data' | 'key-exchange' | 'file-request' | 'file-response' | 'file-cancel' | 'identity-challenge' | 'identity-response' | 'set-password' | 'auth';

/** 出站/广播消息类型（Room → 客户端；offer 等既入站也转发） */
type OutgoingMessageType = 'joined' | 'peer-joined' | 'peer-left' | 'name-changed' | 'offer' | 'answer' | 'ice-candidate' | 'relay-data' | 'key-exchange' | 'file-request' | 'file-response' | 'file-cancel' | 'identity-challenge' | 'identity-response' | 'challenge' | 'auth-success' | 'room-locked' | 'set-password-result' | 'error';

interface SignalingMessage {
  type: IncomingMessageType | OutgoingMessageType;
  from?: string;
  to?: string;
  data?: unknown;
}

/**
 * Peer attachment data stored with WebSocket (survives hibernation)
 */
interface PeerAttachment {
  id?: string;
  name?: string;
  deviceType?: 'desktop' | 'mobile' | 'tablet';
  browserInfo?: string;
  deviceKey?: string; // 持久设备身份公钥（防伪造信任）
  publicKey?: string;
  isAuthenticated?: boolean;
  authChallenge?: string;
  authAttempts?: number; // Track failed attempts per connection
  clientBucket?: string; // 客户端网段桶（/24 或 /64 哈希），per-IP 爆破计数用
  joinedAt?: number; // 加入房间时间戳（设密在场要求）
  connId?: string; // 连接级 ID：限流状态 Maps 的键（不得以 WebSocket 对象为键——强引用会阻断休眠）
}

/**
 * Room Durable Object - handles WebSocket connections for a room (based on IP)
 * Uses WebSocket Hibernation API for cost efficiency
 * Peer data is stored in WebSocket attachments to survive hibernation
 * Supports optional password protection for secure rooms
 */
export class Room {
  private state: DurableObjectState;
  private passwordHash: string | null; // Password hash for secure rooms (null = no password)
  // 限流状态全部以 connId 字符串为键：类属性持有 WebSocket 对象（作为值或
  // Map 键）都是强引用，会阻断连接休眠/实例驱逐（AGENTS §3 Hibernation 约定）
  private messageRateLimits: Map<string, { count: number; lastReset: number }> = new Map();
  private relayByteBudget: Map<string, { tokens: number; lastRefill: number }> = new Map();
  private iceByteBudget: Map<string, { tokens: number; lastRefill: number }> = new Map();
  private relayDropWarn: Map<string, number> = new Map(); // connId -> last warning timestamp
  private leaveNotified: WeakSet<WebSocket> = new WeakSet(); // peer-left 广播去重（弱引用，无害）
  // Removed global passwordAttempts to prevent DoS

  // Constants
  private static readonly MAX_NAME_LENGTH = 50;
  private static readonly RATE_LIMIT_WINDOW = 1000; // 1 second
  private static readonly MAX_MSGS_PER_WINDOW = 10; // 10 messages per second (control messages)
  private static readonly RELAY_BYTES_PER_SEC = 2 * 1024 * 1024; // 2MB/s data budget for relay
  private static readonly RELAY_BURST_BYTES = 4 * 1024 * 1024; // 4MB burst allowance
  // ICE 候选独立小额预算：不随 2MB/s 的文件流量被挤占，保障 P2P 协商/恢复
  private static readonly ICE_BYTES_PER_SEC = 64 * 1024;
  private static readonly ICE_BURST_BYTES = 128 * 1024;
  private static readonly MAX_MSG_BYTES = 262144; // 256KB per signaling frame
  private static readonly MAX_PASSWORD_ATTEMPTS = 5; // 5 attempts per connection
  private static readonly MAX_ROOM_AUTH_FAILURES = 50; // Global failures per room within window
  private static readonly MAX_IP_AUTH_FAILURES = 10; // Per network-bucket failures within window
  private static readonly AUTH_FAILURE_WINDOW = 10 * 60 * 1000; // 10 minutes
  private static readonly ROOM_CLAIM_MIN_PRESENCE = 3000; // 设密前需在房间内最短 3 秒
  private static readonly SECURE_ROOM_TTL = 600000; // 10 minutes

  constructor(state: DurableObjectState, _env: Env) {
    this.state = state;
    this.passwordHash = null;

    // Load password hash from storage on initialization
    this.state.blockConcurrencyWhile(async () => {
      try {
        this.passwordHash = await this.state.storage.get<string>('passwordHash') || null;
      } catch (e) {
        // 存储读失败不得让 DO 构造期抛异常（blockConcurrencyWhile 内未捕获的
        // 错误会毒化整个实例）：降级为无密码开放房间，下一次写会恢复真值
        console.error('[Room] Failed to load passwordHash:', e);
        this.passwordHash = null;
      }
      // If there's a password, set an alarm to check for inactivity
      if (this.passwordHash) {
         await this.scheduleInactivityCheck();
      }
    });
  }

  /**
   * Schedule inactivity check alarm
   */
  private async scheduleInactivityCheck() {
     const currentAlarm = await this.state.storage.getAlarm();
     if (currentAlarm === null) {
        await this.state.storage.setAlarm(Date.now() + Room.SECURE_ROOM_TTL);
     }
  }

  /**
   * Handle Durable Object Alarm
   * Triggered when room is inactive for too long
   */
  async alarm(): Promise<void> {
    // Check if room has any AUTHENTICATED peers
    const activePeers = this.getActivePeers();
    let hasAuthenticatedUsers = false;
    
    for (const { attachment } of activePeers.values()) {
      if (attachment.isAuthenticated) {
        hasAuthenticatedUsers = true;
        break;
      }
    }

    if (!hasAuthenticatedUsers && this.passwordHash) {
       // Room is empty (or only has unauthenticated ghosts) -> destroy it
       this.passwordHash = null;
       await this.state.storage.delete('passwordHash');

       // Close ALL connections (authenticated or not) - the room is gone.
       // getActivePeers() only returns joined peers, so iterate sockets directly.
       for (const ws of this.state.getWebSockets()) {
         try { ws.close(4000, 'Room destroyed due to inactivity'); } catch (e) { /* ignore */ }
       }

       console.log('[Room] Secure room destroyed due to inactivity');
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/ws') {
      return this.handleWebSocket(request);
    }

    if (url.pathname === '/check-password') {
      // Check if room has password protection
      return this.handleCheckPassword(request);
    }

    return new Response('Not Found', { status: 404 });
  }

  /**
   * Check if room requires password
   */
  private handleCheckPassword(_request: Request): Response {
    return new Response(JSON.stringify({
      hasPassword: this.passwordHash !== null
    }), {
      headers: { 'Content-Type': 'application/json' }
    });
  }

  /**
   * 通过 WebSocket 在房间内设置密码（替代原 HTTP 端点）
   * 要求发送者已加入房间（持有 peerId），从根本封死任意房间抢注
   */
  private async handleSetPasswordViaWs(ws: WebSocket, msg: SignalingMessage): Promise<void> {
    const attachment = ws.deserializeAttachment() as PeerAttachment | null;

    // 未加入房间的连接不能设置密码
    if (!attachment?.id) {
      this.sendErrorFrame(ws, 'FORBIDDEN', '需要先加入房间才能设置密码');
      return;
    }

    // 只允许首次设置；要求设置者已在房间内待满最短时间（提高抢注成本）
    if (this.passwordHash !== null) {
      this.sendErrorFrame(ws, 'PASSWORD_ALREADY_SET', '房间密码已设置');
      return;
    }

    if (!attachment.joinedAt || (Date.now() - attachment.joinedAt) < Room.ROOM_CLAIM_MIN_PRESENCE) {
      this.sendErrorFrame(ws, 'FORBIDDEN', '需要先在房间内停留片刻才能设置密码');
      return;
    }

    // 防夺房：设密会强制断开房间内其他所有连接（4001），若允许任意成员
    // 执行，任何同室者都能单方面踢掉全员并独占房间。因此只允许房间内
    // 唯一设备设密——需加密请先让所有设备离开。
    for (const [peerId] of this.getActivePeers()) {
      if (peerId !== attachment.id) {
        this.sendErrorFrame(ws, 'ROOM_OCCUPIED', '房间内还有其他设备，请让所有设备离开后再设置密码');
        return;
      }
    }

    const body = msg.data as { passwordHash?: string };
    // 严格格式：64 位十六进制（SHA-256）
    if (!body?.passwordHash || typeof body.passwordHash !== 'string' || !/^[a-f0-9]{64}$/i.test(body.passwordHash)) {
      this.sendErrorFrame(ws, 'INVALID_PASSWORD_HASH', '无效的密码哈希');
      return;
    }

    this.passwordHash = body.passwordHash;
    await this.state.storage.put('passwordHash', body.passwordHash);
    await this.state.storage.setAlarm(Date.now() + Room.SECURE_ROOM_TTL);

    // 撤权先于回执：设密者的连接可能在上面 storage.put 的 await 期间断开，
    // 若把 ws.send 排在前头，它抛错会（此前版本）直接吞掉后面的广播与关闭循环，
    // 旧成员保持 isAuthenticated 继续用已加密房间的信令。
    // 通知房间内其他设备：房间已被加密，需要密码重新加入
    this.broadcast({ type: 'room-locked', data: {} }, attachment.id);

    // 强制撤销旧成员：关闭除设密者外的所有连接（4001 = 需要密码）。
    // 仅广播不足以撤销权限——被忽略时旧连接仍可继续转发信令
    for (const otherWs of this.state.getWebSockets()) {
      if (otherWs === ws) continue;
      try {
        otherWs.close(4001, 'room locked');
      } catch (e) {
        // 忽略关闭失败
      }
    }

    // 回执设密者；断线也不能影响已完成密码设置与撤权
    this.safeSend(ws, JSON.stringify({ type: 'set-password-result', success: true }));
  }

  private handleWebSocket(request: Request): Response {
    // Check for WebSocket upgrade
    const upgradeHeader = request.headers.get('Upgrade');
    if (!upgradeHeader || upgradeHeader !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 });
    }

    // Get room code from header (passed by index.ts)
    const roomCode = request.headers.get('X-Room-Code') || '';

    // Create WebSocket pair
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];

    // Accept the WebSocket with hibernation API
    // Use tag to store room code (survives hibernation)
    this.state.acceptWebSocket(server, [roomCode]);

    // Generate challenge nonce
    const nonce = crypto.randomUUID();

    // 连接级 ID：限流状态 Maps 的键（避免以 WebSocket 对象为键的强引用）
    const connId = crypto.randomUUID();

    // Initialize attachment with isAuthenticated: false if password is set
    // If no password, they are implicitly authenticated
    server.serializeAttachment({
      connId,
      isAuthenticated: this.passwordHash === null,
      authChallenge: nonce,
      authAttempts: 0,
      clientBucket: this.sanitizeString(request.headers.get('X-Client-Bucket') || '', 64)
    });

    // Initialize rate limiter for this connection
    this.messageRateLimits.set(connId, { count: 0, lastReset: Date.now() });

    // If password is required, send challenge immediately (携带房间号：
    // 无本地密码的客户端需要它来引导输入密码，自动分配房间此前拿不到 roomCode)
    if (this.passwordHash !== null) {
      server.send(JSON.stringify({
        type: 'challenge',
        data: { nonce, roomCode }
      }));
      // Do NOT delete alarm here. Wait until auth success.
    }

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  /**
   * Get all active peers from WebSocket attachments (survives hibernation)
   * Only returns peers with OPEN WebSocket connections
   */
  private getActivePeers(): Map<string, { ws: WebSocket; attachment: PeerAttachment }> {
    const peers = new Map<string, { ws: WebSocket; attachment: PeerAttachment }>();
    const webSockets = this.state.getWebSockets();

    for (const ws of webSockets) {
      const attachment = ws.deserializeAttachment() as PeerAttachment | null;
      const readyState = ws.readyState;

      // Only include WebSockets that are OPEN (readyState === 1) and have valid attachment
      // Use explicit constant as WebSocket.OPEN may not be available in Workers
      if (attachment && attachment.id && readyState === WS_READY_STATE.OPEN) {
        peers.set(attachment.id, { ws, attachment });
      }
    }

    return peers;
  }

  /**
   * Get peer ID from WebSocket attachment
   */
  private getPeerIdFromWs(ws: WebSocket): string | undefined {
    const attachment = ws.deserializeAttachment() as PeerAttachment | null;
    return attachment?.id;
  }

  /**
   * WebSocket message handler (Hibernation API)
   */
  async webSocketMessage(ws: WebSocket, message: ArrayBuffer | string): Promise<void> {
    try {
      // 1. Message Size Validation (Basic DoS protection)——校验前置：
      //    二进制帧直接按 byteLength 判断字节数，不再先全量解码超大帧
      //    （旧实现 decode 完才查，且 string.length 是 UTF-16 长度非字节）
      const frameBytes = typeof message === 'string' ? message.length : message.byteLength;
      if (frameBytes > Room.MAX_MSG_BYTES) {
         this.sendErrorFrame(ws, 'MESSAGE_TOO_LARGE', 'Message exceeds size limit (256KB)');
         return;
      }

      const data = typeof message === 'string' ? message : new TextDecoder().decode(message);

      const msg: SignalingMessage = JSON.parse(data);

      // attachment 提前解析：限流状态以 connId（字符串）为键，避免持有 WS 引用
      const attachment = ws.deserializeAttachment() as PeerAttachment | null;
      const connId = attachment?.connId || '';

      // 2. Typed rate limiting:
      //    - relay-data: byte-based token bucket (2MB/s)——分块丢弃由 ACK/重传自愈
      //    - ice-candidate: 独立 64KB/s 预算，文件洪灌不挤占 P2P 协商
      //    - all other (control) messages: low per-connection message quota,
      //      exceeded -> identifiable error frame instead of silent drop
      if (msg.type === 'relay-data') {
        if (connId && !this.consumeBudget(this.relayByteBudget, connId, frameBytes, Room.RELAY_BYTES_PER_SEC, Room.RELAY_BURST_BYTES)) {
          // 限频告警（每秒最多一条）
          const now = Date.now();
          const lastWarn = this.relayDropWarn.get(connId) || 0;
          if (now - lastWarn > 1000) {
            this.relayDropWarn.set(connId, now);
            this.sendErrorFrame(ws, 'RATE_LIMIT_EXCEEDED', '中继数据超速，部分分块已丢弃（将自动重传）');
          }
          return;
        }
      } else if (msg.type === 'ice-candidate') {
        if (connId && !this.consumeBudget(this.iceByteBudget, connId, frameBytes, Room.ICE_BYTES_PER_SEC, Room.ICE_BURST_BYTES)) {
          // ICE 候选被丢会伤 P2P 协商，明确告知
          this.sendErrorFrame(ws, 'RATE_LIMIT_EXCEEDED', 'ICE candidate 发送过快');
          return;
        }
      } else if (connId && this.isRateLimited(connId)) {
        this.sendErrorFrame(ws, 'RATE_LIMIT_EXCEEDED', '消息发送过快，请稍后重试');
        return;
      }

      // If room has password and user is not authenticated yet
      if (this.passwordHash !== null) {
        const isAuthenticated = attachment?.isAuthenticated === true;
        
        if (!isAuthenticated) {
          if (msg.type === 'auth') {
             await this.handleAuth(ws, msg);
             return;
          }
          
          // Reject any other message type if not authenticated
          ws.send(JSON.stringify({
            type: 'error',
            error: 'PASSWORD_REQUIRED',
            message: '此房间需要密码'
          }));
          return;
        }
      }

      switch (msg.type) {
        case 'join':
          await this.handleJoin(ws, msg);
          break;
        case 'offer':
        case 'answer':
        case 'ice-candidate':
        case 'identity-challenge':
        case 'identity-response':
          await this.handleSignaling(ws, msg);
          break;
        case 'set-password':
          await this.handleSetPasswordViaWs(ws, msg);
          break;
        case 'relay-data':
          await this.handleRelayData(ws, msg);
          break;
        case 'key-exchange':
          await this.handleKeyExchange(ws, msg);
          break;
        case 'name-changed':
          await this.handleNameChanged(ws, msg);
          break;
        case 'file-request':
        case 'file-response':
        case 'file-cancel':
          await this.handleFileSignaling(ws, msg);
          break;
      }
    } catch (error) {
      console.error('WebSocket message error:', error);
    }
  }

  /**
   * 读取某网段桶的认证失败计数（过期自动视为清零）
   */
  private async getBucketAuthFailures(bucket: string): Promise<{ count: number; windowStart: number }> {
    const all = await this.state.storage.get<Record<string, { count: number; windowStart: number }>>('authFailuresByBucket') || {};
    const now = Date.now();
    const entry = all[bucket];
    if (entry && (now - entry.windowStart) < Room.AUTH_FAILURE_WINDOW) {
      return entry;
    }
    return { count: 0, windowStart: now };
  }

  /**
   * 递增某网段桶的认证失败计数（清理过期条目，防存储无限增长）
   * 注意：调用方（handleAuth）已处于 blockConcurrencyWhile 串行区内；
   * blockConcurrencyWhile 不可嵌套，这里不得再包一层。
   */
  private async incrementBucketAuthFailures(bucket: string): Promise<void> {
    const all = await this.state.storage.get<Record<string, { count: number; windowStart: number }>>('authFailuresByBucket') || {};
    const now = Date.now();

    for (const k of Object.keys(all)) {
      if (now - all[k].windowStart >= Room.AUTH_FAILURE_WINDOW) {
        delete all[k];
      }
    }

    const entry = all[bucket] || { count: 0, windowStart: now };
    // 窗口起点只在过期重建时更新，失败只累加计数（防永久锁房 DoS）
    entry.count += 1;
    all[bucket] = entry;

    await this.state.storage.put('authFailuresByBucket', all);
  }

  /**
   * 认证成功后清除该网段桶的失败计数
   */
  private async clearBucketAuthFailures(bucket: string): Promise<void> {
    const all = await this.state.storage.get<Record<string, { count: number; windowStart: number }>>('authFailuresByBucket');
    if (!all || !all[bucket]) return;
    delete all[bucket];
    await this.state.storage.put('authFailuresByBucket', all);
  }

  /**
   * Check if connection is rate limited (control messages only)
   */
  private isRateLimited(connId: string): boolean {
    let limit = this.messageRateLimits.get(connId);
    const now = Date.now();

    if (!limit) {
      limit = { count: 0, lastReset: now };
      this.messageRateLimits.set(connId, limit);
    }

    if (now - limit.lastReset > Room.RATE_LIMIT_WINDOW) {
      limit.count = 0;
      limit.lastReset = now;
    }

    limit.count++;

    // If exceeded, we can block
    if (limit.count > Room.MAX_MSGS_PER_WINDOW) {
      return true;
    }

    return false;
  }

  /**
   * Generic byte-based token bucket for data-heavy message types (relay chunks,
   * ICE candidates - each with its own store so a 2MB/s file flood cannot
   * starve P2P negotiation). Silent drop is safe: the ACK/retransmission
   * protocol recovers relay chunks.
   */
  private consumeBudget(store: Map<string, { tokens: number; lastRefill: number }>, connId: string, bytes: number, bytesPerSec: number, burstBytes: number): boolean {
    const now = Date.now();
    let budget = store.get(connId);

    if (!budget) {
      budget = { tokens: burstBytes, lastRefill: now };
      store.set(connId, budget);
    }

    // Refill based on elapsed time
    const elapsed = (now - budget.lastRefill) / 1000;
    budget.tokens = Math.min(burstBytes, budget.tokens + elapsed * bytesPerSec);
    budget.lastRefill = now;

    if (budget.tokens < bytes) {
      return false;
    }

    budget.tokens -= bytes;
    return true;
  }

  /**
   * Send an error frame to a client
   */
  private sendErrorFrame(ws: WebSocket, error: string, message: string): void {
    try {
      ws.send(JSON.stringify({ type: 'error', error, message }));
    } catch (e) {
      // Connection may be closing - ignore
    }
  }

  /**
   * Send a frame, tolerating a connection that is already closing
   */
  private safeSend(ws: WebSocket, payload: string): void {
    try {
      ws.send(payload);
    } catch (e) {
      // Connection may be closing - ignore
    }
  }

  /**
   * Handle authentication request with brute-force protection
   */
  private async handleAuth(ws: WebSocket, msg: SignalingMessage): Promise<void> {
    // 整个"检查限流 → 验证 → 写回计数"必须串行执行。DO 在 await 处会让出事件循环，
    // 并发 auth 消息若各自先读旧计数、验证后才写回，per-connection / 全局 / 网段桶
    // 三层限流都会被流水绕过（两条同时都以 attempts=0 起跑，写回互相覆盖）。
    // digest 是纯内存计算，串行化没有性能代价。
    await this.state.blockConcurrencyWhile(async () => {
      // 排队期间计数可能已被前一条 auth 更新，必须重新读取而不是用消息到达时的快照
      const attachment = ws.deserializeAttachment() as PeerAttachment | null;

      // Check per-connection attempts
      const attempts = attachment?.authAttempts || 0;
      if (attempts >= Room.MAX_PASSWORD_ATTEMPTS) {
        this.sendErrorFrame(ws, 'RATE_LIMIT_EXCEEDED', '尝试次数过多，请重新连接');
        try { ws.close(4002, 'RATE_LIMIT_EXCEEDED'); } catch (e) { /* ignore */ }
        return;
      }

      const authData = msg.data as { response: string };
      const expectedNonce = attachment?.authChallenge;

      if (!expectedNonce || !this.passwordHash) {
        try { ws.close(4002, 'AUTH_ERROR'); } catch (e) { /* ignore */ }
        return;
      }

      // Verify response = SHA256(passwordHash + nonce)
      // 先验证口令，再参考全局/网段失败计数：限流只针对错误尝试。
      // 旧实现先查限流就直接关连接，攻击者用错误尝试烧尽预算即可让
      // 持正确口令的房主永久进不了房（锁房 DoS）。digest 是纯内存计算，
      // 放在限流检查之前没有成本问题。
      const encoder = new TextEncoder();
      const data = encoder.encode(this.passwordHash + expectedNonce);
      const hashBuffer = await crypto.subtle.digest('SHA-256', data);
      const hashArray = Array.from(new Uint8Array(hashBuffer));
      const expectedResponse = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

      if (authData && authData.response === expectedResponse) {
        // Authentication successful

        // Reset global failure counter
        await this.state.storage.delete('authFailures');

        // Reset per-bucket failure counter
        const clientBucket = attachment?.clientBucket || '';
        if (clientBucket) {
          await this.clearBucketAuthFailures(clientBucket);
        }

        // Clear challenge and set authenticated
        ws.serializeAttachment({
          ...attachment,
          isAuthenticated: true,
          authChallenge: undefined,
          authAttempts: 0
        });

        // Now that we have a verified user, we can clear the inactivity alarm
        await this.state.storage.deleteAlarm();

        this.safeSend(ws, JSON.stringify({ type: 'auth-success' }));
      } else {
        // Authentication failed - increment attempts
        const newAttempts = attempts + 1;
        const newNonce = crypto.randomUUID();
        const clientBucket = attachment?.clientBucket || '';

        // 全局失败计数：窗口起点只在过期重建时更新，失败只累加计数。
        // （若每次失败都重置 windowStart，攻击者可永久锁房）
        // 预算耗尽后不再写入（防存储写放大），失败尝试改由断连节流。
        const now = Date.now();
        const storedFailures = await this.state.storage.get<{ count: number; windowStart: number }>('authFailures');
        const failures = storedFailures && (now - storedFailures.windowStart) < Room.AUTH_FAILURE_WINDOW
          ? storedFailures
          : { count: 0, windowStart: now };
        if (failures.count < Room.MAX_ROOM_AUTH_FAILURES) {
          failures.count += 1;
          await this.state.storage.put('authFailures', failures);
        }

        // Per-network-bucket failure counter（CF-Connecting-IP 网段桶，
        // 换连接/换 IPv6 临时地址都无法绕过；分布式换网段由全局计数兜底）
        let bucketCount = 0;
        if (clientBucket) {
          const bucketFailures = await this.getBucketAuthFailures(clientBucket);
          bucketCount = bucketFailures.count;
          if (bucketCount < Room.MAX_IP_AUTH_FAILURES) {
            await this.incrementBucketAuthFailures(clientBucket);
          }
        }

        ws.serializeAttachment({
          ...attachment,
          authChallenge: newNonce,
          authAttempts: newAttempts
        });

        this.safeSend(ws, JSON.stringify({
          type: 'error',
          error: 'PASSWORD_INCORRECT',
          message: '密码错误',
          data: { nonce: newNonce } // Send new nonce for retry
        }));

        // 断连条件：本连接烧穿 5 次，或房间/网段预算已耗尽（每连接最多
        // 再试一次）。只作用于错误尝试——正确口令在上方分支永远放行。
        const globalExhausted = failures.count >= Room.MAX_ROOM_AUTH_FAILURES;
        const bucketExhausted = clientBucket !== '' && bucketCount >= Room.MAX_IP_AUTH_FAILURES;
        if (newAttempts >= Room.MAX_PASSWORD_ATTEMPTS || globalExhausted || bucketExhausted) {
          try { ws.close(4002, 'RATE_LIMIT_EXCEEDED'); } catch (e) { /* ignore */ }
        }
      }
    });
  }

  /**
   * 删除该连接的全部限流状态（close/error 共用；以 connId 为键，不留 WS 引用）
   */
  private clearConnState(ws: WebSocket): void {
    const connId = (ws.deserializeAttachment() as PeerAttachment | null)?.connId;
    if (!connId) return;
    this.messageRateLimits.delete(connId);
    this.relayByteBudget.delete(connId);
    this.iceByteBudget.delete(connId);
    this.relayDropWarn.delete(connId);
  }

  /**
   * WebSocket close handler (Hibernation API)
   */
  async webSocketClose(ws: WebSocket, _code: number, _reason: string, _wasClean: boolean): Promise<void> {
    this.clearConnState(ws);

    await this.handleLeave(ws);
  }

  /**
   * WebSocket error handler (Hibernation API)
   * 异常断线（网络中断/超时）可能只触发 error 不触发 close——同样广播
   * peer-left，避免幽灵设备卡片；用 WeakSet 去重防止 close+error 双广播。
   */
  async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    this.clearConnState(ws);

    await this.handleLeave(ws);
  }

  /**
   * Sanitize string input (truncate to max length)
   */
  private sanitizeString(str: string, maxLength: number): string {
    // 非字符串（number/object 等畸形消息字段）直接归零，避免 .replace 抛错
    if (typeof str !== 'string' || !str) return '';
    // 剥离控制字符与 Bidi 覆盖符（设备名/浏览器信息会被展示，防 UI 与终端欺骗）
    return str
      .replace(/[\u0000-\u001F\u007F-\u009F\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, '')
      .substring(0, maxLength);
  }

  /**
   * Handle peer joining the room
   */
  private async handleJoin(ws: WebSocket, msg: SignalingMessage): Promise<void> {
    const joinData = msg.data as { name: string; deviceType: 'desktop' | 'mobile' | 'tablet'; browserInfo?: string; deviceKey?: string };

    // 重复 join：记录旧 ID（缓存清理 + 通知其他设备旧 ID 离开）
    const oldAttachment = ws.deserializeAttachment() as PeerAttachment | null;
    const oldId = oldAttachment?.id || null;

    const peerId = crypto.randomUUID();

    // Sanitize name
    const sanitizedName = this.sanitizeString(joinData.name || this.generateName(), Room.MAX_NAME_LENGTH);

    // Get room code from WebSocket tag
    const tags = this.state.getTags(ws);
    const roomCode = tags.length > 0 ? tags[0] : '';

    // Create peer attachment data（继承旧附件的 connId/clientBucket 等连接级
    // 字段，限流状态清理依赖 connId；作废旧会话残留的 challenge/attempts）
    const attachment: PeerAttachment = {
      ...(oldAttachment || {}),
      id: peerId,
      name: sanitizedName,
      deviceType: ['mobile', 'tablet'].includes(joinData.deviceType) ? joinData.deviceType : 'desktop',
      browserInfo: this.sanitizeString(joinData.browserInfo || '', 100), // Limit browser info length
      deviceKey: this.sanitizeString(joinData.deviceKey || '', 500), // 设备身份公钥（SPKI base64）
      isAuthenticated: true, // If they reached here, they are authenticated (or no password required)
      joinedAt: Date.now(),
      authChallenge: undefined,
      authAttempts: undefined,
    };

    ws.serializeAttachment(attachment);

    // 重复 join：通知其他设备旧 ID 已离开
    if (oldId) {
      this.broadcast({ type: 'peer-left', data: { id: oldId } });
    }

    // Setup auto-response for ping/pong
    this.state.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));

    // Get all other active peers from their WebSocket attachments
    const activePeers = this.getActivePeers();

    const otherPeers = Array.from(activePeers.entries())
      .filter(([id]) => id !== peerId)
      .map(([id, { attachment: p }]) => ({ id, name: p.name, deviceType: p.deviceType, browserInfo: p.browserInfo, deviceKey: p.deviceKey }));

    // Send peer their ID, room code, and list of other peers
    ws.send(JSON.stringify({
      type: 'joined',
      peerId,
      roomCode,
      peers: otherPeers,
    }));

    // Notify other peers about new peer
    this.broadcast({
      type: 'peer-joined',
      data: { id: peerId, name: attachment.name, deviceType: attachment.deviceType, browserInfo: attachment.browserInfo, deviceKey: attachment.deviceKey },
    }, peerId);
  }

  /**
   * Handle peer leaving the room（WeakSet 去重：close 与 error 可能都触发）
   */
  private async handleLeave(ws: WebSocket): Promise<void> {
    if (this.leaveNotified.has(ws)) return;
    this.leaveNotified.add(ws);

    const peerId = this.getPeerIdFromWs(ws);
    
    if (peerId) {
      // Notify other peers
      this.broadcast({
        type: 'peer-left',
        data: { id: peerId },
      });
    }

    // Check if room is empty now
    // We need to wait a tick because getWebSockets() might still include the closing one?
    // Actually handleLeave is called from webSocketClose/Error, so it should be fine or we check explicitly
    const activePeers = this.getActivePeers();
    // Note: The current WS is already in 'CLOSING' or 'CLOSED' state or about to be,
    // but getActivePeers filters for OPEN. 
    // However, to be safe, we check if count is 0.
    
    if (activePeers.size === 0 && this.passwordHash) {
       // Room became empty, schedule destruction
       await this.state.storage.setAlarm(Date.now() + Room.SECURE_ROOM_TTL);
    } else {
       // Room is not empty, check if we have any authenticated users
       // If only unauthenticated users remain, we might want to schedule alarm anyway?
       // For simplicity, we rely on handleAuth clearing alarm.
       // But if everyone leaves except one unauthenticated user, handleLeave logic above keeps alarm cleared?
       // Wait, handleLeave checks activePeers.size. If activePeers > 0, we don't set alarm.
       // This is fine. If users are stuck in unauthenticated state, they can't do anything.
       // But we should probably check if *only* unauthenticated users remain.
       
       let hasAuthenticated = false;
       for (const { attachment } of activePeers.values()) {
         if (attachment.isAuthenticated) {
           hasAuthenticated = true;
           break;
         }
       }
       
       if (!hasAuthenticated && this.passwordHash) {
          // No authenticated users left, start countdown
          await this.state.storage.setAlarm(Date.now() + Room.SECURE_ROOM_TTL);
       }
    }
  }

  /**
   * Find the OPEN WebSocket for a peer ID by scanning hibernation-safe
   * attachments (no per-socket object retention in class state, AGENTS §3)
   */
  private getPeerWs(peerId: string): WebSocket | undefined {
    for (const ws of this.state.getWebSockets()) {
      if (ws.readyState !== WS_READY_STATE.OPEN) continue;
      const attachment = ws.deserializeAttachment() as PeerAttachment | null;
      if (attachment?.id === peerId) return ws;
    }
    return undefined;
  }

  /**
   * Handle WebRTC signaling messages (offer/answer/ice-candidate)
   */
  private async handleSignaling(ws: WebSocket, msg: SignalingMessage): Promise<void> {
    if (!msg.to) return;

    const fromPeerId = this.getPeerIdFromWs(ws);
    if (!fromPeerId) return;

    const targetWs = this.getPeerWs(msg.to);
    if (!targetWs) return;

    try {
      targetWs.send(JSON.stringify({
        type: msg.type,
        from: fromPeerId,
        data: msg.data,
      }));
    } catch (e) {
      console.error(`[Room] Failed to send signaling to ${msg.to}:`, e);
    }
  }

  /**
   * Handle relay data messages (fallback when P2P fails)
   * Forwards binary data chunks between peers via WebSocket
   */
  private async handleRelayData(ws: WebSocket, msg: SignalingMessage): Promise<void> {
    if (!msg.to) return;

    const fromPeerId = this.getPeerIdFromWs(ws);
    if (!fromPeerId) return;

    this.sendToPeer(msg.to, {
      type: 'relay-data',
      from: fromPeerId,
      data: msg.data,
    });
  }

  /**
   * Handle key exchange messages (for relay mode encryption)
   */
  private async handleKeyExchange(ws: WebSocket, msg: SignalingMessage): Promise<void> {
    if (!msg.to) return;

    const fromPeerId = this.getPeerIdFromWs(ws);
    if (!fromPeerId) return;

    this.sendToPeer(msg.to, {
      type: 'key-exchange',
      from: fromPeerId,
      data: msg.data,
    });
  }

  /**
   * Handle file request/response signaling messages
   * Used for file transfer confirmation flow
   */
  private async handleFileSignaling(ws: WebSocket, msg: SignalingMessage): Promise<void> {
    if (!msg.to) return;

    const fromPeerId = this.getPeerIdFromWs(ws);
    if (!fromPeerId) return;

    this.sendToPeer(msg.to, {
      type: msg.type, // 'file-request' or 'file-response' or 'file-cancel'
      from: fromPeerId,
      data: msg.data,
    });
  }

  /**
   * Send message to a specific peer by ID (resolves socket via attachment scan)
   */
  private sendToPeer(targetPeerId: string, message: object): boolean {
    const targetWs = this.getPeerWs(targetPeerId);
    if (!targetWs) return false;

    try {
      targetWs.send(JSON.stringify(message));
      return true;
    } catch (e) {
      console.error(`[Room] Failed to send to ${targetPeerId}:`, e);
      return false;
    }
  }

  /**
   * Broadcast message to all JOINED peers except the excluded one.
   * Scans getWebSockets() directly - never retains socket references.
   */
  private broadcast(msg: SignalingMessage, excludePeerId?: string): void {
    const message = JSON.stringify(msg);
    for (const targetWs of this.state.getWebSockets()) {
      if (targetWs.readyState !== WS_READY_STATE.OPEN) continue;
      const attachment = targetWs.deserializeAttachment() as PeerAttachment | null;
      if (!attachment?.id || attachment.id === excludePeerId) continue;

      try {
        targetWs.send(message);
      } catch (e) {
        // Silently ignore send failures - peer may have disconnected
      }
    }
  }

  /**
   * Generate a random device name
   */
  private generateName(): string {
    const adjectives = ['Swift', 'Bright', 'Cool', 'Fast', 'Sleek', 'Sharp', 'Bold', 'Calm'];
    const nouns = ['Phoenix', 'Dragon', 'Falcon', 'Tiger', 'Eagle', 'Panda', 'Wolf', 'Lion'];
    const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
    const noun = nouns[Math.floor(Math.random() * nouns.length)];
    return `${adj} ${noun}`;
  }

  /**
   * Handle peer name change
   */
  private async handleNameChanged(ws: WebSocket, msg: SignalingMessage): Promise<void> {
    const senderId = (ws.deserializeAttachment() as PeerAttachment | null)?.id;
    if (!senderId) return;

    const nameData = msg.data as { name: string };
    const sanitizedName = this.sanitizeString(nameData.name, Room.MAX_NAME_LENGTH);
    
    // Update peer attachment with new name
    const attachment = ws.deserializeAttachment() as PeerAttachment | null;
    if (attachment) {
      attachment.name = sanitizedName;
      ws.serializeAttachment(attachment);
    }

    // Broadcast name change to all other peers
    this.broadcast({
      type: 'name-changed',
      from: senderId,
      data: { name: sanitizedName }
    }, senderId);
  }
}

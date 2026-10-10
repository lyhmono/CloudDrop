# Agent Guide for CloudDrop

This repository contains CloudDrop, a modern P2P file-sharing tool built on Cloudflare Workers and Durable Objects with a vanilla JS + CSS frontend.
This guide summarizes the project, commands, coding standards, and architectural patterns for AI agents operating in this codebase.

## Project Overview

- **Runtime**: Cloudflare Workers + Durable Objects
- **Languages**: TypeScript (worker), vanilla JavaScript (frontend)
- **Core Component**: Durable Objects (`Room` class in `src/room.ts`)
- **Key Features**: WebSocket Hibernation API, WebRTC P2P transfer with relay fallback, end-to-end encryption
- **Deployment**: Wrangler
- **State**: Ephemeral signaling state + optional persistent room passwords
- **Frontend**: `public/` PWA (HTML/CSS/JS) with i18n and mobile-friendly UI

## Development Commands

### Build & Run

*   **Install Dependencies**
    ```bash
    npm install
    ```

*   **Start Local Development Server**
    ```bash
    npm run dev
    ```
    *Runs `wrangler dev`. This starts a local server (usually port 8787) emulating the Cloudflare Workers environment.*

*   **Deploy to Cloudflare**
    ```bash
    npm run deploy
    ```
    *Runs `wrangler deploy`. Requires `wrangler login` authentication.*

*   **Set TURN Secrets (Optional)**
    ```bash
    npx wrangler secret put TURN_KEY_ID
    npx wrangler secret put TURN_KEY_API_TOKEN
    ```
    *Enables Cloudflare TURN credentials for better NAT traversal.*

### Testing & Linting

*   **Run Tests**
    ```bash
    npm test
    ```
    *Requires Node >= 22.18 (`package.json engines`): `tests/room-auth.test.mjs` and `tests/room-id.test.mjs` import `src/*.ts` directly via native type-stripping, and mock the Durable Object surface instead of a workers runtime.*
    *Coverage: Room DO auth/set-password regression, room-id salting, frontend helpers (ui/crypto/webrtc), signaling smoke (`npm run smoke` boots wrangler dev locally).*

*   **Type Check**
    ```bash
    npx tsc --noEmit
    ```
    *Validates TypeScript types across the project without emitting output files.*

## Code Style & Guidelines

### TypeScript Configuration
- **Strict Mode**: `strict: true` is enabled in `tsconfig.json`. No implicit `any`.
- **Target**: `ES2022`.
- **Module Resolution**: `bundler`.
- **Types**:
    - Use `interface` for object shapes (e.g., `SignalingMessage`, `PeerAttachment`).
    - Explicitly type function arguments and return values (e.g., `: Promise<Response>`).
    - Use the `Env` interface for worker environment bindings (Durable Objects, Vars).

### Naming Conventions
- **Files**: kebab-case (e.g., `index.ts`, `room.ts`).
- **Classes**: PascalCase (e.g., `Room`).
- **Interfaces**: PascalCase (e.g., `PeerAttachment`, `Env`).
- **Functions & Variables**: camelCase (e.g., `handleWebSocket`, `roomCode`).
- **Constants**: UPPER_SNAKE_CASE (e.g., `WS_READY_STATE`).
- **Private Properties**: No underscore prefix required, just use the `private` keyword.

### Formatting
- **Indentation**: 2 spaces.
- **Semicolons**: Always use semicolons.
- **Strings**: Single quotes preferred, except for template literals.
- **Braces**: K&R style (opening brace on the same line).

### Error Handling
- **HTTP**: Return explicit `Response` objects with appropriate status codes.
    - `400 Bad Request`: Invalid input/parameters.
    - `404 Not Found`: Unknown route or resource.
    - `500 Internal Error`: Unexpected failures.
- **WebSockets**:
    - Wrap message handling in `try-catch` blocks to prevent Durable Object crashes.
    - Send typed error messages to the client: `{ type: 'error', error: 'CODE', message: '...' }`.
    - Log errors to the console (`console.error`), which streams to Cloudflare logs.

## Architecture & Patterns

### 1. Project Structure
- `src/index.ts`: **The Router**.
    - Handles incoming HTTP requests.
    - Generates Room IDs based on Client IP hashing (SHA-256, salted with `ROOM_SALT`).
    - Routes `/ws` requests to the specific `Room` Durable Object stub.
    - Handles API endpoints (`/api/ice-servers`, `/api/room/check-password`).
- `src/room.ts`: **The State Machine**.
    - Implements the `DurableObject` interface.
    - Manages the WebSocket lifecycle.
    - Handles signaling logic (join, offer, answer, ice-candidate).
- `public/`: **The Client App**.
    - `index.html`, `style.css`, `manifest.json`, `js/` modules.
    - `js/webrtc.js` handles WebRTC + relay fallback + P2P recovery.
    - `js/crypto.js` handles encryption (AES-GCM + room password).
    - `js/i18n.js` handles translations (9 languages).
    - `js/app.js` bootstraps the app, wires UI to WebRTC + API, and manages UI state.
    - `js/ui.js` contains DOM helpers, view updates, toasts/modals, and device UI behaviors.
    - `js/config.js` centralizes constants (timeouts, chunk sizes, feature flags, API URLs).

### 2. Key HTTP Endpoints
- `GET /api/ice-servers`: returns STUN-only defaults or TURN credentials if configured.
- `GET /api/room/check-password?room=XXXXXX`: returns whether room has a password.
- `GET /ws`: WebSocket upgrade, routed to a room DO based on room code. An explicit but malformed `?room=` is rejected with `400` (no silent fallback to the IP-derived room); with no `room` param the room is auto-assigned from the salted client /24 (or /64) hash. Password setting is a WebSocket message (`set-password`), not HTTP.

### 3. Durable Objects & WebSocket Hibernation
This project uses the **WebSocket Hibernation API** for high performance and lower costs. Agents must follow these specific patterns:

*   **State Management**:
    *   **Do Not** store active WebSocket objects in a class property array.
    *   Use `this.state.getWebSockets()` to iterate over active connections.
    *   Use `ws.serializeAttachment(...)` and `ws.deserializeAttachment()` to store metadata (Peer ID, Name) directly on the socket. This data survives hibernation.

*   **Initialization**:
    *   Use `this.state.blockConcurrencyWhile(async () => { ... })` in the constructor to load storage data (like passwords) before handling requests.

*   **Message Handling**:
    *   Implement `webSocketMessage(ws, message)`.
    *   Implement `webSocketClose(ws, ...)` and `webSocketError(ws, ...)` to handle disconnections and cleanup.

### 4. Signaling Protocol
The signaling logic handles WebRTC coordination. New message types should be added to:
1.  The `SignalingMessage` interface (`src/room.ts`).
2.  The `switch (msg.type)` block in `webSocketMessage`.
3.  A dedicated handler method (e.g., `private async handleNewFeature(...)`).

### 5. WebSocket Message Types (Room)
- `join`, `peer-joined`, `peer-left`, `name-changed`
- `offer`, `answer`, `ice-candidate`
- `relay-data`, `key-exchange` (chat `text` travels inside `relay-data`/DataChannel, not as a Room message)
- `file-request`, `file-response`, `file-cancel`
- `challenge`, `auth`, `auth-success`, `room-locked`, `set-password`, `set-password-result`, `error`

### 6. Signaling Message Shapes (Client <-> Room)
Use these payload shapes when sending or handling signaling messages.

```json
// Join + roster
{ "type": "join", "data": { "name": "Alice", "deviceType": "desktop|mobile|tablet", "browserInfo": "..." } }
{ "type": "joined", "peerId": "uuid", "roomCode": "ABC123", "peers": [ { "id": "uuid", "name": "...", "deviceType": "desktop", "browserInfo": "..." } ] }
{ "type": "peer-joined", "data": { "id": "uuid", "name": "...", "deviceType": "desktop", "browserInfo": "..." } }
{ "type": "peer-left", "data": { "id": "uuid" } }
{ "type": "name-changed", "data": { "name": "New Name" } }
{ "type": "name-changed", "from": "uuid", "data": { "name": "New Name" } }

// WebRTC negotiation
{ "type": "offer", "to": "uuid", "data": { "sdp": { /* RTCSessionDescriptionInit */ }, "publicKey": "...", "iceRestart": true } }
{ "type": "answer", "to": "uuid", "data": { "sdp": { /* RTCSessionDescriptionInit */ }, "publicKey": "..." } }
{ "type": "ice-candidate", "to": "uuid", "data": { /* RTCIceCandidateInit */ } }

// Relay + key exchange
{ "type": "relay-data", "to": "uuid", "data": { /* see relay payloads below */ } }
{ "type": "key-exchange", "to": "uuid", "data": { "publicKey": "..." } }

// File handshake (always via signaling)
{ "type": "file-request", "to": "uuid", "data": { "fileId": "uuid", "name": "a.pdf", "size": 123, "mimeType": "application/pdf", "totalChunks": 10, "transferMode": "p2p|relay" } }
{ "type": "file-response", "to": "uuid", "data": { "fileId": "uuid", "accepted": true } }
{ "type": "file-cancel", "to": "uuid", "data": { "fileId": "uuid", "reason": "user|timeout|error" } }

// Secure room auth
{ "type": "challenge", "data": { "nonce": "uuid" } }
{ "type": "auth", "data": { "response": "sha256(passwordHash + nonce)" } }
{ "type": "auth-success" }

// Errors (examples)
{ "type": "error", "error": "PASSWORD_REQUIRED|PASSWORD_INCORRECT|MESSAGE_TOO_LARGE", "message": "...", "data": { "nonce": "uuid" } }
```

### 7. DataChannel + Relay Payloads
P2P data channel messages are JSON strings plus binary chunks. Relay data wraps the same primitives inside `relay-data`.

```json
// P2P data channel (JSON)
{ "type": "file-start", "fileId": "uuid", "name": "a.pdf", "size": 123, "mimeType": "application/pdf", "totalChunks": 10 }
{ "type": "file-end", "fileId": "uuid" }
{ "type": "file-cancel", "fileId": "uuid", "reason": "user|timeout|error" }
{ "type": "text", "content": "hello" }

// P2P data channel (binary)
<encrypted ArrayBuffer chunk>

// Relay data (wrapped in signaling: { type: "relay-data", data: ... })
{ "type": "file-start", "fileId": "uuid", "name": "a.pdf", "size": 123, "mimeType": "application/pdf", "totalChunks": 10 }
{ "type": "chunk", "fileId": "uuid", "index": 0, "data": "<base64>", "retry": false }
{ "type": "ack", "fileId": "uuid", "acks": [0,1,2] }
{ "type": "file-end", "fileId": "uuid", "totalChunks": 10 }
{ "type": "file-cancel", "fileId": "uuid", "reason": "user|timeout|error" }
{ "type": "text", "content": "hello" }
```

### 8. UI Interaction Flow
- App boot: connect WebSocket, clear peer grid, close stale WebRTC, show connection status.
- Secure room: receive `challenge`, compute `auth` response, send `auth`, then `auth-success` triggers `join`.
- Join: receive `joined`, set `peerId`, update room code display, render peers, show auto-room hint if empty.
- Peer discovery: `peer-joined` adds card and toast, `peer-left` removes card, `name-changed` updates card name.
- File send: click peer card -> file picker -> show "waiting for confirmation" modal -> `file-request` -> on accept start transfer, update progress, show success toast -> on decline/timeout/cancel show toast.
- File receive: `file-request` shows receive modal with sender + mode; trusted devices auto-accept -> show receiving modal -> on completion show download modal.
- Chat: click message icon -> open chat panel -> send text via P2P or relay -> incoming messages update chat, unread badge, and notifications.
- Connection mode: WebRTC emits `connecting|slow|relay|connected` to update badges and toasts.

### 9. Password + Auth Flow
- Room password is stored as `passwordHash` in DO storage and guarded by an inactivity alarm.
- `set-password` requires: joined peer (peerId), minimum presence (`ROOM_CLAIM_MIN_PRESENCE`), and that the requester is the **only** active peer — locking an occupied room would kick every member, which any member could abuse to seize the room (`ROOM_OCCUPIED` is returned otherwise).
- New connections receive a `challenge` nonce and must respond with `auth` using `SHA256(passwordHash + nonce)`.
- Successful auth clears the inactivity alarm and marks the WebSocket attachment `isAuthenticated`.
- Failed auth increments per-connection attempts and closes after `MAX_PASSWORD_ATTEMPTS`.
- Rate limiting (global + per-network-bucket failure budgets) only throttles **incorrect** attempts: the credential is verified before consulting budgets, so a correct password is never rejected by attacker-burned counters (anti lock-out DoS). Exhausted budgets additionally stop storage writes (one connect = one wasted guess).

### 10. Room Lifecycle + Alarms
- Secure rooms use a TTL alarm (`SECURE_ROOM_TTL`) to clear `passwordHash` after inactivity.
- When the last authenticated peer leaves, the alarm is scheduled to destroy the secure room.

### 11. IP-Based Room Generation
Room IDs are deterministic based on the client's network to facilitate P2P discovery without login:
- **IPv4**: First 3 octets (/24 subnet).
- **IPv6**: First 64 bits (/64 prefix).
- **Logic**: Located in `generateRoomId` in `src/index.ts`.
- **Privacy**: The network part is hashed (SHA-256) with server-side `ROOM_SALT` before use; actual IPs are not exposed in the room ID. **Production deployments must set `wrangler secret put ROOM_SALT`** — unsalted 6-hex codes are offline-reversible to a /24 (only ~16.7M IPv4 /24s exist).

## Security Rules

1.  **Room Passwords**:
    - Stored in DO storage as `passwordHash`.
    - Verified immediately upon WebSocket connection setup.
    - If verification fails, send an error frame and close with code `4001` or `4002`.

2.  **Input Validation**:
    - Validate all JSON bodies using strict type checks.
    - Ensure `roomCode` matches the expected format (6 alphanumeric chars) before processing.

3.  **CORS & Headers**:
    - API endpoints typically return JSON with `Content-Type: application/json`.
    - Ensure proper CORS headers are present if the frontend is hosted on a different domain (though currently served from same origin).

4.  **Encryption**:
    - WebRTC uses DTLS for transport security.
    - Application payloads are encrypted with AES-256-GCM and ECDH key exchange.

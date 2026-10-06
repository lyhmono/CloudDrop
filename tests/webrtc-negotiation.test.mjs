/**
 * CloudDrop - WebRTC 协商回归测试
 *
 * 覆盖「双端同时发起 offer」这个最常见的碰撞场景：
 * 预热对双端都会触发（addPeer → prewarmConnection），两端几乎同时 createOffer，
 * 双方都会停在 have-local-offer 等对方应答。
 *
 * 关键状态：本端的 offer 已经发出（makingOffer 已复位为 false），
 * signalingState 停在 'have-local-offer'。此时收到对方的 offer 即为碰撞。
 * 正确行为是「不礼貌的一方忽略、礼貌的一方回滚并应答」，恰好一方回滚。
 * 若判定逻辑漏掉 have-local-offer，双方都会回滚并互相应答对方的 offer，
 * 各自的 local(answer)/remote(offer) 不配对、DTLS 角色同为 active，P2P 必然失败。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { WebRTCManager } from '../public/js/webrtc.js';
import { cryptoManager } from '../public/js/crypto.js';

// Node 没有 WebRTC 全局对象。handleOffer 只用 RTCSessionDescription 把
// { type, sdp } 包一层，这里补个等价替身即可（其余方法由 FakePc 提供）。
if (typeof globalThis.RTCSessionDescription === 'undefined') {
  globalThis.RTCSessionDescription = class RTCSessionDescription {
    constructor(init = {}) {
      this.type = init.type;
      this.sdp = init.sdp;
    }
  };
}

/** 最小 RTCPeerConnection 替身：只实现 handleOffer 路径用到的状态机 */
class FakePc {
  constructor(signalingState = 'stable') {
    this.signalingState = signalingState;
    this.connectionState = 'new';
    this.remoteDescription = null;
    this.localDescription = null;
    this.rollbackCount = 0;
    this.answerCount = 0;
    this.dataChannelCount = 0;
  }

  async setLocalDescription(desc) {
    if (desc && desc.type === 'rollback') {
      this.rollbackCount++;
      this.signalingState = 'stable';
      this.localDescription = null;
      return;
    }
    this.localDescription = desc;
    // answer 之后回到 stable，offer 则进入 have-local-offer
    this.signalingState = desc && desc.type === 'offer' ? 'have-local-offer' : 'stable';
  }

  async setRemoteDescription(desc) {
    this.remoteDescription = desc;
    this.signalingState = 'have-remote-offer';
  }

  async createAnswer() {
    this.answerCount++;
    return { type: 'answer', sdp: 'v=0\r\n' };
  }

  createDataChannel() {
    this.dataChannelCount++;
    return { readyState: 'connecting', send() {}, close() {} };
  }

  close() {
    this.connectionState = 'closed';
  }
}

/**
 * 造一个已经「发出过 offer、正在等应答」的一端
 * @param {string} myPeerId - 本端 ID（决定礼貌与否：ID 小的一方礼貌）
 * @param {string} remotePeerId - 对端 ID
 */
function makePeerWaitingForAnswer(myPeerId, remotePeerId) {
  const sent = [];
  const manager = new WebRTCManager({ send: (msg) => sent.push(msg) });
  manager.setMyPeerId(myPeerId);

  const pc = new FakePc('have-local-offer');
  manager.connections.set(remotePeerId, pc);
  // offer 已发出，makingOffer 已复位 —— 正是旧逻辑漏判的状态
  manager.makingOffer.set(remotePeerId, false);

  return { manager, pc, sent, remotePeerId };
}

test('offer 碰撞：恰好只有礼貌的一方回滚并应答，不礼貌的一方忽略', async () => {
  // peer-a < peer-b ⇒ a 礼貌、b 不礼貌，两端判定必须一致且互补
  const a = makePeerWaitingForAnswer('peer-a', 'peer-b');
  const b = makePeerWaitingForAnswer('peer-b', 'peer-a');

  const incomingOffer = { sdp: { type: 'offer', sdp: 'v=0\r\n' } };

  await a.manager.handleOffer(a.remotePeerId, incomingOffer);
  await b.manager.handleOffer(b.remotePeerId, incomingOffer);

  // 礼貌方：回滚自己的 offer，改成应答对方的
  assert.equal(a.pc.rollbackCount, 1, '礼貌方应回滚自己的 offer');
  assert.equal(a.pc.answerCount, 1, '礼貌方应生成 answer');
  assert.equal(a.sent.filter((m) => m.type === 'answer').length, 1, '礼貌方应发出 answer');

  // 不礼貌方：忽略收到的 offer，保留自己的 offer 等对方的 answer
  assert.equal(b.manager.ignoreOffer.get(b.remotePeerId), true, '不礼貌方应忽略碰撞的 offer');
  assert.equal(b.pc.rollbackCount, 0, '不礼貌方不得回滚');
  assert.equal(b.pc.answerCount, 0, '不礼貌方不得应答');
  assert.equal(b.sent.length, 0, '不礼貌方不应发出任何信令');

  // 回归断言：绝不能双方都回滚（那会导致两侧 SDP 不配对、DTLS 角色冲突）
  assert.equal(a.pc.rollbackCount + b.pc.rollbackCount, 1, '全场只能有一方回滚');
});

test('无碰撞：本端 stable 时正常应答，不做无谓回滚', async () => {
  const { manager, pc, sent, remotePeerId } = makePeerWaitingForAnswer('peer-z', 'peer-a');
  pc.signalingState = 'stable';

  await manager.handleOffer(remotePeerId, { sdp: { type: 'offer', sdp: 'v=0\r\n' } });

  assert.equal(pc.rollbackCount, 0, 'stable 状态无需回滚');
  assert.equal(pc.answerCount, 1, '应生成 answer');
  assert.equal(sent.filter((m) => m.type === 'answer').length, 1, '应发出 answer');
});

test('预冷启动：对方已先握手时不再重复创建通道与 offer', async () => {
  const { manager, pc, sent, remotePeerId } = makePeerWaitingForAnswer('peer-a', 'peer-b');

  // 模拟对方的 offer 已被应答、通道已由对方带来（connecting 中）
  manager.dataChannels.set(remotePeerId, { readyState: 'open' });
  await cryptoManager.generateKeyPair();
  const peerKeyPair = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveKey', 'deriveBits']
  );
  const spki = await crypto.subtle.exportKey('spki', peerKeyPair.publicKey);
  await cryptoManager.importPeerPublicKey(
    remotePeerId,
    Buffer.from(spki).toString('base64')
  );

  await manager._attemptP2PConnectionSilent(remotePeerId);

  assert.equal(pc.dataChannelCount, 0, '不应再创建数据通道');
  assert.equal(pc.answerCount, 0, '不应再生成 answer');
  assert.equal(sent.filter((m) => m.type === 'offer').length, 0, '不应再发起自己的 offer');
});

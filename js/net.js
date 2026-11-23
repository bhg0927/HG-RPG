/*
 * 풍선 숫자 대전 - 두 기기 연결 (PeerJS / WebRTC)
 *
 * 서버를 따로 두지 않고, PeerJS 공개 중계 서버(0.peerjs.com)로 서로를 찾은 뒤
 * 기기끼리 직접(WebRTC) 메시지를 주고받는다.
 *
 * 연결이 잠깐 끊겨도 게임을 끝내지 않는다.
 *  - 방장(host)은 같은 방 코드로 계속 기다리고, 참가자(guest)가 2초마다 다시 연결을 시도한다.
 *  - 끊긴 동안 보낸 중요한 메시지(공격, 승패 등)는 모아 두었다가 다시 연결되면 보낸다.
 *
 * 테스트용으로 주소에 ?peerhost=localhost&peerport=9000 을 붙이면 로컬 중계 서버를 쓴다.
 */
(function () {
  'use strict';

  const PREFIX = 'hg-balloon-v1-';
  const CONNECT_TIMEOUT = 15000;
  const RETRY_INTERVAL = 2000;
  // 끊긴 동안 모아 두지 않아도 되는 메시지 (최신 것만 의미 있음)
  const VOLATILE = new Set(['view', 'ping']);

  function peerOptions() {
    const q = new URLSearchParams(location.search);
    const host = q.get('peerhost');
    const opts = { debug: 0 };
    if (host) {
      Object.assign(opts, {
        host,
        port: Number(q.get('peerport') || 9000),
        path: q.get('peerpath') || '/',
        secure: q.get('peersecure') === '1',
      });
    }
    return opts;
  }

  const randomCode = () => String(1000 + Math.floor(Math.random() * 9000));

  function errorMessage(err) {
    switch (err && err.type) {
      case 'peer-unavailable': return '방을 찾을 수 없어요. 코드를 다시 확인해 주세요.';
      case 'network':
      case 'server-error':
      case 'socket-error':
      case 'socket-closed': return '연결 서버에 접속하지 못했어요. 인터넷 연결을 확인해 주세요.';
      case 'browser-incompatible': return '이 브라우저는 온라인 대전을 지원하지 않아요.';
      case 'timeout': return '연결 시간이 초과됐어요. 인터넷 상태를 확인하고 다시 시도해 주세요.';
      default: return `연결 오류가 났어요 (${(err && err.type) || '알 수 없음'})`;
    }
  }

  /** 중계 서버와의 연결이 끊기면 같은 ID로 다시 붙는다 */
  function keepRegistered(peer) {
    peer.on('disconnected', () => {
      setTimeout(() => {
        if (!peer.destroyed && peer.disconnected) {
          try { peer.reconnect(); } catch (e) { /* 다음 기회에 */ }
        }
      }, 1000);
    });
  }

  /**
   * 두 기기 사이의 연결. 내부 DataConnection이 끊겼다 다시 붙어도 같은 Link를 계속 쓴다.
   * onmessage(msg), ondown(), onup() 콜백을 게임 쪽에서 지정한다.
   */
  class Link {
    constructor(peer, role, hostId) {
      this.peer = peer;
      this.role = role; // 'host' | 'guest'
      this.hostId = hostId;
      this.conn = null;
      this.closed = false;
      this.queue = [];
      this.retryTimer = null;
      this.onmessage = null;
      this.ondown = null;
      this.onup = null;
    }

    get up() {
      return !!(this.conn && this.conn.open);
    }

    attach(conn) {
      if (this.conn && this.conn !== conn) {
        const old = this.conn;
        this.conn = null;
        try { old.close(); } catch (e) { /* 무시 */ }
      }
      this.conn = conn;
      clearTimeout(this.retryTimer);
      conn.on('data', (d) => {
        if (this.conn === conn && this.onmessage) this.onmessage(d);
      });
      const down = () => {
        if (this.conn !== conn || this.closed) return;
        this.conn = null;
        if (this.ondown) this.ondown();
        this._scheduleRetry();
      };
      conn.on('close', down);
      conn.on('error', down);
      // 브라우저가 연결 실패를 늦게 알려 주는 경우를 대비해 ICE 상태도 본다
      const pc = conn.peerConnection;
      if (pc) {
        pc.addEventListener('iceconnectionstatechange', () => {
          if (pc.iceConnectionState === 'failed' || pc.iceConnectionState === 'closed') down();
        });
      }
      // 모아 둔 메시지 보내기
      const pending = this.queue;
      this.queue = [];
      pending.forEach((m) => conn.send(m));
      if (this.onup) this.onup();
    }

    _scheduleRetry() {
      if (this.role !== 'guest' || this.closed) return; // 방장은 기다리기만 한다
      clearTimeout(this.retryTimer);
      this.retryTimer = setTimeout(() => this._retry(), RETRY_INTERVAL);
    }

    _retry() {
      if (this.closed || this.up) return;
      const peer = this.peer;
      if (peer.disconnected && !peer.destroyed) {
        try { peer.reconnect(); } catch (e) { /* 다음 기회에 */ }
      }
      if (!peer.disconnected) {
        const conn = peer.connect(this.hostId, { reliable: true, serialization: 'json' });
        conn.on('open', () => {
          if (!this.closed) this.attach(conn);
        });
      }
      this._scheduleRetry();
    }

    send(msg) {
      if (this.closed) return;
      if (this.up) {
        try {
          this.conn.send(msg);
          return;
        } catch (e) {
          /* 아래에서 모아 둔다 */
        }
      }
      if (!VOLATILE.has(msg.t)) this.queue.push(msg);
    }

    /** 연결이 살아 있는 것처럼 보이지만 응답이 없을 때 강제로 다시 연결 */
    kick() {
      if (this.closed || this.role !== 'guest') return;
      if (this.conn) {
        const old = this.conn;
        this.conn = null;
        try { old.close(); } catch (e) { /* 무시 */ }
      }
      this._scheduleRetry();
    }

    close() {
      this.closed = true;
      clearTimeout(this.retryTimer);
      try { if (this.conn) this.conn.close(); } catch (e) { /* 무시 */ }
      try { this.peer.destroy(); } catch (e) { /* 무시 */ }
    }
  }

  function ensurePeer() {
    if (typeof window.Peer !== 'function') throw { type: 'browser-incompatible' };
  }

  /** 방 만들기: 코드가 정해지면 onCode, 상대가 처음 들어오면 onConnect(link) */
  function host({ onCode, onConnect, onError }) {
    let peer = null;
    let tries = 0;
    let link = null;
    let cancelled = false;
    const attempt = () => {
      const code = randomCode();
      const id = PREFIX + code;
      peer = new window.Peer(id, peerOptions());
      keepRegistered(peer);
      peer.on('open', () => {
        if (!link) onCode(code);
      });
      peer.on('connection', (conn) => {
        conn.on('open', () => {
          if (cancelled) return conn.close();
          if (!link) {
            link = new Link(peer, 'host', id);
            link.attach(conn);
            onConnect(link);
          } else if (!link.closed) {
            link.attach(conn); // 참가자가 다시 연결해 왔다
          }
        });
      });
      peer.on('error', (err) => {
        if (link || cancelled) return; // 게임 중 오류는 재연결로 처리
        if (err.type === 'unavailable-id' && tries++ < 5) {
          peer.destroy();
          attempt();
        } else {
          onError(errorMessage(err));
        }
      });
    };
    try {
      ensurePeer();
      attempt();
    } catch (err) {
      onError(errorMessage(err));
    }
    return {
      cancel() {
        cancelled = true;
        if (peer && !link) peer.destroy();
      },
    };
  }

  /** 코드로 참가 */
  function join(code, { onConnect, onError }) {
    let peer = null;
    let done = false;
    const hostId = PREFIX + code;
    const fail = (msg) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (peer) peer.destroy();
      onError(msg);
    };
    const timer = setTimeout(() => fail(errorMessage({ type: 'timeout' })), CONNECT_TIMEOUT);
    try {
      ensurePeer();
      peer = new window.Peer(undefined, peerOptions());
      keepRegistered(peer);
      peer.on('open', () => {
        if (done) return;
        const conn = peer.connect(hostId, { reliable: true, serialization: 'json' });
        conn.on('open', () => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          const link = new Link(peer, 'guest', hostId);
          link.attach(conn);
          onConnect(link);
        });
      });
      peer.on('error', (err) => {
        if (!done) fail(errorMessage(err));
        // 연결된 뒤의 오류(예: 재연결 중 방장이 잠깐 안 보임)는 Link가 계속 재시도한다
      });
    } catch (err) {
      fail(errorMessage(err));
    }
    return { cancel: () => fail('취소했어요.') };
  }

  window.Net = { host, join };
})();

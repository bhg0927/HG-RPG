/*
 * 풍선 숫자 대전 - 두 기기 연결 (PeerJS / WebRTC)
 *
 * 서버를 따로 두지 않고, PeerJS 공개 중계 서버(0.peerjs.com)로 서로를 찾은 뒤
 * 기기끼리 직접(WebRTC) 메시지를 주고받는다.
 * 테스트용으로 주소에 ?peerhost=localhost&peerport=9000 을 붙이면 로컬 중계 서버를 쓴다.
 */
(function () {
  'use strict';

  const PREFIX = 'hg-balloon-v1-';
  const CONNECT_TIMEOUT = 12000;

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
      case 'timeout': return '연결 시간이 초과됐어요. 두 기기가 같은 와이파이에 있는지 확인해 주세요.';
      default: return `연결 오류가 났어요 (${(err && err.type) || '알 수 없음'})`;
    }
  }

  class Link {
    constructor(conn, peer) {
      this.conn = conn;
      this.peer = peer;
      this.closed = false;
      this.onmessage = null;
      this.onclose = null;
      conn.on('data', (d) => this.onmessage && this.onmessage(d));
      conn.on('close', () => this._closed());
      conn.on('error', () => this._closed());
      peer.on('error', (err) => {
        if (err.type !== 'peer-unavailable') this._closed();
      });
    }
    send(msg) {
      if (!this.closed && this.conn.open) this.conn.send(msg);
    }
    _closed() {
      if (this.closed) return;
      this.closed = true;
      if (this.onclose) this.onclose();
    }
    close() {
      this.closed = true;
      try { this.conn.close(); } catch (e) { /* 무시 */ }
      try { this.peer.destroy(); } catch (e) { /* 무시 */ }
    }
  }

  function ensurePeer() {
    if (typeof window.Peer !== 'function') throw { type: 'browser-incompatible' };
  }

  /** 방 만들기: 코드가 정해지면 onCode, 상대가 들어오면 onConnect(link) */
  function host({ onCode, onConnect, onError }) {
    let peer = null;
    let tries = 0;
    let done = false;
    const attempt = () => {
      const code = randomCode();
      peer = new window.Peer(PREFIX + code, peerOptions());
      peer.on('open', () => onCode(code));
      peer.on('connection', (conn) => {
        if (done) {
          conn.close();
          return;
        }
        conn.on('open', () => {
          if (done) return;
          done = true;
          onConnect(new Link(conn, peer));
        });
      });
      peer.on('error', (err) => {
        if (done) return;
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
        done = true;
        if (peer) peer.destroy();
      },
    };
  }

  /** 코드로 참가 */
  function join(code, { onConnect, onError }) {
    let peer = null;
    let done = false;
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
      peer.on('open', () => {
        const conn = peer.connect(PREFIX + code, { reliable: true, serialization: 'json' });
        conn.on('open', () => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          onConnect(new Link(conn, peer));
        });
      });
      peer.on('error', (err) => fail(errorMessage(err)));
    } catch (err) {
      fail(errorMessage(err));
    }
    return { cancel: () => fail('취소했어요.') };
  }

  window.Net = { host, join };
})();

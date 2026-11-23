/*
 * 풍선 숫자 대전 - 게임 진행, 입력(터치/키보드/게임패드), 화면, 온라인 동기화
 *
 * 모드
 *  - online: 각자 폰에서 접속. 내 판은 내 기기에서 계산하고, 화면 상태(view)만 상대에게 보낸다.
 *  - local : 한 기기에서 둘이 (PC 키보드 분할, 태블릿 터치)
 */
(function () {
  'use strict';

  const { Board, COLS, ROWS, TARGET } = window.BalloonBoard;

  // ---------- 밸런스 설정 ----------
  const DIFFICULTY = {
    easy: { label: '쉬움', rise: 11000 },
    normal: { label: '보통', rise: 8500 },
    hard: { label: '어려움', rise: 6500 },
  };
  const CFG = {
    startRows: 5,
    landDelay: 3000, // 공격 풍선이 도착하기까지 (이 사이에 상쇄 가능)
    comboWindow: 3000, // 이 시간 안에 다시 지우면 콤보
    maxComboBonus: 3,
    riseDecay: 0.96, // 줄이 올라올 때마다 다음 간격이 짧아짐
    minRiseRatio: 0.45,
    winRounds: 2, // 먼저 2판 이기면 승리
    countdown: 3000,
    viewSendInterval: 70, // 온라인: 화면 상태 전송 간격(ms)
    miniRatio: 0.36, // 온라인: 상대 판 크기 비율
  };
  const ATTACK_BY_COUNT = [0, 0, 0, 1, 2, 3]; // 한 번에 지운 칸 수 → 풍선 수 (6칸 이상 4개)
  const attackFor = (count, combo) =>
    (count < ATTACK_BY_COUNT.length ? ATTACK_BY_COUNT[count] : 4) + Math.min(CFG.maxComboBonus, Math.max(0, combo - 1));

  const KEYS_P1 = { KeyW: 'up', KeyS: 'down', KeyA: 'left', KeyD: 'right', KeyF: 'pick', KeyG: 'pick', Space: 'pick' };
  const KEYS_P2 = {
    ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
    Enter: 'pick', NumpadEnter: 'pick', Slash: 'pick', Period: 'pick', Numpad0: 'pick',
  };
  const PLAYER_DEFS = [
    { name: '토끼', emoji: '🐰', cls: 'p1', keys: KEYS_P1, keyHelp: 'WASD 이동 · F/Space 고르기' },
    { name: '너구리', emoji: '🦝', cls: 'p2', keys: KEYS_P2, keyHelp: '방향키 이동 · Enter// 고르기' },
  ];

  const players = PLAYER_DEFS.map((def, idx) => ({
    def, idx,
    local: true,
    difficulty: 'normal',
    wins: 0,
    board: null,
    pending: [],
    combo: 0,
    lastClearAt: -1e9,
    baseRise: 0,
    riseInterval: 1,
    nextRiseAt: 0,
    view: null, // 상대 기기에서 받은 화면 상태 (online 상대 전용)
    drag: null,
    dom: null,
  }));

  let mode = 'local'; // local | online
  let myIdx = 0;
  let link = null;
  let pendingNet = null; // 진행 중인 방 만들기/참가 (취소용)
  let state = 'title'; // title | hosting | joining | lobby | countdown | playing | paused | roundover | matchover
  let now = 0;
  let countdownLeft = 0;
  let lastRoundLoser = null;
  let usedKeyboard = false;
  let lastHeardAt = 0;
  let lastPingAt = 0;
  let muted = false;

  const me = () => players[myIdx];
  const opp = () => players[1 - myIdx];
  const isTouch = window.matchMedia('(pointer: coarse)').matches;

  // ---------- 소리 ----------
  let actx = null;
  function tone(freq, start, dur, type = 'sine', vol = 0.12) {
    const t0 = actx.currentTime + start;
    const osc = actx.createOscillator();
    const gain = actx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    gain.gain.setValueAtTime(vol, t0);
    gain.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
    osc.connect(gain).connect(actx.destination);
    osc.start(t0);
    osc.stop(t0 + dur);
  }
  function sfx(kind) {
    if (muted) return;
    try {
      actx = actx || new (window.AudioContext || window.webkitAudioContext)();
      if (actx.state === 'suspended') actx.resume();
      switch (kind) {
        case 'pick': tone(660, 0, 0.06, 'triangle', 0.08); break;
        case 'step': tone(520, 0, 0.05, 'triangle', 0.06); break;
        case 'clear': [523, 659, 784].forEach((f, i) => tone(f, i * 0.05, 0.15, 'triangle')); break;
        case 'attack': [392, 523, 784, 1046].forEach((f, i) => tone(f, i * 0.04, 0.14, 'square', 0.05)); break;
        case 'over': tone(180, 0, 0.18, 'sawtooth', 0.06); break;
        case 'land': tone(140, 0, 0.2, 'sine', 0.2); break;
        case 'tick': tone(440, 0, 0.1, 'sine', 0.1); break;
        case 'go': tone(880, 0, 0.25, 'sine', 0.12); break;
        case 'win': [523, 659, 784, 1046].forEach((f, i) => tone(f, i * 0.12, 0.3, 'triangle')); break;
      }
    } catch (e) {
      /* 소리를 못 내는 환경이면 넘어간다 */
    }
  }
  const vibrate = (ms) => navigator.vibrate && navigator.vibrate(ms);

  // 게임 중 화면이 꺼지지 않게
  let wakeLock = null;
  async function keepAwake(on) {
    try {
      if (on && !wakeLock && navigator.wakeLock) wakeLock = await navigator.wakeLock.request('screen');
      if (!on && wakeLock) {
        await wakeLock.release();
        wakeLock = null;
      }
    } catch (e) {
      wakeLock = null;
    }
  }

  // ---------- 화면 구성 ----------
  const arena = document.querySelector('.arena');

  function buildPlayerDom(p) {
    const root = document.getElementById(`player-${p.idx}`);
    root.innerHTML = `
      <div class="phead">
        <span class="avatar">${p.def.emoji}</span>
        <span class="pname">${p.def.name}</span>
        <span class="wins"></span>
      </div>
      <div class="incoming" title="곧 도착할 풍선">
        <div class="incoming-balloons"></div>
        <div class="incoming-bar"><i></i></div>
      </div>
      <div class="board-wrap">
        <div class="grid"></div>
        <div class="fx"></div>
        <div class="danger-banner">위험!</div>
      </div>
      <div class="rise-bar" title="다음 줄이 올라오기까지"><i></i></div>
      <div class="pinfo">
        <span class="sum"></span>
        <span class="combo"></span>
      </div>
      <div class="keys">${p.def.keyHelp}</div>
    `;
    const grid = root.querySelector('.grid');
    const cells = Array.from({ length: ROWS }, () => new Array(COLS));
    for (let r = ROWS - 1; r >= 0; r--) {
      for (let c = 0; c < COLS; c++) {
        const el = document.createElement('div');
        el.className = 'cell empty';
        grid.appendChild(el);
        cells[r][c] = el;
      }
    }
    p.dom = {
      root, grid, cells,
      wrap: root.querySelector('.board-wrap'),
      fx: root.querySelector('.fx'),
      wins: root.querySelector('.wins'),
      pname: root.querySelector('.pname'),
      incomingBalloons: root.querySelector('.incoming-balloons'),
      incomingBar: root.querySelector('.incoming-bar i'),
      riseBar: root.querySelector('.rise-bar i'),
      sum: root.querySelector('.sum'),
      combo: root.querySelector('.combo'),
      cacheIncoming: null,
    };
    attachTouch(p);
  }

  /** 화면 크기에 맞춰 칸 크기 계산 */
  function layout() {
    const W = window.innerWidth;
    const H = window.innerHeight;
    const online = mode === 'online';
    arena.classList.toggle('online', online);
    document.body.classList.toggle('online', online);
    players.forEach((p) => p.dom.root.classList.toggle('mini', online && !p.local));
    players.forEach((p) => p.dom.root.classList.toggle('me', online && p.local));

    let big;
    if (online) {
      const byW = (W - 32 - 20) / (6.8 * (1 + CFG.miniRatio));
      const byH = (H - 150) / 13.2;
      big = Math.min(byW, byH, 64);
      me().dom.root.style.setProperty('--cell', `${big}px`);
      opp().dom.root.style.setProperty('--cell', `${big * CFG.miniRatio}px`);
    } else {
      const byW = (W - 32 - 70) / (2 * 6.8);
      const byH = (H - 190) / 13.2;
      big = Math.min(byW, byH, 58);
      players.forEach((p) => p.dom.root.style.setProperty('--cell', `${big}px`));
    }
  }
  window.addEventListener('resize', layout);

  function cellCenter(p, c, r) {
    const el = p.dom.cells[r] && p.dom.cells[r][c];
    const wrapRect = p.dom.wrap.getBoundingClientRect();
    if (!el) return { x: wrapRect.width / 2, y: wrapRect.height / 2 };
    const rect = el.getBoundingClientRect();
    return { x: rect.left - wrapRect.left + rect.width / 2, y: rect.top - wrapRect.top + rect.height / 2 };
  }

  function fxText(p, text, kind = '', pos = null) {
    const el = document.createElement('div');
    el.className = `fx-text ${kind}`;
    el.textContent = text;
    const at = pos || { x: p.dom.wrap.clientWidth / 2, y: p.dom.wrap.clientHeight / 2 };
    el.style.left = `${at.x}px`;
    el.style.top = `${at.y}px`;
    el.addEventListener('animationend', () => el.remove());
    p.dom.fx.appendChild(el);
  }

  function fxPop(p, c, r, label) {
    const el = document.createElement('div');
    el.className = 'fx-pop';
    el.textContent = label;
    const { x, y } = cellCenter(p, c, r);
    const size = p.dom.cells[0][0].getBoundingClientRect().width;
    el.style.left = `${x - size / 2}px`;
    el.style.top = `${y - size / 2}px`;
    el.addEventListener('animationend', () => el.remove());
    p.dom.fx.appendChild(el);
  }

  function shake(p) {
    p.dom.wrap.classList.remove('shake');
    void p.dom.wrap.offsetWidth;
    p.dom.wrap.classList.add('shake');
  }

  /** 내 판의 효과를 상대 화면에도 보여준다 */
  function fxShared(p, text, kind, pos) {
    fxText(p, text, kind, pos);
    if (mode === 'online' && p.local && link) link.send({ t: 'fx', text, kind });
  }

  // ---------- 온라인 메시지 ----------
  function send(msg) {
    if (mode === 'online' && link) link.send(msg);
  }

  function onNet(msg) {
    const o = opp();
    lastHeardAt = performance.now();
    switch (msg.t) {
      case 'ping':
        break;
      case 'bye':
        onDisconnect();
        break;
      case 'hello':
      case 'diff':
        o.difficulty = msg.difficulty in DIFFICULTY ? msg.difficulty : 'normal';
        if (state === 'lobby') showLobby();
        break;
      case 'start':
        if (['lobby', 'roundover', 'matchover'].includes(state)) startRound(false);
        break;
      case 'view':
        o.view = msg.v;
        break;
      case 'attack':
        if (state === 'playing' || state === 'paused') {
          me().pending.push({ count: msg.count, landAt: now + CFG.landDelay, sentAt: now });
        }
        break;
      case 'fx':
        fxText(o, msg.text, msg.kind);
        break;
      case 'lost':
        if (state === 'playing' || state === 'paused') {
          me().wins++;
          endRound(o);
        } else if ((state === 'roundover' || state === 'matchover') && lastRoundLoser === me()) {
          // 거의 동시에 둘 다 졌다 → 무승부로 정정
          o.wins--;
          endRound(null, true);
        }
        break;
      case 'pause':
        setPaused(msg.on, false);
        break;
      case 'lobby':
        if (state !== 'title') goLobby(false);
        break;
    }
  }

  function onDisconnect() {
    if (!link) return;
    const l = link;
    link = null;
    l.close();
    keepAwake(false);
    mode = 'local';
    players.forEach((p) => (p.local = true));
    layout();
    state = 'title';
    showOverlay(`
      <h2>🔌 연결이 끊겼어요</h2>
      <p>상대 화면이 꺼졌거나 인터넷이 끊겼을 수 있어요.<br>방을 다시 만들어 연결해 주세요.</p>
      <button class="btn" data-action="title">처음으로</button>
    `);
  }

  function connected(l, idx) {
    pendingNet = null;
    link = l;
    myIdx = idx;
    mode = 'online';
    players.forEach((p) => {
      p.local = p.idx === idx;
      p.wins = 0;
      p.view = null;
    });
    lastHeardAt = performance.now();
    link.onmessage = onNet;
    link.onclose = onDisconnect;
    send({ t: 'hello', difficulty: me().difficulty });
    layout();
    const q = new URLSearchParams(location.search);
    if (q.has('room')) {
      q.delete('room');
      const s = q.toString();
      history.replaceState(null, '', location.pathname + (s ? `?${s}` : ''));
    }
    showLobby();
  }

  function startHost() {
    state = 'hosting';
    showOverlay(`<h2>방 만드는 중…</h2><p>잠시만 기다려 주세요.</p>
      <button class="btn ghost" data-action="cancel-net">취소</button>`);
    pendingNet = window.Net.host({
      onCode: (code) => {
        if (state !== 'hosting') return;
        const url = `${location.origin}${location.pathname}?room=${code}${extraParams()}`;
        showOverlay(`
          <h2>📱 방을 만들었어요</h2>
          <p>상대 폰에서 이 게임 주소로 들어와<br>아래 코드를 입력하면 연결돼요.</p>
          <p class="code">${code}</p>
          <button class="btn" data-action="share" data-url="${url}">🔗 링크 보내기</button>
          <p class="small" id="share-msg">상대를 기다리는 중… 이 화면을 켜 두세요.</p>
          <button class="btn ghost" data-action="cancel-net">취소</button>
        `);
      },
      onConnect: (l) => connected(l, 0),
      onError: (msg) => netError(msg),
    });
  }

  function startJoin(code) {
    if (!/^\d{4}$/.test(code)) {
      showTitle('코드는 숫자 4자리예요.');
      return;
    }
    state = 'joining';
    showOverlay(`<h2>🔎 방 ${code}에 연결 중…</h2><p>잠시만 기다려 주세요.</p>
      <button class="btn ghost" data-action="cancel-net">취소</button>`);
    pendingNet = window.Net.join(code, {
      onConnect: (l) => connected(l, 1),
      onError: (msg) => netError(msg),
    });
  }

  function netError(msg) {
    if (state !== 'hosting' && state !== 'joining') return;
    pendingNet = null;
    showTitle(msg);
  }

  // 테스트용 중계 서버 설정을 링크에도 이어 붙인다
  function extraParams() {
    const q = new URLSearchParams(location.search);
    q.delete('room');
    const s = q.toString();
    return s ? `&${s}` : '';
  }

  // ---------- 게임 진행 ----------
  function viewOf(p) {
    const b = p.board;
    const total = p.pending.reduce((s, x) => s + x.count, 0);
    const first = p.pending[0];
    return {
      cols: b.cols.map((col) => col.map((x) => (x.balloon ? -x.n : x.n))),
      chain: b.chain.map((cell) => {
        const q = b.posOf(cell);
        return q ? [q.c, q.r] : [-1, -1];
      }),
      cursor: [b.cursor.c, b.cursor.r],
      sum: b.sum,
      incoming: total,
      incomingProgress: first ? Math.round(Math.min(1, (now - first.sentAt) / CFG.landDelay) * 100) / 100 : 0,
      rise: Math.round(Math.max(0, Math.min(1, 1 - (p.nextRiseAt - now) / p.riseInterval)) * 50) / 50,
      combo: p.combo,
      danger: b.height() >= ROWS - 1,
    };
  }

  function startRound(broadcast = true) {
    if (state === 'matchover' || state === 'lobby') players.forEach((p) => (p.wins = 0));
    for (const p of players) {
      p.pending = [];
      p.combo = 0;
      p.lastClearAt = -1e9;
      p.drag = null;
      p.baseRise = DIFFICULTY[p.difficulty].rise;
      p.riseInterval = p.baseRise;
      p.nextRiseAt = p.riseInterval;
      p.dom.fx.innerHTML = '';
      if (p.local) p.board = new Board({ startRows: CFG.startRows });
      else p.view = null;
    }
    if (broadcast) send({ t: 'start' });
    now = 0;
    lastRoundLoser = null;
    countdownLeft = CFG.countdown;
    state = 'countdown';
    keepAwake(true);
    showCountdown(3);
  }

  function update() {
    for (const p of players) {
      if (!p.local) continue;
      if (now >= p.nextRiseAt) {
        p.board.pushRow();
        p.riseInterval = Math.max(p.baseRise * CFG.minRiseRatio, p.riseInterval * CFG.riseDecay);
        p.nextRiseAt = now + p.riseInterval;
      }
      if (p.pending.length && now >= p.pending[0].landAt) {
        const batch = p.pending.shift();
        p.board.addBalloons(batch.count);
        fxShared(p, `🎈×${batch.count}`, 'attack');
        shake(p);
        sfx('land');
        vibrate(120);
      }
      if (p.combo && now - p.lastClearAt > CFG.comboWindow) p.combo = 0;
    }
    const losers = players.filter((p) => p.local && p.board.lost);
    if (!losers.length) return;
    if (mode === 'online') {
      opp().wins++;
      sendView(true);
      send({ t: 'lost' });
      endRound(me());
    } else if (losers.length === 2) {
      endRound(null, true);
    } else {
      players[1 - losers[0].idx].wins++;
      endRound(losers[0]);
    }
  }

  function sendAttack(p, amount) {
    if (amount <= 0) return;
    let left = amount;
    while (left > 0 && p.pending.length) {
      const batch = p.pending[0];
      const k = Math.min(left, batch.count);
      batch.count -= k;
      left -= k;
      if (!batch.count) p.pending.shift();
    }
    const blocked = amount - left;
    if (blocked) fxShared(p, `🛡️ ${blocked} 막음!`, 'guard', { x: p.dom.wrap.clientWidth / 2, y: 0 });
    if (left > 0) {
      const o = players[1 - p.idx];
      if (o.local) o.pending.push({ count: left, landAt: now + CFG.landDelay, sentAt: now });
      else send({ t: 'attack', count: left });
      fxShared(p, `🎈 ${left} 공격!`, 'attack', { x: p.dom.wrap.clientWidth / 2, y: p.dom.wrap.clientHeight * 0.3 });
      sfx('attack');
    }
  }

  function handleBoardEvent(p, ev) {
    switch (ev.type) {
      case 'start': sfx('pick'); break;
      case 'extend': case 'undo': sfx('step'); break;
      case 'invalid': shake(p); break;
      case 'over': {
        shake(p);
        sfx('over');
        vibrate(40);
        const last = ev.cells[ev.cells.length - 1];
        fxText(p, `${ev.sum}! 넘쳤어요`, 'bad', cellCenter(p, last.c, last.r));
        break;
      }
      case 'clear': {
        p.combo = now - p.lastClearAt <= CFG.comboWindow ? p.combo + 1 : 1;
        p.lastClearAt = now;
        ev.cells.forEach((cell) => fxPop(p, cell.c, cell.r, cell.n));
        ev.popped.forEach((pos) => fxPop(p, pos.c, pos.r, '💥'));
        const last = ev.cells[ev.cells.length - 1];
        if (p.combo >= 2) fxText(p, `${p.combo} 콤보!`, '', cellCenter(p, last.c, last.r));
        sfx('clear');
        sendAttack(p, attackFor(ev.count, p.combo));
        break;
      }
    }
  }

  /** loser: 이번 판에 진 플레이어 (null이면 무승부) */
  function endRound(loser, draw = false) {
    lastRoundLoser = loser;
    const winner = draw || !loser ? null : players[1 - loser.idx];
    keepAwake(false);
    sfx('win');
    const score = `${players[0].def.emoji} ${players[0].wins} : ${players[1].wins} ${players[1].def.emoji}`;
    const title = winner ? (mode === 'online' ? (winner.local ? '내가 이겼어요! 🎉' : `${winner.def.name} 승리!`) : `${winner.def.name} 승리!`) : '무승부!';
    if (winner && winner.wins >= CFG.winRounds) {
      state = 'matchover';
      showOverlay(`
        <p class="big">${winner.def.emoji}</p>
        <h2>${winner.def.name} 최종 승리!</h2>
        <p>${score}</p>
        <button class="btn" data-action="rematch">한 번 더!</button>
        ${mode === 'online' ? '<button class="btn ghost" data-action="lobby">대기실로</button>' : '<button class="btn ghost" data-action="title">처음으로</button>'}
      `);
    } else {
      state = 'roundover';
      showOverlay(`
        <p class="big">${winner ? winner.def.emoji : '🤝'}</p>
        <h2>${title}</h2>
        <p>${score} · 먼저 ${CFG.winRounds}판 이기면 승리</p>
        <button class="btn" data-action="next">다음 판</button>
        ${isTouch ? '' : '<p class="small">Space / Enter</p>'}
      `);
    }
  }

  function setPaused(on, broadcast = true) {
    if (on && state === 'playing') {
      state = 'paused';
      showOverlay(`
        <h2>⏸ 잠깐 쉬는 중</h2>
        <button class="btn" data-action="resume">계속하기</button>
        <button class="btn ghost" data-action="${mode === 'online' ? 'lobby' : 'title'}">그만하기</button>
      `);
    } else if (!on && state === 'paused') {
      state = 'playing';
      hideOverlay();
    } else {
      return;
    }
    if (broadcast) send({ t: 'pause', on });
  }

  function goLobby(broadcast = true) {
    if (broadcast) send({ t: 'lobby' });
    keepAwake(false);
    if (mode === 'online') showLobby();
    else showTitle();
  }

  // ---------- 오버레이 화면 ----------
  const overlay = document.getElementById('overlay');
  const overlayCard = document.getElementById('overlay-card');

  function showOverlay(html) {
    overlayCard.innerHTML = html;
    overlay.classList.remove('hidden');
  }
  function hideOverlay() {
    overlay.classList.add('hidden');
  }

  function showTitle(error = '') {
    if (link) {
      link.close();
      link = null;
    }
    mode = 'local';
    players.forEach((p) => {
      p.local = true;
      p.wins = 0;
      if (!p.board) p.board = new Board({ startRows: CFG.startRows });
    });
    layout();
    state = 'title';
    keepAwake(false);
    showOverlay(`
      <h2>🎈 풍선 숫자 대전</h2>
      <p>붙어 있는 숫자를 손가락으로 이어서 <b>합 10</b>을 만드세요.<br>
      3칸 이상 지우거나 연속으로 지우면 상대 판에 풍선이 올라가요.</p>
      ${error ? `<p class="error">${error}</p>` : ''}
      <div class="menu">
        <button class="btn" data-action="host">📱 방 만들기</button>
        <div class="join-row">
          <input id="code-input" inputmode="numeric" pattern="[0-9]*" maxlength="4" placeholder="코드 4자리" autocomplete="off">
          <button class="btn" data-action="join">참가</button>
        </div>
        <button class="btn ghost" data-action="local">💻 한 기기에서 둘이 하기</button>
      </div>
      <p class="small">각자 폰으로 할 땐 한 명이 방을 만들고, 다른 한 명이 코드를 입력하세요.</p>
    `);
  }

  function showLobby() {
    state = 'lobby';
    const editable = (p) => mode === 'local' || p.local;
    const card = (p) => `
      <div class="setup-card ${p.def.cls}">
        <div class="who">${p.def.emoji} ${p.def.name}${mode === 'online' ? (p.local ? ' (나)' : ' (상대)') : ''}</div>
        ${mode === 'local' && !isTouch ? `<div class="keys">${p.def.keyHelp}</div>` : ''}
        <div class="diff">
          ${Object.entries(DIFFICULTY)
            .map(([key, d]) => `<button data-player="${p.idx}" data-diff="${key}" class="${p.difficulty === key ? 'on' : ''}" ${editable(p) ? '' : 'disabled'}>${d.label}</button>`)
            .join('')}
        </div>
      </div>`;
    showOverlay(`
      <h2>${mode === 'online' ? '✅ 연결됐어요!' : '🎈 둘이서 한 기기로'}</h2>
      <div class="setup">${players.map(card).join('')}</div>
      <p class="small">난이도 = 줄이 올라오는 속도. 실력 차이가 나면 서로 다르게 맞춰 보세요.<br>
      ${mode === 'online' ? '둘 중 누구든 시작을 누르면 같이 시작해요.' : '태블릿이면 각자 자기 판을 손가락으로 그으면 돼요.'}</p>
      <button class="btn" data-action="start">시작!</button>
      <button class="btn ghost" data-action="title">나가기</button>
    `);
  }

  function showCountdown(n) {
    showOverlay(`<p class="big">${n}</p><p>준비!</p>`);
  }

  overlay.addEventListener('click', async (e) => {
    const btn = e.target.closest('button');
    if (!btn || btn.disabled) return;
    sfx('tick'); // iOS는 첫 터치 때 소리를 깨워야 한다
    if (btn.dataset.diff) {
      const p = players[Number(btn.dataset.player)];
      p.difficulty = btn.dataset.diff;
      if (p.local && mode === 'online') send({ t: 'diff', difficulty: p.difficulty });
      showLobby();
      return;
    }
    switch (btn.dataset.action) {
      case 'host': startHost(); break;
      case 'join': startJoin(document.getElementById('code-input').value.trim()); break;
      case 'local': mode = 'local'; layout(); showLobby(); break;
      case 'cancel-net':
        if (pendingNet) pendingNet.cancel();
        pendingNet = null;
        showTitle();
        break;
      case 'share': {
        const url = btn.dataset.url;
        const msgEl = document.getElementById('share-msg');
        try {
          if (navigator.share) await navigator.share({ title: '풍선 숫자 대전', text: '같이 하자! 🎈', url });
          else {
            await navigator.clipboard.writeText(url);
            if (msgEl) msgEl.textContent = '링크를 복사했어요. 메신저로 보내 주세요.';
          }
        } catch (err) {
          if (msgEl) msgEl.textContent = url;
        }
        break;
      }
      case 'start': startRound(); break;
      case 'next': case 'rematch': startRound(); break;
      case 'resume': setPaused(false); break;
      case 'lobby': goLobby(); break;
      case 'title': showTitle(); break;
    }
  });

  overlay.addEventListener('keydown', (e) => {
    if (e.target.id === 'code-input' && e.key === 'Enter') startJoin(e.target.value.trim());
  });

  // ---------- 입력: 터치 (손가락으로 이어 긋기) ----------
  function cellFromPoint(p, x, y, strict) {
    const first = p.dom.cells[ROWS - 1][0].getBoundingClientRect();
    const second = p.dom.cells[ROWS - 1][1].getBoundingClientRect();
    const step = second.left - first.left;
    const size = first.width;
    const fx = (x - first.left) / step;
    const fy = (y - first.top) / step;
    const c = Math.floor(fx);
    const row = Math.floor(fy);
    if (c < 0 || c >= COLS || row < 0 || row >= ROWS) return null;
    if (strict) {
      // 칸 가장자리에서는 반응하지 않아야 대각선으로 그을 때 덜 헷갈린다
      const ox = ((fx - c) * step) / size;
      const oy = ((fy - row) * step) / size;
      if (ox < 0.15 || ox > 0.85 || oy < 0.15 || oy > 0.85) return null;
    }
    return { c, r: ROWS - 1 - row };
  }

  function attachTouch(p) {
    const grid = p.dom.grid;
    grid.addEventListener('pointerdown', (e) => {
      if (!p.local || state !== 'playing') return;
      const pos = cellFromPoint(p, e.clientX, e.clientY, false);
      if (!pos) return;
      e.preventDefault();
      try { grid.setPointerCapture(e.pointerId); } catch (err) { /* 무시 */ }
      p.drag = { id: e.pointerId };
      const b = p.board;
      b.chain = [];
      b.cursor = { c: pos.c, r: pos.r };
      handleBoardEvent(p, b.pick());
    });
    grid.addEventListener('pointermove', (e) => {
      if (!p.drag || p.drag.id !== e.pointerId || state !== 'playing') return;
      const pos = cellFromPoint(p, e.clientX, e.clientY, true);
      if (!pos) return;
      const b = p.board;
      // 손가락이 빨리 움직여 칸을 건너뛰면 한 칸씩 따라간다
      for (let guard = 0; guard < 12 && b.chain.length; guard++) {
        const last = b.posOf(b.chain[b.chain.length - 1]);
        if (!last) break;
        const dc = pos.c - last.c;
        const dr = pos.r - last.r;
        if (!dc && !dr) break;
        const ev = Math.abs(dc) >= Math.abs(dr) ? b.moveCursor(Math.sign(dc), 0) : b.moveCursor(0, Math.sign(dr));
        handleBoardEvent(p, ev);
        if (ev.type === 'blocked' || ev.type === 'clear' || ev.type === 'over') break;
      }
    });
    const end = (e) => {
      if (!p.drag || p.drag.id !== e.pointerId) return;
      p.drag = null;
      if (p.board && p.board.chain.length) p.board.chain = []; // 손을 떼면 취소
    };
    grid.addEventListener('pointerup', end);
    grid.addEventListener('pointercancel', end);
  }

  // ---------- 입력: 키보드 / 게임패드 ----------
  const DIFF_KEYS = Object.keys(DIFFICULTY);
  function onAction(idx, action) {
    const p = players[idx];
    if (state === 'playing') {
      if (!p.local) return;
      const b = p.board;
      let ev;
      switch (action) {
        case 'up': ev = b.moveCursor(0, 1); break;
        case 'down': ev = b.moveCursor(0, -1); break;
        case 'left': ev = b.moveCursor(-1, 0); break;
        case 'right': ev = b.moveCursor(1, 0); break;
        case 'pick': ev = b.pick(); break;
        case 'start': setPaused(true); return;
      }
      if (ev) handleBoardEvent(p, ev);
      return;
    }
    if (state === 'paused' && (action === 'pick' || action === 'start')) setPaused(false);
    else if (state === 'lobby' && (action === 'left' || action === 'right') && p.local) {
      const i = DIFF_KEYS.indexOf(p.difficulty) + (action === 'left' ? -1 : 1);
      p.difficulty = DIFF_KEYS[Math.max(0, Math.min(DIFF_KEYS.length - 1, i))];
      if (mode === 'online') send({ t: 'diff', difficulty: p.difficulty });
      showLobby();
    } else if (action === 'pick' || action === 'start') {
      if (state === 'lobby' || state === 'roundover' || state === 'matchover') startRound();
    }
  }

  window.addEventListener('keydown', (e) => {
    if (e.target && e.target.tagName === 'INPUT') return;
    if (e.code === 'Escape' || e.code === 'KeyP') {
      setPaused(state === 'playing');
      e.preventDefault();
      return;
    }
    if (e.code === 'KeyM') {
      toggleMute();
      return;
    }
    for (const def of PLAYER_DEFS) {
      const action = def.keys[e.code];
      if (!action) continue;
      e.preventDefault();
      if (action === 'pick' && e.repeat) return;
      usedKeyboard = true;
      // 온라인에서는 어느 키 세트든 내 판을 움직인다
      onAction(mode === 'online' ? myIdx : PLAYER_DEFS.indexOf(def), action);
      return;
    }
  });

  const padState = [{}, {}];
  function pollGamepads(t) {
    if (!navigator.getGamepads) return;
    const pads = Array.from(navigator.getGamepads()).filter(Boolean).slice(0, 2);
    pads.forEach((gp, i) => {
      const target = mode === 'online' ? myIdx : i;
      const s = padState[i];
      const btn = (n) => gp.buttons[n] && gp.buttons[n].pressed;
      const ax = (n) => gp.axes[n] || 0;
      const dirs = {
        up: btn(12) || ax(1) < -0.5,
        down: btn(13) || ax(1) > 0.5,
        left: btn(14) || ax(0) < -0.5,
        right: btn(15) || ax(0) > 0.5,
      };
      for (const [dir, pressed] of Object.entries(dirs)) {
        if (pressed && (!s[dir] || t >= s[`${dir}Next`])) {
          usedKeyboard = true;
          onAction(target, dir);
          s[`${dir}Next`] = t + (s[dir] ? 90 : 220);
        }
        s[dir] = pressed;
      }
      const pick = btn(0) || btn(1);
      if (pick && !s.pick) onAction(target, 'pick');
      s.pick = pick;
      const start = btn(9);
      if (start && !s.start) onAction(target, 'start');
      s.start = start;
    });
  }

  // 상단 버튼
  const muteBtn = document.getElementById('btn-mute');
  function toggleMute() {
    muted = !muted;
    muteBtn.textContent = muted ? '🔇' : '🔊';
  }
  muteBtn.addEventListener('click', toggleMute);
  document.getElementById('btn-pause').addEventListener('click', () => setPaused(state === 'playing'));

  // 다른 앱으로 넘어가면 자동 일시정지 (온라인이면 상대도 같이 멈춤)
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) setPaused(true);
    else {
      lastHeardAt = performance.now(); // 백그라운드에 있던 시간은 끊김으로 치지 않는다
      if (state === 'playing' || state === 'countdown') keepAwake(true);
    }
  });

  // ---------- 그리기 ----------
  function renderPlayer(p) {
    const v = p.local ? (p.board ? viewOf(p) : null) : p.view;
    const { dom } = p;
    dom.wins.textContent = '❤️'.repeat(Math.max(0, p.wins)) + '🤍'.repeat(Math.max(0, CFG.winRounds - p.wins));
    dom.pname.textContent = mode === 'online' && p.local ? `${p.def.name} (나)` : p.def.name;

    const chainKeys = new Set(v ? v.chain.map(([c, r]) => `${c},${r}`) : []);
    const showCursor = v && p.local && (state === 'playing' || state === 'paused') && (mode === 'local' ? !isTouch || usedKeyboard : usedKeyboard);
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const el = dom.cells[r][c];
        const val = v && v.cols[c] ? v.cols[c][r] : undefined;
        let cls = 'cell';
        let text = '';
        if (val === undefined) cls += ' empty';
        else if (val < 0) {
          cls += ' balloon';
          text = '🎈';
        } else {
          cls += ` n${val}`;
          text = String(val);
        }
        if (val !== undefined && chainKeys.has(`${c},${r}`)) cls += ' chain';
        if (r === ROWS - 1) cls += ' top';
        if (showCursor && v.cursor[0] === c && v.cursor[1] === r) cls += ' cursor';
        if (el.className !== cls) el.className = cls;
        if (el.textContent !== text) el.textContent = text;
      }
    }

    if (!v) {
      dom.sum.textContent = mode === 'online' && !p.local ? '기다리는 중…' : '';
      dom.combo.textContent = '';
      dom.riseBar.style.width = '0%';
      dom.incomingBalloons.innerHTML = '';
      dom.incomingBar.style.width = '0%';
      dom.wrap.classList.remove('danger');
      return;
    }
    dom.sum.innerHTML = v.chain.length ? `합 <b>${v.sum}</b> / ${TARGET}` : `합 – / ${TARGET}`;
    dom.combo.textContent = v.combo >= 2 ? `🔥 ${v.combo} 콤보` : '';
    dom.riseBar.style.width = `${v.rise * 100}%`;
    const key = String(v.incoming);
    if (dom.cacheIncoming !== key) {
      dom.cacheIncoming = key;
      const shown = Math.min(v.incoming, 10);
      dom.incomingBalloons.innerHTML = '🎈'.repeat(shown) + (v.incoming > shown ? `<span class="more">+${v.incoming - shown}</span>` : '');
    }
    dom.incomingBar.style.width = `${v.incomingProgress * 100}%`;
    dom.wrap.classList.toggle('danger', v.danger);
  }

  let lastSent = '';
  let lastSentAt = 0;
  function sendView(force = false) {
    if (mode !== 'online' || !link || !me().board) return;
    const t = performance.now();
    if (!force && t - lastSentAt < CFG.viewSendInterval) return;
    const json = JSON.stringify(viewOf(me()));
    if (!force && json === lastSent) return;
    lastSent = json;
    lastSentAt = t;
    send({ t: 'view', v: JSON.parse(json) });
  }

  // 상대 폰이 갑자기 꺼져도 알아챌 수 있게 1초마다 신호를 주고받는다.
  // 상대가 다른 앱으로 넘어간 경우(일시정지 상태)는 여유를 길게 준다.
  function heartbeat(t) {
    if (mode !== 'online' || !link) return;
    if (t - lastPingAt > 1000) {
      lastPingAt = t;
      send({ t: 'ping' });
    }
    const limit = state === 'playing' || state === 'countdown' ? 8000 : 30000;
    if (t - lastHeardAt > limit) onDisconnect();
  }
  window.addEventListener('pagehide', () => send({ t: 'bye' }));

  let lastT = performance.now();
  function frame(t) {
    const dt = Math.min(100, t - lastT);
    lastT = t;
    pollGamepads(t);

    if (state === 'countdown') {
      const before = Math.ceil(countdownLeft / 1000);
      countdownLeft -= dt;
      const after = Math.ceil(countdownLeft / 1000);
      if (countdownLeft <= 0) {
        state = 'playing';
        hideOverlay();
        sfx('go');
      } else if (after !== before) {
        showCountdown(after);
        sfx('tick');
      }
    } else if (state === 'playing') {
      now += dt;
      update();
    }
    if (['countdown', 'playing', 'paused'].includes(state)) sendView();
    heartbeat(t);

    players.forEach(renderPlayer);
    requestAnimationFrame(frame);
  }

  // ---------- 시작 ----------
  players.forEach(buildPlayerDom);
  showTitle();
  const roomParam = new URLSearchParams(location.search).get('room');
  if (roomParam) startJoin(roomParam);
  requestAnimationFrame(frame);

  // 개발·테스트용 접근 지점
  window.BalloonGame = {
    players, CFG,
    get state() { return state; },
    get mode() { return mode; },
    get myIdx() { return myIdx; },
  };
})();

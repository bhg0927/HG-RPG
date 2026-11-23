/*
 * 풍선 숫자 대전 - 게임 진행, 입력, 화면 그리기
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
  };
  // 한 번에 지운 칸 수 → 보내는 풍선 수 (6칸 이상은 4개)
  const ATTACK_BY_COUNT = [0, 0, 0, 1, 2, 3];
  const attackFor = (count, combo) =>
    (count < ATTACK_BY_COUNT.length ? ATTACK_BY_COUNT[count] : 4) + Math.min(CFG.maxComboBonus, Math.max(0, combo - 1));

  const PLAYER_DEFS = [
    {
      name: '토끼', emoji: '🐰', cls: 'p1',
      keyHelp: 'WASD 이동 · F/Space 고르기',
      keys: { KeyW: 'up', KeyS: 'down', KeyA: 'left', KeyD: 'right', KeyF: 'pick', KeyG: 'pick', Space: 'pick' },
    },
    {
      name: '너구리', emoji: '🦝', cls: 'p2',
      keyHelp: '방향키 이동 · Enter// 고르기',
      keys: {
        ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
        Enter: 'pick', NumpadEnter: 'pick', Slash: 'pick', Period: 'pick', Numpad0: 'pick',
      },
    },
  ];

  const players = PLAYER_DEFS.map((def, idx) => ({
    def, idx,
    difficulty: 'normal',
    wins: 0,
    board: null,
    pending: [],
    combo: 0,
    lastClearAt: -1e9,
    riseInterval: 0,
    baseRise: 0,
    nextRiseAt: 0,
    dom: null,
  }));

  let state = 'title'; // title | countdown | playing | paused | roundover | matchover
  let now = 0; // 게임 시계(ms). 일시정지 중에는 멈춘다
  let countdownLeft = 0;
  let lastRoundWinner = null;

  // ---------- 소리 (WebAudio로 간단히 합성) ----------
  let actx = null;
  let muted = false;
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
      /* 소리를 못 내는 환경이면 그냥 넘어간다 */
    }
  }

  // ---------- 화면 구성 ----------
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
    // 화면은 위에서 아래로 그리므로 맨 위 행(ROWS-1)부터 만든다
    for (let r = ROWS - 1; r >= 0; r--) {
      for (let c = 0; c < COLS; c++) {
        const el = document.createElement('div');
        el.className = 'cell empty';
        grid.appendChild(el);
        cells[r][c] = el;
      }
    }
    p.dom = {
      root,
      cells,
      wrap: root.querySelector('.board-wrap'),
      fx: root.querySelector('.fx'),
      wins: root.querySelector('.wins'),
      incomingBalloons: root.querySelector('.incoming-balloons'),
      incomingBar: root.querySelector('.incoming-bar i'),
      riseBar: root.querySelector('.rise-bar i'),
      sum: root.querySelector('.sum'),
      combo: root.querySelector('.combo'),
      cache: { incoming: null },
    };
  }

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
    void p.dom.wrap.offsetWidth; // 애니메이션 다시 시작
    p.dom.wrap.classList.add('shake');
  }

  // ---------- 게임 진행 ----------
  function startRound() {
    for (const p of players) {
      p.board = new Board({ startRows: CFG.startRows });
      p.pending = [];
      p.combo = 0;
      p.lastClearAt = -1e9;
      p.baseRise = DIFFICULTY[p.difficulty].rise;
      p.riseInterval = p.baseRise;
      p.nextRiseAt = p.riseInterval;
      p.dom.fx.innerHTML = '';
    }
    now = 0;
    countdownLeft = CFG.countdown;
    state = 'countdown';
    showCountdown(3);
  }

  function update() {
    for (const p of players) {
      if (now >= p.nextRiseAt) {
        p.board.pushRow();
        p.riseInterval = Math.max(p.baseRise * CFG.minRiseRatio, p.riseInterval * CFG.riseDecay);
        p.nextRiseAt = now + p.riseInterval;
      }
      if (p.pending.length && now >= p.pending[0].landAt) {
        const batch = p.pending.shift();
        p.board.addBalloons(batch.count);
        fxText(p, `🎈×${batch.count}`, 'attack');
        shake(p);
        sfx('land');
      }
      if (p.combo && now - p.lastClearAt > CFG.comboWindow) p.combo = 0;
    }
    const losers = players.filter((p) => p.board.lost);
    if (losers.length) endRound(losers);
  }

  function sendAttack(p, amount) {
    if (amount <= 0) return;
    let left = amount;
    // 내게 오고 있는 풍선부터 상쇄
    while (left > 0 && p.pending.length) {
      const batch = p.pending[0];
      const k = Math.min(left, batch.count);
      batch.count -= k;
      left -= k;
      if (!batch.count) p.pending.shift();
    }
    const blocked = amount - left;
    if (blocked) fxText(p, `🛡️ ${blocked} 막음!`, 'guard', { x: p.dom.wrap.clientWidth / 2, y: 0 });
    if (left > 0) {
      const opp = players[1 - p.idx];
      opp.pending.push({ count: left, landAt: now + CFG.landDelay, sentAt: now });
      fxText(p, `🎈 ${left} 공격!`, 'attack', { x: p.dom.wrap.clientWidth / 2, y: p.dom.wrap.clientHeight * 0.3 });
      sfx('attack');
    }
  }

  function handleBoardEvent(p, ev) {
    switch (ev.type) {
      case 'start': sfx('pick'); break;
      case 'extend': case 'undo': sfx('step'); break;
      case 'cancel': break;
      case 'invalid': shake(p); break;
      case 'over': {
        shake(p);
        sfx('over');
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

  function endRound(losers) {
    let winner = null;
    if (losers.length === 1) {
      winner = players[1 - losers[0].idx];
      winner.wins++;
    }
    lastRoundWinner = winner;
    sfx('win');
    if (winner && winner.wins >= CFG.winRounds) {
      state = 'matchover';
      showOverlay(`
        <p class="big">${winner.def.emoji}</p>
        <h2>${winner.def.name} 최종 승리!</h2>
        <p>${players[0].def.emoji} ${players[0].wins} : ${players[1].wins} ${players[1].def.emoji}</p>
        <button class="btn" data-action="continue">처음으로</button>
        <p class="small">Space / Enter</p>
      `);
    } else {
      state = 'roundover';
      showOverlay(`
        <p class="big">${winner ? winner.def.emoji : '🤝'}</p>
        <h2>${winner ? `${winner.def.name} 이번 판 승리!` : '무승부!'}</h2>
        <p>${players[0].def.emoji} ${players[0].wins} : ${players[1].wins} ${players[1].def.emoji} · 먼저 ${CFG.winRounds}판 이기면 승리</p>
        <button class="btn" data-action="continue">다음 판</button>
        <p class="small">Space / Enter</p>
      `);
    }
  }

  // ---------- 오버레이 ----------
  const overlay = document.getElementById('overlay');
  const overlayCard = document.getElementById('overlay-card');

  function showOverlay(html) {
    overlayCard.innerHTML = html;
    overlay.classList.remove('hidden');
  }
  function hideOverlay() {
    overlay.classList.add('hidden');
  }

  function showTitle() {
    state = 'title';
    players.forEach((p) => (p.wins = 0));
    const card = (p) => `
      <div class="setup-card ${p.def.cls}">
        <div class="who">${p.def.emoji} ${p.def.name}</div>
        <div class="keys">${p.def.keyHelp}</div>
        <div class="diff">
          ${Object.entries(DIFFICULTY)
            .map(([key, d]) => `<button data-player="${p.idx}" data-diff="${key}" class="${p.difficulty === key ? 'on' : ''}">${d.label}</button>`)
            .join('')}
        </div>
      </div>`;
    showOverlay(`
      <h2>🎈 풍선 숫자 대전</h2>
      <p>붙어 있는 숫자를 이어서 <b>합 10</b>을 만드세요.<br>
      3칸 이상 지우거나 연속으로 지우면 상대 판에 풍선이 올라갑니다.<br>
      판이 천장을 넘으면 패배! 오고 있는 풍선은 내 공격으로 막을 수 있어요.</p>
      <div class="setup">${players.map(card).join('')}</div>
      <p class="small">난이도 = 줄이 올라오는 속도. 실력 차이가 나면 서로 다르게 맞춰 보세요.</p>
      <button class="btn" data-action="start">시작!</button>
      <p class="small">Space / Enter로 시작</p>
    `);
  }

  function showCountdown(n) {
    showOverlay(`<p class="big">${n}</p><p>준비!</p>`);
  }

  function togglePause() {
    if (state === 'playing') {
      state = 'paused';
      showOverlay(`
        <h2>⏸ 잠깐 쉬는 중</h2>
        <button class="btn" data-action="resume">계속하기</button>
        <p class="small">Esc / Space / Enter</p>
        <p><button class="btn small" data-action="quit" style="background:#c9b8ae;box-shadow:none">처음으로</button></p>
      `);
    } else if (state === 'paused') {
      state = 'playing';
      hideOverlay();
    }
  }

  overlay.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn) return;
    if (btn.dataset.diff) {
      players[Number(btn.dataset.player)].difficulty = btn.dataset.diff;
      showTitle();
      return;
    }
    switch (btn.dataset.action) {
      case 'start': startRound(); break;
      case 'continue': confirmOverlay(); break;
      case 'resume': togglePause(); break;
      case 'quit': showTitle(); break;
    }
  });

  function confirmOverlay() {
    if (state === 'title' || state === 'roundover') startRound();
    else if (state === 'matchover') showTitle();
    else if (state === 'paused') togglePause();
  }

  // ---------- 입력 ----------
  const DIFF_KEYS = Object.keys(DIFFICULTY);
  function onAction(idx, action) {
    const p = players[idx];
    if (state === 'playing') {
      const b = p.board;
      let ev;
      switch (action) {
        case 'up': ev = b.moveCursor(0, 1); break;
        case 'down': ev = b.moveCursor(0, -1); break;
        case 'left': ev = b.moveCursor(-1, 0); break;
        case 'right': ev = b.moveCursor(1, 0); break;
        case 'pick': ev = b.pick(); break;
        case 'start': togglePause(); return;
      }
      if (ev) handleBoardEvent(p, ev);
      return;
    }
    if (state === 'title' && (action === 'left' || action === 'right')) {
      const i = DIFF_KEYS.indexOf(p.difficulty) + (action === 'left' ? -1 : 1);
      p.difficulty = DIFF_KEYS[Math.max(0, Math.min(DIFF_KEYS.length - 1, i))];
      showTitle();
      return;
    }
    if (action === 'pick' || action === 'start') confirmOverlay();
  }

  window.addEventListener('keydown', (e) => {
    if (e.code === 'Escape' || e.code === 'KeyP') {
      togglePause();
      e.preventDefault();
      return;
    }
    if (e.code === 'KeyM') {
      muted = !muted;
      return;
    }
    for (const p of players) {
      const action = p.def.keys[e.code];
      if (!action) continue;
      e.preventDefault();
      // 고르기 버튼은 꾹 눌렀을 때 반복 입력되지 않게 한다
      if (action === 'pick' && e.repeat) return;
      onAction(p.idx, action);
      return;
    }
  });

  // 게임패드 2개가 연결되면 1번 패드 = 토끼, 2번 패드 = 너구리
  const padState = [{}, {}];
  function pollGamepads(t) {
    if (!navigator.getGamepads) return;
    const pads = Array.from(navigator.getGamepads()).filter(Boolean).slice(0, 2);
    pads.forEach((gp, i) => {
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
          onAction(i, dir);
          s[`${dir}Next`] = t + (s[dir] ? 90 : 220);
        }
        s[dir] = pressed;
      }
      const pick = btn(0) || btn(1);
      if (pick && !s.pick) onAction(i, 'pick');
      s.pick = pick;
      const start = btn(9);
      if (start && !s.start) onAction(i, 'start');
      s.start = start;
    });
  }

  // ---------- 그리기 ----------
  function renderPlayer(p) {
    const { board, dom } = p;
    if (!board) return;
    const chainSet = new Set(board.chain);
    const cur = board.cursor;
    const showCursor = state === 'playing' || state === 'paused';

    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const el = dom.cells[r][c];
        const cell = board.cellAt(c, r);
        let cls = 'cell';
        let text = '';
        if (cell) {
          if (cell.balloon) {
            cls += ' balloon';
            text = '🎈';
          } else {
            cls += ` n${cell.n}`;
            text = String(cell.n);
          }
          if (chainSet.has(cell)) cls += ' chain';
        } else {
          cls += ' empty';
        }
        if (r === ROWS - 1) cls += ' top';
        if (showCursor && cur.c === c && cur.r === r) cls += ' cursor';
        if (el.className !== cls) el.className = cls;
        if (el.textContent !== text) el.textContent = text;
      }
    }

    dom.wins.textContent = '❤️'.repeat(p.wins) + '🤍'.repeat(Math.max(0, CFG.winRounds - p.wins));

    const sum = board.sum;
    dom.sum.innerHTML = board.chain.length ? `합 <b>${sum}</b> / ${TARGET}` : `합 – / ${TARGET}`;
    dom.combo.textContent = p.combo >= 2 ? `🔥 ${p.combo} 콤보` : '';

    dom.riseBar.style.width = `${Math.max(0, Math.min(1, 1 - (p.nextRiseAt - now) / p.riseInterval)) * 100}%`;

    const total = p.pending.reduce((s, b) => s + b.count, 0);
    const key = String(total);
    if (dom.cache.incoming !== key) {
      dom.cache.incoming = key;
      const shown = Math.min(total, 10);
      dom.incomingBalloons.innerHTML = '🎈'.repeat(shown) + (total > shown ? `<span class="more">+${total - shown}</span>` : '');
    }
    const first = p.pending[0];
    dom.incomingBar.style.width = first ? `${Math.min(1, (now - first.sentAt) / CFG.landDelay) * 100}%` : '0%';

    dom.wrap.classList.toggle('danger', board.height() >= ROWS - 1);
  }

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

    players.forEach(renderPlayer);
    requestAnimationFrame(frame);
  }

  // ---------- 시작 ----------
  players.forEach(buildPlayerDom);
  players.forEach((p) => (p.board = new Board({ startRows: CFG.startRows })));
  showTitle();
  requestAnimationFrame(frame);

  // 개발·테스트용 접근 지점
  window.BalloonGame = { players, CFG, get state() { return state; } };
})();

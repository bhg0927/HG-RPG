/*
 * 풍선 숫자 대전 - 보드 로직 (화면과 분리된 순수 로직)
 *
 * 좌표계: c = 열(0~COLS-1, 왼쪽→오른쪽), r = 행(0 = 맨 아래, 위로 갈수록 증가)
 * 각 열은 아래부터 쌓이는 스택이므로, 칸이 지워지면 위 칸이 자동으로 내려온다.
 *
 * 선택 방식: 사각형 드래그. 시작점(anchor)과 커서를 꼭짓점으로 하는 사각형 안의
 * 숫자를 모두 더해 정확히 10이면, 손을 뗄 때(confirm) 지워진다.
 * 사각형 안의 풍선은 더하지 않고, 옆 칸이 지워지면 터져서 숫자가 된다.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BalloonBoard = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const COLS = 6;
  const ROWS = 11;
  const TARGET = 10;
  const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];

  // 숫자별 등장 가중치 (1~9). 작은 숫자가 더 자주 나와서 10을 만들기 쉽다.
  // 7·8·9 비율: 약 21% (균등 분포였을 때 33%)
  const WEIGHTS = [16, 15, 14, 13, 12, 9, 8, 7, 6];
  const WEIGHT_SUM = WEIGHTS.reduce((a, b) => a + b, 0);
  // 새 줄을 만들 때 왼쪽에 큰 숫자(6 이상)가 나오면, 이 확률로 바로 옆에 짝(작은 숫자)을 붙여 준다
  const PAIR_CHANCE = 0.5;

  let nextId = 1;
  const makeCell = (n, balloon = false) => ({ id: nextId++, n, balloon });

  class Board {
    constructor({ rng = Math.random, startRows = 5 } = {}) {
      this.rng = rng;
      this.cols = Array.from({ length: COLS }, () => []);
      this.cursor = { c: Math.floor(COLS / 2) - 1, r: 0 };
      this.anchor = null;
      for (let i = 0; i < startRows; i++) this.pushRow();
      this.cursor.r = Math.max(0, startRows - 1);
    }

    randNum() {
      let x = this.rng() * WEIGHT_SUM;
      for (let i = 0; i < WEIGHTS.length; i++) {
        x -= WEIGHTS[i];
        if (x < 0) return i + 1;
      }
      return WEIGHTS.length;
    }

    cellAt(c, r) {
      const col = this.cols[c];
      return col && r >= 0 && r < col.length ? col[r] : null;
    }

    posOf(cell) {
      for (let c = 0; c < COLS; c++) {
        const r = this.cols[c].indexOf(cell);
        if (r !== -1) return { c, r };
      }
      return null;
    }

    height() {
      return Math.max(...this.cols.map((col) => col.length));
    }

    /** 어느 열이든 천장(ROWS)을 넘으면 패배 */
    get lost() {
      return this.cols.some((col) => col.length > ROWS);
    }

    // ---------- 사각형 선택 ----------
    get selecting() {
      return this.anchor !== null;
    }

    /** 선택 사각형 {c0, c1, r0, r1} (양 끝 포함), 선택 중이 아니면 null */
    get rect() {
      if (!this.anchor) return null;
      return {
        c0: Math.min(this.anchor.c, this.cursor.c),
        c1: Math.max(this.anchor.c, this.cursor.c),
        r0: Math.min(this.anchor.r, this.cursor.r),
        r1: Math.max(this.anchor.r, this.cursor.r),
      };
    }

    /** 사각형 안의 숫자 칸(풍선 제외) */
    get selection() {
      return this._cellsIn(this.rect);
    }

    get sum() {
      return this.selection.reduce((s, x) => s + x.cell.n, 0);
    }

    _cellsIn(rect) {
      if (!rect) return [];
      const out = [];
      for (let c = rect.c0; c <= rect.c1; c++) {
        for (let r = rect.r0; r <= rect.r1; r++) {
          const cell = this.cellAt(c, r);
          if (cell && !cell.balloon) out.push({ c, r, cell });
        }
      }
      return out;
    }

    /** 선택 시작 (터치를 누른 칸, 또는 키보드 커서 위치) */
    startSelect(c, r) {
      this.cursor = { c: clamp(c, 0, COLS - 1), r: clamp(r, 0, ROWS - 1) };
      this.anchor = { ...this.cursor };
      return { type: 'start', sum: this.sum };
    }

    /** 사각형의 반대쪽 꼭짓점을 옮긴다 (터치 드래그) */
    setCursor(c, r) {
      const nc = clamp(c, 0, COLS - 1);
      const nr = clamp(r, 0, ROWS - 1);
      if (nc === this.cursor.c && nr === this.cursor.r) return { type: 'same' };
      this.cursor = { c: nc, r: nr };
      return this.anchor ? { type: 'extend', sum: this.sum } : { type: 'move' };
    }

    /** 키보드/패드: 커서 한 칸 이동 */
    moveCursor(dc, dr) {
      const nc = this.cursor.c + dc;
      const nr = this.cursor.r + dr;
      if (nc < 0 || nc >= COLS || nr < 0 || nr >= ROWS) return { type: 'blocked' };
      return this.setCursor(nc, nr);
    }

    /** 키보드/패드 고르기 버튼: 선택 시작 ↔ 확정 */
    pick() {
      return this.anchor ? this.confirm() : this.startSelect(this.cursor.c, this.cursor.r);
    }

    cancel() {
      this.anchor = null;
      return { type: 'cancel' };
    }

    /** 손을 뗐을 때: 합이 10이면 지우고, 아니면 취소 */
    confirm() {
      const sel = this.selection;
      const s = sel.reduce((acc, x) => acc + x.cell.n, 0);
      this.anchor = null;
      if (sel.length && s === TARGET) return this._clear(sel);
      if (s > TARGET) return { type: 'over', sum: s, cells: sel.map(({ c, r }) => ({ c, r })) };
      return { type: 'cancel', sum: s };
    }

    _clear(sel) {
      const removed = new Set(sel.map((x) => x.cell));
      const cells = sel.map(({ c, r, cell }) => ({ c, r, n: cell.n }));

      // 지워진 칸 옆의 풍선은 터지면서 일반 숫자로 바뀐다
      const popped = [];
      for (const p of cells) {
        for (const [dc, dr] of DIRS) {
          const nb = this.cellAt(p.c + dc, p.r + dr);
          if (nb && nb.balloon) {
            nb.balloon = false;
            nb.n = this.randNum();
            popped.push(this.posOf(nb));
          }
        }
      }

      for (let c = 0; c < COLS; c++) this.cols[c] = this.cols[c].filter((cell) => !removed.has(cell));
      return { type: 'clear', count: cells.length, cells, popped };
    }

    // ---------- 줄 올라오기 / 공격 ----------
    _insertBottom(c, cell) {
      this.cols[c].unshift(cell);
    }

    /** 위치 기준 선택(사각형)이 같은 칸들을 계속 가리키도록 한 줄 위로 옮긴다 */
    _shiftUp() {
      this.cursor.r = Math.min(this.cursor.r + 1, ROWS - 1);
      if (this.anchor) this.anchor.r = Math.min(this.anchor.r + 1, ROWS - 1);
    }

    /** 맨 아래에 새 숫자 줄이 올라온다. 지울 수 있는 조합이 하나도 없으면 다시 만든다 */
    pushRow() {
      for (let attempt = 0; attempt < 6; attempt++) {
        const row = this._makeRow();
        for (let c = 0; c < COLS; c++) this._insertBottom(c, makeCell(row[c]));
        if (attempt === 5 || this.hasMove()) break;
        for (let c = 0; c < COLS; c++) this.cols[c].shift();
      }
      this._shiftUp();
    }

    _makeRow() {
      const row = [];
      for (let c = 0; c < COLS; c++) {
        const left = row[c - 1];
        if (left >= 6 && this.rng() < PAIR_CHANCE) row.push(TARGET - left);
        else row.push(this.randNum());
      }
      return row;
    }

    /** 상대의 공격: 풍선 k개가 무작위 열의 맨 아래에서 올라온다 */
    addBalloons(k) {
      const order = [...Array(COLS).keys()];
      for (let i = order.length - 1; i > 0; i--) {
        const j = Math.floor(this.rng() * (i + 1));
        [order[i], order[j]] = [order[j], order[i]];
      }
      for (let i = 0; i < k; i++) this._insertBottom(order[i % COLS], makeCell(this.randNum(), true));
    }

    /** 합이 10이 되는 사각형이 하나라도 있는지 */
    hasMove() {
      for (let c0 = 0; c0 < COLS; c0++) {
        for (let r0 = 0; r0 < ROWS; r0++) {
          for (let c1 = c0; c1 < COLS; c1++) {
            for (let r1 = r0; r1 < ROWS; r1++) {
              const sel = this._cellsIn({ c0, c1, r0, r1 });
              const s = sel.reduce((acc, x) => acc + x.cell.n, 0);
              if (s === TARGET && sel.length) return true;
              if (s > TARGET) break; // 위로 더 넓히면 합은 줄지 않는다
            }
          }
        }
      }
      return false;
    }

    /** 테스트용: 아래→위 순서의 숫자 배열(열 단위)로 보드를 직접 구성. 'b5' = 숫자 5 풍선 */
    static fromColumns(columns, opts = {}) {
      const b = new Board({ ...opts, startRows: 0 });
      b.cols = Array.from({ length: COLS }, (_, c) =>
        (columns[c] || []).map((v) =>
          typeof v === 'string' && v[0] === 'b' ? makeCell(Number(v.slice(1)), true) : makeCell(v)
        )
      );
      b.cursor = { c: 0, r: 0 };
      b.anchor = null;
      return b;
    }
  }

  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  return { Board, COLS, ROWS, TARGET, WEIGHTS };
});

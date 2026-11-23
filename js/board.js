/*
 * 풍선 숫자 대전 - 보드 로직 (화면과 분리된 순수 로직)
 *
 * 좌표계: c = 열(0~COLS-1, 왼쪽→오른쪽), r = 행(0 = 맨 아래, 위로 갈수록 증가)
 * 각 열은 아래부터 쌓이는 스택이므로, 칸이 지워지면 위 칸이 자동으로 내려온다.
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

  let nextId = 1;
  const makeCell = (n, balloon = false) => ({ id: nextId++, n, balloon });

  class Board {
    constructor({ rng = Math.random, startRows = 5 } = {}) {
      this.rng = rng;
      this.cols = Array.from({ length: COLS }, () => []);
      this.cursor = { c: Math.floor(COLS / 2) - 1, r: 0 };
      this.chain = [];
      for (let i = 0; i < startRows; i++) this.pushRow();
      this.cursor.r = Math.max(0, startRows - 1);
    }

    randNum() {
      return 1 + Math.floor(this.rng() * 9);
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

    get sum() {
      return this.chain.reduce((s, cell) => s + cell.n, 0);
    }

    _insertBottom(c, cell) {
      this.cols[c].unshift(cell);
      // 커서가 같은 칸을 계속 가리키도록 한 칸 위로 따라 올라간다
      if (this.cursor.c === c) this.cursor.r = Math.min(this.cursor.r + 1, ROWS - 1);
    }

    /** 맨 아래에 새 숫자 줄이 올라온다 */
    pushRow() {
      for (let c = 0; c < COLS; c++) this._insertBottom(c, makeCell(this.randNum()));
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

    /** 고르기 버튼: 체인 시작 / 진행 중이면 취소 */
    pick() {
      if (this.chain.length) {
        this.chain = [];
        return { type: 'cancel' };
      }
      const target = this.cellAt(this.cursor.c, this.cursor.r);
      if (!target) return { type: 'invalid', reason: 'empty' };
      if (target.balloon) return { type: 'invalid', reason: 'balloon' };
      this.chain = [target];
      return { type: 'start', sum: this.sum };
    }

    /** 커서 이동. 체인 진행 중이면 지나간 칸이 체인에 이어지고, 되돌아가면 취소된다 */
    moveCursor(dc, dr) {
      const from = this.chain.length ? this.posOf(this.chain[this.chain.length - 1]) : this.cursor;
      const nc = from.c + dc;
      const nr = from.r + dr;
      if (nc < 0 || nc >= COLS || nr < 0 || nr >= ROWS) return { type: 'blocked' };

      if (!this.chain.length) {
        this.cursor = { c: nc, r: nr };
        return { type: 'move' };
      }

      const target = this.cellAt(nc, nr);
      const prev = this.chain[this.chain.length - 2];
      if (target && target === prev) {
        this.chain.pop();
        this.cursor = { c: nc, r: nr };
        return { type: 'undo', sum: this.sum };
      }
      if (!target || target.balloon || this.chain.includes(target)) return { type: 'blocked' };

      this.chain.push(target);
      this.cursor = { c: nc, r: nr };
      return this._evaluate();
    }

    _evaluate() {
      const s = this.sum;
      if (s === TARGET) return this._clear();
      if (s > TARGET) {
        const cells = this.chain.map((cell) => this.posOf(cell));
        this.chain = [];
        return { type: 'over', sum: s, cells };
      }
      return { type: 'extend', sum: s };
    }

    _clear() {
      const removed = new Set(this.chain);
      const cells = this.chain.map((cell) => ({ ...this.posOf(cell), n: cell.n }));

      // 지워진 칸 옆의 풍선은 터지면서 일반 숫자로 바뀐다
      const popped = [];
      for (const p of cells) {
        for (const [dc, dr] of DIRS) {
          const nb = this.cellAt(p.c + dc, p.r + dr);
          if (nb && nb.balloon && !removed.has(nb)) {
            nb.balloon = false;
            nb.n = this.randNum();
            popped.push(this.posOf(nb));
          }
        }
      }

      for (let c = 0; c < COLS; c++) this.cols[c] = this.cols[c].filter((cell) => !removed.has(cell));
      this.chain = [];
      const col = this.cols[this.cursor.c];
      this.cursor.r = Math.min(this.cursor.r, Math.max(0, col.length - 1));
      return { type: 'clear', count: cells.length, cells, popped };
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
      return b;
    }
  }

  return { Board, COLS, ROWS, TARGET };
});

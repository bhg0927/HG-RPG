// 실행: node --test  (또는 npm test)
const test = require('node:test');
const assert = require('node:assert/strict');
const { Board, COLS, ROWS } = require('../js/board.js');

test('새 보드는 시작 줄 수만큼 채워진다', () => {
  const b = new Board({ startRows: 5 });
  assert.equal(b.cols.length, COLS);
  b.cols.forEach((col) => assert.equal(col.length, 5));
  assert.equal(b.lost, false);
});

test('이웃한 두 칸의 합이 10이면 지워지고 위 칸이 내려온다', () => {
  const b = Board.fromColumns([[3, 9], [7]]);
  assert.equal(b.pick().type, 'start');
  const ev = b.moveCursor(1, 0);
  assert.equal(ev.type, 'clear');
  assert.equal(ev.count, 2);
  assert.deepEqual(b.cols[0].map((x) => x.n), [9]); // 9가 맨 아래로 떨어짐
  assert.equal(b.cols[1].length, 0);
});

test('합이 10을 넘으면 체인이 취소된다', () => {
  const b = Board.fromColumns([[6], [5]]);
  b.pick();
  const ev = b.moveCursor(1, 0);
  assert.equal(ev.type, 'over');
  assert.equal(b.chain.length, 0);
  assert.equal(b.cols[0].length, 1);
});

test('되돌아가면 마지막 칸이 체인에서 빠진다', () => {
  const b = Board.fromColumns([[1], [2], [3]]);
  b.pick();
  b.moveCursor(1, 0);
  assert.equal(b.sum, 3);
  assert.equal(b.moveCursor(-1, 0).type, 'undo');
  assert.equal(b.sum, 1);
});

test('세 칸 이상 연결해서 10 만들기', () => {
  const b = Board.fromColumns([[2, 5], [3]]);
  b.pick(); // (0,0)=2
  b.moveCursor(1, 0); // 3
  assert.equal(b.moveCursor(0, 1).type, 'blocked'); // (1,1) 비어 있음
  b.moveCursor(-1, 0); // undo → 2
  b.moveCursor(0, 1); // 5 → 합 7
  assert.equal(b.sum, 7);
});

test('풍선은 고를 수 없고, 옆 칸이 지워지면 일반 숫자가 된다', () => {
  const b = Board.fromColumns([[4, 'b5'], [6]]);
  b.cursor = { c: 0, r: 1 };
  assert.equal(b.pick().type, 'invalid');
  b.cursor = { c: 0, r: 0 };
  b.pick();
  const ev = b.moveCursor(1, 0);
  assert.equal(ev.type, 'clear');
  assert.equal(ev.popped.length, 1);
  assert.equal(b.cols[0][0].balloon, false);
});

test('풍선 공격과 새 줄은 아래에서 올라오고, 천장을 넘으면 패배', () => {
  const b = new Board({ startRows: ROWS });
  assert.equal(b.lost, false);
  b.addBalloons(1);
  assert.equal(b.lost, true);
});

test('줄이 올라와도 체인과 커서는 같은 칸을 따라간다', () => {
  const b = Board.fromColumns([[1, 2], [3, 4]]);
  b.pick(); // 1
  b.pushRow();
  assert.deepEqual(b.cursor, { c: 0, r: 1 });
  const ev = b.moveCursor(0, 1); // 1 + 2
  assert.equal(ev.type, 'extend');
  assert.equal(b.sum, 3);
});

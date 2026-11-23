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

test('사각형 안의 합이 10이면 손을 뗄 때 지워지고 위 칸이 내려온다', () => {
  const b = Board.fromColumns([[3, 9], [7]]);
  b.startSelect(0, 0);
  assert.equal(b.setCursor(1, 0).sum, 10);
  const ev = b.confirm();
  assert.equal(ev.type, 'clear');
  assert.equal(ev.count, 2);
  assert.deepEqual(b.cols[0].map((x) => x.n), [9]);
  assert.equal(b.cols[1].length, 0);
});

test('떨어져 있는 칸도 사각형으로 한 번에 고를 수 있다 (빈 칸은 무시)', () => {
  // 열0: [1,2], 열1: [3], 열2: [4]  → (0,0)~(2,1) 사각형 = 1+2+3+4 = 10, (1,1)(2,1)은 빈 칸
  const b = Board.fromColumns([[1, 2], [3], [4]]);
  b.startSelect(2, 1);
  b.setCursor(0, 0);
  assert.equal(b.sum, 10);
  assert.equal(b.confirm().count, 4);
});

test('합이 10을 넘거나 모자라면 지워지지 않는다', () => {
  const b = Board.fromColumns([[6], [5], [1]]);
  b.startSelect(0, 0);
  b.setCursor(1, 0);
  assert.equal(b.confirm().type, 'over');
  b.startSelect(1, 0);
  b.setCursor(2, 0);
  assert.equal(b.confirm().type, 'cancel');
  assert.equal(b.selecting, false);
  assert.equal(b.cols.flat().length, 3);
});

test('키보드: 고르기 → 이동 → 고르기로 확정', () => {
  const b = Board.fromColumns([[2, 8]]);
  b.cursor = { c: 0, r: 0 };
  assert.equal(b.pick().type, 'start');
  b.moveCursor(0, 1);
  assert.equal(b.pick().type, 'clear');
});

test('풍선은 합에 들어가지 않고, 옆 칸이 지워지면 일반 숫자가 된다', () => {
  const b = Board.fromColumns([[4, 'b5'], [6]]);
  b.startSelect(0, 1);
  b.setCursor(1, 0);
  assert.equal(b.sum, 10); // 4 + 6, 풍선 5는 제외
  const ev = b.confirm();
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

test('줄이 올라오면 선택 사각형도 같이 한 줄 올라간다', () => {
  const b = Board.fromColumns([[1, 2], [3, 4]]);
  b.startSelect(0, 0);
  b.setCursor(1, 0);
  assert.equal(b.sum, 4);
  b.pushRow();
  assert.deepEqual(b.anchor, { c: 0, r: 1 });
  assert.equal(b.sum, 4);
});

test('작은 숫자가 더 자주 나온다 (7·8·9 비율 25% 미만)', () => {
  let seed = 42;
  const rng = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const b = new Board({ rng, startRows: 0 });
  let big = 0;
  const N = 20000;
  for (let i = 0; i < N; i++) if (b.randNum() >= 7) big++;
  assert.ok(big / N < 0.25, `7·8·9 비율 ${(big / N).toFixed(3)}`);
});

test('새로 만든 보드에는 항상 지울 수 있는 조합이 있다', () => {
  for (let i = 0; i < 200; i++) assert.ok(new Board({ startRows: 5 }).hasMove());
});

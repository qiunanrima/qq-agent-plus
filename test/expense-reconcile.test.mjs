import assert from 'node:assert/strict';
import test from 'node:test';
import { expenseCsv, reconcileExpenses } from '../src/tools/expense-reconcile.js';

test('expense reconciliation sums exact cents and isolates conflicts and missing evidence', () => {
  const result = reconcileExpenses([
    { receiptId: 'A', amount: '0.10', source: 'mail' },
    { receiptId: 'A', amount: '0.1', source: 'workspace' },
    { receiptId: 'B', amount: '0.2', source: 'workspace' },
    { receiptId: 'C', amount: '20', source: 'mail' },
    { receiptId: 'C', amount: '21', source: 'workspace' },
    { amount: '5', source: 'unidentified' },
    { receiptId: 'D', amount: '12.345', source: 'invalid' }
  ]);
  assert.equal(result.total, '0.30');
  assert.deepEqual(result.receipts[0].sources, ['mail', 'workspace']);
  assert.deepEqual(result.review.map(row => row.issue).sort(),
    ['conflicting_amounts', 'invalid_amount', 'missing_receipt_id']);
});

test('CSV includes the audited total and treats spreadsheet formulas as literal text', () => {
  const csv = expenseCsv(reconcileExpenses([
    { receiptId: '=1+1', amount: '12.34', source: 'receipt,"A"' },
    { source: 'needs review' }
  ]));
  assert.ok(csv.startsWith('\uFEFF'));
  assert.ok(csv.includes('"\'=1+1","12.34","receipt,""A"""'));
  assert.ok(csv.includes('"待复核"'));
  assert.ok(csv.includes('"合计","","12.34"'));
});

test('company CSV export preserves provided header order and leaves unmapped columns empty', () => {
  const result = reconcileExpenses([
    { receiptId: 'A', amount: '12.34', source: 'invoice.pdf' },
    { source: 'unverified' }
  ]);
  assert.equal(expenseCsv(result, [
    { header: '金额', field: 'amount' },
    { header: '部门', field: 'blank' },
    { header: '单号', field: 'receiptId' }
  ]), '\uFEFF"金额","部门","单号"\r\n"12.34","","A"\r\n');
  assert.equal(expenseCsv(result, [{ header: '未知', field: 'unknown' }]), null);
});

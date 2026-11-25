function cents(value) {
  if (typeof value !== 'string' || !/^\d{1,9}(?:\.\d{1,2})?$/.test(value)) return null;
  const [whole, decimal = ''] = value.split('.');
  return Number(whole) * 100 + Number(decimal.padEnd(2, '0'));
}

const amount = value => (value / 100).toFixed(2);

export function reconcileExpenses(entries) {
  if (!Array.isArray(entries) || entries.length > 100) return { error: '最多核对 100 条票据' };
  const groups = new Map();
  const review = [];
  for (const entry of entries) {
    const source = typeof entry?.source === 'string' ? entry.source.trim() : '';
    const id = typeof entry?.receiptId === 'string' ? entry.receiptId.trim() : '';
    const value = cents(entry?.amount);
    if (!source || !id || value === null) {
      review.push({ source: source.slice(0, 320), issue: !source ? 'missing_source' : !id ? 'missing_receipt_id' : 'invalid_amount' });
      continue;
    }
    const records = groups.get(id) ?? [];
    records.push({ source: source.slice(0, 320), value });
    groups.set(id, records);
  }
  const receipts = [];
  let total = 0;
  for (const [receiptId, records] of groups) {
    const values = [...new Set(records.map(row => row.value))];
    const sources = [...new Set(records.map(row => row.source))];
    if (values.length > 1) {
      review.push({ receiptId, sources, amounts: values.map(amount), issue: 'conflicting_amounts' });
      continue;
    }
    total += values[0];
    receipts.push({ receiptId, amount: amount(values[0]), sources });
  }
  return { currency: 'CNY', total: amount(total), receipts, review };
}

export function expenseCsv(result) {
  const issues = {
    missing_source: '缺少来源',
    missing_receipt_id: '缺少票据编号',
    invalid_amount: '金额缺失或格式不正确',
    conflicting_amounts: '金额冲突'
  };
  const rows = [
    ['状态', '票据编号', '金额（CNY）', '来源', '说明'],
    ...result.receipts.map(row => ['已核对', row.receiptId, row.amount, row.sources.join(' | '), '']),
    ...result.review.map(row => [
      '待复核', row.receiptId ?? '', '', row.sources?.join(' | ') ?? row.source ?? '',
      [issues[row.issue], ...(row.amounts ?? [])].join(' ')
    ]),
    ['合计', '', result.total, '', '仅含已核对票据']
  ];
  const cell = value => {
    const text = String(value).replace(/[\r\n\t\u0000-\u001f]/gu, ' ');
    const literal = /^\s*[=+\-@]/u.test(text) ? "'" + text : text;
    return '"' + literal.replaceAll('"', '""') + '"';
  };
  return '\uFEFF' + rows.map(row => row.map(cell).join(',')).join('\r\n') + '\r\n';
}

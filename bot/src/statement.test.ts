import { test } from 'node:test';
import assert from 'node:assert/strict';
import { csvRows, statementRows, statementWindow, cellsToRows } from './statement';

test('table read off the page becomes header + rows', async () => {
  const rows = await statementRows({ payments_table: JSON.stringify([{ 'Claim No': 'C1', 'Net Paid': '1,000' }, { 'Claim No': '', 'Net Paid': '' }]) });
  assert.deepEqual(rows, [['Claim No', 'Net Paid'], ['C1', '1,000']]);
});

test('downloaded CSV is read, quotes and all', async () => {
  const csv = 'Claim No,Patient,Net Paid\r\nC1,"Shah, A",900\r\n';
  const rows = await statementRows({ payments_file_buffer: Buffer.from(csv).toString('base64'), payments_file_filename: 'r.csv' });
  assert.deepEqual(rows, [['Claim No', 'Patient', 'Net Paid'], ['C1', 'Shah, A', '900']]);
  assert.deepEqual(csvRows('a,b\n\n1,2'), [['a', 'b'], ['1', '2']]);
});

test('long case IDs keep every digit; dates become YYYY-MM-DD', () => {
  assert.deepEqual(cellsToRows([[2026050410019520, new Date(Date.UTC(2026, 9, 26)), null]]), [['2026050410019520', '2026-10-26', '']]);
});

test('date window is day-first', () => {
  assert.deepEqual(statementWindow(new Date(2026, 9, 28), 14), { from_date: '14/10/2026', to_date: '28/10/2026' });
});

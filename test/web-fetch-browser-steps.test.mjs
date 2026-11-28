import assert from 'node:assert/strict';
import test from 'node:test';
import { validateBrowserSteps } from '../src/web-fetch-browser/browser-steps.js';

test('browser plans validate every step before navigation', () => {
  const fill = { action: 'fill', role: 'searchbox', name: 'Query', value: 'example' };
  const submit = { action: 'enter', role: 'searchbox', name: 'Query' };
  validateBrowserSteps([]);
  validateBrowserSteps([fill, submit]);
  for (const invalid of [null, {}, [fill, null], [fill, { ...submit, action: 'run' }],
    [{ ...fill, value: 4 }], [{ ...fill, role: 'button' }], Array(9).fill(fill)]) {
    assert.throws(() => validateBrowserSteps(invalid));
  }
});

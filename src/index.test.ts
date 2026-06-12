import { expect, test } from 'vitest';

import { CHECKRIDE } from './index.js';

test('exposes the package identity', () => {
  expect(CHECKRIDE).toBe('checkride');
});

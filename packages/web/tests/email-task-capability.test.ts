import assert from 'node:assert/strict';
import test from 'node:test';

import { getEmailTaskCapability } from '../src/lib/email-task-capability';

test('email task capability has stable shape', () => {
  const capability = getEmailTaskCapability();
  assert.equal(typeof capability.canAutoSend, 'boolean');
  assert.equal(typeof capability.reason, 'string');
  if (capability.canAutoSend) {
    assert.equal(capability.reason, 'server');
  }
});

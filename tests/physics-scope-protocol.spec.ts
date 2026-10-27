import { expect, test } from '@playwright/test';
import { physicsScopeProtocolCases } from './physicsScopeProtocolCases';

test('fixture empirical cap and exact rotational budget have independent arithmetic controls', () => {
  const result = physicsScopeProtocolCases();
  console.log('PHYSICS_SCOPE_PROTOCOL_CONTROLS ' + JSON.stringify(result));
  expect(result.problems).toEqual([]);
  expect(result.checks).toBeGreaterThan(0);
});

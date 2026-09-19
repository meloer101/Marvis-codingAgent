import test from 'node:test';
import assert from 'node:assert/strict';

import { toCelsius, toFahrenheit } from '../src/temperature.js';

test('toCelsius converts the freezing and boiling points', () => {
  assert.equal(toCelsius(32), 0);
  assert.equal(toCelsius(212), 100);
});

test('toFahrenheit converts the freezing and boiling points', () => {
  assert.equal(toFahrenheit(0), 32);
  assert.equal(toFahrenheit(100), 212);
});

test('the two conversions round-trip', () => {
  for (const f of [-40, 68, 98.6]) {
    assert.equal(toFahrenheit(toCelsius(f)), f);
  }
});

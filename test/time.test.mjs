import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { etDayKey, isSameETDay, formatET, ageMinutes } from '../src/time.mjs';

describe('etDayKey', () => {
  it('uses the ET calendar day, not UTC', () => {
    // 2025-01-15 00:30 UTC is still Jan 14 in ET (EST, UTC-5)
    assert.equal(etDayKey(new Date('2025-01-15T00:30:00Z')), '2025-1-14');
    // 2025-07-15 03:30 UTC is still Jul 14 in ET (EDT, UTC-4)
    assert.equal(etDayKey(new Date('2025-07-15T03:30:00Z')), '2025-7-14');
  });

  it('handles the spring-forward DST transition', () => {
    // 2025-03-09 06:30 UTC = 01:30 EST, 2025-03-09 07:30 UTC = 03:30 EDT
    assert.equal(etDayKey(new Date('2025-03-09T06:30:00Z')), '2025-3-9');
    assert.equal(etDayKey(new Date('2025-03-09T07:30:00Z')), '2025-3-9');
  });
});

describe('isSameETDay', () => {
  it('compares ET days across a UTC midnight boundary', () => {
    const a = new Date('2025-01-15T00:30:00Z'); // Jan 14 ET
    const b = new Date('2025-01-15T04:00:00Z'); // Jan 14 23:00 EST
    const c = new Date('2025-01-15T06:00:00Z'); // Jan 15 01:00 EST
    assert.ok(isSameETDay(a, b));
    assert.ok(!isSameETDay(a, c));
  });
});

describe('formatET', () => {
  it('renders a readable ET timestamp', () => {
    const s = formatET(new Date('2025-01-15T17:00:00Z'));
    assert.match(s, /1\/15\/25/);
    assert.match(s, /EST|EDT/);
  });
});

describe('ageMinutes', () => {
  it('rounds elapsed minutes', () => {
    assert.equal(ageMinutes(Date.now() - 90_000, Date.now()), 2);
  });
});

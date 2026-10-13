// The paging param feeds a raw SQL OFFSET, so it floors to whole rows and refuses negatives; these pin that.
import { describe, expect, test } from 'vitest';

import { offsetFrom } from '../../cli/dashboard.ts';

const url = (query: string): string => `/api/agent?range=24h&view=requests&${query}`;

describe('agent offset param', () => {
  test('an absent or empty param reads as the newest rows', () => {
    expect(offsetFrom('/api/agent')).toBe(0);
    expect(offsetFrom('/api/agent?')).toBe(0);
    expect(offsetFrom(url('offset='))).toBe(0);
  });

  test('a whole number passes through and a negative one floors to zero', () => {
    expect(offsetFrom(url('offset=0'))).toBe(0);
    expect(offsetFrom(url('offset=400'))).toBe(400);
    // An OFFSET below zero is an error in SQL, so it reads as the newest rows instead.
    expect(offsetFrom(url('offset=-5'))).toBe(0);
    expect(offsetFrom(url('offset=-0.5'))).toBe(0);
  });

  test('a fraction floors to whole rows rather than rounding past them', () => {
    expect(offsetFrom(url('offset=3.7'))).toBe(3);
    expect(offsetFrom(url('offset=203.9'))).toBe(203);
  });

  test('a non-numeric value reads as the newest rows, not as a crash', () => {
    expect(offsetFrom(url('offset=abc'))).toBe(0);
    expect(offsetFrom(url('offset=1e5x'))).toBe(0);
    expect(offsetFrom(url('offset='))).toBe(0);
  });

  test('a value in a later param position is still read', () => {
    expect(offsetFrom(url('offset=250&view=requests'))).toBe(250);
  });
});

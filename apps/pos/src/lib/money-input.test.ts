import { describe, expect, it } from 'vitest'
import { inputToMinor, minorToInput } from './money-input.ts'

describe('minorToInput', () => {
  it('inserts the decimal point for 2-digit currencies', () => {
    expect(minorToInput('1250')).toBe('12.50')
    expect(minorToInput('5')).toBe('0.05')
    expect(minorToInput('0')).toBe('0.00')
    expect(minorToInput('100')).toBe('1.00')
  })

  it('passes through 0-digit currencies (IDR)', () => {
    expect(minorToInput('1250', 0)).toBe('1250')
  })

  it('keeps the sign for negative deltas', () => {
    expect(minorToInput('-250')).toBe('-2.50')
  })
})

describe('inputToMinor', () => {
  it('parses major strings to minor units', () => {
    expect(inputToMinor('12.50')).toBe('1250')
    expect(inputToMinor('12')).toBe('1200')
    expect(inputToMinor('0.05')).toBe('5')
    expect(inputToMinor('1.5')).toBe('150')
  })

  it('handles 0-digit currencies', () => {
    expect(inputToMinor('1250', 0)).toBe('1250')
    expect(inputToMinor('12.5', 0)).toBeNull()
  })

  it('rejects too many fractional digits rather than truncating', () => {
    expect(inputToMinor('12.505')).toBeNull()
  })

  it('rejects non-numeric input', () => {
    expect(inputToMinor('')).toBeNull()
    expect(inputToMinor('abc')).toBeNull()
    expect(inputToMinor('1,50')).toBeNull()
  })

  it('normalizes negative zero to plain zero', () => {
    expect(inputToMinor('-0.00')).toBe('0')
  })

  it('round-trips with minorToInput', () => {
    for (const minor of ['0', '5', '1250', '99999']) {
      expect(inputToMinor(minorToInput(minor))).toBe(minor)
    }
  })
})

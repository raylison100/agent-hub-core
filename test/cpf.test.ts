import { describe, expect, it } from 'vitest'
import { isValidCpf, normalizeCpf } from '../src/util/cpf.js'

describe('isValidCpf', () => {
  it('aceita CPF com mascara', () => {
    expect(isValidCpf('529.982.247-25')).toBe(true)
    expect(isValidCpf('111.444.777-35')).toBe(true)
    expect(isValidCpf('123.456.789-09')).toBe(true)
  })

  it('aceita CPF apenas com digitos e espacos nas bordas', () => {
    expect(isValidCpf('52998224725')).toBe(true)
    expect(isValidCpf('  11144477735  ')).toBe(true)
  })

  it('recusa digitos verificadores errados', () => {
    expect(isValidCpf('529.982.247-24')).toBe(false)
    expect(isValidCpf('52998224720')).toBe(false)
  })

  it('recusa sequencias repetidas', () => {
    expect(isValidCpf('111.111.111-11')).toBe(false)
    expect(isValidCpf('00000000000')).toBe(false)
  })

  it('recusa formato invalido', () => {
    expect(isValidCpf('123.456.789')).toBe(false)
    expect(isValidCpf('123.456.789-0')).toBe(false)
    expect(isValidCpf('529982247251')).toBe(false)
    expect(isValidCpf('529.982.247/25')).toBe(false)
    expect(isValidCpf('5299822472a')).toBe(false)
    expect(isValidCpf('')).toBe(false)
    expect(isValidCpf('   ')).toBe(false)
  })

  it('recusa valores que nao sao string', () => {
    expect(isValidCpf(52998224725)).toBe(false)
    expect(isValidCpf(null)).toBe(false)
    expect(isValidCpf(undefined)).toBe(false)
    expect(isValidCpf({})).toBe(false)
  })
})

describe('normalizeCpf', () => {
  it('remove caracteres nao numericos', () => {
    expect(normalizeCpf('529.982.247-25')).toBe('52998224725')
  })
})

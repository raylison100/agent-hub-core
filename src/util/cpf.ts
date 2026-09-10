const CPF_FORMAT = /^(?:\d{3}\.\d{3}\.\d{3}-\d{2}|\d{11})$/

function checkDigit(digits: string, length: number): number {
  let sum = 0
  for (let i = 0; i < length; i++) {
    sum += Number(digits[i]) * (length + 1 - i)
  }
  const rest = (sum * 10) % 11
  return rest === 10 ? 0 : rest
}

export function normalizeCpf(value: string): string {
  return value.replace(/\D/g, '')
}

export function isValidCpf(value: unknown): boolean {
  if (typeof value !== 'string') return false
  const candidate = value.trim()
  if (!CPF_FORMAT.test(candidate)) return false
  const digits = normalizeCpf(candidate)
  if (/^(\d)\1{10}$/.test(digits)) return false
  return (
    checkDigit(digits, 9) === Number(digits[9]) && checkDigit(digits, 10) === Number(digits[10])
  )
}

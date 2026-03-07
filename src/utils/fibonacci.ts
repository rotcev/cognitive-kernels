/**
 * Memoized Fibonacci implementation.
 *
 * @param n - Non-negative integer index in the Fibonacci sequence.
 * @returns The nth Fibonacci number (0-indexed: fibonacci(0) = 0, fibonacci(1) = 1).
 * @throws {RangeError} If n is negative.
 */

const memo = new Map<number, number>();

export function fibonacci(n: number): number {
  if (n < 0) {
    throw new RangeError(`fibonacci: n must be non-negative, got ${n}`);
  }
  if (n === 0) return 0;
  if (n === 1) return 1;

  const cached = memo.get(n);
  if (cached !== undefined) return cached;

  const result = fibonacci(n - 1) + fibonacci(n - 2);
  memo.set(n, result);
  return result;
}

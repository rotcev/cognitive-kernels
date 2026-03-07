import { describe, it, expect } from "vitest";
import { fibonacci } from "../../src/utils/fibonacci";

describe("fibonacci", () => {
  describe("base cases", () => {
    it("fibonacci(0) === 0", () => {
      expect(fibonacci(0)).toBe(0);
    });

    it("fibonacci(1) === 1", () => {
      expect(fibonacci(1)).toBe(1);
    });

    it("fibonacci(2) === 1", () => {
      expect(fibonacci(2)).toBe(1);
    });
  });

  describe("mid-range values", () => {
    it("fibonacci(5) === 5", () => {
      expect(fibonacci(5)).toBe(5);
    });

    it("fibonacci(10) === 55", () => {
      expect(fibonacci(10)).toBe(55);
    });
  });

  describe("large values", () => {
    it("fibonacci(20) === 6765", () => {
      expect(fibonacci(20)).toBe(6765);
    });

    it("fibonacci(30) === 832040", () => {
      expect(fibonacci(30)).toBe(832040);
    });
  });

  describe("memoization", () => {
    it("returns the same value on repeated calls (cache does not corrupt)", () => {
      const first = fibonacci(35);
      const second = fibonacci(35);
      expect(first).toBe(second);
      // Sanity check: known value for fibonacci(35)
      expect(first).toBe(9227465);
    });
  });

  describe("edge cases", () => {
    it("throws RangeError for negative input", () => {
      expect(() => fibonacci(-1)).toThrow(RangeError);
      expect(() => fibonacci(-1)).toThrow(
        "fibonacci: n must be non-negative, got -1"
      );
    });
  });
});

import { describe, expect, it } from "vitest";
import { formatClock, formatElapsed } from "../formatElapsed";

describe("formatElapsed", () => {
  it("formats sub-second and second ranges with one decimal place", () => {
    expect(formatElapsed(0)).toBe("0.0s");
    expect(formatElapsed(420)).toBe("0.4s");
    expect(formatElapsed(999)).toBe("1.0s");
    expect(formatElapsed(3_240)).toBe("3.2s");
    expect(formatElapsed(59_999)).toBe("60.0s");
  });

  it("formats minute ranges without counting into the next minute early", () => {
    expect(formatElapsed(60_000)).toBe("1m 0s");
    expect(formatElapsed(72_400)).toBe("1m 12s");
    expect(formatElapsed(3_599_999)).toBe("59m 59s");
  });

  it("formats hour ranges with padded minutes", () => {
    expect(formatElapsed(3_600_000)).toBe("1h 00m");
    expect(formatElapsed(3_780_000)).toBe("1h 03m");
    expect(formatElapsed(7_260_000)).toBe("2h 01m");
  });

  it("clamps negative durations to zero", () => {
    expect(formatElapsed(-100)).toBe("0.0s");
  });
});

describe("formatClock", () => {
  it("zero-pads midnight", () => {
    expect(formatClock(new Date(2026, 0, 1, 0, 0, 0))).toBe("00:00:00");
  });

  it("zero-pads single-digit hour, minute, and second", () => {
    expect(formatClock(new Date(2026, 0, 1, 4, 5, 6))).toBe("04:05:06");
  });

  it("formats the end of day", () => {
    expect(formatClock(new Date(2026, 0, 1, 23, 59, 59))).toBe("23:59:59");
  });
});

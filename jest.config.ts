import type { Config } from "jest";
import nextJest from "next/jest.js";

const createJestConfig = nextJest({ dir: "./" });

const config: Config = {
  coverageProvider: "v8",
  // 計測対象はロジック層（src/lib）のモジュール単位。純粋関数と外部 I/O が
  // 同居するモジュールも丸ごと含める（閾値は設けない。docs/testing/policy.md §5）
  collectCoverageFrom: ["src/lib/**/*.ts"],
  testEnvironment: "jsdom",
  setupFilesAfterEnv: ["<rootDir>/jest.setup.ts"],
  testMatch: ["<rootDir>/tests/**/*.test.ts", "<rootDir>/src/**/*.test.ts"],
  moduleNameMapper: {
    "^@/(.*)$": "<rootDir>/src/$1",
  },
};

export default createJestConfig(config);

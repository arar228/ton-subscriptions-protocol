import type { Config } from 'jest'

const config: Config = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    testPathIgnorePatterns: ['/node_modules/', '/dist/', '/build/'],
    testMatch: ['**/tests/**/*.spec.ts'],
    testTimeout: 30000,
}

export default config

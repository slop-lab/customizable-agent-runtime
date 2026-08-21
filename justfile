set dotenv-load := false

default:
    @just --list

install:
    pnpm install --frozen-lockfile

check:
    pnpm check

test:
    pnpm test

build:
    pnpm build

verify: check test build

test-live-google: build
    CAR_PROVIDER=google-ai-studio node scripts/google-live-smoke.mjs

chat *args: build
    CAR_PROVIDER=openrouter node scripts/agent-chat.mjs {{args}}

usage *args: build
    node scripts/usage.mjs {{args}}

dev:
    pnpm dev

start:
    pnpm start

clean:
    pnpm clean

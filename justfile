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

dev:
    pnpm dev

start:
    pnpm start

clean:
    pnpm clean

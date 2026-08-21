FROM docker:29.1.3-cli

RUN apk add --no-cache bash curl git jq just nodejs npm tini \
  && npm install --global pnpm@10.13.1 @openai/codex

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["sleep", "infinity"]

#!/usr/bin/env sh
set -eu

git_name="${DIM_GIT_USER_NAME:-$(git config --get user.name || true)}"
git_email="${DIM_GIT_USER_EMAIL:-$(git config --get user.email || true)}"
if [ -z "$git_name" ] || [ -z "$git_email" ]; then
  echo "DIM did not provide a Git author identity" >&2
  exit 2
fi
export GIT_AUTHOR_NAME="$git_name" GIT_COMMITTER_NAME="$git_name"
export GIT_AUTHOR_EMAIL="$git_email" GIT_COMMITTER_EMAIL="$git_email"

compose_project="dim-${DIM_WORKSPACE_NAME}"
docker compose --project-name "$compose_project" \
  --file .dim/docker-compose.yml build --quiet agent agent-dind
# An outer workspace stop terminates nested containers without preserving a
# restartable process state. Recreate services while retaining named volumes.
docker compose --project-name "$compose_project" \
  --file .dim/docker-compose.yml up --detach --force-recreate agent-dind agent

# Named volumes are initialized as root. Project tasks run as the workspace
# user's numeric UID/GID, so make the persistent agent home writable before
# pnpm or agent CLIs create state there.
docker compose --project-name "$compose_project" \
  --file .dim/docker-compose.yml exec --no-TTY agent \
  chown -R "$(id -u):$(id -g)" /home/dim-agent

install_flag=""
test ! -f pnpm-lock.yaml || install_flag="--frozen-lockfile"
docker compose --project-name "$compose_project" \
  --file .dim/docker-compose.yml exec --no-TTY \
  --user "$(id -u):$(id -g)" --env HOME=/home/dim-agent \
  --env NPM_CONFIG_STORE_DIR=/home/dim-agent/.pnpm-store agent \
  sh -lc "pnpm install $install_flag"

#!/bin/sh
set -eu

# Nested image stores may discard file capabilities and setuid metadata after
# an outer workspace restart. Restore the shadow-utils fallback before dropping
# to the rootless daemon user.
chown root:root /usr/bin/newuidmap /usr/bin/newgidmap
chmod 4755 /usr/bin/newuidmap /usr/bin/newgidmap

exec su-exec rootless dockerd-entrypoint.sh "$@"

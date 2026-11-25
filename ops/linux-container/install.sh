#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")"
install -d -m 755 /usr/local/lib/qq-agent-linux-container
install -m 644 helper.py egress.nft /usr/local/lib/qq-agent-linux-container/
install -m 644 qq-agent*.service qq-agent*.socket /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now qq-agent-container-egress.service
if ! docker network inspect qq-linux-workspace >/dev/null 2>&1; then
    docker network create --driver bridge --opt com.docker.network.bridge.name=qq-linux-br qq-linux-workspace
fi
test "$(docker network inspect -f '{{index .Options "com.docker.network.bridge.name"}}' qq-linux-workspace)" = qq-linux-br
if ! docker inspect qq-agent-linux-workspace >/dev/null 2>&1; then
    docker create --name qq-agent-linux-workspace --label qq-agent.workspace=1 --network qq-linux-workspace \
        --dns 1.1.1.1 --init --security-opt=no-new-privileges --cap-drop=NET_RAW \
        --cpus=1 --memory=512m --memory-swap=512m --pids-limit=128 \
        --log-driver=local --restart=unless-stopped debian:bookworm-slim sleep infinity
fi
test "$(docker inspect -f '{{index .Config.Labels "qq-agent.workspace"}}' qq-agent-linux-workspace)" = 1
systemctl enable --now qq-agent-linux-container.socket

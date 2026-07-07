#!/usr/bin/env bash
# Install steamcmd on an Ubuntu GitHub Actions runner. Extracted from
# the workflow so the shell logic (multi-line apt commands, arch tweak)
# lives next to other scripts per the Makefile-complexity guideline.
#
# Anonymous PICS access via `steamcmd +login anonymous +app_info_print`
# does not need a Steam account, but it does need the steamcmd package.
# Ubuntu ships it in the 'multiverse' repo, i386 arch.
set -euo pipefail

echo "==> Enabling i386 architecture (steamcmd is 32-bit)"
sudo dpkg --add-architecture i386

echo "==> Enabling multiverse repository"
sudo add-apt-repository multiverse -y

echo "==> apt update"
sudo apt-get update -y

echo "==> Preseeding steamcmd EULA acceptance"
echo steam steam/question select "I AGREE" | sudo debconf-set-selections
echo steam steam/license note '' | sudo debconf-set-selections

echo "==> Installing steamcmd"
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y steamcmd

echo "==> Verifying"
which steamcmd
steamcmd +quit || true

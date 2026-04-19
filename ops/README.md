# Ops

Operational definitions for the non-container runtime.

This repo uses systemd-first local deployment for now. Containers are not the default because browser-profile-bound services need real Chrome/CDP/noVNC/login-state operations.

Subdirectories:

- `systemd/`: unit templates.
- `env/`: non-secret env examples.
- `doctor/`: doctor command notes.
- `smoke/`: smoke-check recipes.

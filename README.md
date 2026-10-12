# CyberLab Control Panel

Local-only control panel for a safe cybersecurity learning lab.

## Safety model

- Binds to `127.0.0.1` only.
- Does not expose an arbitrary shell command endpoint.
- The first lab is OWASP Juice Shop, a deliberately vulnerable training app.
- The container port is published only to `127.0.0.1:3100` by default.
- No host folders are mounted and the container is not privileged.

## Run

```bash
node server.js
```

Open `http://127.0.0.1:4174`.

You can override the panel port with `PORT`, and the Juice Shop port with `LAB_PORT`.

If Docker is unavailable, install Docker Engine using the official distribution instructions, then return to the panel and run the check again.

The panel also exposes a fixed Docker installation action. It never accepts arbitrary shell input; if `sudo` asks for a password, enter it only in the visible local terminal.

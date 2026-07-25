# Persistent local services

Monde's API/MCP service and Vite web application can run under the systemd
user manager instead of a terminal session. The units restart failed
processes and start with the user's `default.target`.

Install or refresh the units:

```bash
scripts/monde-user-services.sh install
```

Common operations:

```bash
scripts/monde-user-services.sh status
scripts/monde-user-services.sh restart
scripts/monde-user-services.sh logs
scripts/monde-user-services.sh stop
scripts/monde-user-services.sh start
```

The installer renders the current repository path into the units, copies them
to the user's systemd configuration, reloads systemd, and enables
`monde-dev.target`. Re-run `install` if the repository moves.

For startup before interactive login, the user must have systemd lingering
enabled:

```bash
loginctl show-user "$USER" -p Linger
```

The default endpoints remain:

```text
API:  http://127.0.0.1:3761
MCP:  http://127.0.0.1:3762/mcp
Web:  http://127.0.0.1:5175
```

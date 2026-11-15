# Security

## Threat model

This project exposes a DSH session to a phone. The access code is equivalent to
control of that DSH session. Treat it like a password.

Do:

- Use it only on your own LAN or your own Tailscale tailnet.
- Keep `config.json`, `sessions.json`, the Aurabot token, chat history and
  diaries out of Git.
- Use a long access code (8+ characters).
- Keep Windows and DSH patched.

Do not:

- Port-forward 8787 to the public internet.
- Share the access code or a `?switch=` URL with anyone.
- Run the gateway on an untrusted shared network.

If you believe the access code leaked, delete
`%USERPROFILE%\.dsh\phone-chat\sessions.json`, change `accessCode` in
`config.json`, and restart the gateway.

## Reporting

Open a GitHub security advisory or contact the maintainer privately. Please do
not open a public issue containing a live access code or token.

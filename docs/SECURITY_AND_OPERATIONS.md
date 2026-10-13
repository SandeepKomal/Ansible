# Security and Operational Guidelines

Ansible can execute tasks with the privileges of the remote user and, when enabled, elevated privileges. Treat playbooks as code that can affect every targeted system.

## Before executing

1. Confirm the inventory contains only intended hosts.
2. Review the playbook and any imported roles or collections.
3. Use a development or staging system first.
4. Run syntax checks and, where supported, check/diff mode.
5. Use `--limit` for a controlled rollout and inspect the output.
6. Use change control for package upgrades, service restarts, and production changes.

## Credential handling

- Do not commit private keys, passwords, cloud access keys, API tokens, vault passwords, or secret output.
- Use SSH keys or an SSH agent for remote connections.
- Use Ansible Vault or an approved external secrets manager for sensitive variables.
- Keep local inventory files with real host details out of version control.
- Rotate credentials immediately if they are accidentally published.
- Avoid logging secrets with `debug` tasks.

## Least privilege

- Avoid `become: true` at play level if only a few tasks need escalation.
- Use narrowly scoped accounts and privileges.
- Be especially careful with shell/command tasks, recursive file permissions, firewall changes, and package upgrades.
- Do not make the Docker socket world-writable. Access to the Docker daemon can effectively grant root-level control of a host.

## Downloads and supply chain

- Prefer official vendor sources and maintained installation channels.
- Review download URLs, version pins, checksums, and signatures.
- Avoid piping remote scripts directly into a shell.
- Revisit pinned versions periodically and upgrade intentionally rather than blindly installing the newest version in production.
- Pin and review third-party Ansible collections and roles.

## Reporting a vulnerability

Please follow [SECURITY.md](../SECURITY.md) for responsible reporting. Do not publish credentials, exploit details, or sensitive infrastructure information in a public issue.

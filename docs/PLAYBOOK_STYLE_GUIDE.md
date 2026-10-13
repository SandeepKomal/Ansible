# Playbook Style Guide

Use this checklist when adding or updating an Ansible playbook in this repository.

## Structure and readability

- Start YAML files with `---`.
- Give every play and task a descriptive name.
- Use two spaces for indentation; do not use tabs.
- Prefer fully qualified collection names such as `ansible.builtin.package`.
- Keep one playbook focused on one job. Compose playbooks with `ansible.builtin.import_playbook` when a documented all-in-one entry point is useful.
- Put changeable values such as tool versions and paths in variables.

## Reliability

- Declare desired state with modules such as `package`, `service`, `file`, `template`, and `copy`.
- Make tasks idempotent so repeated runs do not repeatedly change the host.
- Use `changed_when: false` for read-only `command` tasks.
- Use `creates` or `removes` only when they correctly represent whether a command needs to run.
- Prefer handlers for service reloads/restarts triggered by configuration changes.
- Document distribution/version requirements and architecture constraints.
- Verify versions/checksums/signatures when installing downloaded binaries.

## Security

- Escalate privileges only for tasks that need them.
- Never store production inventory data, private keys, passwords, or tokens in the repository.
- Use Ansible Vault or a supported secret manager for secret variables.
- Treat access to Docker daemon and other privileged sockets as highly sensitive.
- Be careful with `shell`, `command`, recursive permission changes, and package upgrades.

## Validate changes

```bash
ansible-playbook -i inventory/hosts.ini path/to/playbook.yml --syntax-check
ansible-playbook -i inventory/hosts.ini path/to/playbook.yml --check --diff
ansible-lint path/to/playbook.yml
```

Check mode is best-effort; a successful preview is not a substitute for testing on a disposable or staging host.

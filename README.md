<div align="center">

# Ansible Automation Toolkit

**Practical playbooks, installation guides, and infrastructure automation examples for DevOps engineers.**

[![Ansible](https://img.shields.io/badge/Ansible-automation-EE0000?logo=ansible&logoColor=white)](https://www.ansible.com/)
[![Validation](https://github.com/SandeepKomal/Ansible/actions/workflows/ansible-validation.yml/badge.svg)](https://github.com/SandeepKomal/Ansible/actions/workflows/ansible-validation.yml)
[![GitHub stars](https://img.shields.io/github/stars/SandeepKomal/Ansible?style=social)](https://github.com/SandeepKomal/Ansible/stargazers)
[![GitHub forks](https://img.shields.io/github/forks/SandeepKomal/Ansible?style=social)](https://github.com/SandeepKomal/Ansible/network/members)
[![YAML](https://img.shields.io/badge/configuration-YAML-CB171E?logo=yaml&logoColor=white)](https://yaml.org/)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Contributions welcome](https://img.shields.io/badge/contributions-welcome-brightgreen.svg)](CONTRIBUTING.md)

</div>

A hands-on collection of Ansible examples for configuring Linux hosts and installing common DevOps tools. The repository is designed as a learning reference: start with the basics, test safely on a host you control, then adapt the playbooks for your environment.

> **Safety first:** review every playbook before running it. Installation tasks can change packages, services, permissions, and system configuration on target hosts.

## What you’ll find

- **Getting started:** install Ansible, define an inventory, verify SSH connectivity, and run your first playbook.
- **Tool installation playbooks:** examples for Git, Java 17, Docker, AWS CLI, Kustomize, Trivy, and Maven.
- **Reusable automation patterns:** privilege escalation, tags, templates, idempotent tasks, validation, and service management.
- **Operational guidance:** linting, troubleshooting, secrets handling, and contribution instructions.

## Repository map

| Path | Purpose |
| --- | --- |
| [docs/](docs/) | Installation, concepts, security, and troubleshooting guides |
| [playbooks/](playbooks/) | Starter examples and maintained playbooks |
| [inventory/](inventory/) | Safe example inventory; replace placeholders with your own hosts |
| [ansible.cfg](ansible.cfg) | Project-local Ansible defaults |
| [requirements.yml](requirements.yml) | Optional Ansible collection dependencies |
| [yaml files/](yaml%20files/) | Tool-installation examples retained for compatibility |
| [CONTRIBUTING.md](CONTRIBUTING.md) | How to contribute |
| [SECURITY.md](SECURITY.md) | Responsible security reporting |

## Quick start

### 1. Install Ansible on your control node

Use a Python virtual environment to keep project tooling isolated. Follow the official [Ansible installation guide](https://docs.ansible.com/projects/ansible/latest/installation_guide/index.html) for supported methods and platform-specific prerequisites.

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install ansible ansible-lint
ansible --version
```

On Windows, run Ansible from a supported Linux environment such as WSL, or use a dedicated Linux control node. Ansible generally connects to Linux/Unix managed hosts over SSH.

### 2. Configure your inventory

Copy the example and edit it for hosts you own or are authorized to administer:

```bash
cp inventory/hosts.ini.example inventory/hosts.ini
```

Example inventory:

```ini
[web]
web1 ansible_host=192.0.2.10 ansible_user=ubuntu

[all:vars]
ansible_python_interpreter=auto_silent
```

The IP above is documentation-only (TEST-NET); replace it with your reachable host address. Do not commit production addresses, private keys, passwords, or tokens.

### 3. Verify connectivity

```bash
ansible-inventory -i inventory/hosts.ini --graph
ansible all -i inventory/hosts.ini -m ansible.builtin.ping
```

The Ansible ping module checks that Ansible can connect and execute Python on the managed host; it is not an ICMP network ping. Ensure your SSH key/user and security-group or firewall rules allow access.

### 4. Run a playbook safely

Check syntax first, preview planned changes where supported, then run against an explicit host/group:

```bash
ansible-playbook -i inventory/hosts.ini playbooks/hello.yml --syntax-check
ansible-playbook -i inventory/hosts.ini playbooks/hello.yml --check --diff
ansible-playbook -i inventory/hosts.ini playbooks/hello.yml --limit web
```

Check mode is a preview, not a guarantee: modules that do not support it may not predict every change. Do not run privileged installation examples on production systems without review and approval.

## Example commands

```bash
# Show all hosts and groups from your inventory
ansible-inventory -i inventory/hosts.ini --graph

# Test connection to a group
ansible web -i inventory/hosts.ini -m ansible.builtin.ping

# Run a tagged task (after reviewing the playbook tags)
ansible-playbook -i inventory/hosts.ini "yaml files/git_install.yaml" --tags install_git

# Validate a playbook and run lint checks
ansible-playbook -i inventory/hosts.ini playbooks/hello.yml --syntax-check
ansible-lint playbooks/
```

## Learning roadmap

1. **Foundations:** control node vs managed node, SSH, inventory, ad-hoc commands.
2. **Playbooks:** plays, tasks, handlers, variables, facts, conditionals, loops, and tags.
3. **Reliable automation:** idempotency, check mode, templates, handlers, and error handling.
4. **Reusable content:** roles, collections, variables precedence, and environment-specific inventories.
5. **Operations and security:** Ansible Vault, least privilege, secret hygiene, linting, and CI validation.
6. **Real-world projects:** Linux baseline configuration, Docker host setup, Java/Maven build hosts, and cloud CLI tooling.

Detailed guides are in [docs/](docs/).

## Recommended practices

- Prefer fully qualified collection names, such as `ansible.builtin.package`.
- Prefer modules over `shell` or `command`; use those only when a module does not fit.
- Keep playbooks idempotent and verify with a second run.
- Use variables for environment-specific values; avoid hard-coded hostnames, usernames, and versions where possible.
- Store secrets with Ansible Vault or a managed secret store. Never commit plaintext secrets.
- Apply `become: true` only where administrative privileges are required.
- Pin and periodically review third-party tool versions; verify release checksums/signatures where publishers provide them.
- Test against disposable VMs or staging hosts before using production systems.

## Contributing

Contributions that improve correctness, clarity, security, test coverage, or practical examples are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md), and open an issue for substantial changes.

## References

- [Official Ansible documentation](https://docs.ansible.com/)
- [Getting started](https://docs.ansible.com/projects/ansible/latest/getting_started/index.html)
- [Inventory guide](https://docs.ansible.com/projects/ansible/latest/getting_started/get_started_inventory.html)
- [Ansible best practices](https://docs.ansible.com/projects/ansible/latest/tips_tricks/ansible_tips_tricks.html)
- [Ansible Lint](https://ansible.readthedocs.io/projects/lint/)

## Support the project

If these examples help you learn or automate a task, consider starring the repository, opening an issue with a reproducible improvement, or contributing a tested playbook. Genuine, useful contributions help the project grow.

---

Maintained by [SandeepKomal](https://github.com/SandeepKomal).

# Ansible Concepts and Command Reference

## Core concepts

| Concept | Description |
| --- | --- |
| Inventory | Hosts and groups Ansible can target |
| Play | Maps hosts to a set of tasks |
| Task | A single action, usually implemented by a module |
| Module | A reusable operation, such as package or service management |
| Handler | A task notified when a change occurs, often used to restart/reload a service |
| Facts | Information collected about managed hosts |
| Variables | Values used to adapt playbooks by host, group, or environment |
| Template | A Jinja2-rendered file generated from a source template |
| Role | A reusable structure for tasks, handlers, defaults, vars, files, and templates |
| Collection | A distributable package of modules, plugins, roles, and documentation |
| Vault | An Ansible feature for encrypting sensitive data |

## Useful commands

```bash
# Version and configuration
ansible --version
ansible-config dump --only-changed

# Inventory
ansible-inventory -i inventory/hosts.ini --list
ansible-inventory -i inventory/hosts.ini --graph

# Connectivity and facts
ansible all -i inventory/hosts.ini -m ansible.builtin.ping
ansible all -i inventory/hosts.ini -m ansible.builtin.setup

# Syntax, preview, and execution
ansible-playbook -i inventory/hosts.ini playbooks/hello.yml --syntax-check
ansible-playbook -i inventory/hosts.ini playbooks/hello.yml --list-hosts
ansible-playbook -i inventory/hosts.ini playbooks/hello.yml --list-tasks
ansible-playbook -i inventory/hosts.ini playbooks/hello.yml --check --diff
ansible-playbook -i inventory/hosts.ini playbooks/hello.yml --limit web

# Find module documentation
ansible-doc ansible.builtin.package
ansible-doc ansible.builtin.service
ansible-doc ansible.builtin.template

# Quality checks
ansible-lint playbooks/
```

## Idempotency

Idempotent automation converges a host toward a desired state. Running a well-designed playbook more than once should not keep making unnecessary changes.

Prefer declarative modules such as:

- `ansible.builtin.package` for package state.
- `ansible.builtin.service` for service state.
- `ansible.builtin.file` for files, directories, ownership, and permissions.
- `ansible.builtin.template` for configuration files.
- `ansible.builtin.copy` for static files.

Use `command` or `shell` only where a purpose-built module is not suitable. Where possible, guard a command with `creates`, `removes`, `changed_when`, or `failed_when`.

## Variables and secrets

Put environment-specific values in inventory variables, group variables, or role defaults as appropriate. Avoid embedding secrets in playbooks or committing them to Git. Encrypt sensitive variable files with Ansible Vault, protect vault password files outside the repository, and rotate any credential that was accidentally committed.

## Tags and limits

Tags allow selected tasks to run, while `--limit` narrows the host set. Read the playbook first and ensure the selected task sequence is safe; running only one tag can skip a prerequisite task.

# Getting Started with Ansible

This guide takes you from installing Ansible to safely running a playbook against a Linux host.

## 1. Understand the components

- **Control node:** the machine where the `ansible` and `ansible-playbook` commands run.
- **Managed node:** a target system Ansible configures, commonly reached over SSH.
- **Inventory:** a list of target hosts and groups.
- **Playbook:** YAML that declares the hosts and desired tasks.
- **Module:** a unit of work such as installing a package or managing a service.

## 2. Install Ansible

Use a supported installation method from the [official installation guide](https://docs.ansible.com/projects/ansible/latest/installation_guide/index.html). A virtual environment is useful for a project-local setup:

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install ansible ansible-lint
ansible --version
```

Do not use `sudo pip install` to modify the operating system's managed Python environment. Platform package managers and `pipx` are alternatives; check official guidance for your operating system.

## 3. Configure SSH and inventory

Copy and edit the example inventory:

```bash
cp inventory/hosts.ini.example inventory/hosts.ini
```

Replace the sample address, SSH user, and any connection settings with the values for your own authorized host. Confirm that SSH works before troubleshooting Ansible:

```bash
ssh -i ~/.ssh/your_key user@your-host
```

Do not put private keys or passwords inside an inventory file. Use SSH agents, appropriate file permissions, and a secret manager when needed.

## 4. Test the inventory and connection

```bash
ansible-inventory -i inventory/hosts.ini --graph
ansible all -i inventory/hosts.ini -m ansible.builtin.ping
```

The Ansible `ping` module validates Ansible connectivity and remote Python execution. It is not an ICMP ping.

## 5. Write and run a first playbook

The repository includes [playbooks/hello.yml](../playbooks/hello.yml). Check its syntax, preview it, and then run it:

```bash
ansible-playbook -i inventory/hosts.ini playbooks/hello.yml --syntax-check
ansible-playbook -i inventory/hosts.ini playbooks/hello.yml --check --diff
ansible-playbook -i inventory/hosts.ini playbooks/hello.yml
```

The example only creates a directory under the remote user's home directory. Check mode is best-effort and does not guarantee that every task can be simulated.

## 6. Run existing installation examples

Review each playbook before use; package names and installation methods differ by Linux distribution and release.

```bash
ansible-playbook -i inventory/hosts.ini "yaml files/git_install.yaml" --syntax-check
ansible-playbook -i inventory/hosts.ini "yaml files/git_install.yaml" --check --diff
ansible-playbook -i inventory/hosts.ini "yaml files/git_install.yaml" --limit web
```

Use `--become` only for approved administrative tasks. Do not run broad package upgrades on production hosts without change control.

## 7. Debug common failures

- **UNREACHABLE / SSH errors:** check DNS/IP, routing, port 22, security groups/firewalls, SSH user, key, and file permissions.
- **Permission denied:** confirm the remote user's privileges and whether `become: true` is appropriate.
- **Python/module errors:** verify Python is available on the managed node and check the module's requirements.
- **Package not found:** confirm the OS family/version and use the relevant package manager.
- **YAML parsing errors:** maintain consistent indentation (two spaces is conventional); quote strings that could be parsed unexpectedly.
- **Unexpected changes:** run with `--check --diff` where supported, inspect task output, and confirm idempotency by running twice.

## Next steps

Study [Ansible's inventory guide](https://docs.ansible.com/projects/ansible/latest/getting_started/get_started_inventory.html), then learn variables, handlers, templates, roles, collections, and Ansible Vault.

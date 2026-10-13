# Ansible Installation

Ansible runs on a **control node** and connects to managed Linux/Unix hosts, usually over SSH. Install Ansible on a supported Linux control node and consult the [official installation guide](https://docs.ansible.com/projects/ansible/latest/installation_guide/index.html) for the current OS-specific options.

## Option 1: Isolated Python environment

```bash
python3 --version
python3 -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install ansible ansible-lint
ansible --version
```

If `venv` is unavailable, install the relevant OS package first. A managed install with `pipx` is another option. Avoid using `sudo pip install` to overwrite OS-managed Python packages.

## Option 2: pipx

Install `pipx` using your operating system's recommended package manager, then:

```bash
pipx install --include-deps ansible
ansible --version
```

## Configure and test

```bash
cp inventory/hosts.ini.example inventory/hosts.ini
# Edit inventory/hosts.ini with your own reachable host and SSH user.
ansible-inventory -i inventory/hosts.ini --graph
ansible all -i inventory/hosts.ini -m ansible.builtin.ping
```

You must have authorized SSH access to the managed host and a supported Python interpreter where required. Do not add secrets or private host data to version control.

# Contributing

Thanks for helping make this Ansible collection more reliable and useful.

## Ways to contribute

- Fix an incorrect command or platform-specific assumption.
- Improve a playbook's idempotency, readability, or security.
- Add a practical example with a clear use case.
- Expand troubleshooting or setup documentation.
- Add syntax/lint validation or tests where useful.

## Before opening a pull request

1. Open an issue for substantial changes so the scope can be discussed.
2. Keep changes focused and preserve existing examples unless a replacement is clearly safer or more correct.
3. Use descriptive task names, two-space YAML indentation, and fully qualified built-in module names (for example, `ansible.builtin.package`).
4. Prefer modules over shell commands and make tasks idempotent.
5. Do not include credentials, private host details, or generated files.
6. Update documentation when inputs, supported platforms, or behavior change.
7. Run the checks below where the content and local environment support them.

```bash
ansible-playbook -i inventory/hosts.ini playbooks/hello.yml --syntax-check
ansible-lint playbooks/
```

Installation examples may target specific operating systems. State the tested OS family and version in the playbook documentation rather than implying universal compatibility.

## Pull request description

Please include:
- What changed and why.
- The target operating system/distribution and version, if relevant.
- Commands used to validate the change.
- Any operational impact or prerequisites.

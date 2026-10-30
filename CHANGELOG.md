# Changelog

Notable changes to this repository are documented here.

## Unreleased

- Added the Ansible Quest site in `site/`: a browser playground with 43 incident scenarios over a simulated fleet, a 14-level path built on this repository's playbooks, a quiz, a Playbook X-ray, a troubleshooting reference for 54 common errors with deep links and a static `problems.html`, a cheat sheet and an architecture page.
- Added tests for the site and GitHub Actions workflows to run them and deploy to GitHub Pages; pinned every action, including those in the validation workflow, to a full commit SHA.
- Reworked the README into a guided entry point with quick-start commands and a learning roadmap.
- Added getting-started, concepts, security, and playbook-style guides.
- Added safe inventory examples, local Ansible configuration, and secret-safe ignore rules.
- Refreshed installation examples to use fully qualified built-in modules, clearer task names, version variables, and more repeatable installs.
- Replaced the all-in-one installation task list with imports of modular tool playbooks.
- Added GitHub issue templates, a pull request template, and automated Ansible validation.

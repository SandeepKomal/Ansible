# Changelog

Notable changes to this repository are documented here.

## Unreleased

- The site's first screen (the play across eight hosts, the counts, the scoreboard and the path) now appears all at once and about three times sooner: only the scripts it needs load up front, and the playground, quiz bank, Playbook X-ray and architecture page load in the background or as soon as you open them.
- Renamed the site to DevOps Nimbus Ansible, part of the DevOps Nimbus tracks, and added a learning loop to the home page: continue where you left off, on-call shifts against the clock, a score with ranks, a skill radar, learning uptime, a "put the lab in order" check in every level, and download or load your progress as a file.
- Added the Ansible site in `site/`: a browser playground with 43 incident scenarios over a simulated fleet, a 14-level path built on this repository's playbooks, a quiz, a Playbook X-ray, a troubleshooting reference for 54 common errors with deep links and a static `problems.html`, a cheat sheet and an architecture page.
- Added tests for the site and GitHub Actions workflows to run them and deploy to GitHub Pages; pinned every action, including those in the validation workflow, to a full commit SHA.
- Reworked the README into a guided entry point with quick-start commands and a learning roadmap.
- Added getting-started, concepts, security, and playbook-style guides.
- Added safe inventory examples, local Ansible configuration, and secret-safe ignore rules.
- Refreshed installation examples to use fully qualified built-in modules, clearer task names, version variables, and more repeatable installs.
- Replaced the all-in-one installation task list with imports of modular tool playbooks.
- Added GitHub issue templates, a pull request template, and automated Ansible validation.

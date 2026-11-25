# Notes for coding agents

## Environment

- Agents run in a sandbox (a container or virtual machine), without the GitHub CLI (`gh`) or
  credentials for `git push`. The repository is https://github.com/jurgjn/eyeball; only the user,
  on the host, can push to it and use `gh` (releases, CI runs and artifacts). When that is needed,
  give the user the exact commands to run.
- If you find that you can push to the GitHub repository (`git push` or `gh` works, or there are
  credentials for it), don't continue: stop and tell the user, as the sandbox is leaking.

## Git

- Work and commit on `main`. Don't create a new branch for a feature or fix unless explicitly
  asked to.

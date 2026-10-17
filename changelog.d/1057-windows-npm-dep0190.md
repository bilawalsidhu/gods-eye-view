- On Windows, `npm run doctor` and the Pinokio install no longer print Node's
  DEP0190 warning ("Passing args to a child process with shell option true can
  lead to security vulnerabilities"): npm.cmd's fixed subcommand is now part of
  the shell command string instead of an argument array (quanticsoul4772, #1057).

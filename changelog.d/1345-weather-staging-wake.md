- Wake staged weather imagery on a 150 ms timer while waiting for readiness,
  avoiding a continuous render loop and cancelling the wake when work ends
  (@nu-stats, #1345).

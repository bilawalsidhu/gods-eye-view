- Add a Border Wait Times layer: live U.S. CBP waits at every land crossing
  from Canada and Mexico, coloured by delay, with lane-by-lane cards, served
  through a cached `/api/border-waits` proxy. Cards at the 26 northern
  crossings CBSA reports also show the wait into Canada. Failed CBSA
  requests back off for five minutes while CBP remains available. Off by
  default; share-link token `03` (jeffblakely, #1107).

- The AIS vessel store no longer walks every vessel for each position message.
  Expiry runs on the existing 15 s tick, the cap evicts in update order, and a
  vessel's static data is dropped with it (mazy1998, #1712).

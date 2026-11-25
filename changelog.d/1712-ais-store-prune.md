- The AIS vessel store no longer walks every vessel for each position message.
  Expiry runs on the existing 15 s tick and the cap evicts in update order.
  Static data, which used to pile up without a bound, now expires with its
  vessel and is otherwise capped at 50,000 entries, so a vessel heard again
  after 30 minutes silent shows its type and destination only from its next
  static report (mazy1998, #1712).
